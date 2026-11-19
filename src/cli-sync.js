/**
 * Sincronización puntual desde línea de comandos: `npm run sync` (añade `-- --force` para forzar).
 * Útil para programarla con el Programador de tareas de Windows o cron si el servidor no está siempre encendido.
 */
import { config } from './config.js';
import { openDb } from './db.js';
import { createTmdb } from './tmdb.js';
import { runSync } from './sync.js';

const db = openDb(config.dbPath);
const tmdb = createTmdb({ apiKey: config.tmdbApiKey, readToken: config.tmdbReadToken, language: config.tmdbLanguage });
const log = (...a) => console.log(new Date().toLocaleString('es-ES'), ...a);

try {
  const run = await runSync({ db, config, tmdb, log }, { trigger: 'cli', force: process.argv.includes('--force') });
  const errors = JSON.parse(run.errors);
  log(`Resultado: ${run.status}. Nuevos: ${run.new_count}, modificados: ${run.updated_count}, ausentes: ${run.missing_count}, no disponibles: ${run.unavailable_count}, enriquecidos: ${run.enriched_count}`);
  for (const e of errors) log(`  - ${e}`);
  process.exitCode = run.status === 'error' ? 1 : 0;
} catch (err) {
  log(err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
