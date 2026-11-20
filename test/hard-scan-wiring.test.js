// Wiring tests for Hard Deep Scan step 6: engine dispatch, checkpoint
// v4 save/resume, the v3 honor path, report shapes, and the reputation
// lifecycle — all driven through runHardScan with the virtual catalog's
// fake probe injected via the task seam, so no test touches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runHardScan,
  hasHardScanState,
  HARD_STATE_VERSION,
} from '../src/hard-scan.js';
import { createDefaultSettings } from '../src/config/settings.js';
import { buildRangePlan } from '../src/candidate/hard-order.js';
import { buildEligibilitySummary } from '../src/report.js';
import { paths } from '../src/platform/paths.js';
import { createVirtualCatalog } from './fixtures/virtual-catalog.js';

const VLESS_URI =
  'vless://11111111-2222-3333-4444-555555555555@edge.example.com:2052?encryption=none&security=none&type=ws&host=edge.example.com&path=%2Fws#Wiring';
const RANGES = ['10.0.0.0/22'];
const LEGACY_TOTAL_KEYS = [
  'complete',
  'eligible',
  'failed',
  'highConfidence',
  'includedInReport',
  'retryQueued',
  'retryRecovered',
  'tested',
  'withBrowsing',
  'withStreaming',
];
const BLOCK_TOTAL_KEYS = [
  'probesSpent',
  'primerProbes',
  'expansionProbes',
  'reserveProbes',
  'blocksTotal',
  'blocksPrimed',
  'blocksExpanded',
  'blocksExhausted',
  'blocksByTier',
  'blocksExtended',
  'suspectsServed',
  'blocksPromoted',
  'blocksSplit',
];

const silentLogger = {
  info() {},
  debug() {},
  warn() {},
  error() {},
};

function tempLayout(ranges) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfqoe-wiring-'));
  const layout = paths(root);
  for (const directory of [
    layout.data,
    layout.results,
    layout.hardScanDir,
    path.dirname(layout.rangesFile),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(layout.rangesFile, `${ranges.join('\n')}\n`);
  return layout;
}

function makeSettings(hardOverrides = {}) {
  const settings = createDefaultSettings('linux');
  settings.calibration.enabled = false;
  settings.tunnel.enabled = false;
  Object.assign(settings.hard, { concurrency: 4 }, hardOverrides);
  return settings;
}

function readNdjsonIps(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line).ip);
}

test('buildEligibilitySummary adds a block key only when one is passed', () => {
  const observations = [
    { ok: true, handshakeMs: 120, connectMs: 40, cfRay: 'x-FRA', colo: 'FRA', error: null },
  ];
  const plain = buildEligibilitySummary({
    ip: '10.0.0.1',
    range: '10.0.0.0/22',
    eligibility: observations,
  });
  assert.ok(!('block' in plain));
  const tagged = buildEligibilitySummary({
    ip: '10.0.0.1',
    range: '10.0.0.0/22',
    eligibility: observations,
    block: '10.0.0.0/24',
  });
  assert.equal(tagged.block, '10.0.0.0/24');
});

test(
  'dispatch: hard.engine "blocks" runs the block-adaptive engine and reports block totals',
  { timeout: 60000 },
  async () => {
    const layout = tempLayout(RANGES);
    const catalog = createVirtualCatalog({ ranges: RANGES, map: 'clustered', seed: 7 });
    const result = await runHardScan({
      vlessUri: VLESS_URI,
      settings: makeSettings({ engine: 'blocks', budgetProbes: 400 }),
      layout,
      logger: silentLogger,
      runId: 'wiring-blocks',
      task: catalog.task,
    });
    assert.equal(result.canceled, false);
    assert.equal(result.report.schema, 10);
    assert.equal(result.report.traversal, 'block-adaptive');
    for (const key of BLOCK_TOTAL_KEYS) {
      assert.ok(key in result.report.totals, `totals.${key} present`);
    }
    assert.deepEqual(
      Object.keys(result.report.totals).sort(),
      [...LEGACY_TOTAL_KEYS, ...BLOCK_TOTAL_KEYS].sort(),
    );
    assert.ok(result.report.totals.probesSpent > 0);
    assert.ok(result.report.totals.probesSpent <= 400);
    assert.equal(result.report.totals.blocksTotal, 4);
    assert.deepEqual(Object.keys(result.report.totals.blocksByTier).sort(), [
      'confirm',
      'full',
      'skip',
    ]);
    assert.ok(result.report.results.length > 0);
    assert.ok(
      result.report.results.every((entry) => typeof entry.block === 'string'),
    );
    // A completed run removes its live checkpoint.
    assert.equal(hasHardScanState(layout), false);
  },
);

test(
  'dispatch: the legacy engine keeps its exact report shape (no block keys anywhere)',
  { timeout: 60000 },
  async () => {
    const layout = tempLayout(RANGES);
    const catalog = createVirtualCatalog({ ranges: RANGES, map: 'clustered', seed: 7 });
    const result = await runHardScan({
      vlessUri: VLESS_URI,
      settings: makeSettings({ engine: 'round-robin' }),
      layout,
      logger: silentLogger,
      runId: 'wiring-legacy',
      task: catalog.task,
    });
    assert.equal(result.canceled, false);
    assert.equal(result.report.schema, 10);
    assert.equal(result.report.traversal, 'range-round-robin');
    assert.deepEqual(
      Object.keys(result.report.totals).sort(),
      [...LEGACY_TOTAL_KEYS].sort(),
    );
    assert.ok(result.report.results.length > 0);
    assert.ok(result.report.results.every((entry) => !('block' in entry)));
    assert.equal(hasHardScanState(layout), false);
    // The legacy path never touches the reputation store.
    assert.equal(fs.existsSync(layout.reputationFile), false);
  },
);

test(
  'v4 checkpoint: cancel persists engine state, resume continues deterministically, reputation follows completion only',
  { timeout: 60000 },
  async () => {
    const layout = tempLayout(RANGES);
    const catalog = createVirtualCatalog({ ranges: RANGES, map: 'clustered', seed: 99 });
    let sigintSent = false;
    const partOne = await runHardScan({
      vlessUri: VLESS_URI,
      settings: makeSettings({ engine: 'blocks', budgetProbes: 600 }),
      layout,
      logger: silentLogger,
      runId: 'wiring-part',
      task: catalog.task,
      onProgress: (event) => {
        if (event.phase === 'hard-primer' && !sigintSent) {
          sigintSent = true;
          process.emit('SIGINT');
        }
      },
    });
    assert.equal(partOne.canceled, true);
    assert.equal(hasHardScanState(layout), true);
    const saved = JSON.parse(fs.readFileSync(layout.hardStateFile, 'utf8'));
    assert.equal(saved.version, HARD_STATE_VERSION);
    assert.equal(saved.version, 4);
    assert.equal(saved.engine, 'blocks');
    assert.equal(saved.traversal, 'block-adaptive');
    assert.equal(saved.status, 'paused');
    assert.equal(saved.phase, 'primer');
    assert.equal(saved.cursor, null);
    assert.ok(saved.blockState);
    assert.ok(saved.blockState.blocks.length >= 4);
    assert.ok(saved.counts.primerProbes > 0);
    assert.equal(typeof saved.catalogHash, 'string');
    // A canceled run must not create or update the reputation file:
    // the engine merges only on natural completion.
    assert.equal(fs.existsSync(layout.reputationFile), false);
    const partOneIps = readNdjsonIps(saved.files.eligibilityFile);
    assert.ok(partOneIps.length > 0);

    const partTwo = await runHardScan({
      vlessUri: VLESS_URI,
      settings: makeSettings({ engine: 'blocks', budgetProbes: 600 }),
      layout,
      logger: silentLogger,
      runId: 'wiring-part-resume',
      resume: true,
      task: catalog.task,
    });
    assert.equal(partTwo.canceled, false);
    assert.equal(partTwo.report.traversal, 'block-adaptive');
    assert.equal(hasHardScanState(layout), false);
    // Natural completion saved the reputation store the engine merged.
    assert.equal(fs.existsSync(layout.reputationFile), true);
    const store = JSON.parse(fs.readFileSync(layout.reputationFile, 'utf8'));
    assert.equal(store.version, 1);
    assert.ok(Object.keys(store.blocks).length > 0);

    // Deterministic continuation: the interrupted run's eligibility
    // NDJSON is a strict prefix of the resumed run's, and the combined
    // screening sequence equals an uninterrupted run's exactly.
    const resumedIps = readNdjsonIps(saved.files.eligibilityFile);
    assert.deepEqual(resumedIps.slice(0, partOneIps.length), partOneIps);
    assert.ok(resumedIps.length > partOneIps.length);

    const fullLayout = tempLayout(RANGES);
    const fullCatalog = createVirtualCatalog({
      ranges: RANGES,
      map: 'clustered',
      seed: 99,
    });
    const full = await runHardScan({
      vlessUri: VLESS_URI,
      settings: makeSettings({ engine: 'blocks', budgetProbes: 600 }),
      layout: fullLayout,
      logger: silentLogger,
      runId: 'wiring-full',
      task: fullCatalog.task,
    });
    assert.equal(full.canceled, false);
    const fullState = JSON.parse(
      fs.readFileSync(
        path.join(fullLayout.hardScanDir, 'run-wiring-full.state.json'),
        'utf8',
      ),
    );
    assert.deepEqual(resumedIps, readNdjsonIps(fullState.files.eligibilityFile));
    assert.equal(
      partTwo.report.totals.probesSpent,
      full.report.totals.probesSpent,
    );
  },
);

test(
  'a v3 checkpoint resumes and finishes on the legacy engine even when settings ask for blocks',
  { timeout: 60000 },
  async () => {
    const layout = tempLayout(RANGES);
    const catalog = createVirtualCatalog({ ranges: RANGES, map: 'clustered', seed: 5 });
    const runId = 'wiring-v3';
    const basePath = path.join(layout.hardScanDir, `run-${runId}`);
    const plan = buildRangePlan(RANGES);
    const v3State = {
      version: 3,
      runId,
      mode: 'hard',
      traversal: 'range-round-robin',
      execution: 'parallel-batched',
      status: 'paused',
      startedAt: new Date().toISOString(),
      target: { description: 'v3 fixture' },
      settings: {},
      total: plan.total,
      rangesCount: RANGES.length,
      cursor: { rangeIndex: 0, passIndex: 0 },
      counts: {
        tested: 0,
        eligible: 0,
        failed: 0,
        retryQueued: 0,
        retryRecovered: 0,
      },
      files: {
        eligibilityFile: `${basePath}.eligibility.ndjson`,
        retryFile: `${basePath}.retry.ndjson`,
        snapshotJson: `${basePath}.partial.json`,
        snapshotTxt: `${basePath}.partial.txt`,
        archiveStateFile: `${basePath}.state.json`,
      },
      topEligibility: [],
    };
    fs.writeFileSync(
      layout.hardStateFile,
      `${JSON.stringify(v3State, null, 2)}\n`,
    );
    const result = await runHardScan({
      vlessUri: VLESS_URI,
      settings: makeSettings({ engine: 'blocks' }),
      layout,
      logger: silentLogger,
      runId: 'wiring-v3-resume',
      resume: true,
      task: catalog.task,
    });
    assert.equal(result.canceled, false);
    // The checkpoint's engine wins over the current setting.
    assert.equal(result.report.traversal, 'range-round-robin');
    assert.deepEqual(
      Object.keys(result.report.totals).sort(),
      [...LEGACY_TOTAL_KEYS].sort(),
    );
    assert.equal(hasHardScanState(layout), false);
    assert.equal(fs.existsSync(layout.reputationFile), false);
  },
);
