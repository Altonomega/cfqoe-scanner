import { calibrateConcurrency } from './calibration.js';
import { abortReason, throwIfAborted } from './abort.js';
import { probeWebsocket } from '../probe/websocket.js';
import { mulberry32 } from '../random.js';
import { DEFAULT_SETTINGS } from '../config/settings.js';

// The control hunt's probe cap. On a heavily filtered path ~90% of
// candidates can be dead; the old hunt — the first 8 sampled candidates,
// in order — then found no working control ~43% of the time and
// calibration silently no-oped exactly where the concurrency choice
// matters most. The hunt now walks a shuffled copy of the pool (a dead
// cluster at the head of the sample cannot starve it) and stops at the
// first success, at most CONTROL_HUNT_LIMIT probes.
const CONTROL_HUNT_LIMIT = 32;

// How many hunt probes fly at once. The cap above is the coverage and
// stays; what changed is the overlap. Sequentially, a blackhole path
// burned one full probe timeout per candidate — 32 × 6 s ≈ 192 s of
// dead time before the scan even started. In batches of 8 the same
// shuffled pool and the same cap cost at most ⌈32 / 8⌉ = 4 timeout
// rounds (≈ 24 s at the 6 s default) when every candidate blackholes,
// and a healthy path still answers on the first batch. Eight one-shot
// handshakes is far below the concurrency the scan itself is about to
// run, so the overlap cannot distort the ladder that follows.
const CONTROL_HUNT_BATCH = 8;

function positiveInteger(value, fallback = 1) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function shuffledCopy(items, seed) {
  const copy = items.slice(),
    random = mulberry32(seed);
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

// Runs one batch of hunt probes concurrently and resolves with the
// first candidate whose probe succeeds — in completion order, so the
// control is the most responsive working candidate of the batch — or
// null once every probe in the batch has settled without one. Each
// settled attempt counts on onAttempt as it lands; the moment the
// batch has an answer (a success, exhaustion, or an abort) the rest
// are abandoned: their handlers stay attached, so a late settlement
// can neither count, nor change the answer, nor surface unhandled.
// An abort rejects with the abort reason instead of waiting out the
// batch, so a stop lands immediately, not one timeout later.
function probeHuntBatch(batch, { vless, timeoutMs, probeTask, signal, onAttempt }) {
  return new Promise((resolve, reject) => {
    let remaining = batch.length,
      settled = false;
    const finish = (complete, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      complete(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const onObservation = (candidate, observation) => {
      if (settled) return;
      onAttempt();
      if (observation?.ok) finish(resolve, candidate);
      else if ((remaining -= 1) === 0) finish(resolve, null);
    };
    for (const candidate of batch) {
      let attempt = null;
      try {
        attempt = probeTask({ ip: candidate.ip, vless, timeoutMs });
      } catch {
        // A synchronously throwing probe is a failed attempt, counted
        // through the same path as an asynchronous failure below.
        attempt = null;
      }
      Promise.resolve(attempt).then(
        (observation) => onObservation(candidate, observation),
        () => onObservation(candidate, null),
      );
    }
  });
}

export async function calibrateWebsocketConcurrency({
  candidates = [],
  vless,
  calibration = {},
  requestedConcurrency = 1,
  timeoutMs = 6000,
  probeTask = probeWebsocket,
  seed = 404,
  // Optional cancel token (AbortSignal-shaped): an abort anywhere in
  // the hunt or the ladder fails the whole calibration with an
  // AbortError. An aborted calibration is NOT a verdict — callers
  // must not record it as one (no selected concurrency, no
  // no-control warning); the run simply ends canceled.
  signal = null,
  // Optional progress observer: the control hunt reports first
  // ({ completed, total, hunt: true } — an announcement at 0, then one
  // per attempt), then the ladder observer forwarded from
  // calibrateConcurrency: one { completed: 0, total } announcement
  // when the ladder size is known, then { completed, total, level,
  // accepted } per level.
  onProgress = null,
} = {}) {
  // Abort outranks every verdict below, including disabled and
  // no-candidates: a stopped run measured nothing.
  throwIfAborted(signal);
  const requested = positiveInteger(requestedConcurrency);
  if (calibration?.enabled === false) {
    return { enabled: false, selectedConcurrency: requested, requestedConcurrency: requested, reason: 'disabled', levels: [] };
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { enabled: true, selectedConcurrency: requested, requestedConcurrency: requested, reason: 'no_candidates', levels: [] };
  }

  let control = null,
    controlProbes = 0;
  const huntPool = shuffledCopy(candidates, seed).slice(0, CONTROL_HUNT_LIMIT);
  // The hunt announces itself before the first probe and counts each
  // attempt on the same channel the ladder uses below: on a blackhole
  // path every probe burns its full timeout, so an unannounced hunt
  // is a long stretch of silence in the UI and the log —
  // indistinguishable from a hang. Hunt events carry `hunt: true` so
  // consumers can tell them from the ladder counts that follow once
  // a control exists.
  // Attempts are counted as they complete (controlProbes likewise):
  // with batches in flight, started-but-abandoned probes are not
  // attempts made, and the count stops the moment the hunt does.
  onProgress?.({ completed: 0, total: huntPool.length, hunt: true });
  for (let offset = 0; offset < huntPool.length && !control; offset += CONTROL_HUNT_BATCH) {
    throwIfAborted(signal);
    control = await probeHuntBatch(huntPool.slice(offset, offset + CONTROL_HUNT_BATCH), {
      vless,
      timeoutMs,
      probeTask,
      signal,
      onAttempt: () => {
        controlProbes += 1;
        onProgress?.({ completed: controlProbes, total: huntPool.length, hunt: true });
      },
    });
  }
  if (!control) {
    return { enabled: true, selectedConcurrency: requested, requestedConcurrency: requested, reason: 'no_working_control', levels: [], controlProbes };
  }

  const configuredLevels = Array.isArray(calibration?.levels) ? calibration.levels : DEFAULT_SETTINGS.calibration.levels;
  const levels = [...new Set([
    1,
    ...configuredLevels.map(Number).filter((value) => Number.isInteger(value) && value > 0 && value <= requested),
    requested,
  ])].sort((a, b) => a - b);

  // The ladder size is known only now; announce it before the first
  // level so progress has a denominator from the start.
  onProgress?.({ completed: 0, total: levels.length });
  const result = await calibrateConcurrency({
    levels,
    latencyInflationLimit: calibration?.latencyInflationLimit,
    // The settings value is the single source; the fallback keeps a
    // hand-built calibration object from reviving the pre-0.9.0 limit
    // that one dropped handshake could trip at every level.
    failureRateIncreaseLimit: calibration?.failureRateIncreaseLimit ?? DEFAULT_SETTINGS.calibration.failureRateIncreaseLimit,
    eventLoopLagLimitMs: calibration?.eventLoopLagLimitMs,
    controlTask: () => probeTask({ ip: control.ip, vless, timeoutMs }),
    signal,
    onProgress,
  });

  return {
    enabled: true,
    requestedConcurrency: requested,
    selectedConcurrency: Math.min(requested, positiveInteger(result.selectedConcurrency)),
    controlIp: control.ip,
    reason: 'measured',
    controlProbes,
    baseline: result.baseline,
    levels: result.levels,
  };
}
