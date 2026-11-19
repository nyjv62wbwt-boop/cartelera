import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { config as defaultConfig } from './config.js';
import { openDb, setSetting, nowIso, transaction } from './db.js';
import { createTmdb, parseTmdbRef } from './tmdb.js';
import { createScheduler } from './scheduler.js';
import { applyEnrichment } from './sync.js';
import { buildCatalog, getItem, adminStatus, adminItems, catalogVersion } from './catalog.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; img-src 'self' https: http: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function resolveAdminToken(config) {
  if (config.adminToken) return config.adminToken;
  const file = path.join(config.dataDir, 'admin-token.txt');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(config.dataDir, { recursive: true });
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Petición demasiado grande');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON no válido');
  }
}

function send(req, res, status, body, headers = {}) {
  let buf = typeof body === 'string' || Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  const h = { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /json|text|javascript|svg/.test(h['content-type'])) {
    buf = gzipSync(buf);
    h['content-encoding'] = 'gzip';
    h.vary = 'Accept-Encoding';
  }
  h['content-length'] = buf.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

export function createApp({ config = defaultConfig, db, tmdb, scheduler, log = console.log } = {}) {
  const adminToken = resolveAdminToken(config);
  let catalogCache = { version: null, etag: null, body: null };
  const staticCache = new Map();

  function isAdmin(req) {
    const header = req.headers.authorization || '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(adminToken);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  async function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
    const file = path.normalize(path.join(config.publicDir, rel));
    if (!file.startsWith(config.publicDir + path.sep)) throw new HttpError(403, 'Prohibido');
    let info;
    try {
      info = await stat(file);
    } catch {
      throw new HttpError(404, 'No encontrado');
    }
    if (!info.isFile()) throw new HttpError(404, 'No encontrado');
    let cached = staticCache.get(file);
    if (!cached || cached.mtime !== info.mtimeMs) {
      const data = await readFile(file);
      cached = { mtime: info.mtimeMs, data, etag: `"${createHash('sha1').update(data).digest('base64url').slice(0, 16)}"` };
      staticCache.set(file, cached);
    }
    const ext = path.extname(file);
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      etag: cached.etag,
      // Revalidación con ETag: barata (304) y garantiza que tras actualizar la web nadie se queda con JS/CSS antiguos.
      'cache-control': ext === '.svg' || ext === '.ico' ? 'public, max-age=86400' : 'no-cache',
    };
    if (req.headers['if-none-match'] === cached.etag) {
      res.writeHead(304, { ...SECURITY_HEADERS, ...headers });
      return res.end();
    }
    send(req, res, 200, cached.data, headers);
  }

  function catalogResponse(req, res) {
    const version = catalogVersion(db);
    if (catalogCache.version !== version) {
      const body = JSON.stringify(buildCatalog(db));
      catalogCache = { version, body, etag: `"cat-${version}-${createHash('sha1').update(body).digest('base64url').slice(0, 10)}"` };
    }
    const headers = { etag: catalogCache.etag, 'cache-control': 'no-cache' };
    if (req.headers['if-none-match'] === catalogCache.etag) {
      res.writeHead(304, { ...SECURITY_HEADERS, ...headers });
      return res.end();
    }
    send(req, res, 200, catalogCache.body, headers);
  }

  const bumpVersion = () => setSetting(db, 'catalog_version', String(Date.now()));

  async function adminApi(req, res, url) {
    if (!isAdmin(req)) throw new HttpError(401, 'Token de administración no válido');
    const p = url.pathname;

    if (p === '/api/admin/status' && req.method === 'GET') {
      return send(req, res, 200, adminStatus(db, { scheduler, tmdbConfigured: tmdb.configured, config }));
    }
    if (p === '/api/admin/sync' && req.method === 'POST') {
      const body = await readBody(req);
      if (scheduler.isRunning()) throw new HttpError(409, 'Ya hay una sincronización en curso');
      scheduler.trigger('manual', { force: body.force === true }).catch(() => {});
      return send(req, res, 202, { started: true });
    }
    if (p === '/api/admin/settings' && req.method === 'PUT') {
      const body = await readBody(req);
      const errors = [];
      const hours = Number(body.intervalHours);
      const threshold = Number(body.missingThreshold);
      if (!(hours >= 1 && hours <= 168)) errors.push('El intervalo debe estar entre 1 y 168 horas.');
      if (!(Number.isInteger(threshold) && threshold >= 1 && threshold <= 30)) errors.push('El umbral de ausencia debe ser un entero entre 1 y 30.');
      if (errors.length) throw new HttpError(400, errors.join(' '));
      setSetting(db, 'missing_threshold', threshold);
      scheduler.setInterval(hours);
      return send(req, res, 200, { ok: true, nextSyncAt: scheduler.nextRunAt()?.toISOString() ?? null });
    }
    if (p === '/api/admin/items' && req.method === 'GET') {
      return send(req, res, 200, { items: adminItems(db, url.searchParams.get('filter') || 'unidentified') });
    }
    if (p === '/api/admin/tmdb/preview' && req.method === 'GET') {
      if (!tmdb.configured) throw new HttpError(400, 'TMDB no está configurado en el servidor (TMDB_API_KEY).');
      const ref = parseTmdbRef(url.searchParams.get('ref'), url.searchParams.get('type'));
      if (!ref) throw new HttpError(400, 'Indica un ID numérico o una URL de themoviedb.org/movie/... o /tv/...');
      const data = ref.type === 'tv' ? await tmdb.tv(ref.id) : await tmdb.movie(ref.id);
      if (!data) throw new HttpError(404, `TMDB no tiene ${ref.type === 'tv' ? 'la serie' : 'la película'} con ID ${ref.id}`);
      const conflict = db.prepare('SELECT id, title FROM items WHERE tmdb_type = ? AND tmdb_id = ? AND id <> ?')
        .get(ref.type, ref.id, url.searchParams.get('itemId') || '');
      return send(req, res, 200, { ref, preview: { ...data, seasons: data.seasons.map((s) => ({ number: s.number, name: s.name, episodes: s.episodes.length })) }, conflict: conflict || null });
    }

    const m = /^\/api\/admin\/items\/([a-f0-9]{12})(\/link|\/refresh)?$/.exec(p);
    if (m) {
      const id = m[1];
      const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
      if (!row) throw new HttpError(404, 'Título no encontrado');

      if (m[2] === '/link' && req.method === 'POST') {
        if (!tmdb.configured) throw new HttpError(400, 'TMDB no está configurado en el servidor (TMDB_API_KEY).');
        const body = await readBody(req);
        const ref = parseTmdbRef(body.ref, body.type);
        if (!ref) throw new HttpError(400, 'Referencia de TMDB no válida');
        const conflict = db.prepare('SELECT id, title FROM items WHERE tmdb_type = ? AND tmdb_id = ? AND id <> ?').get(ref.type, ref.id, id);
        if (conflict && body.confirmMerge !== true) {
          throw new HttpError(409, `Ese título ya existe en el catálogo ("${conflict.title}"). Confirma la fusión para unirlos.`);
        }
        const data = ref.type === 'tv' ? await tmdb.tv(ref.id) : await tmdb.movie(ref.id);
        if (!data) throw new HttpError(404, 'TMDB no devolvió datos para ese ID');
        const result = applyEnrichment(db, id, data, { manual: true });
        bumpVersion();
        return send(req, res, 200, { ok: true, ...result, item: getItem(db, result.id) });
      }
      if (m[2] === '/refresh' && req.method === 'POST') {
        db.prepare('UPDATE items SET enriched_at = NULL WHERE id = ?').run(id);
        return send(req, res, 200, { ok: true, message: 'Se actualizará en la próxima sincronización.' });
      }
      if (!m[2] && req.method === 'PUT') {
        // Edición manual (cuando no hay TMDB o el título no existe allí).
        const body = await readBody(req);
        const errors = [];
        const title = String(body.title || '').trim();
        const year = body.year === '' || body.year == null ? null : Number(body.year);
        const overview = String(body.overview || '').trim() || null;
        const genres = Array.isArray(body.genres) ? [...new Set(body.genres.map((g) => String(g).trim()).filter(Boolean))].slice(0, 6) : [];
        if (!title) errors.push('El título es obligatorio.');
        if (title.length > 200) errors.push('El título no puede superar 200 caracteres.');
        if (year !== null && !(Number.isInteger(year) && year >= 1888 && year <= new Date().getFullYear() + 2)) errors.push('Año no válido.');
        if (overview && overview.length > 4000) errors.push('La descripción es demasiado larga (máx. 4000).');
        if (errors.length) throw new HttpError(400, errors.join(' '));
        const now = nowIso();
        transaction(db, () => {
          db.prepare(`UPDATE items SET title = ?, title_source = 'manual', year = ?, overview = ?, genres = ?, updated_at = ? WHERE id = ?`)
            .run(title, year, overview, JSON.stringify(genres), now, id);
        });
        bumpVersion();
        return send(req, res, 200, { ok: true, item: getItem(db, id) });
      }
    }
    throw new HttpError(404, 'Ruta no encontrada');
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/catalog' && (req.method === 'GET' || req.method === 'HEAD')) return catalogResponse(req, res);
      const im = /^\/api\/items\/([a-f0-9]{12})$/.exec(url.pathname);
      if (im && req.method === 'GET') {
        const item = getItem(db, im[1]);
        if (!item) throw new HttpError(404, 'Este título ya no está en el catálogo');
        return send(req, res, 200, item, { 'cache-control': 'no-cache' });
      }
      if (url.pathname === '/api/health') return send(req, res, 200, { ok: true });
      if (url.pathname.startsWith('/api/admin/')) return await adminApi(req, res, url);
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Ruta no encontrada');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido');
      return await serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log(`[http] ${req.method} ${url.pathname}: ${err.stack || err.message}`);
      send(req, res, status, { error: status >= 500 ? 'Error interno del servidor' : err.message });
    }
  };
}

export function start(config = defaultConfig) {
  const db = openDb(config.dbPath);
  const tmdb = createTmdb({ apiKey: config.tmdbApiKey, readToken: config.tmdbReadToken, language: config.tmdbLanguage });
  const log = (...a) => console.log(new Date().toLocaleString('es-ES'), ...a);
  const ctx = { db, config, tmdb, log };
  const scheduler = createScheduler(ctx);
  const server = http.createServer(createApp({ config, db, tmdb, scheduler, log }));
  server.listen(config.port, config.host, () => {
    log(`Cartelera en http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    log(`Panel de sincronización: http://localhost:${config.port}/admin`);
    if (!config.adminToken) log(`Token de admin en ${path.join(config.dataDir, 'admin-token.txt')}`);
    if (!tmdb.configured) log('TMDB no configurado: el catálogo mostrará solo los datos que publica la fuente (pósters, enlaces).');
    scheduler.start();
  });
  const shutdown = () => {
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { server, db, scheduler };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) start();
