import { VERSION } from '../version.js';
import { SETTINGS_VERSION } from '../config/settings.js';

// Run lifecycle records, emitted by the entry points (menu/CLI) around
// every scan run. run.start opens the run's story with the facts
// triage needs first — which build, which platform, which mode — and
// run.end closes it with an explicit status. A log whose seq stops
// mid-phase with no run.end IS the abnormal-termination signal; the
// diagnostics summarizer reads exactly that (see summarizeLogFile).
export function emitRunStart(logger, { mode, resume = false } = {}) {
  if (!logger || typeof logger.info !== 'function') return;
  logger.info('run.start', {
    appVersion: VERSION,
    platform: `${process.platform}-${process.arch}`,
    nodeVersion: process.version,
    settingsVersion: SETTINGS_VERSION,
    mode,
    resume,
  });
}

export function emitRunEnd(logger, { status, startedAt, totals = {}, error = null } = {}) {
  if (!logger || typeof logger.info !== 'function') return;
  logger.info('run.end', {
    status,
    durationMs: Math.max(0, Date.now() - startedAt),
    // Snapshot before this record is written: run.end reports the
    // counters of everything that came before it, not of itself.
    counters: { ...(logger.counters || {}) },
    ...totals,
    ...(error ? { error } : {}),
  });
}
