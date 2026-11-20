import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBlockScreening } from '../src/hard-engine.js';
import { createDefaultSettings } from '../src/config/settings.js';
import { createLogger } from '../src/logging/logger.js';
import {
  createVirtualCatalog,
  virtualRanges,
} from './fixtures/virtual-catalog.js';

// Wave 1 transparency (plan ch. 2): the engine now emits phase-start and
// per-batch progress from its probe funnel and mirrors progress into
// the log. The hard constraint is that all of it is OBSERVER-ONLY —
// these tests pin that: with observers attached, the probe sequence
// and the serialized checkpoint state are byte-identical to a bare run.

function makeRun(seed, observers = {}) {
  const catalog = createVirtualCatalog({
    ranges: virtualRanges(8),
    map: 'clustered',
    seed,
  });
  const settings = createDefaultSettings('linux');
  settings.hard.budgetProbes = 2400;
  settings.hard.finalTop = 53;
  settings.hard.concurrency = 12;
  return runBlockScreening({
    blocks: catalog.blocks,
    settings,
    concurrency: 12,
    task: catalog.task,
    seed,
    ...observers,
  }).then((outcome) => ({ catalog, outcome }));
}

test('observer-only: progress + logging change neither probes nor state', async () => {
  const bare = await makeRun(2027);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfqoe-transp-'));
  const logger = createLogger({
    level: 'debug',
    directory,
    quiet: true,
    runId: 'observed',
  });
  const events = [];
  const observed = await makeRun(2027, {
    logger,
    onProgress: (event) => events.push(event),
    onSummary: () => {},
  });
  await logger.close();

  assert.ok(events.length > 0, 'the observed run really emitted progress');
  assert.deepEqual(
    observed.catalog.probeLog.map((entry) => entry.ip),
    bare.catalog.probeLog.map((entry) => entry.ip),
    'identical probe sequence with observers attached',
  );
  assert.equal(
    JSON.stringify(observed.outcome.blockState),
    JSON.stringify(bare.outcome.blockState),
    'identical serialized checkpoint state',
  );
  assert.deepEqual(observed.outcome.totals, bare.outcome.totals);
  assert.deepEqual(observed.outcome.summary, bare.outcome.summary);
});

test('primer emission: phase-start first, then per-batch, phase-end last', async () => {
  const events = [];
  await makeRun(2027, { onProgress: (event) => events.push(event) });

  const primer = events.filter((event) => event.phase === 'hard-primer');
  assert.ok(primer.length >= 3, 'start + at least one batch + phase-end');
  assert.equal(primer[0].completed, 0, 'phase-start announces completed 0');
  assert.ok(primer[0].total > 0);
  assert.match(primer[0].note, /blocks · skip \d+ · confirm \d+ · full \d+/);
  for (let index = 1; index < primer.length; index += 1) {
    assert.ok(
      primer[index].completed >= primer[index - 1].completed,
      'primer progress never goes backwards',
    );
  }
  assert.equal(primer.at(-1).note, 'primer phase complete');

  const coverage = events.filter(
    (event) => event.phase === 'hard-split-coverage',
  );
  assert.ok(coverage.length >= 1, 'split coverage reports too');
  assert.equal(coverage[0].completed, 0);

  const expansion = events.filter((event) => event.phase === 'hard-expansion');
  assert.ok(expansion.length >= 1, 'expansion still reports per wave');
});

test('engine progress lands in the log with the checkpoint phase vocabulary', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfqoe-transp-'));
  const logger = createLogger({
    level: 'debug',
    directory,
    quiet: true,
    runId: 'logged',
  });
  await makeRun(2027, { logger });
  await logger.close();

  const records = fs
    .readFileSync(logger.filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  records.forEach((record, index) => {
    assert.equal(record.v, 2);
    assert.equal(record.seq, index + 1);
  });

  const start = records.find((record) => record.event === 'hard.engine.start');
  assert.ok(start.blocksByTier, 'engine start carries the tier counts');
  assert.equal(
    start.blocksByTier.skip + start.blocksByTier.confirm + start.blocksByTier.full,
    start.blocks,
  );

  const progress = records.filter(
    (record) => record.event === 'hard.engine.progress',
  );
  assert.ok(progress.length > 0);
  const primerProgress = progress.filter((record) => record.phase === 'primer');
  assert.ok(primerProgress.length > 0, 'primer progress is in the log');
  for (let index = 1; index < primerProgress.length; index += 1) {
    assert.ok(
      primerProgress[index].completed >= primerProgress[index - 1].completed,
    );
  }
});
