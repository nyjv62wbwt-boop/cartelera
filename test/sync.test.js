import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, fakeSource, testConfig, removeCard } from './helpers.js';
import { openDb } from '../src/db.js';
import { runSync, applyEnrichment } from '../src/sync.js';
import { buildCatalog, getItem } from '../src/catalog.js';
import { stableId } from '../src/parser.js';
import { createTmdb, parseTmdbRef, mapGenres } from '../src/tmdb.js';

const noTmdb = { configured: false };
const ctxFor = (fetchImpl, extra = {}) => ({ db: openDb(':memory:'), config: testConfig(), fetchImpl, tmdb: noTmdb, sleep: async () => {}, ...extra });
const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;

test('primera importación completa y segunda sin duplicados (con caché HTTP 304)', async () => {
  const fetchImpl = fakeSource();
  const ctx = ctxFor(fetchImpl);
  const r1 = await runSync(ctx, { trigger: 'manual' });
  assert.equal(r1.status, 'success');
  assert.equal(r1.new_count, 378);
  assert.equal(count(ctx.db, 'SELECT COUNT(*) n FROM items'), 378);

  const r2 = await runSync(ctx);
  assert.equal(r2.new_count, 0);
  assert.equal(r2.updated_count, 0);
  assert.equal(count(ctx.db, 'SELECT COUNT(*) n FROM items'), 378);
  assert.ok(fetchImpl.calls.slice(4).every((c) => c.headers['if-none-match']), 'la 2ª pasada usa peticiones condicionales');

  const cat = buildCatalog(ctx.db);
  assert.equal(cat.items.length, 378);
  assert.deepEqual(cat.categories.map((c) => c.count), [2, 160, 24, 192]);
});

test('detecta títulos nuevos y modificados', async () => {
  const pages = {};
  const ctx = ctxFor(fakeSource(pages));
  await runSync(ctx);
  const series = fixture('series');
  const newCard = '<div class="movie"><a href="https://www.themoviedb.org/tv/999999-nueva-serie?language=es"><img src="https://media.themoviedb.org/t/p/w300_and_h450_face/nuevo.jpg" alt="x"></a></div>';
  pages.series = series.replace('<div class="movies">', `<div class="movies">${newCard}`)
    .replace('4ZwzUEFKKOwVjpFsXc13fJxWErN.jpg', 'POSTERNUEVO.jpg');
  const r = await runSync(ctx);
  assert.equal(r.new_count, 1);
  assert.equal(r.updated_count, 1, 'cambio de póster = modificado');
  const item = getItem(ctx.db, stableId('tmdb:tv:999999'));
  assert.equal(item.title, 'Nueva serie');
  assert.equal(item.categories[0].key, 'series');
});

test('ausencias: missing -> unavailable según umbral, sin borrar, y restauración', async () => {
  const pages = {};
  const ctx = ctxFor(fakeSource(pages));
  await runSync(ctx);
  const id = stableId('tmdb:tv:95350');
  pages.series = removeCard(fixture('series'), '/tv/95350-lanterns');

  const r1 = await runSync(ctx);
  assert.equal(r1.missing_count, 1);
  assert.equal(getItem(ctx.db, id).status, 'missing');
  assert.ok(buildCatalog(ctx.db).items.some((i) => i.id === id), 'sigue visible mientras está "missing"');

  const r2 = await runSync(ctx);
  assert.equal(r2.unavailable_count, 1);
  assert.equal(getItem(ctx.db, id).status, 'unavailable');
  assert.ok(!buildCatalog(ctx.db).items.some((i) => i.id === id), 'oculto en la web pública');
  assert.equal(count(ctx.db, 'SELECT COUNT(*) n FROM items WHERE id = ?', id), 1, 'nunca se borra');

  delete pages.series;
  const r3 = await runSync(ctx);
  assert.equal(r3.restored_count, 1);
  assert.equal(getItem(ctx.db, id).status, 'available');
});

test('una página caída no marca su contenido como ausente y se reintenta', async () => {
  const pages = {};
  const fetchImpl = fakeSource(pages);
  const ctx = ctxFor(fetchImpl);
  await runSync(ctx);
  pages.series = { status: 503 };
  const r = await runSync(ctx);
  assert.equal(r.status, 'partial');
  assert.equal(r.attempts, 2);
  assert.equal(r.missing_count, 0);
  assert.equal(count(ctx.db, "SELECT COUNT(*) n FROM items WHERE type = 'tv' AND status = 'available'"), 192);
  assert.match(JSON.parse(r.errors)[0], /HTTP 503/);
});

test('una página vacía o incompleta no vacía el catálogo (salvo forzado)', async () => {
  const pages = {};
  const ctx = ctxFor(fakeSource(pages));
  await runSync(ctx);
  pages.taquillas = '<html><body><div class="movies"></div></body></html>';
  const r = await runSync(ctx);
  assert.equal(r.status, 'partial');
  assert.equal(r.missing_count, 0);
  assert.match(JSON.parse(r.errors)[0], /incompleta/);
  const forced = await runSync(ctx, { force: true });
  assert.equal(forced.missing_count, 160);
});

test('fuente inaccesible: error registrado y datos anteriores intactos', async () => {
  const ctx = ctxFor(fakeSource());
  await runSync(ctx);
  ctx.fetchImpl = fakeSource({ taquillazo: { throws: true }, taquillas: { throws: true }, infantiles: { throws: true }, series: { throws: true } });
  const r = await runSync(ctx);
  assert.equal(r.status, 'error');
  assert.equal(count(ctx.db, "SELECT COUNT(*) n FROM items WHERE status = 'available'"), 378);
});

test('bloqueo: no se solapan dos sincronizaciones', async () => {
  let release;
  const slow = async (...a) => {
    await new Promise((r) => (release = r));
    return fakeSource()(...a);
  };
  const ctx = ctxFor(slow);
  const first = runSync(ctx);
  await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(runSync(ctx), /en curso/);
  release();
  // liberar el resto de peticiones pendientes
  const timer = setInterval(() => release?.(), 1);
  await first;
  clearInterval(timer);
});

function fakeMovie(id, title, extra = {}) {
  return {
    tmdbType: 'movie', tmdbId: id, title, originalTitle: title, releaseDate: '2025-05-01', year: 2025, overview: `Sinopsis de ${title}`,
    genres: ['Acción'], originalLanguage: 'en', spokenLanguages: ['en'], rating: 7.1, voteCount: 500, popularity: 50, runtime: 112,
    tmdbPosterUrl: null, backdropUrl: null, images: [], cast: [{ name: 'Actor Uno', character: 'Héroe', photo: null }], directors: ['Directora X'],
    creators: [], seasons: [], numberOfSeasons: null, numberOfEpisodes: null, signature: null, externalUrl: `https://www.themoviedb.org/movie/${id}`, ...extra,
  };
}

test('enriquecimiento: películas identificadas por póster con TMDB y fusión de duplicados', async () => {
  const taq = fixture('taquillas');
  const posters = [...taq.matchAll(/t\/p\/[^/]+\/([\w-]+\.jpg)/g)].map((m) => m[1]);
  const inf = fixture('infantiles');
  const infPoster = /t\/p\/[^/]+\/([\w-]+\.jpg)/.exec(inf)[1];
  const series = fixture('series');
  const faIdx = series.indexOf('filmaffinity.com/es/film481581');
  const faPoster = /t\/p\/[^/]+\/([\w-]+\.jpg)/.exec(series.slice(faIdx))[1];
  const tmdb = {
    configured: true,
    requests: 0,
    // El póster 0 de Taquillas es el principal de la 101; el de Infantiles es un póster alternativo de la
    // misma película (solo aparece en sus imágenes) -> deben fusionarse.
    discoverCandidates: async () => new Map([[101, [posters[0]]], [102, [posters[1]]], [103, []]]),
    moviePosters: async (id) => (id === 101 ? [posters[0], infPoster] : []),
    // Serie de FilmAffinity (sin ID de TMDB en la fuente) identificada por su póster alternativo.
    discoverTvCandidates: async () => new Map([[555, []]]),
    tvPosters: async (id) => (id === 555 ? [faPoster] : []),
    movie: async (id) => fakeMovie(id, id === 101 ? 'Peli Uno' : 'Peli Dos'),
    tv: async (id) => ({ ...fakeMovie(id, `Serie ${id}`), tmdbType: 'tv', directors: [], creators: ['Creador'], numberOfSeasons: 1, numberOfEpisodes: 2, signature: 's1', seasons: [{ number: 1, name: 'Temporada 1', episodes: [{ number: 1, name: 'Piloto' }, { number: 2, name: 'Dos' }] }] }),
  };
  const ctx = ctxFor(fakeSource(), { tmdb });
  const r = await runSync(ctx);
  const details = JSON.parse(r.details);
  assert.equal(details.tmdb.matchedByPoster, 4);
  assert.equal(r.status, 'success');
  const fa = getItem(ctx.db, stableId('fa:481581'));
  assert.equal(fa.title, 'Serie 555');
  assert.match(fa.externalUrl, /filmaffinity/, 'se conserva el enlace original de la fuente');
  assert.equal(count(ctx.db, 'SELECT COUNT(*) n FROM items WHERE tmdb_type = ? AND tmdb_id = ?', 'movie', 101), 1, 'sin duplicados');
  assert.equal(count(ctx.db, 'SELECT COUNT(*) n FROM items'), 377, 'dos pósters de la misma película = un título');

  const merged = buildCatalog(ctx.db).items.find((i) => i.title === 'Peli Uno');
  assert.deepEqual(merged.categories.map((c) => c.key).sort(), ['infantiles', 'taquillas']);
  assert.deepEqual(merged.directors, ['Directora X']);
  assert.equal(merged.identified, true);

  const serie = getItem(ctx.db, stableId('tmdb:tv:273918'));
  assert.equal(serie.title, 'Serie 273918');
  assert.equal(serie.seasons[0].episodes[1].name, 'Dos');

  // La siguiente sincronización reconoce el póster fusionado por su alias: no crea un título nuevo.
  const r2 = await runSync(ctx);
  assert.equal(r2.new_count, 0);
  assert.equal(count(ctx.db, 'SELECT COUNT(*) n FROM items'), 377);
  // Un enlace antiguo al título fusionado sigue funcionando.
  assert.equal(getItem(ctx.db, stableId(`poster:${infPoster}`)).title, 'Peli Uno');
});

test('los datos manuales no se pisan en las sincronizaciones', async () => {
  const ctx = ctxFor(fakeSource());
  await runSync(ctx);
  const id = stableId('tmdb:tv:95350');
  ctx.db.prepare("UPDATE items SET title = 'Lanterns (manual)', title_source = 'manual' WHERE id = ?").run(id);
  await runSync(ctx);
  assert.equal(getItem(ctx.db, id).title, 'Lanterns (manual)');
});

test('applyEnrichment marca vinculación manual', () => {
  const db = openDb(':memory:');
  const now = new Date().toISOString();
  db.prepare("INSERT INTO items(id, source_key, type, first_seen_at, last_seen_at, updated_at) VALUES('aaaaaaaaaaaa','poster:x.jpg','movie',?,?,?)").run(now, now, now);
  const res = applyEnrichment(db, 'aaaaaaaaaaaa', fakeMovie(5, 'Manual'), { manual: true });
  assert.equal(res.id, 'aaaaaaaaaaaa');
  assert.equal(db.prepare('SELECT tmdb_manual FROM items').get().tmdb_manual, 1);
});

test('cliente TMDB: clave en servidor, reintento 429 y mapeo de géneros', async () => {
  const urls = [];
  let n = 0;
  const fetchImpl = async (url, opts) => {
    urls.push({ url: String(url), auth: opts.headers.authorization });
    n += 1;
    if (n === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
    return Response.json({ id: 7, title: 'X', genres: [{ id: 10759 }, { id: 35 }], vote_count: 0, credits: { cast: [], crew: [] } });
  };
  const tmdb = createTmdb({ readToken: 'tok', fetchImpl, minIntervalMs: 0 });
  const m = await tmdb.movie(7);
  assert.equal(urls.length, 2);
  assert.equal(urls[1].auth, 'Bearer tok');
  assert.ok(!urls[1].url.includes('api_key'));
  assert.deepEqual(m.genres, ['Acción', 'Aventura', 'Comedia']);
  assert.equal(m.rating, null, 'sin votos no se muestra valoración');
  assert.deepEqual(mapGenres([{ id: 10765 }]), ['Ciencia ficción', 'Fantasía']);
  assert.deepEqual(parseTmdbRef('https://www.themoviedb.org/tv/66732-stranger-things'), { type: 'tv', id: 66732 });
  assert.deepEqual(parseTmdbRef('603', 'movie'), { type: 'movie', id: 603 });
  assert.equal(parseTmdbRef('hola'), null);
});
