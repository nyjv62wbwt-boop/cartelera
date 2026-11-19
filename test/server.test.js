import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fakeSource, testConfig } from './helpers.js';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { createApp } from '../src/server.js';
import { createScheduler } from '../src/scheduler.js';

let server;
let base;
let db;
const config = testConfig();
const auth = { authorization: `Bearer ${config.adminToken}` };

before(async () => {
  db = openDb(':memory:');
  const ctx = { db, config, fetchImpl: fakeSource(), tmdb: { configured: false }, sleep: async () => {}, log: () => {} };
  await runSync(ctx);
  const scheduler = createScheduler(ctx);
  server = http.createServer(createApp({ config, db, tmdb: ctx.tmdb, scheduler, log: () => {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('catálogo público con ETag (304 si no cambia)', async () => {
  const r1 = await fetch(`${base}/api/catalog`);
  assert.equal(r1.status, 200);
  const data = await r1.json();
  assert.equal(data.items.length, 378);
  assert.ok(!JSON.stringify(data).includes('secreto'), 'sin credenciales en la respuesta');
  const r2 = await fetch(`${base}/api/catalog`, { headers: { 'if-none-match': r1.headers.get('etag') } });
  assert.equal(r2.status, 304);
});

test('ficha individual y 404 claro', async () => {
  const { items } = await (await fetch(`${base}/api/catalog`)).json();
  const serie = items.find((i) => i.type === 'tv');
  const r = await fetch(`${base}/api/items/${serie.id}`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.id, serie.id);
  assert.ok(Array.isArray(d.seasons));
  const nf = await fetch(`${base}/api/items/000000000000`);
  assert.equal(nf.status, 404);
  assert.match((await nf.json()).error, /ya no está/);
});

test('páginas estáticas, cabeceras de seguridad y protección de rutas', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(`${base}/admin`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fsrc%2fserver.js`)).status, 403);
});

test('API de administración exige token', async () => {
  assert.equal((await fetch(`${base}/api/admin/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/status`, { headers: { authorization: 'Bearer malo' } })).status, 401);
  const r = await fetch(`${base}/api/admin/status`, { headers: auth });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.counts.movies, 184);
  assert.equal(s.counts.series, 192);
  assert.equal(s.runs[0].status, 'success');
  assert.equal(s.runs[0].new_count, 378);
});

test('validación de ajustes y edición manual', async () => {
  const bad = await fetch(`${base}/api/admin/settings`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ intervalHours: 0, missingThreshold: 99 }) });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${base}/api/admin/settings`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ intervalHours: 6, missingThreshold: 3 }) });
  assert.equal(ok.status, 200);
  const s = await (await fetch(`${base}/api/admin/status`, { headers: auth })).json();
  assert.equal(s.intervalHours, 6);
  assert.equal(s.missingThreshold, 3);

  const { items } = await (await fetch(`${base}/api/admin/items?filter=unidentified`, { headers: auth })).json();
  const movie = items.find((i) => i.type === 'movie');
  const missing = await fetch(`${base}/api/admin/items/${movie.id}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ title: '  ' }) });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /obligatorio/);
  const saved = await fetch(`${base}/api/admin/items/${movie.id}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Película de prueba', year: 2025, genres: ['Drama'] }) });
  assert.equal(saved.status, 200);
  const cat = await (await fetch(`${base}/api/catalog`)).json();
  assert.ok(cat.items.some((i) => i.id === movie.id && i.title === 'Película de prueba' && i.genres[0] === 'Drama'));
});

test('vincular a TMDB sin clave devuelve un mensaje claro', async () => {
  const r = await fetch(`${base}/api/admin/tmdb/preview?ref=603`, { headers: auth });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /TMDB no está configurado/);
});
