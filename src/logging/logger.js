import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const UUID_PATTERN = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const VLESS_PATTERN = /vless:\/\/\S+/gi;
const SENSITIVE_KEYS = /^(id|uuid|password|token|secret|credential|authorization|uri|vless)$/i;

export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return value.replace(VLESS_PATTERN, '[REDACTED_VLESS_URI]').replace(UUID_PATTERN, '[REDACTED_UUID]');
  }
  if (typeof value === 'bigint') return value.toString();
  if (!value || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redact(item, seen);
  }
  return output;
}

// Schema v2 record shape: { v, time, elapsedMs, seq, runId, level,
// phase, event, ...details }. `seq` is a per-run monotonic counter so a
// truncated tail (kill mid-write) is detectable instead of silent;
// `elapsedMs` comes from a monotonic clock, so durations survive the
// wall clock jumping when a laptop sleeps; `phase` is stamped from the
// same phase state the checkpoint/UI use (see setPhase), so the log,
// the checkpoint and the screen can never disagree about where a run
// was. v1 files stay readable: summarizeLogFile tolerates their missing
// fields and reports the absence honestly.
export function createLogger({ level = 'info', directory = null, runId = randomUUID(), quiet = false } = {}) {
  let threshold = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  let filePath = null;
  let streamFailed = false;
  let seq = 0;
  let phase = null;
  const createdAtMs = performance.now();

  const counters = { debug: 0, info: 0, warn: 0, error: 0, fileErrors: 0 };

  if (directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    filePath = path.join(directory, `run-${runId}.ndjson`);
    stream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 });
    // A failed log stream must never kill a measurement: on error the
    // file sink disables itself, the failure is counted and mirrored to
    // stderr once, and logging continues as a no-op sink.
    stream.on('error', (error) => {
      if (streamFailed) return;
      streamFailed = true;
      counters.fileErrors += 1;
      if (!quiet) {
        process.stderr.write(
          `[error] log stream failed (${error.code || error.message}); file logging disabled for this run\n`,
        );
      }
    });
  }

  function write(levelName, event, details) {
    if ((LEVELS[levelName] ?? 0) < threshold) return;
    counters[levelName] += 1;
    seq += 1;
    const record = {
      v: 2,
      time: new Date().toISOString(),
      elapsedMs: Math.max(0, Math.round(performance.now() - createdAtMs)),
      seq,
      runId,
      level: levelName,
      phase,
      event,
      ...redact(details || {}),
    };
    if (stream && !streamFailed) stream.write(`${JSON.stringify(record)}\n`);
    if (!quiet && (levelName === 'warn' || levelName === 'error')) {
      process.stderr.write(`[${levelName}] ${event}\n`);
    }
  }

  return {
    runId,
    filePath,
    counters,
    debug: (event, details) => write('debug', event, details),
    info: (event, details) => write('info', event, details),
    warn: (event, details) => write('warn', event, details),
    error: (event, details) => write('error', event, details),
    // Entry points create the logger before settings exist (bootstrap),
    // then re-level it once the settings file has spoken.
    setLevel(name) {
      if (LEVELS[name] !== undefined) threshold = LEVELS[name];
    },
    // The run's current phase, stamped onto every subsequent record.
    // Callers pass the same vocabulary their checkpoint uses.
    setPhase(name) {
      phase = typeof name === 'string' && name ? name : null;
    },
    async close() {
      if (!stream || streamFailed) return;
      await new Promise((resolve) => {
        stream.once('error', resolve);
        stream.end(resolve);
      });
    },
  };
}

// Mirrors live progress events into the log as records — one definition
// for the terminal and the file. Cadence follows the standing ruling:
// every event lands at DEBUG; at INFO at most one record per
// ~infoIntervalMs per phase (phase-end summaries are separate records
// emitted by the stages themselves). The record payload is the numeric
// heart of the progress event: { completed, total, eligible, failed }.
export function createProgressRecorder(logger, { event, infoIntervalMs = 10000 } = {}) {
  const lastInfoAtByPhase = new Map();
  return (progress = {}) => {
    if (!logger || typeof logger.debug !== 'function') return;
    if (typeof logger.setPhase === 'function' && progress.phase) {
      logger.setPhase(progress.phase);
    }
    const details = {};
    for (const key of ['completed', 'total', 'eligible', 'failed']) {
      if (Number.isFinite(progress[key])) details[key] = progress[key];
    }
    logger.debug(event, details);
    if (typeof logger.info !== 'function') return;
    const key = progress.phase || event;
    const nowMs = Date.now();
    if (nowMs - (lastInfoAtByPhase.get(key) ?? Number.NEGATIVE_INFINITY) >= infoIntervalMs) {
      lastInfoAtByPhase.set(key, nowMs);
      logger.info(event, details);
    }
  };
}

export function summarizeLogFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const events = raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const byLevel = { debug: 0, info: 0, warn: 0, error: 0 };
  const errors = [];
  const slowest = [];

  for (const event of events) {
    if (byLevel[event.level] !== undefined) byLevel[event.level] += 1;
    if (event.level === 'error' || event.level === 'warn') {
      errors.push({ event: event.event, reason: event.error || event.reason || null });
    }
    if (Number.isFinite(event.durationMs)) {
      slowest.push({ event: event.event, durationMs: event.durationMs });
    }
  }

  slowest.sort((a, b) => b.durationMs - a.durationMs);

  // End-status honesty (the frozen-scan lesson): a run.end record is
  // the only proof a run finished. Without one, progress records still
  // say where the run was last seen; a v1 log has neither, and the
  // summary must say "no progress information" rather than guess.
  const runEnd = [...events].reverse().find((event) => event.event === 'run.end');
  const progressRecords = events.filter(
    (event) => typeof event.event === 'string' && event.event.endsWith('.progress'),
  );
  const lastProgress = progressRecords.at(-1) ?? null;
  const lastRecord = events.at(-1) ?? null;

  return {
    total: events.length,
    byLevel,
    errors: errors.slice(0, 20),
    slowest: slowest.slice(0, 10),
    runId: events[0]?.runId || null,
    hasRunStart: events.some((event) => event.event === 'run.start'),
    endStatus: runEnd
      ? (typeof runEnd.status === 'string' ? runEnd.status : 'completed')
      : lastProgress
        ? 'no-end-record'
        : 'no-progress-information',
    lastPhase: lastProgress?.phase ?? lastRecord?.phase ?? null,
    lastProgress: lastProgress
      ? {
          phase: lastProgress.phase ?? null,
          completed: lastProgress.completed ?? null,
          total: lastProgress.total ?? null,
          eligible: lastProgress.eligible ?? null,
          failed: lastProgress.failed ?? null,
        }
      : null,
    lastRecordAt: lastRecord?.time ?? null,
  };
}
