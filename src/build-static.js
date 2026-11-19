/**
 * Genera la versión estática de la web en dist/ para publicarla gratis (GitHub Pages u otro hosting estático).
 * Mismas rutas que el servidor: api/catalog y api/items/<id> son archivos JSON.
 * El panel /admin no se incluye (no hay servidor): su función la cubren GitHub Actions
 * (resumen de cada sincronización y botón "Run workflow").
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { openDb, parseJson } from './db.js';
import { buildCatalog, getItem } from './catalog.js';
import { stableId } from './parser.js';

const ADMIN_FILES = new Set(['admin.html', path.join('js', 'admin.js'), path.join('css', 'admin.css')]);
const out = path.resolve(process.argv[2] || path.join(config.root, 'dist'));

const db = openDb(config.dbPath);
try {
  rmSync(out, { recursive: true, force: true });
  cpSync(config.publicDir, out, {
    recursive: true,
    filter: (src) => !ADMIN_FILES.has(path.relative(config.publicDir, src)),
  });
  writeFileSync(path.join(out, '.nojekyll'), '');

  const catalog = buildCatalog(db);
  mkdirSync(path.join(out, 'api', 'items'), { recursive: true });
  writeFileSync(path.join(out, 'api', 'catalog'), JSON.stringify(catalog));

  let files = 0;
  for (const item of catalog.items) {
    writeFileSync(path.join(out, 'api', 'items', item.id), JSON.stringify(getItem(db, item.id)));
    files += 1;
  }
  // Identificadores antiguos de títulos fusionados (enlaces y favoritos guardados siguen funcionando).
  const visible = new Set(catalog.items.map((i) => i.id));
  for (const a of db.prepare('SELECT source_key, item_id FROM aliases').all()) {
    const oldId = stableId(a.source_key);
    if (visible.has(a.item_id) && !visible.has(oldId)) {
      writeFileSync(path.join(out, 'api', 'items', oldId), JSON.stringify(getItem(db, a.item_id)));
    }
  }
  console.log(`Web estática generada en ${out}: ${catalog.items.length} títulos, ${files} fichas.`);

  // Resumen visible en la pestaña Actions de GitHub (sustituye al panel de administración).
  if (process.env.GITHUB_STEP_SUMMARY) {
    const run = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
    const c = db.prepare(`SELECT SUM(type='movie' AND status<>'unavailable') m, SUM(type='tv' AND status<>'unavailable') s,
      SUM(status='missing') mi, SUM(status='unavailable') u,
      SUM(type IN ('movie','tv') AND status<>'unavailable' AND (title_source IS NULL OR title_source NOT IN ('tmdb','manual'))) ui FROM items`).get();
    const errors = parseJson(run?.errors, []);
    const details = parseJson(run?.details, {});
    const title = (id) => db.prepare('SELECT title FROM items WHERE id = ?').get(id)?.title || id;
    const lines = [
      '## Sincronización de la cartelera',
      '',
      '| Dato | Valor |', '|---|---|',
      `| Estado | ${run?.status ?? '—'} |`,
      `| Fecha | ${run?.finished_at ?? '—'} |`,
      `| Películas disponibles | ${c.m ?? 0} |`,
      `| Series disponibles | ${c.s ?? 0} |`,
      `| Nuevos | ${run?.new_count ?? 0} |`,
      `| Modificados | ${run?.updated_count ?? 0} |`,
      `| Ausentes / no disponibles | ${c.mi ?? 0} / ${c.u ?? 0} |`,
      `| Sin identificar | ${c.ui ?? 0} |`,
      '',
    ];
    if (details.newItems?.length) lines.push('### Nuevos', ...details.newItems.slice(0, 50).map((id) => `- ${title(id)}`), '');
    if (errors.length) lines.push('### Errores', ...errors.map((e) => `- ${e}`), '');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
} finally {
  db.close();
}
