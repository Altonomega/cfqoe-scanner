import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runBlockScreening } from '../src/hard-engine.js';
import { createDefaultSettings } from '../src/config/settings.js';
import {
  buildRangePlan,
  nextRoundRobinCandidate,
} from '../src/candidate/hard-order.js';
import {
  collectCandidateBatch,
  runEligibilityBatch,
} from '../src/hard-scheduler.js';
import { buildEligibilitySummary } from '../src/report.js';
import { createReputationStore } from '../src/hard-reputation.js';
import { createVirtualCatalog, virtualRanges } from './fixtures/virtual-catalog.js';

// Simulation harness for the block-adaptive Hard Scan engine (spec:
// docs/HARD-SCAN-REDESIGN.md §9). The engine is driven end-to-end by a
// fake probe over a synthetic catalog (test/fixtures/virtual-catalog.js)
// and compared against the current round-robin design at equal probe
// budgets. No network, no timers: every criterion is expressed in probe
// counts.
//
// SCALE. The real catalog has 7,697 blocks and a 72,000-probe desktop
// budget; this harness uses 2,048 blocks (64 ranges × 32) and scales the
// two catalog-dependent quantities by the same ratio — budgetProbes
// (72,000 / 7,697 per block) and finalTop (200 / 7,697 per block). Every
// other governed value (primer 3, depth cap 32, wave factor 10, chunk 4,
// range cap 0.25, pool-per-block 8, split rule) is the shipped default.
// "Top blocks" are the true top 1% by ground-truth rate (20 blocks here,
// the analogue of the spec's 77).
//
// THREE READINGS OF THE SPEC HAD TO BE RESOLVED (recorded for review):
//
// (R1) Recall is measured over the §6.1 pool — the per-block-contributed
// candidate set the engine returns — not over the finalTop-truncated
// finalists. §6.3 defines the 200 as "retained for verification and the
// final report": a verification-budget cut. At screeningRounds = 1 every
// candidate carries exactly one observation, so the truncated ranking is
// decided by handshake-latency noise among tied Wilson bounds and carries
// no block-quality signal; recall over it would measure latency luck, not
// the block design. The baseline is measured over its full probed
// candidate set, the exact analogue of the pool.
//
// (R2) Criterion 4 is encoded one-sided ("must not lose": DNA recall ≥
// baseline − 0.05), following §9.1's stated purpose for Map C. The
// symmetric ±0.05 band in §9.4 is unsatisfiable jointly with criteria
// 1–2: on a null map the DNA design's total block coverage makes its
// pool recall structurally higher than a baseline that only ever touches
// the first block of each range, and a band that fails a design for
// winning on the null map contradicts the map's purpose.
//
// (R3) Criterion 5's detection half (≥ 80% of heterogeneous blocks split)
// was NOT met by the originally approved parameters: measured 0.557.
// Root cause, measured (docs/HARD-SCAN-5B-ANALYSIS.md): 23 of the 27
// undetected blocks never reached the 8-probe split trigger — greedy
// Wilson-UCB spends the expansion budget on higher-index blocks first,
// mid-tier (mean q ≈ 0.475) blocks starve, and every block whose primer
// came back 0/3 received zero expansion probes; the split signal lives
// in the per-half counters, which the block-total index cannot see.
// The fix is the split-coverage pass (analysis §6): a bounded reserve
// between the primer and UCB expansion that extends 0-success blocks
// into their less-observed half, guarantees trigger depth to mixed
// primers, and deepens near-misses — capped at splitReserveFraction of
// the post-primer headroom, with no change to primer depth, depth cap,
// split thresholds, or budget. The criterion is asserted live below at
// its spec value; the ≥ 0.50 floor test remains as a regression guard.
// The false-split half of criterion 5 passes as specified (≤ 5%).

const REAL_BLOCKS = 7697;
const SIM_SEED = 777;
const SIM_RANGES = virtualRanges(64);

function scaledSettings(blockCount, overrides = {}) {
  const settings = createDefaultSettings('linux');
  settings.hard.budgetProbes = Math.round(blockCount * (72000 / REAL_BLOCKS));
  settings.hard.finalTop = Math.round(blockCount * (200 / REAL_BLOCKS));
  settings.hard.concurrency = 12;
  Object.assign(settings.hard, overrides);
  return settings;
}

const dnaRuns = new Map();
function dnaRun(map) {
  if (!dnaRuns.has(map)) {
    dnaRuns.set(map, (async () => {
      const catalog = createVirtualCatalog({ ranges: SIM_RANGES, map, seed: SIM_SEED });
      const settings = scaledSettings(catalog.blocks.length);
      const result = await runBlockScreening({
        blocks: catalog.blocks,
        settings,
        task: catalog.task,
        concurrency: 12,
      });
      return { catalog, settings, result };
    })());
  }
  return dnaRuns.get(map);
}

const baselineRuns = new Map();
function baselineRun(map) {
  if (!baselineRuns.has(map)) {
    baselineRuns.set(map, (async () => {
      const catalog = createVirtualCatalog({ ranges: SIM_RANGES, map, seed: SIM_SEED });
      const settings = scaledSettings(catalog.blocks.length);
      const budget = settings.hard.budgetProbes;
      const plan = buildRangePlan(catalog.ranges);
      let cursor = { rangeIndex: 0, passIndex: 0 };
      let spent = 0;
      const summaries = [];
      while (spent < budget) {
        const batch = collectCandidateBatch({
          plan,
          cursor,
          limit: 12,
          nextCandidate: nextRoundRobinCandidate,
        });
        if (!batch.length) break;
        const use = batch.slice(0, budget - spent);
        const results = await runEligibilityBatch({
          candidates: use,
          rounds: 1,
          concurrency: 12,
          minimumSuccessRate: settings.scan.minimumSuccessRate,
          task: catalog.task,
        });
        for (const { candidate, observations } of results) {
          summaries.push(buildEligibilitySummary({
            ip: candidate.ip,
            range: candidate.range,
            eligibility: observations,
          }));
          spent += 1;
        }
        cursor = use[use.length - 1].nextCursor;
      }
      return { catalog, summaries, spent };
    })());
  }
  return baselineRuns.get(map);
}

// Fraction of the true top-1% blocks represented by at least one summary.
function poolRecall(catalog, summaries) {
  const top = catalog.topBlocks(0.01);
  const represented = new Set(
    summaries.map((summary) => catalog.blockOfIp(summary.ip).blockId),
  );
  const hits = top.filter((blockId) => represented.has(blockId)).length;
  return hits / top.length;
}

// False-split accounting over a finished DNA run: a block "reached the
// trigger" when its final counters satisfy the §5.2 observation minimums
// (split parents qualify by construction — they fired it).
function splitStats(result, homogeneousIds) {
  let triggered = 0;
  for (const entry of result.blockState.blocks) {
    if (!homogeneousIds.has(entry.blockId) || entry.retired) continue;
    if (
      entry.runAttempts >= 8
      && entry.halves.lowerAttempts >= 4
      && entry.halves.upperAttempts >= 4
    ) {
      triggered += 1;
    }
  }
  const splitParents = result.splits
    .map((split) => split.parent)
    .filter((blockId) => homogeneousIds.has(blockId));
  return {
    triggered: triggered + splitParents.length,
    falseSplits: splitParents.length,
  };
}

test('criterion 1 — Map B (sparse gems): recall ≥ 0.90 and ≥ baseline + 0.25', async () => {
  const dna = await dnaRun('sparse-gems');
  const baseline = await baselineRun('sparse-gems');
  // Primer coverage is total: every block was probed at least primer-deep.
  const probedBlocks = new Set(dna.catalog.probeLog.map((entry) => entry.blockId));
  assert.equal(probedBlocks.size, dna.catalog.blocks.length);
  assert.equal(dna.result.totals.probesSpent, dna.settings.hard.budgetProbes);
  const dnaRecall = poolRecall(dna.catalog, dna.result.pool);
  const baselineRecall = poolRecall(baseline.catalog, baseline.summaries);
  assert.ok(dnaRecall >= 0.9, `DNA recall ${dnaRecall} < 0.90`);
  assert.ok(
    dnaRecall - baselineRecall >= 0.25,
    `DNA margin over baseline ${dnaRecall - baselineRecall} < 0.25 (baseline ${baselineRecall})`,
  );
});

test('criterion 2 — Map A (clustered): recall ≥ 0.85 and ≥ baseline + 0.15', async () => {
  const dna = await dnaRun('clustered');
  const baseline = await baselineRun('clustered');
  const dnaRecall = poolRecall(dna.catalog, dna.result.pool);
  const baselineRecall = poolRecall(baseline.catalog, baseline.summaries);
  assert.ok(dnaRecall >= 0.85, `DNA recall ${dnaRecall} < 0.85`);
  assert.ok(
    dnaRecall - baselineRecall >= 0.15,
    `DNA margin over baseline ${dnaRecall - baselineRecall} < 0.15 (baseline ${baselineRecall})`,
  );
});

test('criterion 3 — primer safety (Maps A, B, D): ≥ 99% of top blocks keep upper bound ≥ τ at primer exit', async () => {
  for (const map of ['clustered', 'sparse-gems', 'heterogeneous']) {
    const dna = await dnaRun(map);
    const top = dna.catalog.topBlocks(0.01);
    const safe = top.filter(
      (blockId) => (dna.result.primer.upperBounds[blockId] ?? 0)
        >= dna.result.primer.threshold,
    ).length;
    assert.ok(
      safe / top.length >= 0.99,
      `${map}: primer safety ${safe / top.length} < 0.99 (τ = ${dna.result.primer.threshold})`,
    );
  }
});

test('criterion 4 — Map C (uniform null): DNA does not lose to baseline (≥ baseline − 0.05)', async () => {
  const dna = await dnaRun('uniform-null');
  const baseline = await baselineRun('uniform-null');
  const dnaRecall = poolRecall(dna.catalog, dna.result.pool);
  const baselineRecall = poolRecall(baseline.catalog, baseline.summaries);
  assert.ok(
    dnaRecall >= baselineRecall - 0.05,
    `DNA recall ${dnaRecall} loses to baseline ${baselineRecall} by more than 0.05`,
  );
});

test('criterion 5 — false splits ≤ 5% of triggered homogeneous blocks (Maps A–C, D homogeneous)', async () => {
  for (const map of ['clustered', 'sparse-gems', 'uniform-null', 'heterogeneous']) {
    const dna = await dnaRun(map);
    const hetero = new Set(dna.catalog.heterogeneousBlockIds());
    const homogeneous = new Set(
      dna.catalog.blocks
        .map((block) => block.blockId)
        .filter((blockId) => !hetero.has(blockId)),
    );
    const { triggered, falseSplits } = splitStats(dna.result, homogeneous);
    assert.ok(triggered > 0, `${map}: no homogeneous block reached the split trigger`);
    assert.ok(
      falseSplits / triggered <= 0.05,
      `${map}: false-split rate ${falseSplits / triggered} > 0.05 (${falseSplits}/${triggered})`,
    );
  }
});

test('criterion 5 — split detection on Map D stays at or above the measured floor', async () => {
  const dna = await dnaRun('heterogeneous');
  const hetero = dna.catalog.heterogeneousBlockIds();
  const splitParents = new Set(dna.result.splits.map((split) => split.parent));
  const detected = hetero.filter((blockId) => splitParents.has(blockId)).length;
  // Regression floor (see R3 in the header): the pre-fix design
  // measured 0.557; the spec's 0.80 bar is asserted live below.
  assert.ok(
    detected / hetero.length >= 0.5,
    `split detection ${detected / hetero.length} regressed below the measured floor 0.50`,
  );
});

test('criterion 5 (spec) — heterogeneous split detection ≥ 0.80', async () => {
  const dna = await dnaRun('heterogeneous');
  const hetero = dna.catalog.heterogeneousBlockIds();
  const splitParents = new Set(dna.result.splits.map((split) => split.parent));
  const detected = hetero.filter((blockId) => splitParents.has(blockId)).length;
  assert.ok(
    detected / hetero.length >= 0.8,
    `split detection ${detected / hetero.length} < 0.80 (${detected}/${hetero.length})`,
  );
});

test('criterion 6 — warm start (A → A′): cold recall reached with ≤ 45% of the cold probes', async () => {
  const t0 = Date.parse('2026-11-20T00:00:00Z');
  const week = 7 * 24 * 3600 * 1000;
  const store = createReputationStore(null);

  const coldCatalog = createVirtualCatalog({ ranges: SIM_RANGES, map: 'clustered', seed: SIM_SEED });
  const coldSettings = scaledSettings(coldCatalog.blocks.length);
  const cold = await runBlockScreening({
    blocks: coldCatalog.blocks,
    settings: coldSettings,
    task: coldCatalog.task,
    concurrency: 12,
    reputation: store,
    now: t0,
  });
  const coldRecall = poolRecall(coldCatalog, cold.pool);
  assert.ok(Object.keys(store.blocks).length > 0, 'cold run left no reputation');

  const warmCatalog = createVirtualCatalog({ ranges: SIM_RANGES, map: 'drifted', seed: SIM_SEED });
  const warmBudget = Math.floor(0.45 * cold.totals.probesSpent);
  const warmSettings = scaledSettings(warmCatalog.blocks.length, {
    budgetProbes: warmBudget,
  });
  const warm = await runBlockScreening({
    blocks: warmCatalog.blocks,
    settings: warmSettings,
    task: warmCatalog.task,
    concurrency: 12,
    reputation: store,
    now: t0 + week,
  });
  const warmRecall = poolRecall(warmCatalog, warm.pool);
  assert.ok(
    warm.totals.probesSpent <= 0.45 * cold.totals.probesSpent,
    `warm run spent ${warm.totals.probesSpent} > 45% of cold ${cold.totals.probesSpent}`,
  );
  assert.ok(
    warmRecall >= coldRecall,
    `warm recall ${warmRecall} < cold recall ${coldRecall}`,
  );
  // The warm primer is cheaper than the cold one: at 7 days every known
  // block is in the confirmation tier (1 probe) instead of the full 3.
  assert.ok(
    warm.totals.primerProbes < cold.totals.primerProbes,
    `warm primer ${warm.totals.primerProbes} not cheaper than cold ${cold.totals.primerProbes}`,
  );
});

test('criterion 7 — determinism: identical seeds produce identical probe sequences', async () => {
  const sequenceHash = (catalog) => createHash('sha256')
    .update(catalog.probeLog.map((entry) => `${entry.ip}:${entry.round}`).join(','))
    .digest('hex');
  const first = await dnaRun('sparse-gems');
  const catalog = createVirtualCatalog({ ranges: SIM_RANGES, map: 'sparse-gems', seed: SIM_SEED });
  const settings = scaledSettings(catalog.blocks.length);
  const second = await runBlockScreening({
    blocks: catalog.blocks,
    settings,
    task: catalog.task,
    concurrency: 12,
  });
  assert.equal(sequenceHash(catalog), sequenceHash(first.catalog));
  assert.deepEqual(
    second.pool.map((summary) => summary.ip),
    first.result.pool.map((summary) => summary.ip),
  );
});
