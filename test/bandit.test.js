import test from 'node:test';
import assert from 'node:assert/strict';
import {
  wilsonUcbIndex,
  rankBlocks,
  isExpansionEligible,
  allocateWave,
  isBudgetExhausted,
  evaluateMarginalGain,
  fisherExactTwoSided,
  shouldSplitBlock,
} from '../src/measurement/bandit.js';
import { wilsonInterval } from '../src/measurement/confidence.js';

function blockState(overrides = {}) {
  return {
    blockIndex: 0,
    base: 0,
    range: '203.0.113.0/24',
    successes: 0,
    attempts: 0,
    probed: 0,
    usable: 254,
    hardDead: false,
    ...overrides,
  };
}

function grantsByIndex(allocations) {
  return new Map(allocations.map((entry) => [entry.blockIndex, entry.probes]));
}

test('wilsonUcbIndex is the Wilson upper bound at default exploration', () => {
  assert.equal(wilsonUcbIndex(3, 3), wilsonInterval(3, 3).upper);
  assert.equal(wilsonUcbIndex(3, 3), 1);
  assert.equal(wilsonUcbIndex(0, 3), wilsonInterval(0, 3).upper);
  assert.equal(wilsonUcbIndex(0, 0), 1);
});

test('wilsonUcbIndex rewards evidence and shrinks with attempts', () => {
  assert.ok(wilsonUcbIndex(5, 10) > wilsonUcbIndex(4, 10));
  assert.ok(wilsonUcbIndex(9, 10) < wilsonUcbIndex(3, 3));
  assert.equal(wilsonUcbIndex(1, 4, 0), 0.25);
  assert.equal(wilsonUcbIndex(2, 5), wilsonUcbIndex(2, 5, 1));
});

test('rankBlocks orders by index, then attempts, then base', () => {
  const weak = blockState({ blockIndex: 3, base: 3000, successes: 1, attempts: 10 });
  const strong = blockState({ blockIndex: 2, base: 2000, successes: 9, attempts: 10 });
  const perfect = blockState({ blockIndex: 1, base: 1000, successes: 3, attempts: 3 });
  const unprobed = blockState({ blockIndex: 0, base: 0 });
  const ranked = rankBlocks([weak, strong, perfect, unprobed]);
  assert.deepEqual(ranked.map((state) => state.blockIndex), [0, 1, 2, 3]);
  assert.equal(ranked[0].index, 1);
});

test('rankBlocks does not mutate its inputs', () => {
  const states = [
    blockState({ blockIndex: 1, base: 1000, successes: 3, attempts: 3 }),
    blockState({ blockIndex: 0, base: 0 }),
  ];
  rankBlocks(states);
  assert.equal(states[0].blockIndex, 1);
  assert.ok(!('index' in states[0]));
  assert.ok(!('index' in states[1]));
});

test('isExpansionEligible enforces depth, hard-dead, and threshold', () => {
  const alive = blockState({ successes: 3, attempts: 3, probed: 3 });
  assert.equal(isExpansionEligible(alive), true);
  assert.equal(isExpansionEligible(blockState({ hardDead: true, successes: 3, attempts: 3 })), false);
  assert.equal(isExpansionEligible(blockState({ successes: 3, attempts: 32, probed: 32 })), false);
  const cold = blockState({ successes: 0, attempts: 10, probed: 10 });
  assert.equal(isExpansionEligible(cold, { threshold: 0.5 }), false);
  assert.equal(isExpansionEligible(alive, { threshold: 0.5 }), true);
});

test('allocateWave fills the wave in chunks of 4 per pass', () => {
  const states = [];
  for (let index = 0; index < 10; index += 1) {
    states.push(blockState({
      blockIndex: index,
      base: index * 256,
      successes: 3,
      attempts: 3,
      probed: 3,
    }));
  }
  const even = grantsByIndex(allocateWave(states, { waveSize: 120 }));
  assert.equal([...even.values()].reduce((sum, probes) => sum + probes, 0), 120);
  assert.ok([...even.values()].every((probes) => probes === 12));

  const partial = grantsByIndex(allocateWave(states, { waveSize: 30 }));
  assert.equal([...partial.values()].reduce((sum, probes) => sum + probes, 0), 30);
  assert.equal(partial.get(0), 4);
  assert.equal(partial.get(7), 2);
  assert.equal(partial.has(8), false);
});

test('allocateWave never exceeds the per-block depth cap', () => {
  const nearlyDone = blockState({ successes: 3, attempts: 31, probed: 31 });
  const allocations = allocateWave([nearlyDone], { waveSize: 100 });
  assert.deepEqual(allocations, [{ blockIndex: 0, probes: 1 }]);
});

test('allocateWave excludes hard-dead and below-threshold blocks', () => {
  const dead = blockState({ blockIndex: 0, hardDead: true, successes: 3, attempts: 3, probed: 3 });
  assert.deepEqual(allocateWave([dead], { waveSize: 10 }), []);
  const cold = blockState({ blockIndex: 1, successes: 0, attempts: 10, probed: 10 });
  const hot = blockState({ blockIndex: 2, base: 512, successes: 3, attempts: 3, probed: 3 });
  const allocations = allocateWave([cold, hot], { waveSize: 10, threshold: 0.5 });
  assert.deepEqual(allocations, [{ blockIndex: 2, probes: 10 }]);
});

test('allocateWave caps any one range at 25% of the wave', () => {
  const states = [];
  for (let rangeIndex = 0; rangeIndex < 5; rangeIndex += 1) {
    for (let blockInRange = 0; blockInRange < 4; blockInRange += 1) {
      const index = rangeIndex * 4 + blockInRange;
      states.push(blockState({
        blockIndex: index,
        base: index * 256,
        range: `203.0.${rangeIndex}.0/24`,
        successes: 3,
        attempts: 3,
        probed: 3,
      }));
    }
  }
  const allocations = allocateWave(states, { waveSize: 100 });
  assert.equal(allocations.reduce((sum, entry) => sum + entry.probes, 0), 100);
  const firstRangeTotal = allocations
    .filter((entry) => entry.blockIndex < 4)
    .reduce((sum, entry) => sum + entry.probes, 0);
  assert.equal(firstRangeTotal, 25);
});

test('range cap is waived when fewer than four ranges are eligible', () => {
  const states = [];
  for (let index = 0; index < 12; index += 1) {
    states.push(blockState({
      blockIndex: index,
      base: index * 256,
      range: index < 10 ? '203.0.113.0/24' : '198.51.100.0/24',
      successes: 3,
      attempts: 3,
      probed: 3,
    }));
  }
  const allocations = allocateWave(states, { waveSize: 100 });
  assert.equal(allocations.reduce((sum, entry) => sum + entry.probes, 0), 100);
  const dominantRangeTotal = allocations
    .filter((entry) => entry.blockIndex < 10)
    .reduce((sum, entry) => sum + entry.probes, 0);
  assert.ok(dominantRangeTotal > 25);
});

test('parked blocks yield to eligible ones and re-enter residually', () => {
  const parkedState = blockState({
    blockIndex: 9, base: 2304, successes: 0, attempts: 10, probed: 10,
  });
  const hot = blockState({ blockIndex: 1, base: 256, successes: 3, attempts: 3, probed: 3 });
  const filled = grantsByIndex(allocateWave([parkedState, hot], { waveSize: 8 }));
  assert.equal(filled.get(1), 8);
  assert.equal(filled.has(9), false);

  const drained = blockState({
    blockIndex: 2, base: 512, successes: 3, attempts: 30, probed: 30,
  });
  const residual = grantsByIndex(allocateWave([parkedState, drained], { waveSize: 40 }));
  assert.equal(residual.get(2), 2);
  assert.equal(residual.get(9), 22);
});

test('allocateWave with no eligible blocks returns nothing', () => {
  assert.deepEqual(allocateWave([], { waveSize: 10 }), []);
  assert.deepEqual(allocateWave([blockState({})], { waveSize: 0 }), []);
});

test('budget exhaustion is a plain spent >= cap check', () => {
  assert.equal(isBudgetExhausted({ probesSpent: 71999, budgetProbes: 72000 }), false);
  assert.equal(isBudgetExhausted({ probesSpent: 72000, budgetProbes: 72000 }), true);
  assert.equal(isBudgetExhausted({ probesSpent: 72001, budgetProbes: 72000 }), true);
});

test('marginal gain stop needs two consecutive low-gain waves', () => {
  const first = evaluateMarginalGain({ bestIndex: 0.4, threshold: 0.5, consecutiveLowWaves: 0 });
  assert.deepEqual(first, { lowGain: true, consecutiveLowWaves: 1, shouldStop: false });
  const second = evaluateMarginalGain({
    bestIndex: 0.4, threshold: 0.5, consecutiveLowWaves: first.consecutiveLowWaves,
  });
  assert.deepEqual(second, { lowGain: true, consecutiveLowWaves: 2, shouldStop: true });
  const recovered = evaluateMarginalGain({
    bestIndex: 0.6, threshold: 0.5, consecutiveLowWaves: second.consecutiveLowWaves,
  });
  assert.deepEqual(recovered, { lowGain: false, consecutiveLowWaves: 0, shouldStop: false });
});

test('fisher exact matches the spec worked examples', () => {
  const cleanSplit = fisherExactTwoSided({
    lowerSuccesses: 4, lowerAttempts: 4, upperSuccesses: 0, upperAttempts: 4,
  });
  assert.ok(Math.abs(cleanSplit - 2 / 70) < 1e-9);
  const tooThin = fisherExactTwoSided({
    lowerSuccesses: 3, lowerAttempts: 3, upperSuccesses: 0, upperAttempts: 3,
  });
  assert.ok(Math.abs(tooThin - 0.1) < 1e-9);
  const oneLeak = fisherExactTwoSided({
    lowerSuccesses: 4, lowerAttempts: 4, upperSuccesses: 1, upperAttempts: 4,
  });
  assert.ok(Math.abs(oneLeak - 8 / 56) < 1e-9);
});

test('split predicate fires only on gross, well-evidenced heterogeneity', () => {
  assert.equal(shouldSplitBlock({
    lowerSuccesses: 4, lowerAttempts: 4, upperSuccesses: 0, upperAttempts: 4,
  }), true);
  // Six probes cannot carry the conclusion (p = 0.1000, halves < 4).
  assert.equal(shouldSplitBlock({
    lowerSuccesses: 3, lowerAttempts: 3, upperSuccesses: 0, upperAttempts: 3,
  }), false);
  // One success in the cold half breaks significance (p = 0.1429).
  assert.equal(shouldSplitBlock({
    lowerSuccesses: 4, lowerAttempts: 4, upperSuccesses: 1, upperAttempts: 4,
  }), false);
  // A thin half blocks the split even at a clean-looking p-value.
  assert.equal(shouldSplitBlock({
    lowerSuccesses: 4, lowerAttempts: 4, upperSuccesses: 0, upperAttempts: 3,
  }), false);
  // Statistically real but too small to matter: effect floor rejects it.
  assert.equal(shouldSplitBlock({
    lowerSuccesses: 30, lowerAttempts: 40, upperSuccesses: 17, upperAttempts: 40,
  }), false);
});
