// Block-adaptive screening engine for Hard Deep Scan (DNA redesign, spec:
// docs/HARD-SCAN-REDESIGN.md; engineering annex: docs/HARD-SCAN-ENGINEERING.md
// §2.1). The engine orchestrates only: it builds per-block run state over a
// block plan (candidate/blocks.js), lets cross-run reputation
// (hard-reputation.js) set each block's primer depth, runs the primer phase
// (§3), then the split-coverage pass (docs/HARD-SCAN-5B-ANALYSIS.md §6),
// then expansion waves allocated by the pure bandit policy
// (measurement/bandit.js, §4) with heterogeneity splits (§5), and assembles
// the finalist pool (§6.1). Statistics live in bandit.js, block geometry in
// blocks.js, persistence in hard-reputation.js — none of that logic is
// duplicated here.
//
// Probing goes through the injected `task(candidate, round)` seam and the
// shared scheduler (hard-scheduler.js, reused exactly as-is), with the same
// contract hard-scan.js uses today: candidates are probed in batches of
// `concurrency` with `hard.screeningRounds` rounds, every result is
// summarised by buildEligibilitySummary and handed to `onSummary`, and the
// delayed-retry selection runs per batch exactly as the legacy sweep feeds
// it. Wave C wiring is therefore a dispatch change, not a rewrite.
//
// Every governed value comes from settings.hard.* and is passed into the
// Wave A modules as options — including hard.maxDepthPerBlock, which is
// handed to every bandit call site and used for the engine's own depth-cap
// arithmetic, so the cap has exactly one runtime source. The engine is
// deterministic: same seed + same probe outcomes => identical traversal,
// because allocation is a pure function of the per-block counters and all
// iteration follows plan order.
import {
  blockCandidate,
  blockHalfCandidate,
  splitBlock,
} from './candidate/blocks.js';
import {
  allocateWave,
  DEFAULT_SPLIT_MIN_HALF_ATTEMPTS,
  evaluateMarginalGain,
  fisherExactTwoSided,
  isBudgetExhausted,
  rankBlocks,
  shouldSplitBlock,
  wilsonUcbIndex,
} from './measurement/bandit.js';
import {
  runEligibilityBatch,
  selectDelayedRetries,
} from './hard-scheduler.js';
import { buildEligibilitySummary } from './report.js';
import { summarizePops } from './measurement/confidence.js';
import { classifyProbeError } from './probe/errors.js';
import {
  decayedCounts,
  mergeRunIntoReputation,
  primerTierForRecord,
} from './hard-reputation.js';

export const ENGINE_BLOCK_STATE_VERSION = 1;

// Primer safety valves (spec §3.4). These are properties of the valve
// rules themselves, not tunables: the hard-error valve inspects the first
// 200 primer observations, and the dead-path valve only arms once 1,000
// primer probes have been spent.
const HARD_ERROR_WINDOW = 200;
const HARD_ERROR_DOMINANCE = 0.95;
const DEAD_PATH_MIN_PROBES = 1000;
const DEAD_PATH_MAX_SUCCESS_RATE = 0.005;
// A block needs at least this many usable addresses before a split can
// leave both children with statistically meaningful halves (spec §5.2).
const SPLIT_MIN_USABLE = 32;
// Split-coverage pass stage targets (5b analysis §6), all derived from
// the split trigger's half minimum so the pass and the trigger can
// never drift apart: step E tops a 0-success block's less-observed half
// up to half the trigger depth, stage 1 guarantees the trigger depth
// in both halves, stage 2 doubles it for near-miss suspects.
const HALF_TRIGGER_ATTEMPTS = DEFAULT_SPLIT_MIN_HALF_ATTEMPTS;
const EXTENSION_HALF_ATTEMPTS = HALF_TRIGGER_ATTEMPTS / 2;
const DEEP_HALF_ATTEMPTS = 2 * HALF_TRIGGER_ATTEMPTS;

function positiveInt(value, fallback = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function screeningRoundsFor(hard) {
  const parsed = Math.floor(Number(hard.screeningRounds));
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, 5);
}

// The eligibility order used by the legacy finalize (hard-scan.js ranks
// finalists exactly this way): Wilson lower bound, success rate, handshake
// median, connect median, IP. Exported so the finalize wiring and tests
// share one definition of the order the pool is built in.
export function compareEligibilitySummaries(left, right) {
  const leftLower = left.eligibility.confidence95?.lower ?? 0;
  const rightLower = right.eligibility.confidence95?.lower ?? 0;
  if (rightLower !== leftLower) return rightLower - leftLower;
  if (right.eligibility.successRate !== left.eligibility.successRate) {
    return right.eligibility.successRate - left.eligibility.successRate;
  }
  const leftHandshake = left.eligibility.handshakeMedianMs ?? Number.POSITIVE_INFINITY;
  const rightHandshake = right.eligibility.handshakeMedianMs ?? Number.POSITIVE_INFINITY;
  if (leftHandshake !== rightHandshake) return leftHandshake - rightHandshake;
  const leftConnect = left.eligibility.connectMedianMs ?? Number.POSITIVE_INFINITY;
  const rightConnect = right.eligibility.connectMedianMs ?? Number.POSITIVE_INFINITY;
  return leftConnect !== rightConnect
    ? leftConnect - rightConnect
    : left.ip.localeCompare(right.ip);
}

function depthCapFor(block, hard) {
  return Math.min(block.usable, hard.maxDepthPerBlock);
}

function primerTargetForTier(tier, block, hard) {
  const cap = depthCapFor(block, hard);
  if (tier === 'skip') return 0;
  if (tier === 'confirm') return Math.min(1, cap);
  return Math.min(hard.primerPerBlock, cap);
}

function emptyHalves() {
  return {
    lowerSuccesses: 0,
    lowerAttempts: 0,
    upperSuccesses: 0,
    upperAttempts: 0,
  };
}

function createBlockState(block, blockIndex, { prior, tier, hard }) {
  return {
    block,
    blockIndex,
    blockId: block.blockId,
    parentBlockId: block.parentBlockId ?? null,
    priorAttempts: prior.attempts,
    priorSuccesses: prior.successes,
    runAttempts: 0,
    runSuccesses: 0,
    probed: 0,
    orderCursor: 0,
    halfCursors: { lower: 0, upper: 0 },
    probedAddresses: new Set(),
    halves: emptyHalves(),
    tier,
    primerTarget: primerTargetForTier(tier, block, hard),
    primerDone: 0,
    // Successes the run's own primer produced (tracked explicitly, not
    // re-derived from run totals: the split-coverage pass classifies
    // blocks by it, and expansion successes must not rewrite history).
    primerSuccesses: 0,
    // Split-coverage pass progress for this block: 0 untouched, 1 step
    // E settled, 2 stage 1 settled, 3 pass complete. Persisted so a
    // resumed run never re-spends the pass on a settled block.
    passStage: 0,
    extensionCounted: false,
    hardDead: false,
    addressesExhausted: false,
    retired: false,
    expansionProbes: 0,
    records: new Map(),
    children: null,
  };
}

function serializeBlockState(allStates, totals) {
  return {
    version: ENGINE_BLOCK_STATE_VERSION,
    // Probe counters ride along so a resumed invocation continues under
    // the run's original budget instead of a fresh one.
    totals: {
      probesSpent: totals.probesSpent,
      primerProbes: totals.primerProbes,
      expansionProbes: totals.expansionProbes,
      reserveProbes: totals.reserveProbes,
      blocksExtended: totals.blocksExtended,
      suspectsServed: totals.suspectsServed,
      blocksPromoted: totals.blocksPromoted,
      tested: totals.tested,
      eligible: totals.eligible,
      failed: totals.failed,
    },
    blocks: allStates.map((state) => ({
      blockId: state.blockId,
      blockIndex: state.blockIndex,
      parentBlockId: state.parentBlockId,
      splitDepth: state.block.splitDepth,
      priorAttempts: state.priorAttempts,
      priorSuccesses: state.priorSuccesses,
      runAttempts: state.runAttempts,
      runSuccesses: state.runSuccesses,
      probed: state.probed,
      orderCursor: state.orderCursor,
      halfCursors: { ...state.halfCursors },
      probedAddresses: [...state.probedAddresses],
      halves: { ...state.halves },
      tier: state.tier,
      primerTarget: state.primerTarget,
      primerDone: state.primerDone,
      primerSuccesses: state.primerSuccesses,
      passStage: state.passStage,
      extensionCounted: state.extensionCounted,
      hardDead: state.hardDead,
      addressesExhausted: state.addressesExhausted,
      retired: state.retired,
      children: state.children,
      records: [...state.records.values()].map((record) => ({
        candidate: record.candidate,
        observations: record.observations,
        address: record.address,
      })),
    })),
  };
}

export async function runBlockScreening({
  blocks,
  settings,
  task,
  concurrency,
  reputation = null,
  initialBlockState = null,
  onSummary = null,
  onProgress = () => {},
  logger = null,
  isCanceled = () => false,
  now = Date.now(),
  runId = null,
}) {
  const hard = settings.hard;
  const seed = settings.scan?.seed ?? 404;
  const minimumSuccessRate = settings.scan?.minimumSuccessRate ?? 0.6;
  const screeningRounds = screeningRoundsFor(hard);
  const workerConcurrency = positiveInt(concurrency ?? hard.concurrency, 1);
  const waveProbeSize = hard.expansionWaveFactor * workerConcurrency;
  const reputationThresholds = {
    halfLifeDays: hard.reputationHalfLifeDays,
    skipAgeDays: hard.reputationSkipAgeDays,
    confirmAgeDays: hard.reputationConfirmAgeDays,
    maxStoredAttempts: hard.reputationMaxStoredAttempts,
  };
  const log = (method, event, data) => {
    if (logger && typeof logger[method] === 'function') logger[method](event, data);
  };

  // --- Block state construction -------------------------------------------
  // Reputation seeds a block twice over: its decayed counts become the
  // allocator prior, and its freshness tier sets the primer depth (§7.3).
  const rootStates = blocks.map((block, index) => {
    const record = reputation?.blocks?.[block.blockId] ?? null;
    const prior = record
      ? decayedCounts(record, now, reputationThresholds)
      : { attempts: 0, successes: 0 };
    const tier = record
      ? primerTierForRecord(record, now, reputationThresholds)
      : 'full';
    return createBlockState(block, index, { prior, tier, hard });
  });
  const allStates = [...rootStates];
  const statesByIndex = new Map(allStates.map((state) => [state.blockIndex, state]));
  let nextBlockIndex = allStates.length;

  // Run counters. Declared before the restore below because a resumed
  // invocation inherits the original run's counters (budget continuity).
  const totals = {
    probesSpent: 0,
    primerProbes: 0,
    expansionProbes: 0,
    reserveProbes: 0,
    blocksExtended: 0,
    suspectsServed: 0,
    blocksPromoted: 0,
    tested: 0,
    eligible: 0,
    failed: 0,
    retryQueued: 0,
    blocksSplit: 0,
  };

  function registerState(state) {
    allStates.push(state);
    statesByIndex.set(state.blockIndex, state);
  }

  // Saves written before the split-coverage pass existed carry no
  // primerSuccesses; a block's primer records are the first primerDone
  // entries in its insertion-ordered record list, so the count rebuilds
  // exactly from what the save does carry.
  function savedPrimerSuccesses(entry) {
    let successes = 0;
    const records = entry.records ?? [];
    for (const saved of records.slice(0, entry.primerDone ?? 0)) {
      for (const observation of saved.observations ?? []) {
        if (observation.ok) successes += 1;
      }
    }
    return successes;
  }

  function applySavedEntry(state, entry) {
    state.priorAttempts = entry.priorAttempts ?? state.priorAttempts;
    state.priorSuccesses = entry.priorSuccesses ?? state.priorSuccesses;
    state.runAttempts = entry.runAttempts ?? 0;
    state.runSuccesses = entry.runSuccesses ?? 0;
    state.probed = entry.probed ?? 0;
    state.orderCursor = entry.orderCursor ?? 0;
    state.halfCursors = { lower: 0, upper: 0, ...(entry.halfCursors ?? {}) };
    state.probedAddresses = new Set(entry.probedAddresses ?? []);
    state.halves = { ...emptyHalves(), ...(entry.halves ?? {}) };
    state.tier = entry.tier ?? state.tier;
    state.primerTarget = entry.primerTarget ?? state.primerTarget;
    state.primerDone = entry.primerDone ?? 0;
    state.primerSuccesses = entry.primerSuccesses ?? savedPrimerSuccesses(entry);
    state.passStage = entry.passStage ?? 0;
    state.extensionCounted = Boolean(entry.extensionCounted);
    state.hardDead = Boolean(entry.hardDead);
    state.addressesExhausted = Boolean(entry.addressesExhausted);
    state.children = entry.children ?? null;
    for (const saved of entry.records ?? []) {
      const summary = buildEligibilitySummary({
        ip: saved.candidate.ip,
        range: saved.candidate.range,
        eligibility: saved.observations,
      });
      summary.block = saved.candidate.block;
      state.records.set(saved.candidate.ip, {
        candidate: saved.candidate,
        observations: saved.observations,
        summary,
        address: saved.address,
      });
    }
  }

  // Resume: root counters restore by blockId; split children are
  // re-derived structurally from their parent (splitBlock is a pure
  // function of the parent block) and matched by blockId, shallow first.
  function restoreBlockState(saved) {
    if (!saved || !Array.isArray(saved.blocks)) return;
    if (saved.totals) {
      for (const key of ['probesSpent', 'primerProbes', 'expansionProbes', 'reserveProbes', 'blocksExtended', 'suspectsServed', 'blocksPromoted', 'tested', 'eligible', 'failed']) {
        if (Number.isFinite(saved.totals[key])) totals[key] = saved.totals[key];
      }
    }
    const rootIds = new Set(rootStates.map((state) => state.blockId));
    const byId = new Map(saved.blocks.map((entry) => [entry.blockId, entry]));
    for (const state of rootStates) {
      const entry = byId.get(state.blockId);
      if (entry) applySavedEntry(state, entry);
    }
    const childEntries = saved.blocks
      .filter((entry) => entry.parentBlockId && !rootIds.has(entry.blockId))
      .sort((left, right) => (left.splitDepth ?? 0) - (right.splitDepth ?? 0));
    for (const entry of childEntries) {
      // A split's children are all registered when the first child's
      // entry derives them from the parent; a later sibling entry then
      // finds its state already present and only needs its own saved
      // counters applied — skipping it would silently zero the block.
      const existing = allStates.find((state) => state.blockId === entry.blockId);
      if (existing) {
        applySavedEntry(existing, entry);
        continue;
      }
      const parent = allStates.find((state) => state.blockId === entry.parentBlockId);
      if (!parent || parent.retired) continue;
      const derived = splitBlock(parent.block, { maxSplitDepth: entry.splitDepth ?? 1 });
      if (!derived) continue;
      parent.retired = true;
      parent.children = derived.map((child) => child.blockId);
      for (const childBlock of derived) {
        const child = createBlockState(childBlock, nextBlockIndex, {
          prior: { attempts: 0, successes: 0 },
          tier: 'inherited',
          hard,
        });
        nextBlockIndex += 1;
        child.primerTarget = 0;
        if (childBlock.blockId === entry.blockId) applySavedEntry(child, entry);
        registerState(child);
      }
    }
  }
  restoreBlockState(initialBlockState);

  // --- Run artifacts ----------------------------------------------------------
  const retryQueue = [];
  const splits = [];
  // Primer safety-valve bookkeeping (spec §3.4): observation-level counts
  // for the dead-path valve, plus the first-200 window for the hard-error
  // valve, keyed by classified error code.
  const valve = {
    observations: 0,
    successes: 0,
    windowTotal: 0,
    windowByCode: new Map(),
    windowClosed: false,
    aborted: null,
    nextBoundary: waveProbeSize,
  };
  let stoppedReason = null;

  const budgetRemaining = () => Math.max(0, hard.budgetProbes - totals.probesSpent);
  const activeStates = () => allStates.filter((state) => !state.retired);

  // --- Probing --------------------------------------------------------------
  // Draws the next `count` unprobed candidates from a block's seeded
  // permutation. Addresses inherited from a split parent are skipped, so a
  // block never re-probes an address; `probed` (the depth-cap counter)
  // counts only probes drawn for this block state itself.
  function drawCandidates(state, count) {
    const cap = depthCapFor(state.block, hard);
    const drawn = [];
    while (drawn.length < count && state.probed + drawn.length < cap) {
      const candidate = blockCandidate(state.block, state.orderCursor, seed);
      if (!candidate) {
        state.addressesExhausted = true;
        break;
      }
      state.orderCursor += 1;
      const address = state.block.base + candidate.hostOffset;
      if (state.probedAddresses.has(address)) continue;
      state.probedAddresses.add(address);
      candidate.blockIndex = state.blockIndex;
      drawn.push(candidate);
    }
    if (drawn.length === 0 && count > 0) state.addressesExhausted = true;
    state.probed += drawn.length;
    return drawn;
  }

  // Draws the next `count` unprobed candidates from one half's own
  // seeded stream (the split-coverage pass's step E). The half cursor
  // is independent of the main order cursor; addresses the block has
  // already probed — through either stream — are skipped, so a block
  // never re-probes an address.
  function drawHalfCandidates(state, half, count) {
    const cap = depthCapFor(state.block, hard);
    const drawn = [];
    while (drawn.length < count && state.probed + drawn.length < cap) {
      const candidate = blockHalfCandidate(
        state.block,
        half,
        state.halfCursors[half],
        seed,
      );
      if (!candidate) break;
      state.halfCursors[half] += 1;
      const address = state.block.base + candidate.hostOffset;
      if (state.probedAddresses.has(address)) continue;
      state.probedAddresses.add(address);
      candidate.blockIndex = state.blockIndex;
      drawn.push(candidate);
    }
    state.probed += drawn.length;
    return drawn;
  }

  function trackPrimerObservation(observation) {
    valve.observations += 1;
    if (observation.ok) valve.successes += 1;
    if (valve.windowClosed) return;
    valve.windowTotal += 1;
    if (!observation.ok) {
      const classified = classifyProbeError(observation.error);
      if (classified.class === 'non_retryable') {
        valve.windowByCode.set(
          classified.code,
          (valve.windowByCode.get(classified.code) ?? 0) + 1,
        );
      }
    }
    if (valve.windowTotal >= HARD_ERROR_WINDOW) {
      valve.windowClosed = true;
      const dominant = Math.max(0, ...valve.windowByCode.values());
      if (dominant / HARD_ERROR_WINDOW >= HARD_ERROR_DOMINANCE) {
        valve.aborted = 'hard-error';
      }
    }
  }

  function recordResult(candidate, observations, phase) {
    const state = statesByIndex.get(candidate.blockIndex);
    const summary = buildEligibilitySummary({
      ip: candidate.ip,
      range: candidate.range,
      eligibility: observations,
    });
    summary.block = candidate.block;
    const address = state.block.base + candidate.hostOffset;
    state.records.set(candidate.ip, {
      candidate,
      observations,
      summary,
      address,
    });
    const half = candidate.hostOffset < state.block.size / 2 ? 'lower' : 'upper';
    let successes = 0;
    for (const observation of observations) {
      if (observation.ok) successes += 1;
      state.halves[`${half}Attempts`] += 1;
      if (observation.ok) state.halves[`${half}Successes`] += 1;
      if (phase === 'primer') trackPrimerObservation(observation);
    }
    state.runAttempts += observations.length;
    state.runSuccesses += successes;
    if (phase === 'primer') state.primerSuccesses += successes;
    totals.tested += 1;
    if (summary.eligibility.successRate >= minimumSuccessRate) {
      totals.eligible += 1;
    } else {
      totals.failed += 1;
    }
    onSummary?.(summary, candidate);
  }

  // One scheduler batch, processed exactly like a legacy screening batch:
  // delayed-retry selection first (capped per batch), then every result is
  // summarised and recorded in input order.
  async function probeChunk(candidates, phase) {
    if (!candidates.length) return;
    const results = await runEligibilityBatch({
      candidates,
      rounds: screeningRounds,
      concurrency: workerConcurrency,
      minimumSuccessRate,
      task,
    });
    if (hard.delayedRetry) {
      for (const retry of selectDelayedRetries(results, {
        maxRetries: workerConcurrency,
      })) {
        retryQueue.push({ ip: retry.ip, range: retry.range, block: retry.block });
        totals.retryQueued += 1;
      }
    }
    for (const { candidate, observations } of results) {
      recordResult(candidate, observations, phase);
    }
  }

  function checkDeadPathValve() {
    while (!valve.aborted && totals.primerProbes >= valve.nextBoundary) {
      valve.nextBoundary += waveProbeSize;
      if (
        totals.primerProbes >= DEAD_PATH_MIN_PROBES
        && valve.observations > 0
        && valve.successes / valve.observations < DEAD_PATH_MAX_SUCCESS_RATE
      ) {
        valve.aborted = 'dead-path';
      }
    }
  }

  // --- Primer phase (spec §3) ----------------------------------------------
  // Stratified passes over ranges: pass k primers the k-th block of every
  // range, so an interrupted primer has touched a prefix of the blocks of
  // every range rather than exhausting a few ranges.
  function primerSweepOrder() {
    const groups = new Map();
    for (const state of rootStates) {
      if (!groups.has(state.block.rangeIndex)) groups.set(state.block.rangeIndex, []);
      groups.get(state.block.rangeIndex).push(state);
    }
    const groupList = [...groups.values()];
    const maxLength = Math.max(0, ...groupList.map((group) => group.length));
    const ordered = [];
    for (let pass = 0; pass < maxLength; pass += 1) {
      for (const group of groupList) {
        if (group[pass]) ordered.push(group[pass]);
      }
    }
    return ordered;
  }

  // Settles blocks whose primer just completed: a failed confirmation
  // probe extends the block to the full primer (§7.3), and a block whose
  // primer evidence is entirely non-retryable failure is hard-dead for
  // this run (§3.4) — a run-local mark, never written to reputation.
  function settlePrimerStates() {
    for (const state of rootStates) {
      if (state.retired || state.primerDone < state.primerTarget) continue;
      if (
        state.tier === 'confirm'
        && state.primerTarget === 1
        && state.runAttempts > 0
        && state.runSuccesses === 0
      ) {
        state.primerTarget = Math.min(hard.primerPerBlock, depthCapFor(state.block, hard));
        continue;
      }
      if (state.primerTarget === 0 || state.hardDead || state.records.size === 0) continue;
      let sawObservation = false;
      let allHard = true;
      for (const record of state.records.values()) {
        for (const observation of record.observations) {
          sawObservation = true;
          if (observation.ok || classifyProbeError(observation.error).class !== 'non_retryable') {
            allHard = false;
          }
        }
      }
      if (sawObservation && allHard) state.hardDead = true;
    }
  }

  async function runPrimerPhase() {
    while (!isCanceled() && !valve.aborted) {
      const owed = primerSweepOrder().filter(
        (state) => !state.retired && state.primerDone < state.primerTarget,
      );
      if (!owed.length) break;
      let chunk = [];
      const flush = async () => {
        if (!chunk.length) return;
        const batch = chunk;
        chunk = [];
        await probeChunk(batch, 'primer');
        checkDeadPathValve();
      };
      for (const state of owed) {
        let remaining = state.primerTarget - state.primerDone;
        while (remaining > 0 && !isCanceled() && !valve.aborted) {
          const room = budgetRemaining();
          if (room <= 0) break;
          const drawn = drawCandidates(state, Math.min(remaining, room));
          if (!drawn.length) {
            // No unprobed addresses left: the primer is complete by
            // exhaustion even though the target was not reached.
            state.primerDone = state.primerTarget;
            break;
          }
          state.primerDone += drawn.length;
          totals.primerProbes += drawn.length;
          totals.probesSpent += drawn.length;
          chunk.push(...drawn);
          remaining -= drawn.length;
          if (chunk.length >= workerConcurrency) await flush();
        }
        if (isCanceled() || valve.aborted || budgetRemaining() <= 0) break;
      }
      await flush();
      settlePrimerStates();
      if (budgetRemaining() <= 0) break;
    }
  }

  // --- Split-coverage pass (5b analysis §6) ----------------------------------
  // Between the primer and UCB expansion, a bounded reserve guarantees
  // split-trigger depth to the blocks the primer flags. The split
  // signal lives exclusively in the per-half counters, and a
  // heterogeneous block's totals are indistinguishable from a
  // homogeneous mid block's, so pure index order cannot route probes
  // to it — measured on Map D, no 0/3 block was ever served and barely
  // a quarter of the catalog reached trigger depth. The pass iterates
  // root blocks in primer-sweep order (split children join expansion
  // normally and are never pass subjects), spends at most
  // splitReserveFraction of the post-primer headroom, and leaves
  // unserved suspects to UCB — graceful, stratified, deterministic.
  // The slice derives from primerProbes (a restored counter), never
  // from current spend, so a resumed run faces the identical slice.
  function reserveSlice() {
    const headroom = Math.max(0, hard.budgetProbes - totals.primerProbes);
    return Math.floor(hard.splitReserveFraction * headroom);
  }

  function lessObservedHalf(state) {
    return state.halves.lowerAttempts <= state.halves.upperAttempts
      ? 'lower'
      : 'upper';
  }

  // Spends reserve probes until `half` reaches `target` attempts,
  // drawing from the half's own stream (step E). Returns probes spent.
  async function extendHalf(state, half, target) {
    let spent = 0;
    while (
      !isCanceled() && !valve.aborted
      && state.halves[`${half}Attempts`] < target
    ) {
      if (budgetRemaining() <= 0) break;
      const needed = target - state.halves[`${half}Attempts`];
      const drawn = drawHalfCandidates(
        state,
        half,
        Math.min(needed, workerConcurrency),
      );
      if (!drawn.length) break;
      totals.reserveProbes += drawn.length;
      totals.probesSpent += drawn.length;
      spent += drawn.length;
      await probeChunk(drawn, 'coverage');
    }
    return spent;
  }

  // Spends reserve probes until both halves reach `target` attempts,
  // drawing from the block's main permutation (stages 1–2). Returns
  // probes spent.
  async function balanceHalves(state, target) {
    let spent = 0;
    while (
      !isCanceled() && !valve.aborted
      && (state.halves.lowerAttempts < target
        || state.halves.upperAttempts < target)
    ) {
      if (budgetRemaining() <= 0) break;
      const deficit = Math.max(0, target - state.halves.lowerAttempts)
        + Math.max(0, target - state.halves.upperAttempts);
      const drawn = drawCandidates(
        state,
        Math.min(deficit, workerConcurrency),
      );
      if (!drawn.length) break;
      totals.reserveProbes += drawn.length;
      totals.probesSpent += drawn.length;
      spent += drawn.length;
      await probeChunk(drawn, 'coverage');
    }
    return spent;
  }

  // A stage is settled when its target is reached, or when it spent
  // nothing while budget remained and the run was not interrupted —
  // the draws themselves are impossible (depth cap, exhausted halves),
  // so no resume could serve the block further either.
  function stageSettled(state, target, spent) {
    if (
      state.halves.lowerAttempts >= target
      && state.halves.upperAttempts >= target
    ) return true;
    return spent === 0 && budgetRemaining() > 0 && !isCanceled() && !valve.aborted;
  }

  async function runSplitCoveragePass() {
    const slice = reserveSlice();
    const sliceSpent = () => totals.reserveProbes >= slice;
    for (const state of primerSweepOrder()) {
      if (isCanceled() || valve.aborted || budgetRemaining() <= 0) break;
      if (state.retired || state.hardDead || state.passStage >= 3) continue;
      if (state.primerDone === 0) {
        // The primer never ran for this block (skip tier, or the sweep
        // never reached it): there is no run evidence to extend, and
        // reputation already speaks for skip-tier blocks.
        state.passStage = 3;
        continue;
      }

      // Step E — half-coverage extension for 0-success primers, the
      // class UCB starves by construction. The less-observed half is
      // the hot half in ≈95% of cases (the cold half produced the
      // shutout); any success promotes the block to suspect.
      if (state.passStage < 1) {
        if (sliceSpent()) break;
        if (state.primerSuccesses === 0) {
          const half = lessObservedHalf(state);
          const wasPromoted = state.runSuccesses > 0;
          const spent = await extendHalf(state, half, EXTENSION_HALF_ATTEMPTS);
          if (spent > 0 && !state.extensionCounted) {
            state.extensionCounted = true;
            totals.blocksExtended += 1;
          }
          if (!wasPromoted && state.runSuccesses > 0) {
            totals.blocksPromoted += 1;
          }
          if (
            state.halves[`${half}Attempts`] >= EXTENSION_HALF_ATTEMPTS
            || (spent === 0 && budgetRemaining() > 0 && !isCanceled() && !valve.aborted)
          ) {
            state.passStage = 1;
          }
        } else {
          state.passStage = 1;
        }
        applySplits();
        if (state.retired) {
          state.passStage = 3;
          continue;
        }
        if (state.passStage < 1) continue;
      }

      // Suspects: a mixed run primer, or a step-E promotion (primer
      // successes still 0, but the extension found a success).
      const suspect = (state.primerSuccesses === 0 && state.runSuccesses > 0)
        || (state.primerSuccesses >= 1
          && state.primerSuccesses < hard.primerPerBlock);
      if (!suspect) {
        state.passStage = 3;
        continue;
      }

      // Stage 1 — guarantee the split trigger's depth in both halves;
      // drawing until balanced also cures unbalanced landings.
      if (state.passStage < 2) {
        if (sliceSpent()) break;
        const spent = await balanceHalves(state, HALF_TRIGGER_ATTEMPTS);
        if (stageSettled(state, HALF_TRIGGER_ATTEMPTS, spent)) {
          totals.suspectsServed += 1;
          state.passStage = 2;
        }
        applySplits();
        if (state.retired) {
          state.passStage = 3;
          continue;
        }
        if (state.passStage < 2) continue;
      }

      // Stage 2 — a suspect that has not split but sits at a near-miss
      // Fisher p earns one deeper look; the split itself still has to
      // clear splitAlpha inside applySplits.
      if (state.passStage < 3) {
        if (fisherExactTwoSided(state.halves) <= hard.splitReserveAlpha) {
          if (sliceSpent()) break;
          const spent = await balanceHalves(state, DEEP_HALF_ATTEMPTS);
          if (stageSettled(state, DEEP_HALF_ATTEMPTS, spent)) {
            state.passStage = 3;
          }
          applySplits();
        } else {
          state.passStage = 3;
        }
      }
    }
    onProgress({
      phase: 'hard-split-coverage',
      completed: totals.reserveProbes,
      total: slice,
      eligible: totals.eligible,
      failed: totals.failed,
      note: `split-coverage pass complete; ${totals.reserveProbes} reserve probes spent`,
    });
    log('info', 'hard.engine.split-coverage', {
      reserveProbes: totals.reserveProbes,
      slice,
      blocksExtended: totals.blocksExtended,
      suspectsServed: totals.suspectsServed,
      blocksPromoted: totals.blocksPromoted,
    });
  }

  // --- Pool (spec §6.1) ------------------------------------------------------
  function buildPool() {
    const contributed = [];
    for (const state of activeStates()) {
      if (!state.records.size) continue;
      const summaries = [...state.records.values()]
        .map((record) => record.summary)
        .sort(compareEligibilitySummaries);
      contributed.push(...summaries.slice(0, hard.poolPerBlock));
    }
    return contributed.sort(compareEligibilitySummaries);
  }

  // The pool threshold τ (§4.4): the Wilson lower bound of the candidate
  // ranked #finalTop in the pool, or 0 while the pool is not yet full.
  function poolThreshold(pool) {
    if (pool.length < hard.finalTop) return 0;
    return pool[hard.finalTop - 1].eligibility.confidence95?.lower ?? 0;
  }

  // --- Expansion phase (spec §4) ---------------------------------------------
  function toBanditState(state) {
    return {
      blockIndex: state.blockIndex,
      base: state.block.base,
      range: state.block.range,
      successes: state.priorSuccesses + state.runSuccesses,
      attempts: state.priorAttempts + state.runAttempts,
      probed: state.probed,
      usable: state.block.usable,
      hardDead: state.hardDead,
    };
  }

  // Splits (§5): children inherit the parent's observations partitioned by
  // address, so a split costs no probes and strands no evidence. The
  // parent retires from allocation; its candidates stay in the pool
  // through the children's records.
  function applySplits() {
    for (const state of [...activeStates()]) {
      if (state.block.splitDepth >= hard.splitMaxDepth) continue;
      if (state.block.usable < SPLIT_MIN_USABLE) continue;
      if (!shouldSplitBlock(state.halves, {
        alpha: hard.splitAlpha,
        minEffect: hard.splitMinEffect,
      })) continue;
      const childBlocks = splitBlock(state.block, {
        maxSplitDepth: hard.splitMaxDepth,
      });
      if (!childBlocks) continue;
      const childStates = childBlocks.map((childBlock) => {
        const child = createBlockState(childBlock, nextBlockIndex, {
          prior: { attempts: 0, successes: 0 },
          tier: 'inherited',
          hard,
        });
        nextBlockIndex += 1;
        child.primerTarget = 0;
        child.primerDone = 0;
        return child;
      });
      for (const record of state.records.values()) {
        const child = childStates.find(
          (candidate) => record.address >= candidate.block.base
            && record.address < candidate.block.base + candidate.block.size,
        );
        if (!child) continue;
        child.records.set(record.candidate.ip, record);
        child.probedAddresses.add(record.address);
        const half = (record.address - child.block.base) < child.block.size / 2
          ? 'lower'
          : 'upper';
        for (const observation of record.observations) {
          child.runAttempts += 1;
          if (observation.ok) child.runSuccesses += 1;
          child.halves[`${half}Attempts`] += 1;
          if (observation.ok) child.halves[`${half}Successes`] += 1;
        }
      }
      state.retired = true;
      state.children = childStates.map((child) => child.blockId);
      state.records.clear();
      for (const child of childStates) registerState(child);
      splits.push({
        parent: state.blockId,
        children: state.children,
        halves: { ...state.halves },
      });
      totals.blocksSplit += 1;
      log('info', 'hard.engine.split', {
        parent: state.blockId,
        children: state.children,
      });
    }
  }

  async function runExpansionPhase() {
    let consecutiveLowWaves = 0;
    while (!isCanceled() && !valve.aborted) {
      if (isBudgetExhausted({
        probesSpent: totals.probesSpent,
        budgetProbes: hard.budgetProbes,
      })) {
        stoppedReason = 'budget';
        break;
      }
      const threshold = poolThreshold(buildPool());
      const banditStates = activeStates()
        .filter((state) => !state.addressesExhausted)
        .map(toBanditState);
      const expandable = banditStates.filter(
        (state) => !state.hardDead
          && Math.min(state.usable, hard.maxDepthPerBlock) - state.probed > 0,
      );
      if (!expandable.length) {
        stoppedReason = 'exhausted';
        break;
      }
      const ranked = rankBlocks(banditStates, { exploration: hard.banditExploration });
      const expandableIndexes = new Set(expandable.map((state) => state.blockIndex));
      const bestIndex = ranked.find(
        (state) => expandableIndexes.has(state.blockIndex),
      )?.index ?? 0;
      const gain = evaluateMarginalGain({
        bestIndex,
        threshold,
        consecutiveLowWaves,
      });
      consecutiveLowWaves = gain.consecutiveLowWaves;
      if (gain.shouldStop) {
        stoppedReason = 'marginal-gain';
        break;
      }
      const waveSize = Math.min(waveProbeSize, budgetRemaining());
      const allocations = allocateWave(banditStates, {
        waveSize,
        chunk: hard.expansionChunk,
        rangeCapFraction: hard.rangeWaveCapFraction,
        threshold,
        exploration: hard.banditExploration,
        maxDepth: hard.maxDepthPerBlock,
      });
      if (!allocations.length) {
        // A low-gain wave that allocated nothing still counts toward the
        // marginal-gain hysteresis; anything else means the allocator and
        // the eligibility view disagree, which is exhaustion in practice.
        if (gain.lowGain) continue;
        stoppedReason = 'exhausted';
        break;
      }
      let waveProbes = 0;
      for (const allocation of allocations) {
        const state = statesByIndex.get(allocation.blockIndex);
        let remaining = allocation.probes;
        while (remaining > 0 && !isCanceled()) {
          const drawn = drawCandidates(
            state,
            Math.min(remaining, workerConcurrency),
          );
          if (!drawn.length) break;
          state.expansionProbes += drawn.length;
          totals.expansionProbes += drawn.length;
          totals.probesSpent += drawn.length;
          waveProbes += drawn.length;
          remaining -= drawn.length;
          await probeChunk(drawn, 'expansion');
        }
        if (isCanceled()) break;
      }
      if (waveProbes === 0 && !isCanceled()) {
        // Every grant hit exhausted address space: nothing left to spend
        // budget on, whatever the counters say.
        stoppedReason = 'exhausted';
        break;
      }
      applySplits();
      onProgress({
        phase: 'hard-expansion',
        completed: totals.probesSpent,
        total: hard.budgetProbes,
        eligible: totals.eligible,
        failed: totals.failed,
        note: `expansion wave complete; ${totals.expansionProbes} expansion probes spent`,
      });
    }
  }

  // --- Reputation merge -------------------------------------------------------
  function compareBestCandidates(left, right) {
    if (left.successes !== right.successes) return right.successes - left.successes;
    if (left.attempts !== right.attempts) return right.attempts - left.attempts;
    const leftMedian = left.handshakeMedianMs ?? Number.POSITIVE_INFINITY;
    const rightMedian = right.handshakeMedianMs ?? Number.POSITIVE_INFINITY;
    if (leftMedian !== rightMedian) return leftMedian - rightMedian;
    return left.ip.localeCompare(right.ip);
  }

  // One merge input per non-retired block (spec §7.1). A split parent is
  // not merged: its evidence lives on, partitioned, in its children, so
  // merging it too would double-count the same probes.
  function buildBlockResults() {
    const results = [];
    for (const state of allStates) {
      if (state.retired) continue;
      if (state.runAttempts === 0 && state.records.size === 0) continue;
      const best = [...state.records.values()]
        .map((record) => ({
          ip: record.candidate.ip,
          attempts: record.observations.length,
          successes: record.observations.filter((item) => item.ok).length,
          handshakeMedianMs: record.summary.eligibility.handshakeMedianMs,
        }))
        .sort(compareBestCandidates)
        .slice(0, 4);
      const successful = [...state.records.values()]
        .flatMap((record) => record.observations.filter((item) => item.ok));
      results.push({
        block: state.blockId,
        attempts: state.runAttempts,
        successes: state.runSuccesses,
        best,
        colo: summarizePops(successful).dominant,
        runId,
        parent: state.parentBlockId,
        children: null,
      });
    }
    return results;
  }

  // --- Run --------------------------------------------------------------------
  log('info', 'hard.engine.start', {
    blocks: blocks.length,
    budgetProbes: hard.budgetProbes,
    concurrency: workerConcurrency,
    screeningRounds,
    resumed: Boolean(initialBlockState),
  });

  await runPrimerPhase();

  // Primer-exit snapshot: per-block Wilson-UCB upper bounds and the pool
  // threshold at this exact moment — the quantities spec §9's primer-safety
  // criterion is stated over.
  const primerUpperBounds = {};
  for (const state of rootStates) {
    primerUpperBounds[state.blockId] = wilsonUcbIndex(
      state.priorSuccesses + state.runSuccesses,
      state.priorAttempts + state.runAttempts,
      hard.banditExploration,
    );
  }
  const primerThreshold = poolThreshold(buildPool());
  onProgress({
    phase: 'hard-primer',
    completed: totals.primerProbes,
    total: rootStates.reduce((sum, state) => sum + state.primerTarget, 0),
    eligible: totals.eligible,
    failed: totals.failed,
    note: valve.aborted
      ? `primer aborted (${valve.aborted})`
      : 'primer phase complete',
  });
  log('info', 'hard.engine.primer', {
    probes: totals.primerProbes,
    aborted: valve.aborted,
  });

  // The split-coverage pass runs after the primer-exit snapshot above
  // (criterion 3 is stated over that exact moment) and before UCB
  // expansion spends the headroom the pass reserves from.
  if (!isCanceled() && !valve.aborted) {
    await runSplitCoveragePass();
  }
  if (!isCanceled() && !valve.aborted) {
    await runExpansionPhase();
  }
  if (isCanceled() && !stoppedReason) stoppedReason = 'canceled';
  if (valve.aborted) stoppedReason = valve.aborted;
  const completed = !isCanceled() && !valve.aborted;

  const pool = buildPool();
  const finalists = pool.slice(0, hard.finalTop);
  const blockResults = buildBlockResults();
  // Reputation is merged only on a natural completion: a canceled run's
  // evidence is partial by definition, and a valve-aborted run's evidence
  // is untrustworthy (spec §3.4 — hard-dead marks are never persisted).
  // Wave C owns the store's file lifecycle; the engine merges in memory.
  if (reputation && completed) {
    mergeRunIntoReputation(reputation, blockResults, now, reputationThresholds);
  }

  const tierCounts = { skip: 0, confirm: 0, full: 0 };
  for (const state of rootStates) {
    if (tierCounts[state.tier] !== undefined) tierCounts[state.tier] += 1;
  }

  log('info', 'hard.engine.complete', {
    probesSpent: totals.probesSpent,
    stoppedReason,
    completed,
  });

  return {
    pool,
    finalists,
    retryQueue,
    blockResults,
    splits,
    primer: {
      probes: totals.primerProbes,
      threshold: primerThreshold,
      upperBounds: primerUpperBounds,
    },
    totals: {
      ...totals,
      blocksTotal: blocks.length,
      blocksPrimed: rootStates.filter(
        (state) => state.primerTarget > 0 && state.primerDone >= state.primerTarget,
      ).length,
      blocksExpanded: allStates.filter((state) => state.expansionProbes > 0).length,
      blocksExhausted: activeStates().filter(
        (state) => state.addressesExhausted
          || state.probed >= depthCapFor(state.block, hard),
      ).length,
      blocksByTier: tierCounts,
    },
    blockState: serializeBlockState(allStates, totals),
    stoppedReason,
    completed,
    aborted: valve.aborted,
  };
}
