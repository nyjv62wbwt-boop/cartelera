import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.CARTELERA_SKIP_ENV_FILE = '1';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const fixture = (name) => readFileSync(path.join(dir, `${name}.html`), 'utf8');

export const BASE = 'https://fuente.test/';

export function testConfig(overrides = {}) {
  return {
    sourceBaseUrl: BASE,
    userAgent: 'test',
    syncRetries: 2,
    retryDelayMs: 1,
    missingThreshold: 2,
    enrichRefreshDays: 7,
    syncIntervalHours: 12,
    disableScheduler: true,
    dataDir: path.join(dir, '..', '.tmp'),
    adminToken: 'secreto-de-prueba',
    publicDir: path.join(dir, '..', '..', 'public'),
    ...overrides,
  };
}

/**
 * fetch simulado que sirve las páginas de la fuente. `pages` permite sustituir el HTML de una página,
 * o devolver un error (`{ status: 500 }` / `{ throws: true }`).
 */
export function fakeSource(pages = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const name = String(url).replace(BASE, '').replace('.html', '');
    calls.push({ name, headers: opts.headers || {} });
    const override = pages[name];
    if (override?.throws) throw new TypeError('fetch failed');
    if (override?.status) return new Response('error', { status: override.status });
    const html = typeof override === 'string' ? override : fixture(name);
    const etag = `"${name}-${html.length}"`;
    if (opts.headers?.['if-none-match'] === etag) return new Response(null, { status: 304 });
    return new Response(html, { status: 200, headers: { etag, 'last-modified': 'Tue, 17 Nov 2026 19:05:48 GMT' } });
  };
  fn.calls = calls;
  return fn;
}

/** Quita del HTML la tarjeta que contiene `needle`. */
export function removeCard(html, needle) {
  const i = html.indexOf(needle);
  const start = html.lastIndexOf('<div class="movie">', i);
  const end = html.indexOf('</div>', i) + 6;
  return html.slice(0, start) + html.slice(end);
}
