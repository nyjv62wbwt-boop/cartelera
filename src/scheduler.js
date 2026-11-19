import { getSetting, setSetting } from './db.js';
import { runSync } from './sync.js';

const MAX_TIMEOUT = 2 ** 31 - 1;

/**
 * Programador en el propio servidor: no depende de que nadie tenga la web abierta.
 * El intervalo se guarda en la BD (modificable desde /admin) y sobrevive a reinicios.
 */
export function createScheduler(ctx) {
  const { db, config, log = console.log } = ctx;
  let timer = null;
  let running = null;

  const intervalHours = () => Number(getSetting(db, 'sync_interval_hours', config.syncIntervalHours));

  function nextRunAt() {
    const v = getSetting(db, 'next_sync_at');
    return v ? new Date(v) : null;
  }

  function schedule(at) {
    clearTimeout(timer);
    setSetting(db, 'next_sync_at', at.toISOString());
    const delay = Math.max(0, at.getTime() - Date.now());
    timer = setTimeout(() => (delay > MAX_TIMEOUT ? schedule(at) : trigger('scheduled')), Math.min(delay, MAX_TIMEOUT));
  }

  function planFromLastRun() {
    const last = getSetting(db, 'last_run_at');
    const due = last ? new Date(new Date(last).getTime() + intervalHours() * 3600e3) : new Date();
    if (!last && !config.syncOnStart) return schedule(new Date(Date.now() + intervalHours() * 3600e3));
    schedule(due < new Date() ? new Date(Date.now() + 5_000) : due);
  }

  async function trigger(kind = 'manual', opts = {}) {
    if (running) return running;
    running = (async () => {
      try {
        return await runSync(ctx, { trigger: kind, ...opts });
      } catch (err) {
        if (err.code === 'SYNC_RUNNING') log('[scheduler] otra sincronización (p. ej. npm run sync) está en curso');
        else log(`[scheduler] ${err.message}`);
        throw err;
      } finally {
        running = null;
        // Si la última falló del todo, reintento antes (1 h) sin esperar al intervalo completo.
        const lastStatus = db.prepare('SELECT status FROM sync_runs ORDER BY id DESC LIMIT 1').get()?.status;
        const hours = lastStatus === 'error' ? Math.min(1, intervalHours()) : intervalHours();
        if (!config.disableScheduler) schedule(new Date(Date.now() + hours * 3600e3));
      }
    })();
    return running;
  }

  return {
    start() {
      if (config.disableScheduler) return log('[scheduler] desactivado (DISABLE_SCHEDULER=true)');
      planFromLastRun();
      log(`[scheduler] próxima sincronización: ${nextRunAt()?.toLocaleString('es-ES')} (cada ${intervalHours()} h)`);
    },
    stop() {
      clearTimeout(timer);
    },
    trigger,
    isRunning: () => Boolean(running),
    nextRunAt,
    intervalHours,
    setInterval(hours) {
      setSetting(db, 'sync_interval_hours', hours);
      if (!config.disableScheduler) planFromLastRun();
    },
  };
}
