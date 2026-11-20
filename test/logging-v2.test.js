import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLogger,
  createProgressRecorder,
  summarizeLogFile,
} from '../src/logging/logger.js';

const URI = 'vless://11111111-2222-3333-4444-555555555555@edge.example.com:2052?type=ws';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cfqoe-logv2-'));
}

function readRecords(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

test('schema v2: every record carries v, seq, elapsedMs, phase, runId', async () => {
  const directory = tempDir();
  const logger = createLogger({
    level: 'debug',
    directory,
    quiet: true,
    runId: 'schema-run',
  });
  logger.info('before-phase', {});
  logger.setPhase('primer');
  logger.info('run.start', { mode: 'hard' });
  logger.debug('hard.engine.progress', { completed: 5, total: 100 });
  logger.setPhase(null);
  logger.warn('after-phase', { error: 'x' });
  await logger.close();

  const records = readRecords(logger.filePath);
  assert.equal(records.length, 4);
  records.forEach((record, index) => {
    assert.equal(record.v, 2);
    assert.equal(record.seq, index + 1, 'seq strictly increases from 1');
    assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
    assert.equal(record.runId, 'schema-run');
    assert.ok('phase' in record);
    assert.ok(typeof record.time === 'string');
  });
  for (let index = 1; index < records.length; index += 1) {
    assert.ok(records[index].elapsedMs >= records[index - 1].elapsedMs);
  }
  assert.equal(records[0].phase, null);
  assert.equal(records[1].phase, 'primer');
  assert.equal(records[2].phase, 'primer');
  assert.equal(records[3].phase, null);
});

test('setLevel re-levels a bootstrap logger after settings load', async () => {
  const directory = tempDir();
  const logger = createLogger({
    level: 'info',
    directory,
    quiet: true,
    runId: 'relevel-run',
  });
  logger.info('settings.loaded', { source: 'file' });
  logger.setLevel('error');
  logger.warn('dropped', {});
  logger.error('kept', {});
  await logger.close();
  const records = readRecords(logger.filePath);
  assert.deepEqual(
    records.map((record) => record.event),
    ['settings.loaded', 'kept'],
  );
  assert.deepEqual(
    records.map((record) => record.seq),
    [1, 2],
    'filtered records do not consume seq',
  );
});

test('progress recorder: debug per event, info throttled per phase', () => {
  const calls = [];
  const fakeLogger = {
    setPhase: (phase) => calls.push(['phase', phase]),
    debug: (event, details) => calls.push(['debug', event, details]),
    info: (event, details) => calls.push(['info', event, details]),
  };
  const record = createProgressRecorder(fakeLogger, {
    event: 'scan.progress',
    infoIntervalMs: 10000,
  });
  record({ phase: 'screening', completed: 1, total: 10, eligible: 1, failed: 0 });
  record({ phase: 'screening', completed: 2, total: 10, eligible: 1, failed: 1 });
  record({ phase: 'tunnel', completed: 0, total: 3 });

  const debugs = calls.filter(([kind]) => kind === 'debug');
  const infos = calls.filter(([kind]) => kind === 'info');
  assert.equal(debugs.length, 3);
  assert.equal(infos.length, 2, 'first event per phase lands at info, the rest wait');
  assert.deepEqual(infos[0][2], { completed: 1, total: 10, eligible: 1, failed: 0 });
  assert.deepEqual(
    calls.filter(([kind]) => kind === 'phase').map(([, phase]) => phase),
    ['screening', 'screening', 'tunnel'],
  );
});

test('progress recorder tolerates loggers without setPhase and null loggers', () => {
  const seen = [];
  const record = createProgressRecorder(
    { debug: (event, details) => seen.push(details), info: () => {} },
    { event: 'hard.progress' },
  );
  record({ phase: 'primer', completed: 1, total: 2 });
  assert.equal(seen.length, 1);
  createProgressRecorder(null, { event: 'x' })({ phase: 'p', completed: 1 });
});

test('stream failure disables the file sink and never throws into the run', async () => {
  const directory = tempDir();
  // A directory sitting at the log file's path makes the write stream
  // fail asynchronously (EISDIR) — the portable way to force the guard.
  fs.mkdirSync(path.join(directory, 'run-broken.ndjson'));
  const logger = createLogger({
    level: 'info',
    directory,
    quiet: true,
    runId: 'broken',
  });
  logger.info('run.start', { mode: 'full' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(logger.counters.fileErrors >= 1, 'failure is counted');
  logger.info('scan.progress', { completed: 1 });
  logger.error('still-safe', {});
  await logger.close();
});

test('redaction fuzz: secrets in error messages, novel keys and arrays never reach the file', async () => {
  const directory = tempDir();
  const logger = createLogger({
    level: 'debug',
    directory,
    quiet: true,
    runId: 'fuzz',
  });
  logger.error('xray.failed', {
    error: { class: 'xray_start', message: `cannot use ${URI}` },
    link: URI,
    shareUrl: `see ${URI} please`,
    nested: [{ deep: '11111111-2222-3333-4444-555555555555' }],
  });
  await logger.close();
  const raw = fs.readFileSync(logger.filePath, 'utf8');
  assert.equal(raw.includes('vless://'), false);
  assert.equal(raw.includes('11111111-2222'), false);
});

function writeFixtureLog(lines) {
  const directory = tempDir();
  const filePath = path.join(directory, 'run-fixture.ndjson');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

// The frozen-scan regression fixture (Signal's design, test 4): the
// real incident's log — hard.start + hard.engine.start, then silence
// for 23,091 primer probes — must digest to the honest verdict that it
// carries no progress information, while a v2 log with progress
// records must say exactly where the run was last seen.
test('frozen-scan fixture: the v1 two-line log digests honestly', () => {
  const filePath = writeFixtureLog([
    JSON.stringify({
      time: '2026-11-20T10:00:00.000Z',
      runId: 'frozen',
      level: 'info',
      event: 'hard.start',
      totalCandidates: 1970432,
      ranges: 753,
      traversal: 'block-adaptive',
      blocks: 7697,
      concurrency: 12,
    }),
    JSON.stringify({
      time: '2026-11-20T10:00:01.000Z',
      runId: 'frozen',
      level: 'info',
      event: 'hard.engine.start',
      blocks: 7697,
      budgetProbes: 72000,
      concurrency: 12,
    }),
  ]);
  const summary = summarizeLogFile(filePath);
  assert.equal(summary.endStatus, 'no-progress-information');
  assert.equal(summary.lastProgress, null);
  assert.equal(summary.hasRunStart, false);
});

test('frozen-scan fixture: a v2 log with progress records says where the run stopped', () => {
  const filePath = writeFixtureLog([
    JSON.stringify({
      v: 2, time: '2026-11-20T10:00:00.000Z', elapsedMs: 0, seq: 1,
      runId: 'live', level: 'info', phase: null, event: 'run.start', mode: 'hard',
    }),
    JSON.stringify({
      v: 2, time: '2026-11-20T10:00:01.000Z', elapsedMs: 900, seq: 2,
      runId: 'live', level: 'info', phase: 'primer', event: 'hard.engine.start',
    }),
    JSON.stringify({
      v: 2, time: '2026-11-20T10:07:32.000Z', elapsedMs: 452000, seq: 3,
      runId: 'live', level: 'info', phase: 'primer',
      event: 'hard.engine.progress',
      completed: 4102, total: 23091, eligible: 311, failed: 3791,
    }),
  ]);
  const summary = summarizeLogFile(filePath);
  assert.equal(summary.endStatus, 'no-end-record');
  assert.equal(summary.hasRunStart, true);
  assert.equal(summary.lastPhase, 'primer');
  assert.deepEqual(summary.lastProgress, {
    phase: 'primer',
    completed: 4102,
    total: 23091,
    eligible: 311,
    failed: 3791,
  });
});

test('frozen-scan fixture: run.end decides the end status', () => {
  const base = [
    JSON.stringify({
      v: 2, time: '2026-11-20T10:00:00.000Z', elapsedMs: 0, seq: 1,
      runId: 'done', level: 'info', phase: null, event: 'run.start', mode: 'full',
    }),
    JSON.stringify({
      v: 2, time: '2026-11-20T10:01:00.000Z', elapsedMs: 60000, seq: 2,
      runId: 'done', level: 'info', phase: 'screening',
      event: 'scan.progress', completed: 360, total: 360, eligible: 40, failed: 320,
    }),
  ];
  const completed = summarizeLogFile(writeFixtureLog([
    ...base,
    JSON.stringify({
      v: 2, time: '2026-11-20T10:02:00.000Z', elapsedMs: 120000, seq: 3,
      runId: 'done', level: 'info', phase: null, event: 'run.end',
      status: 'completed', durationMs: 120000,
    }),
  ]));
  assert.equal(completed.endStatus, 'completed');

  const canceled = summarizeLogFile(writeFixtureLog([
    ...base,
    JSON.stringify({
      v: 2, time: '2026-11-20T10:02:00.000Z', elapsedMs: 120000, seq: 3,
      runId: 'done', level: 'info', phase: null, event: 'run.end',
      status: 'canceled', durationMs: 120000,
    }),
  ]));
  assert.equal(canceled.endStatus, 'canceled');
});

test('digest joins run.start with the calibration and reputation records (W1 gate C4)', () => {
  const filePath = writeFixtureLog([
    JSON.stringify({
      v: 2, time: '2026-11-20T10:00:00.000Z', elapsedMs: 0, seq: 1,
      runId: 'joined', level: 'info', phase: null, event: 'run.start',
      mode: 'hard', appVersion: '0.9.0',
    }),
    JSON.stringify({
      v: 2, time: '2026-11-20T10:00:05.000Z', elapsedMs: 5000, seq: 2,
      runId: 'joined', level: 'info', phase: 'calibrating', event: 'hard.calibration',
      selectedConcurrency: 12, requestedConcurrency: 16, reason: 'measured',
      controlIp: '1.1.1.1',
    }),
    JSON.stringify({
      v: 2, time: '2026-11-20T10:00:06.000Z', elapsedMs: 6000, seq: 3,
      runId: 'joined', level: 'info', phase: null, event: 'hard.reputation.loaded',
      records: 321,
    }),
    JSON.stringify({
      v: 2, time: '2026-11-20T10:00:07.000Z', elapsedMs: 7000, seq: 4,
      runId: 'joined', level: 'info', phase: 'primer', event: 'hard.engine.progress',
      completed: 100, total: 1000, eligible: 9, failed: 91,
    }),
    JSON.stringify({
      v: 2, time: '2026-11-20T10:00:17.000Z', elapsedMs: 17000, seq: 5,
      runId: 'joined', level: 'info', phase: 'primer', event: 'hard.engine.progress',
      completed: 500, total: 1000, eligible: 40, failed: 460,
    }),
    JSON.stringify({
      v: 2, time: '2026-11-20T10:00:18.000Z', elapsedMs: 18000, seq: 6,
      runId: 'joined', level: 'info', phase: 'expansion', event: 'hard.engine.progress',
      completed: 10, total: 90, eligible: 3, failed: 7,
    }),
    JSON.stringify({
      v: 2, time: '2026-11-20T10:01:00.000Z', elapsedMs: 60000, seq: 7,
      runId: 'joined', level: 'info', phase: null, event: 'hard.reputation.saved',
      blocks: 300,
    }),
    JSON.stringify({
      v: 2, time: '2026-11-20T10:01:01.000Z', elapsedMs: 61000, seq: 8,
      runId: 'joined', level: 'info', phase: null, event: 'run.end',
      status: 'completed', durationMs: 61000,
    }),
  ]);
  const summary = summarizeLogFile(filePath);
  assert.equal(summary.endStatus, 'completed');
  assert.equal(summary.mode, 'hard');
  assert.equal(summary.appVersion, '0.9.0');
  assert.deepEqual(summary.calibration, {
    selectedConcurrency: 12,
    requestedConcurrency: 16,
    reason: 'measured',
    controlIp: '1.1.1.1',
  });
  assert.deepEqual(summary.reputation, { recordsLoaded: 321, blocksSaved: 300 });
  assert.deepEqual(summary.phases, [
    { phase: 'primer', durationMs: 10000, completed: 500, total: 1000, eligible: 40, failed: 460 },
    { phase: 'expansion', durationMs: 0, completed: 10, total: 90, eligible: 3, failed: 7 },
  ]);
});

test('streaming digest: chunk boundaries and multibyte text survive intact', () => {
  // One record with a >64 KB Persian error message forces the line
  // across several read chunks, with multi-byte characters straddling
  // the boundaries; thousands of small records follow it. The digest
  // must count every record and return the message byte-for-byte.
  const longReason = 'خطای شبکه در مسیر سنجش — '.repeat(4000);
  const lines = [
    JSON.stringify({
      v: 2, time: '2026-11-20T10:00:00.000Z', elapsedMs: 0, seq: 1,
      runId: 'streamed', level: 'error', phase: null, event: 'xray.failed',
      error: { class: 'xray_start', message: longReason },
    }),
  ];
  for (let index = 0; index < 5000; index += 1) {
    lines.push(JSON.stringify({
      v: 2, time: '2026-11-20T10:00:01.000Z', elapsedMs: index, seq: index + 2,
      runId: 'streamed', level: 'debug', phase: 'primer',
      event: 'hard.engine.progress', completed: index, total: 5000,
      eligible: 0, failed: index,
    }));
  }
  const summary = summarizeLogFile(writeFixtureLog(lines));
  assert.equal(summary.total, 5001);
  assert.equal(summary.byLevel.error, 1);
  assert.equal(summary.byLevel.debug, 5000);
  assert.equal(summary.errors[0].reason, longReason);
  assert.equal(summary.lastProgress.completed, 4999);
});
