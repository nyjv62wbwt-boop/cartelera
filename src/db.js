import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id                 TEXT PRIMARY KEY,
  source_key         TEXT NOT NULL UNIQUE,      -- identificador original estable (tmdb:tv:ID, fa:ID, poster:FICHERO, sala:...)
  type               TEXT NOT NULL,             -- movie | tv | sala
  title              TEXT,
  title_source       TEXT,                      -- tmdb | slug | source | manual
  original_title     TEXT,
  year               INTEGER,
  release_date       TEXT,
  overview           TEXT,
  genres             TEXT NOT NULL DEFAULT '[]',
  original_language  TEXT,
  spoken_languages   TEXT NOT NULL DEFAULT '[]',
  rating             REAL,
  vote_count         INTEGER,
  popularity         REAL,
  runtime            INTEGER,
  poster_url         TEXT,                      -- póster que publica la fuente original
  tmdb_poster_url    TEXT,
  backdrop_url       TEXT,
  images             TEXT NOT NULL DEFAULT '[]',
  cast_members       TEXT NOT NULL DEFAULT '[]',
  directors          TEXT NOT NULL DEFAULT '[]',
  creators           TEXT NOT NULL DEFAULT '[]',
  seasons            TEXT NOT NULL DEFAULT '[]',
  number_of_seasons  INTEGER,
  number_of_episodes INTEGER,
  tmdb_type          TEXT,
  tmdb_id            INTEGER,
  tmdb_manual        INTEGER NOT NULL DEFAULT 0,
  tmdb_signature     TEXT,
  filmaffinity_id    TEXT,
  external_url       TEXT,
  status             TEXT NOT NULL DEFAULT 'available',  -- available | missing | unavailable
  missing_count      INTEGER NOT NULL DEFAULT 0,
  first_seen_at      TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  enriched_at        TEXT,
  enrich_error       TEXT,
  content_hash       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_tmdb ON items(tmdb_type, tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_items_status ON items(status);

CREATE TABLE IF NOT EXISTS item_sources (
  item_id        TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  position       INTEGER,
  channel_label  TEXT,
  channel_url    TEXT,
  link_url       TEXT,
  raw_alt        TEXT,
  present        INTEGER NOT NULL DEFAULT 1,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  PRIMARY KEY (item_id, category)
);

CREATE TABLE IF NOT EXISTS aliases (
  source_key TEXT PRIMARY KEY,
  item_id    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger           TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT NOT NULL,             -- running | success | partial | error
  attempts          INTEGER NOT NULL DEFAULT 0,
  new_count         INTEGER NOT NULL DEFAULT 0,
  updated_count     INTEGER NOT NULL DEFAULT 0,
  missing_count     INTEGER NOT NULL DEFAULT 0,
  unavailable_count INTEGER NOT NULL DEFAULT 0,
  restored_count    INTEGER NOT NULL DEFAULT 0,
  enriched_count    INTEGER NOT NULL DEFAULT 0,
  errors            TEXT NOT NULL DEFAULT '[]',
  details           TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Índice persistente póster de TMDB -> película (la fuente solo publica el póster de las películas).
CREATE TABLE IF NOT EXISTS tmdb_posters (
  file    TEXT PRIMARY KEY,
  tmdb_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tmdb_scanned (
  tmdb_id    INTEGER PRIMARY KEY,
  scanned_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tmdb_tv_posters (
  file    TEXT PRIMARY KEY,
  tmdb_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tmdb_tv_scanned (
  tmdb_id    INTEGER PRIMARY KEY,
  scanned_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS http_cache (
  url           TEXT PRIMARY KEY,
  etag          TEXT,
  last_modified TEXT,
  body          TEXT,
  fetched_at    TEXT
);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export const nowIso = () => new Date().toISOString();

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Bloqueo entre procesos (servidor + `npm run sync`) para no solapar sincronizaciones. */
export function acquireLock(db, owner, ttlMs = 30 * 60_000) {
  const now = Date.now();
  return transaction(db, () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sync_lock'").get();
    if (row?.value) {
      const [, expires] = row.value.split('|');
      if (Number(expires) > now) return false;
    }
    setSetting(db, 'sync_lock', `${owner}|${now + ttlMs}`);
    return true;
  });
}

export function releaseLock(db, owner) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sync_lock'").get();
  if (row?.value?.startsWith(`${owner}|`)) setSetting(db, 'sync_lock', null);
}

export const parseJson = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};
