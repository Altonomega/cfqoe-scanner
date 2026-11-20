// Pure allocation policy for the block-adaptive Hard Deep Scan engine.
//
// Everything here is a deterministic function of its inputs — no I/O, no
// catalog knowledge, no hidden state — so expansion decisions replay
// exactly from persisted per-block counters after a resume (spec:
// docs/HARD-SCAN-REDESIGN.md §4). Block states are plain objects owned by
// the caller:
//
//   { blockIndex, base, range, successes, attempts, probed, usable,
//     hardDead }
//
// `successes` / `attempts` are the effective counts (this run plus any
// decayed reputation prior); `probed` counts probes spent this run and is
// what the per-block depth cap applies to.
import { wilsonInterval, WILSON_Z } from './confidence.js';

export const DEFAULT_EXPLORATION = 1;
export const DEFAULT_WAVE_CHUNK = 4;
export const DEFAULT_RANGE_WAVE_CAP_FRACTION = 0.25;
export const RANGE_CAP_MIN_RANGES = 4;
export const DEFAULT_MAX_BLOCK_DEPTH = 32;
export const PARKED_INDEX_CEILING = 0.3;
export const PARKED_MIN_RUN_PROBES = 6;
export const DEFAULT_REQUIRED_LOW_GAIN_WAVES = 2;
export const DEFAULT_SPLIT_ALPHA = 0.05;
export const DEFAULT_SPLIT_MIN_EFFECT = 0.5;
export const DEFAULT_SPLIT_MIN_HALF_ATTEMPTS = 4;

// Wilson-UCB allocation index (spec §4.1): the upper end of the same
// Wilson interval the codebase ranks candidates by, so under-sampled
// blocks automatically carry an exploration bonus that decays with
// evidence. The exploration constant scales the interval's z: 1.0 is
// exactly the spec's 95% upper bound, 0 collapses the interval to the
// point estimate (pure exploitation). An unprobed block scores 1.
export function wilsonUcbIndex(successes, attempts, exploration = DEFAULT_EXPLORATION) {
  return wilsonInterval(successes, attempts, WILSON_Z * exploration).upper;
}

function compareRankedBlocks(left, right) {
  if (right.index !== left.index) return right.index - left.index;
  if (left.attempts !== right.attempts) return left.attempts - right.attempts;
  return left.base - right.base;
}

// Ranks block states for expansion (spec §4.1 tie-breaking: higher index,
// then fewer attempts, then lower base address). Returns new objects
// carrying `index`; the inputs are not mutated.
export function rankBlocks(blockStates, { exploration = DEFAULT_EXPLORATION } = {}) {
  return blockStates
    .map((state) => ({
      ...state,
      index: wilsonUcbIndex(state.successes, state.attempts, exploration),
    }))
    .sort(compareRankedBlocks);
}

function remainingDepth(state, maxDepth) {
  return Math.max(0, Math.min(state.usable, maxDepth) - state.probed);
}

export function isExpansionEligible(state, {
  threshold = 0,
  maxDepth = DEFAULT_MAX_BLOCK_DEPTH,
  exploration = DEFAULT_EXPLORATION,
} = {}) {
  if (state.hardDead) return false;
  if (remainingDepth(state, maxDepth) <= 0) return false;
  return wilsonUcbIndex(state.successes, state.attempts, exploration) >= threshold;
}

// Parked blocks (spec §4.4): with enough run evidence their upper bound
// already excludes the rates that produce finalists, so they yield to
// every eligible block — but parking is prioritisation, never deletion:
// they re-enter through the residual pass once eligible blocks drain.
function isParkedBlock(state) {
  return state.probed >= PARKED_MIN_RUN_PROBES && state.index < PARKED_INDEX_CEILING;
}

// Allocates one expansion wave (spec §4.2): eligible blocks are walked in
// index order in passes, each receiving a chunk of probes per pass so one
// hot block cannot consume the wave before other indices refresh. No
// catalog range receives more than `rangeCapFraction` of the wave unless
// fewer than RANGE_CAP_MIN_RANGES ranges have eligible blocks. Parked
// blocks are served only from what the eligible set leaves behind.
// Returns [{ blockIndex, probes }] in allocation priority order.
export function allocateWave(blockStates, {
  waveSize,
  chunk = DEFAULT_WAVE_CHUNK,
  rangeCapFraction = DEFAULT_RANGE_WAVE_CAP_FRACTION,
  threshold = 0,
  exploration = DEFAULT_EXPLORATION,
  maxDepth = DEFAULT_MAX_BLOCK_DEPTH,
} = {}) {
  if (!Number.isInteger(waveSize) || waveSize <= 0) return [];

  const eligible = [];
  const parked = [];
  for (const state of rankBlocks(blockStates, { exploration })) {
    if (state.hardDead || remainingDepth(state, maxDepth) <= 0) continue;
    if (threshold === 0 && isParkedBlock(state)) {
      parked.push(state);
    } else if (state.index >= threshold) {
      eligible.push(state);
    }
  }

  const eligibleRanges = new Set(eligible.map((state) => state.range));
  const rangeCapApplies = eligibleRanges.size >= RANGE_CAP_MIN_RANGES;
  const rangeCap = Math.ceil(rangeCapFraction * waveSize);

  const grants = new Map();
  const rangeSpent = new Map();
  let waveRemaining = waveSize;

  function grantPasses(candidates) {
    let progressed = true;
    while (waveRemaining > 0 && progressed) {
      progressed = false;
      for (const state of candidates) {
        if (waveRemaining <= 0) break;
        const alreadyGranted = grants.get(state.blockIndex) || 0;
        const depthRemaining = remainingDepth(state, maxDepth) - alreadyGranted;
        if (depthRemaining <= 0) continue;
        let grant = Math.min(chunk, depthRemaining, waveRemaining);
        if (rangeCapApplies) {
          const rangeRemaining = rangeCap - (rangeSpent.get(state.range) || 0);
          if (rangeRemaining <= 0) continue;
          grant = Math.min(grant, rangeRemaining);
        }
        if (grant <= 0) continue;
        grants.set(state.blockIndex, alreadyGranted + grant);
        rangeSpent.set(state.range, (rangeSpent.get(state.range) || 0) + grant);
        waveRemaining -= grant;
        progressed = true;
      }
    }
  }

  grantPasses(eligible);
  if (waveRemaining > 0) grantPasses(parked);

  return [...eligible, ...parked]
    .filter((state) => (grants.get(state.blockIndex) || 0) > 0)
    .map((state) => ({ blockIndex: state.blockIndex, probes: grants.get(state.blockIndex) }));
}

// Total budget cap (spec §4.5): primer + expansion probes across the run.
export function isBudgetExhausted({ probesSpent, budgetProbes }) {
  return probesSpent >= budgetProbes;
}

// Marginal-gain stop (spec §4.5): expansion ends when the best remaining
// block index stays below the pool threshold for `requiredLowWaves`
// consecutive waves — the hysteresis guards against stopping on one
// unlucky wave. Feed the returned streak into the next wave's call.
export function evaluateMarginalGain({
  bestIndex,
  threshold,
  consecutiveLowWaves = 0,
  requiredLowWaves = DEFAULT_REQUIRED_LOW_GAIN_WAVES,
}) {
  const lowGain = bestIndex < threshold;
  const streak = lowGain ? consecutiveLowWaves + 1 : 0;
  return {
    lowGain,
    consecutiveLowWaves: streak,
    shouldStop: streak >= requiredLowWaves,
  };
}

function clampCount(successes, attempts) {
  const total = Math.max(0, Math.floor(Number(attempts) || 0));
  const succeeded = Math.max(0, Math.min(total, Math.floor(Number(successes) || 0)));
  return { successes: succeeded, attempts: total };
}

function logChoose(total, choose) {
  if (choose < 0 || choose > total) return Number.NEGATIVE_INFINITY;
  const smaller = Math.min(choose, total - choose);
  let sum = 0;
  for (let step = 1; step <= smaller; step += 1) {
    sum += Math.log((total - smaller + step) / step);
  }
  return sum;
}

// Two-sided Fisher exact p-value for the 2×2 table of a block's two
// halves: the probability, under the halves sharing one success rate, of
// every table with the observed margins at most as likely as the observed
// one. Computed in log space so reputation-fed counts cannot overflow.
export function fisherExactTwoSided({
  lowerSuccesses, lowerAttempts, upperSuccesses, upperAttempts,
}) {
  const lower = clampCount(lowerSuccesses, lowerAttempts);
  const upper = clampCount(upperSuccesses, upperAttempts);
  if (lower.attempts === 0 || upper.attempts === 0) return 1;
  const totalSuccesses = lower.successes + upper.successes;
  const totalAttempts = lower.attempts + upper.attempts;
  const logProbability = (lowerHalfSuccesses) => logChoose(lower.attempts, lowerHalfSuccesses)
    + logChoose(upper.attempts, totalSuccesses - lowerHalfSuccesses)
    - logChoose(totalAttempts, totalSuccesses);
  const observedLog = logProbability(lower.successes);
  const minimum = Math.max(0, totalSuccesses - upper.attempts);
  const maximum = Math.min(lower.attempts, totalSuccesses);
  let pValue = 0;
  for (let candidate = minimum; candidate <= maximum; candidate += 1) {
    const candidateLog = logProbability(candidate);
    if (candidateLog <= observedLog + 1e-9) pValue += Math.exp(candidateLog);
  }
  return Math.min(1, pValue);
}

// Heterogeneity split predicate (spec §5.2): both halves carry enough
// observations, their rates differ by at least the effect floor, and the
// Fisher test rejects a shared rate at alpha. The floor exists because at
// larger n Fisher alone flags differences too small to matter — the guard
// is for gross heterogeneity only. Structural conditions (usable size,
// split depth) are the caller's check, via candidate/blocks.js.
export function shouldSplitBlock(halves, {
  alpha = DEFAULT_SPLIT_ALPHA,
  minEffect = DEFAULT_SPLIT_MIN_EFFECT,
  minHalfAttempts = DEFAULT_SPLIT_MIN_HALF_ATTEMPTS,
} = {}) {
  const { lowerSuccesses, lowerAttempts, upperSuccesses, upperAttempts } = halves;
  if (lowerAttempts < minHalfAttempts || upperAttempts < minHalfAttempts) return false;
  const lowerRate = lowerSuccesses / lowerAttempts;
  const upperRate = upperSuccesses / upperAttempts;
  if (Math.abs(lowerRate - upperRate) < minEffect) return false;
  return fisherExactTwoSided(halves) <= alpha;
}
