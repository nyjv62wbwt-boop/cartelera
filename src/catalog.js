import { CATEGORIES } from './config.js';
import { getSetting, parseJson } from './db.js';
import { stableId } from './parser.js';

const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
const CAT_ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c.key, i]));

function sourcesByItem(db) {
  const map = new Map();
  for (const s of db.prepare('SELECT * FROM item_sources WHERE present = 1 ORDER BY category, position').all()) {
    if (!map.has(s.item_id)) map.set(s.item_id, []);
    map.get(s.item_id).push({
      key: s.category,
      label: CAT_LABEL[s.category] || s.category,
      position: s.position,
      channel: s.channel_label || null,
      channelUrl: s.channel_url || null,
    });
  }
  for (const list of map.values()) list.sort((a, b) => CAT_ORDER[a.key] - CAT_ORDER[b.key]);
  return map;
}

const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s || null);

/** Fila de BD -> objeto público. Solo incluye campos con datos reales (sin inventar). */
function toPublic(row, sources, { full = false } = {}) {
  const cast = parseJson(row.cast_members, []);
  const item = {
    id: row.id,
    type: row.type,
    title: row.title || null,
    titleSource: row.title_source || null,
    originalTitle: row.original_title && row.original_title !== row.title ? row.original_title : null,
    year: row.year ?? null,
    overview: full ? row.overview || null : truncate(row.overview, 240),
    genres: parseJson(row.genres, []),
    language: row.original_language || null,
    rating: row.rating != null ? Math.round(row.rating * 10) / 10 : null,
    votes: row.vote_count ?? null,
    popularity: row.popularity ?? null,
    runtime: row.runtime ?? null,
    poster: row.poster_url || row.tmdb_poster_url || null,
    backdrop: row.backdrop_url || null,
    cast: full ? cast : cast.slice(0, 10).map((c) => c.name),
    directors: parseJson(row.directors, []),
    creators: parseJson(row.creators, []),
    seasonsCount: row.number_of_seasons ?? null,
    episodesCount: row.number_of_episodes ?? null,
    categories: sources || [],
    addedAt: row.first_seen_at,
    status: row.status,
    identified: row.title_source === 'tmdb' || row.title_source === 'manual',
  };
  if (full) {
    item.releaseDate = row.release_date || null;
    item.languages = parseJson(row.spoken_languages, []);
    item.images = parseJson(row.images, []);
    item.seasons = parseJson(row.seasons, []);
    item.externalUrl = row.external_url || null;
    item.lastSeenAt = row.last_seen_at;
    item.updatedAt = row.updated_at;
  }
  return item;
}

export function catalogVersion(db) {
  return getSetting(db, 'catalog_version', '0');
}

export function buildCatalog(db) {
  const sources = sourcesByItem(db);
  const rows = db.prepare(`SELECT * FROM items WHERE status <> 'unavailable'`).all();
  const items = rows.map((r) => toPublic(r, sources.get(r.id)));
  const lastSync = db.prepare("SELECT finished_at FROM sync_runs WHERE status IN ('success','partial') ORDER BY id DESC LIMIT 1").get();
  return {
    version: catalogVersion(db),
    lastSyncAt: lastSync?.finished_at || null,
    categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label, count: items.filter((i) => i.categories.some((s) => s.key === c.key)).length })),
    items,
  };
}

export function getItem(db, id) {
  let row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row) {
    // ID antiguo de un título que se fusionó con otro (enlaces guardados en favoritos, etc.)
    const alias = db.prepare('SELECT source_key, item_id FROM aliases').all().find((a) => stableId(a.source_key) === id);
    if (alias) row = db.prepare('SELECT * FROM items WHERE id = ?').get(alias.item_id);
  }
  if (!row) return null;
  return toPublic(row, sourcesByItem(db).get(row.id), { full: true });
}

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Posibles duplicados: mismo título normalizado y año, distinto identificador. */
export function findDuplicates(db) {
  const groups = new Map();
  for (const r of db.prepare("SELECT id, title, year, type FROM items WHERE status <> 'unavailable' AND title IS NOT NULL").all()) {
    const key = `${r.type}|${norm(r.title)}|${r.year ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r.id);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export function adminItems(db, filter = 'unidentified') {
  const sources = sourcesByItem(db);
  let rows;
  if (filter === 'unidentified') {
    rows = db.prepare(`SELECT * FROM items WHERE status <> 'unavailable' AND type IN ('movie','tv')
      AND (title_source IS NULL OR title_source NOT IN ('tmdb','manual')) ORDER BY type, first_seen_at DESC`).all();
  } else if (filter === 'unavailable') {
    rows = db.prepare(`SELECT * FROM items WHERE status IN ('missing','unavailable') ORDER BY updated_at DESC`).all();
  } else if (filter === 'duplicates') {
    const ids = findDuplicates(db).flat();
    rows = ids.length ? db.prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY title`).all(...ids) : [];
  } else if (filter === 'errors') {
    rows = db.prepare(`SELECT * FROM items WHERE enrich_error IS NOT NULL AND status <> 'unavailable' ORDER BY updated_at DESC`).all();
  } else {
    rows = db.prepare('SELECT * FROM items ORDER BY first_seen_at DESC').all();
  }
  return rows.map((r) => ({
    ...toPublic(r, sources.get(r.id)),
    sourceKey: r.source_key,
    tmdbType: r.tmdb_type,
    tmdbId: r.tmdb_id,
    tmdbManual: Boolean(r.tmdb_manual),
    externalUrl: r.external_url,
    enrichError: r.enrich_error,
    missingCount: r.missing_count,
    lastSeenAt: r.last_seen_at,
  }));
}

export function adminStatus(db, { scheduler, tmdbConfigured, config }) {
  const counts = db.prepare(`SELECT
      SUM(type = 'movie' AND status <> 'unavailable') AS movies,
      SUM(type = 'tv' AND status <> 'unavailable') AS series,
      SUM(type = 'sala' AND status <> 'unavailable') AS salas,
      SUM(status = 'missing') AS missing,
      SUM(status = 'unavailable') AS unavailable,
      SUM(type IN ('movie','tv') AND status <> 'unavailable' AND (title_source IS NULL OR title_source NOT IN ('tmdb','manual'))) AS unidentified
    FROM items`).get();
  const runs = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 15').all().map((r) => {
    const details = parseJson(r.details, {});
    const titleOf = (id) => db.prepare('SELECT title, type FROM items WHERE id = ?').get(id);
    return {
      ...r,
      errors: parseJson(r.errors, []),
      details: {
        ...details,
        newItems: (details.newItems || []).slice(0, 30).map((id) => ({ id, ...(titleOf(id) || {}) })),
        updatedItems: (details.updatedItems || []).slice(0, 30).map((id) => ({ id, ...(titleOf(id) || {}) })),
      },
    };
  });
  const sources = db.prepare('SELECT url, last_modified, fetched_at FROM http_cache ORDER BY url').all();
  return {
    running: scheduler?.isRunning() ?? false,
    lastSuccessAt: getSetting(db, 'last_success_at'),
    lastRunAt: getSetting(db, 'last_run_at'),
    nextSyncAt: scheduler?.nextRunAt()?.toISOString() ?? null,
    intervalHours: scheduler?.intervalHours() ?? config.syncIntervalHours,
    missingThreshold: Number(getSetting(db, 'missing_threshold', config.missingThreshold)),
    schedulerEnabled: !config.disableScheduler,
    sourceBaseUrl: config.sourceBaseUrl,
    tmdbConfigured,
    counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v ?? 0])),
    duplicates: findDuplicates(db).length,
    sources,
    runs,
  };
}
