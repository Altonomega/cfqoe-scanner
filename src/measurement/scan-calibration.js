import { calibrateConcurrency } from './calibration.js';
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

export async function calibrateWebsocketConcurrency({
  candidates = [],
  vless,
  calibration = {},
  requestedConcurrency = 1,
  timeoutMs = 6000,
  probeTask = probeWebsocket,
  seed = 404,
} = {}) {
  const requested = positiveInteger(requestedConcurrency);
  if (calibration?.enabled === false) {
    return { enabled: false, selectedConcurrency: requested, requestedConcurrency: requested, reason: 'disabled', levels: [] };
  }
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { enabled: true, selectedConcurrency: requested, requestedConcurrency: requested, reason: 'no_candidates', levels: [] };
  }

  let control = null,
    controlProbes = 0;
  for (const candidate of shuffledCopy(candidates, seed).slice(0, CONTROL_HUNT_LIMIT)) {
    controlProbes += 1;
    const observation = await probeTask({ ip: candidate.ip, vless, timeoutMs });
    if (observation?.ok) {
      control = candidate;
      break;
    }
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

  const result = await calibrateConcurrency({
    levels,
    latencyInflationLimit: calibration?.latencyInflationLimit,
    // The settings value is the single source; the fallback keeps a
    // hand-built calibration object from reviving the pre-0.9.0 limit
    // that one dropped handshake could trip at every level.
    failureRateIncreaseLimit: calibration?.failureRateIncreaseLimit ?? DEFAULT_SETTINGS.calibration.failureRateIncreaseLimit,
    eventLoopLagLimitMs: calibration?.eventLoopLagLimitMs,
    controlTask: () => probeTask({ ip: control.ip, vless, timeoutMs }),
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
