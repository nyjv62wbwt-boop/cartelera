import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile) && !process.env.CARTELERA_SKIP_ENV_FILE) process.loadEnvFile(envFile);

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir: path.join(ROOT, 'data'),
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',
  dbPath: process.env.DB_PATH || path.join(ROOT, 'data', 'catalog.db'),
  sourceBaseUrl: (process.env.SOURCE_BASE_URL || 'https://novedadestaquillas.cajondecontenido.appboxes.co/').replace(/\/?$/, '/'),
  syncIntervalHours: num(process.env.SYNC_INTERVAL_HOURS, 12),
  missingThreshold: num(process.env.MISSING_THRESHOLD, 2),
  syncRetries: num(process.env.SYNC_RETRIES, 3),
  retryDelayMs: num(process.env.SYNC_RETRY_DELAY_MS, 60_000),
  syncOnStart: process.env.SYNC_ON_START !== 'false',
  disableScheduler: process.env.DISABLE_SCHEDULER === 'true',
  tmdbApiKey: process.env.TMDB_API_KEY || '',
  tmdbReadToken: process.env.TMDB_READ_TOKEN || '',
  tmdbLanguage: process.env.TMDB_LANGUAGE || 'es-ES',
  enrichRefreshDays: num(process.env.ENRICH_REFRESH_DAYS, 7),
  adminToken: process.env.ADMIN_TOKEN || '',
  userAgent: 'CarteleraSync/1.0 (catalog mirror, low-frequency polling)',
};

/** Categorías originales de la web de origen, en el orden de su menú. */
export const CATEGORIES = [
  { key: 'taquillazo', page: 'taquillazo.html', label: 'Taquillazo', itemType: 'sala' },
  { key: 'taquillas', page: 'taquillas.html', label: 'Taquillas', itemType: 'movie' },
  { key: 'infantiles', page: 'infantiles.html', label: 'Infantiles', itemType: 'movie' },
  { key: 'series', page: 'series.html', label: 'Series', itemType: 'tv' },
];
