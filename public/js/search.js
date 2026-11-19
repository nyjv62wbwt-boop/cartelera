/**
 * Búsqueda y filtros del catálogo (módulo puro: sin DOM, se prueba con node --test).
 * Búsqueda flexible: ignora mayúsculas/acentos/puntuación, admite prefijos y pequeñas erratas
 * (distancia de Damerau-Levenshtein) y ordena por relevancia.
 */

export function normalize(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' y ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STOP = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'y', 'the', 'a', 'an', 'of', 'en', 'un', 'una']);

function tokens(s) {
  return normalize(s).split(' ').filter(Boolean);
}

/** Distancia de Damerau-Levenshtein (transposiciones incluidas) con corte temprano. */
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
  }
  return prev[b.length];
}

const allowedTypos = (len) => (len <= 3 ? 0 : len <= 6 ? 1 : 2);

function tokenScore(q, fieldTokens) {
  let best = 0;
  const typos = allowedTypos(q.length);
  for (const t of fieldTokens) {
    if (t === q) return 1;
    if (t.startsWith(q)) best = Math.max(best, q.length >= 2 ? 0.88 : 0.5);
    else if (q.length >= 3 && t.includes(q)) best = Math.max(best, 0.6);
    if (typos && best < 0.75) {
      const d = editDistance(q, t, typos);
      if (d <= typos) best = Math.max(best, 0.78 - 0.1 * d);
      else if (t.length > q.length) {
        // palabra a medio escribir con errata: "matirx" -> "matrix reloaded"
        const dp = editDistance(q, t.slice(0, q.length), typos);
        if (dp <= typos) best = Math.max(best, 0.62 - 0.08 * dp);
      }
    }
  }
  return best;
}

function fieldScore(query, qTokens, field) {
  if (!field.text) return 0;
  let phrase = 0;
  if (field.text === query) phrase = 1;
  else if (field.text.startsWith(query)) phrase = 0.94;
  else if ((' ' + field.text).includes(' ' + query)) phrase = 0.86;
  else if (query.length >= 3 && field.text.includes(query)) phrase = 0.72;

  const significant = qTokens.filter((t) => !STOP.has(t) || qTokens.length === 1);
  let sum = 0;
  let matched = 0;
  for (const q of significant) {
    const s = tokenScore(q, field.tokens);
    if (s > 0) matched += 1;
    sum += s;
  }
  let tok = significant.length ? sum / significant.length : 0;
  if (matched < significant.length) tok *= significant.length > 1 && matched / significant.length >= 0.5 ? 0.55 : 0;
  return Math.max(phrase, tok * 0.9);
}

const FIELD_WEIGHTS = { title: 1, originalTitle: 0.95, people: 0.7, channel: 0.6 };

/** Prepara un índice de búsqueda para todo el catálogo (una vez por versión). */
export function buildIndex(items) {
  return items.map((item) => {
    const mk = (s) => ({ text: normalize(s), tokens: tokens(s) });
    const people = [...(item.cast || []), ...(item.directors || []), ...(item.creators || [])];
    return {
      item,
      fields: {
        title: mk(item.title),
        originalTitle: mk(item.originalTitle),
        people: people.map(mk),
        channel: mk((item.categories || []).map((c) => c.channel).filter(Boolean).join(' ')),
      },
    };
  });
}

/** Devuelve Map(id -> puntuación) con los títulos que coinciden con la consulta. */
export function search(index, rawQuery) {
  const query = normalize(rawQuery);
  const scores = new Map();
  if (!query) return scores;
  const qTokens = query.split(' ');
  for (const { item, fields } of index) {
    let best = fieldScore(query, qTokens, fields.title) * FIELD_WEIGHTS.title;
    best = Math.max(best, fieldScore(query, qTokens, fields.originalTitle) * FIELD_WEIGHTS.originalTitle);
    best = Math.max(best, fieldScore(query, qTokens, fields.channel) * FIELD_WEIGHTS.channel);
    for (const p of fields.people) {
      if (best >= FIELD_WEIGHTS.people) break;
      best = Math.max(best, fieldScore(query, qTokens, p) * FIELD_WEIGHTS.people);
    }
    if (best >= 0.4) scores.set(item.id, best);
  }
  return scores;
}

export const DEFAULT_FILTERS = Object.freeze({
  q: '',
  type: 'all', // all | movie | tv
  category: '', // taquillazo | taquillas | infantiles | series
  genres: [],
  yearFrom: null,
  yearTo: null,
  lang: '',
  minRating: 0,
  sort: 'recent',
  favorites: false,
});

export function isFiltered(f) {
  return Boolean(f.q || f.type !== 'all' || f.category || f.genres.length || f.yearFrom || f.yearTo || f.lang || f.minRating || f.favorites);
}

/** Aplica todos los filtros combinados (AND entre filtros, OR entre géneros seleccionados). */
export function applyFilters(items, f, { scores = null, favorites = null } = {}) {
  return items.filter((it) => {
    if (scores && !scores.has(it.id)) return false;
    if (f.type !== 'all' && it.type !== f.type) return false;
    if (f.category && !(it.categories || []).some((c) => c.key === f.category)) return false;
    if (f.genres.length && !f.genres.some((g) => (it.genres || []).includes(g))) return false;
    if (f.yearFrom && !(it.year && it.year >= f.yearFrom)) return false;
    if (f.yearTo && !(it.year && it.year <= f.yearTo)) return false;
    if (f.lang && it.language !== f.lang) return false;
    if (f.minRating && !(it.rating != null && it.rating >= f.minRating)) return false;
    if (f.favorites && !(favorites && favorites.has(it.id))) return false;
    return true;
  });
}

const firstPos = (it) => Math.min(...(it.categories || []).map((c) => c.position ?? 9999), 9999);
const byText = (a, b) => (a.title || '￿').localeCompare(b.title || '￿', 'es', { sensitivity: 'base' });

/** Puntuación de "destacado": valoración ponderada por nº de votos (estilo IMDb). */
export function featuredScore(it) {
  if (it.rating == null || !it.votes) return 0;
  const m = 150;
  const c = 6.5;
  return (it.votes / (it.votes + m)) * it.rating + (m / (it.votes + m)) * c;
}

export function sortItems(list, sort, scores = null) {
  const arr = [...list];
  const cmp = {
    relevance: (a, b) => (scores?.get(b.id) ?? 0) - (scores?.get(a.id) ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0) || firstPos(a) - firstPos(b),
    recent: (a, b) => (b.addedAt || '').localeCompare(a.addedAt || '') || firstPos(a) - firstPos(b),
    popular: (a, b) => (b.popularity ?? -1) - (a.popularity ?? -1) || firstPos(a) - firstPos(b),
    rating: (a, b) => featuredScore(b) - featuredScore(a) || (b.rating ?? -1) - (a.rating ?? -1),
    az: byText,
    za: (a, b) => byText(b, a),
    'year-desc': (a, b) => (b.year ?? 0) - (a.year ?? 0) || byText(a, b),
    'year-asc': (a, b) => (a.year ?? 9999) - (b.year ?? 9999) || byText(a, b),
  }[sort] || ((a, b) => firstPos(a) - firstPos(b));
  return arr.sort(cmp);
}

/** Opciones de filtro que existen realmente en el catálogo (para no ofrecer filtros vacíos). */
export function facets(items) {
  const genres = new Map();
  const langs = new Map();
  const years = new Set();
  let rated = 0;
  for (const it of items) {
    for (const g of it.genres || []) genres.set(g, (genres.get(g) || 0) + 1);
    if (it.language) langs.set(it.language, (langs.get(it.language) || 0) + 1);
    if (it.year) years.add(it.year);
    if (it.rating != null) rated += 1;
  }
  return {
    genres: [...genres.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    languages: [...langs.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
    years: [...years].sort((a, b) => b - a),
    hasRatings: rated > 0,
    hasPopularity: items.some((i) => i.popularity != null),
  };
}

/** Serializa/deserializa filtros en la URL (#/explorar?...), para poder volver atrás y compartir. */
export function filtersToParams(f) {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.type !== 'all') p.set('tipo', f.type);
  if (f.category) p.set('cat', f.category);
  if (f.genres.length) p.set('genero', f.genres.join(','));
  if (f.yearFrom) p.set('desde', f.yearFrom);
  if (f.yearTo) p.set('hasta', f.yearTo);
  if (f.lang) p.set('idioma', f.lang);
  if (f.minRating) p.set('nota', f.minRating);
  if (f.sort && f.sort !== DEFAULT_FILTERS.sort) p.set('orden', f.sort);
  if (f.favorites) p.set('milista', '1');
  return p;
}

export function paramsToFilters(p) {
  const num = (v) => (v && Number.isFinite(Number(v)) ? Number(v) : null);
  const type = p.get('tipo');
  return {
    ...DEFAULT_FILTERS,
    q: p.get('q') || '',
    type: type === 'movie' || type === 'tv' ? type : 'all',
    category: p.get('cat') || '',
    genres: (p.get('genero') || '').split(',').filter(Boolean),
    yearFrom: num(p.get('desde')),
    yearTo: num(p.get('hasta')),
    lang: p.get('idioma') || '',
    minRating: num(p.get('nota')) || 0,
    sort: p.get('orden') || (p.get('q') ? 'relevance' : DEFAULT_FILTERS.sort),
    favorites: p.get('milista') === '1',
  };
}
