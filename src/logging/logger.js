import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIB = 1024 * 1024;

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
// The live-stream ring: a late subscriber (a browser opening the
// diagnostics tail mid-run, a reconnect) replays the tail of the run
// from here instead of from the file. Bounded, oldest evicted first.
export const LOG_RING_LIMIT = 1000;

// Retention policy (Signal §3.5): one NDJSON file per run, kept
// forever, is a slow storage leak — a single debug Hard run is
// 20–30 MB, and on Termux that is internal storage the user cannot
// see shrinking. Enforced once at logger creation, never mid-run:
// keep the newest `maxFiles` run files AND a total size cap,
// whichever bites first; the smaller Android cap reflects Termux
// storage reality (the platform signal is the same one settings
// use). The numbers live here, in one constant, so the policy is
// tunable without touching a call site.
export const LOG_RETENTION = {
  maxFiles: 20,
  maxBytesDesktop: 50 * MIB,
  maxBytesAndroid: 20 * MIB,
};

const RUN_LOG_NAME = /^run-.+\.ndjson$/;

// Prune a logs directory to the retention policy. `currentFile` (the
// just-created run's own log) is never deleted and counts against
// both budgets first. Everything about pruning is best-effort: a
// file that cannot be stat'ed or removed is simply left behind —
// log hygiene must never break a run. Returns what was removed, for
// tests and for callers that want to say so.
export function pruneRunLogs(directory, { currentFile = null, platform = process.platform } = {}) {
  const removed = [];
  if (!directory) return removed;
  const maxBytes = platform === 'android' ? LOG_RETENTION.maxBytesAndroid : LOG_RETENTION.maxBytesDesktop;
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return removed;
  }
  const files = [];
  for (const name of entries) {
    if (!RUN_LOG_NAME.test(name)) continue;
    const filePath = path.join(directory, name);
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) files.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Vanished between listing and stat: not ours to chase.
    }
  }
  // Newest first; the name breaks mtime ties so the outcome never
  // depends on readdir order.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.filePath < b.filePath ? 1 : -1));
  // The current run's file reserves its place in both budgets before
  // the walk: it is kept unconditionally, and everything else competes
  // for what remains. The reservation holds even when the file is not
  // on disk yet — a write stream creates its file lazily, and pruning
  // runs at logger creation, before the first record lands.
  let keptCount = 0;
  let keptBytes = 0;
  const currentIndex = currentFile === null
    ? -1
    : files.findIndex((file) => file.filePath === currentFile);
  if (currentIndex >= 0) {
    keptCount = 1;
    keptBytes = files[currentIndex].size;
    files.splice(currentIndex, 1);
  } else if (currentFile !== null) {
    keptCount = 1;
  }
  for (const file of files) {
    if (keptCount < LOG_RETENTION.maxFiles && keptBytes + file.size <= maxBytes) {
      keptCount += 1;
      keptBytes += file.size;
      continue;
    }
    try {
      fs.rmSync(file.filePath, { force: true });
      removed.push(file.filePath);
    } catch {
      // Pruning failures are ignored by design (see above).
    }
  }
  return removed;
}

export function createLogger({ level = 'info', directory = null, runId = randomUUID(), quiet = false } = {}) {
  let threshold = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  let filePath = null;
  let streamFailed = false;
  let seq = 0;
  let phase = null;
  const createdAtMs = performance.now();
  const subscribers = new Set();
  const ring = [];

  const counters = { debug: 0, info: 0, warn: 0, error: 0, fileErrors: 0 };

  if (directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    filePath = path.join(directory, `run-${runId}.ndjson`);
    stream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 });
    // Retention is enforced here, once, at creation (Signal §3.5):
    // every run start leaves the logs directory within policy, and
    // the file just opened for this run is the one file pruning may
    // never take. Best-effort by contract — pruneRunLogs swallows
    // its own failures, and this call must never break a logger.
    try {
      pruneRunLogs(directory, { currentFile: filePath });
    } catch {
      // Ignored: retention is hygiene, not a run prerequisite.
    }
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
    // The envelope is stamped AFTER the details spread, on purpose:
    // the identity fields (runId, level, event, seq, time) are the
    // logger's own facts and must win over a detail key of the same
    // name. Several call sites pass the run's id as a detail ({ runId }
    // on scan.start / web.control.scan-start); with the spread last,
    // that value — UUID-shaped, so redact() rewrites it — replaced the
    // record's real runId with "[REDACTED_UUID]", and the log's records
    // stopped agreeing about which run they belong to. Detail values
    // are still fully redacted; only the collision is removed.
    const record = {
      ...redact(details || {}),
      v: 2,
      time: new Date().toISOString(),
      elapsedMs: Math.max(0, Math.round(performance.now() - createdAtMs)),
      seq,
      runId,
      level: levelName,
      phase,
      event,
    };
    if (stream && !streamFailed) stream.write(`${JSON.stringify(record)}\n`);
    if (!quiet && (levelName === 'warn' || levelName === 'error')) {
      process.stderr.write(`[${levelName}] ${event}\n`);
    }
    // Sink C: live subscribers (the web UI's SSE bridge). Fan-out is
    // fire-and-forget and happens after redaction, so a subscriber
    // sees exactly what the file sees — never more. A subscriber that
    // throws is unsubscribed on the spot: a broken observer must
    // never slow, corrupt, or kill a measurement.
    ring.push(record);
    if (ring.length > LOG_RING_LIMIT) ring.splice(0, ring.length - LOG_RING_LIMIT);
    if (subscribers.size > 0) {
      for (const subscriber of [...subscribers]) {
        if ((LEVELS[levelName] ?? 0) < subscriber.minLevel) continue;
        try {
          subscriber.fn(record);
        } catch {
          subscribers.delete(subscriber);
        }
      }
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
    // Live-stream sink (LOGGING §3.3): fn receives every subsequent
    // record at or above minLevel, redacted, in write order — the
    // same objects the file sink serializes. Returns an idempotent
    // unsubscribe. Replay of what came before is `recent()` below.
    subscribe(fn, { minLevel = 'debug' } = {}) {
      if (typeof fn !== 'function') return () => {};
      const subscriber = { fn, minLevel: LEVELS[minLevel] ?? LEVELS.debug };
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    // The newest records still in the ring (oldest first), for late
    // subscribers and reconnect replay. A copy: callers may not mutate
    // the buffer the logger keeps writing into.
    recent(limit = LOG_RING_LIMIT) {
      const count = Math.max(0, Math.min(Math.floor(limit) || 0, ring.length));
      return ring.slice(ring.length - count);
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

// -- Run digest ------------------------------------------------------
// summarizeLogFile reads a run log as a stream of records — chunk by
// chunk, one parsed line at a time — never the whole file into
// memory (Signal §3.4: a debug Hard log is 20–30 MB, and Diagnostics
// runs this on the newest file by default). The StringDecoder keeps
// multi-byte characters intact across chunk boundaries.

const LOG_READ_CHUNK_BYTES = 64 * 1024;

export function eachLogRecord(filePath, visit) {
  const fd = fs.openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(LOG_READ_CHUNK_BYTES);
  let pending = '';
  const handleLine = (line) => {
    if (!line.trim()) return;
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      return; // A torn tail line (kill mid-write) is skipped, not fatal.
    }
    if (record && typeof record === 'object') visit(record);
  };
  try {
    let position = 0;
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        handleLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.end();
    if (pending.trim()) handleLine(pending);
  } finally {
    fs.closeSync(fd);
  }
}

function errorReason(record) {
  if (typeof record.error === 'string') return record.error;
  if (record.error && typeof record.error.message === 'string') return record.error.message;
  return typeof record.reason === 'string' ? record.reason : null;
}

export function summarizeLogFile(filePath) {
  const byLevel = { debug: 0, info: 0, warn: 0, error: 0 };
  const errors = [];
  const slowest = [];
  let total = 0;
  let runId = null;
  let runStart = null;
  let runEnd = null;
  let calibration = null;
  let reputationLoaded = null;
  let reputationSaved = null;
  let lastProgress = null;
  let lastRecord = null;
  // Per-phase rows for the digest's timing table, in first-seen
  // order: where the run spent its time, from the progress records
  // alone (the same heartbeat the frozen-scan fix put in the file).
  const phaseRows = new Map();

  eachLogRecord(filePath, (record) => {
    total += 1;
    if (runId === null && typeof record.runId === 'string') runId = record.runId;
    if (byLevel[record.level] !== undefined) byLevel[record.level] += 1;
    if ((record.level === 'error' || record.level === 'warn') && errors.length < 20) {
      errors.push({ event: record.event, reason: errorReason(record) });
    }
    if (Number.isFinite(record.durationMs)) {
      slowest.push({ event: record.event, durationMs: record.durationMs });
      if (slowest.length > 10) {
        slowest.sort((a, b) => b.durationMs - a.durationMs);
        slowest.length = 10;
      }
    }
    if (record.event === 'run.start' && runStart === null) runStart = record;
    if (record.event === 'run.end') runEnd = record;
    if (record.event === 'scan.calibration' || record.event === 'hard.calibration') {
      calibration = {
        selectedConcurrency: record.selectedConcurrency ?? null,
        requestedConcurrency: record.requestedConcurrency ?? null,
        reason: record.reason ?? null,
        controlIp: record.controlIp ?? null,
      };
    }
    if (record.event === 'hard.reputation.loaded') {
      reputationLoaded = record.records ?? null;
    }
    if (record.event === 'hard.reputation.saved') {
      reputationSaved = record.blocks ?? null;
    }
    if (typeof record.event === 'string' && record.event.endsWith('.progress')) {
      lastProgress = record;
      if (typeof record.phase === 'string' && record.phase) {
        let row = phaseRows.get(record.phase);
        if (!row) {
          row = {
            phase: record.phase,
            firstElapsedMs: Number.isFinite(record.elapsedMs) ? record.elapsedMs : null,
            lastElapsedMs: null,
            firstTimeMs: Date.parse(record.time) || null,
            lastTimeMs: null,
            completed: null,
            total: null,
            eligible: null,
            failed: null,
          };
          phaseRows.set(record.phase, row);
        }
        if (Number.isFinite(record.elapsedMs)) row.lastElapsedMs = record.elapsedMs;
        const timeMs = Date.parse(record.time);
        if (Number.isFinite(timeMs)) row.lastTimeMs = timeMs;
        row.completed = record.completed ?? row.completed;
        row.total = record.total ?? row.total;
        row.eligible = record.eligible ?? row.eligible;
        row.failed = record.failed ?? row.failed;
      }
    }
    lastRecord = record;
  });

  slowest.sort((a, b) => b.durationMs - a.durationMs);

  const phases = [...phaseRows.values()].map((row) => ({
    phase: row.phase,
    durationMs:
      row.firstElapsedMs !== null && row.lastElapsedMs !== null
        ? Math.max(0, row.lastElapsedMs - row.firstElapsedMs)
        : row.firstTimeMs !== null && row.lastTimeMs !== null
          ? Math.max(0, row.lastTimeMs - row.firstTimeMs)
          : null,
    completed: row.completed,
    total: row.total,
    eligible: row.eligible,
    failed: row.failed,
  }));

  // End-status honesty (the frozen-scan lesson): a run.end record is
  // the only proof a run finished. Without one, progress records still
  // say where the run was last seen; a v1 log has neither, and the
  // summary must say "no progress information" rather than guess.
  return {
    total,
    byLevel,
    errors,
    slowest: slowest.slice(0, 10),
    runId,
    hasRunStart: runStart !== null,
    mode: runStart?.mode ?? null,
    appVersion: runStart?.appVersion ?? null,
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
    phases,
    // The digest joins the lifecycle record with the verdicts the
    // engines recorded separately (W1 gate C4): run.start alone does
    // not carry calibration or reputation, so triage reads them from
    // their own records here instead of hunting the raw file.
    calibration,
    reputation:
      reputationLoaded !== null || reputationSaved !== null
        ? { recordsLoaded: reputationLoaded, blocksSaved: reputationSaved }
        : null,
  };
}

// Plain-words rendering of the digest's end status — the words-not-
// codes rule: a status code is for machines, the Diagnostics reader
// gets the sentence.
export function endStatusText(endStatus) {
  switch (endStatus) {
    case 'completed':
      return 'completed';
    case 'canceled':
      return 'canceled';
    case 'failed':
      return 'failed';
    case 'no-end-record':
      return 'no end record — the run was killed, crashed, or is still running';
    case 'no-progress-information':
      return 'no progress information in this log';
    default:
      return typeof endStatus === 'string' && endStatus ? endStatus : 'unknown';
  }
}

// The digest lines both terminal Diagnostics surfaces print (menu +
// `cfqoe diagnose` share this so the two can never drift apart): end
// status in words, where the run was last seen, and the calibration
// verdict when the log carries one.
export function digestLines(summary) {
  const lines = [`End status: ${endStatusText(summary.endStatus)}`];
  const progress = summary.lastProgress;
  if (progress && (progress.completed !== null || progress.total !== null)) {
    const counts = [
      progress.eligible !== null ? `${progress.eligible} eligible` : null,
      progress.failed !== null ? `${progress.failed} failed` : null,
    ].filter(Boolean);
    lines.push(
      `Last progress: ${progress.phase ?? 'unknown phase'} — ${progress.completed ?? '?'}/${progress.total ?? '?'}${counts.length ? ` (${counts.join(', ')})` : ''}`,
    );
  }
  if (summary.calibration && summary.calibration.selectedConcurrency !== null) {
    lines.push(
      `Calibration: concurrency ${summary.calibration.selectedConcurrency} selected${summary.calibration.reason ? ` (${summary.calibration.reason})` : ''}`,
    );
  }
  return lines;
}
