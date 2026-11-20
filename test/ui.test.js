import test from 'node:test';
import assert from 'node:assert/strict';
import {
  phaseLabel,
  formatDurationMs,
  stoppedReasonText,
  hardRunSummaryLines,
  catalogLine,
} from '../src/ui.js';

test('phaseLabel maps internal phases to plain language, raw fallback', () => {
  assert.equal(phaseLabel('hard-primer'), 'Primer (blocks)');
  assert.equal(phaseLabel('hard-split-coverage'), 'Split coverage');
  assert.equal(phaseLabel('hard-coverage'), 'Split coverage');
  assert.equal(phaseLabel('hard-finalize'), 'Final QoE');
  assert.equal(phaseLabel('calibrating'), 'Calibrating');
  assert.equal(phaseLabel('some-future-phase'), 'some-future-phase');
});

test('formatDurationMs renders mm:ss, then h:mm:ss', () => {
  assert.equal(formatDurationMs(0), '0:00');
  assert.equal(formatDurationMs(65000), '1:05');
  assert.equal(formatDurationMs(599000), '9:59');
  assert.equal(formatDurationMs(3661000), '1:01:01');
  assert.equal(formatDurationMs(36000000), '10:00:00');
});

test('stoppedReasonText covers the engine vocabulary', () => {
  assert.equal(stoppedReasonText('budget'), 'probe budget exhausted');
  assert.equal(stoppedReasonText('marginal-gain'), 'marginal gain too low');
  assert.equal(stoppedReasonText('exhausted'), 'catalog exhausted');
  assert.equal(stoppedReasonText('canceled'), 'stopped by user');
  assert.equal(stoppedReasonText('completed'), 'completed');
  assert.equal(stoppedReasonText('novel'), 'novel');
});

// Menu and CLI both render the catalog line through catalogLine, so
// pinning the shared helper pins the parity between the surfaces.
test('catalog line: blocks engine states blocks, IPs, ranges, budget', () => {
  assert.equal(
    catalogLine({
      engine: 'blocks',
      blocks: 7697,
      totalCandidates: 1970432,
      ranges: 753,
      budgetProbes: 72000,
    }),
    'Catalog: 7697 blocks · 1970432 IPs · 753 ranges · probe budget 72000',
  );
  assert.equal(
    catalogLine({
      engine: 'legacy',
      blocks: null,
      totalCandidates: 1970432,
      ranges: 753,
      budgetProbes: null,
    }),
    'Catalog: 1970432 IPs · 753 ranges (legacy round-robin)',
  );
});

test('hard summary: block-adaptive run reports probes, blocks, stop reason', () => {
  const lines = hardRunSummaryLines(
    {
      eligibleCount: 42,
      canceled: false,
      stoppedReason: 'budget',
      reputationSaved: true,
      reputationBlocks: 7697,
      xray: { enabled: false, reason: 'xray_not_found' },
      report: {
        totals: {
          complete: 3,
          partial: 1,
          probesSpent: 72000,
          primerProbes: 23091,
          expansionProbes: 41000,
          reserveProbes: 7909,
          blocksTotal: 7697,
          blocksPrimed: 7600,
          blocksExpanded: 210,
          blocksExhausted: 90,
          blocksSplit: 12,
          blocksByTier: { skip: 100, confirm: 200, full: 7397 },
        },
      },
    },
    { elapsedMs: 3661000 },
  );
  const text = lines.join('\n');
  assert.match(text, /Eligible IPs so far: 42/);
  assert.match(text, /QoE evidence: 3 complete, 1 partial/);
  assert.match(text, /Probes: 72000 spent \(primer 23091 · expansion 41000 · split coverage 7909\)/);
  assert.match(text, /Blocks: 7697 total · 7600 primed · 210 expanded · 90 exhausted · 12 split/);
  assert.match(text, /tiers: skip 100 · confirm 200 · full 7397/);
  assert.match(text, /Stopped: probe budget exhausted/);
  assert.match(text, /Elapsed: 1:01:01/);
  assert.match(text, /Block reputation: saved \(7697 blocks\)/);
  assert.match(text, /Tunnel stage skipped: xray_not_found/);
});

test('hard summary: legacy run omits block lines and the reputation line', () => {
  const lines = hardRunSummaryLines({
    eligibleCount: 5,
    canceled: true,
    report: { totals: { complete: 0, partial: 0 } },
    xray: { enabled: true, reason: null },
  });
  const text = lines.join('\n');
  assert.match(text, /Eligible IPs so far: 5/);
  assert.match(text, /Stopped: stopped by user/);
  assert.doesNotMatch(text, /Probes:/);
  assert.doesNotMatch(text, /Blocks:/);
  assert.doesNotMatch(text, /reputation/);
  assert.doesNotMatch(text, /Tunnel stage skipped/);
});
