// Logger subscriber sink + ring buffer (0.9.0 W3, LOGGING §3.3):
// one pipeline — file, stderr, subscribe — with redaction applied
// once, before any sink sees a record. The web UI's SSE bridge is
// the consumer; these tests pin the logger-side contract it relies
// on: fan-out parity with the file, per-subscriber level filters, a
// throwing subscriber isolated and dropped, and a bounded replay
// ring for late joiners. Nothing here may ever block or throw into
// the scan that is being logged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, LOG_RING_LIMIT } from '../src/logging/logger.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cfqoe-subscribe-'));
}

function readRecords(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

test('fan-out parity: a subscriber receives exactly the file records, in order', async () => {
  const directory = tempDir();
  const logger = createLogger({ level: 'debug', directory, runId: 'parity', quiet: true });
  const received = [];
  logger.subscribe((record) => received.push(record));
  logger.debug('alpha', { n: 1 });
  logger.info('beta', { n: 2 });
  logger.warn('gamma', { n: 3 });
  logger.error('delta', { n: 4 });
  await logger.close();
  const filed = readRecords(logger.filePath);
  assert.equal(filed.length, 4);
  assert.deepEqual(
    received.map((r) => [r.seq, r.event, r.level]),
    filed.map((r) => [r.seq, r.event, r.level]),
  );
  // Same objects the file serialized — one redaction, one truth.
  assert.deepEqual(JSON.parse(JSON.stringify(received)), filed);
});

test('subscribers see redacted records only (the URI never reaches a sink)', async () => {
  const logger = createLogger({ level: 'debug', directory: null, runId: 'redact', quiet: true });
  const received = [];
  logger.subscribe((record) => received.push(record));
  logger.info('config.import', {
    uri: 'vless://11111111-2222-3333-4444-555555555555@edge.example.com:443?encryption=none#x',
    note: 'stored vless://11111111-2222-3333-4444-555555555555@edge.example.com',
  });
  assert.equal(received.length, 1);
  const serialized = JSON.stringify(received[0]);
  assert.ok(!serialized.includes('11111111-2222-3333-4444-555555555555'));
  assert.ok(!serialized.includes('vless://'));
  await logger.close();
});

test('minLevel filters per subscriber; the logger threshold still applies first', async () => {
  const logger = createLogger({ level: 'info', directory: null, runId: 'levels', quiet: true });
  const all = [];
  const warnings = [];
  logger.subscribe((record) => all.push(record.event));
  logger.subscribe((record) => warnings.push(record.event), { minLevel: 'warn' });
  logger.debug('below-threshold');
  logger.info('kept-info');
  logger.warn('kept-warn');
  logger.error('kept-error');
  assert.deepEqual(all, ['kept-info', 'kept-warn', 'kept-error']);
  assert.deepEqual(warnings, ['kept-warn', 'kept-error']);
  await logger.close();
});

test('a throwing subscriber is isolated and unsubscribed; logging never throws', async () => {
  const logger = createLogger({ level: 'debug', directory: null, runId: 'thrower', quiet: true });
  let badCalls = 0;
  const good = [];
  logger.subscribe(() => {
    badCalls += 1;
    throw new Error('observer bug');
  });
  logger.subscribe((record) => good.push(record.event));
  logger.info('one');
  logger.info('two');
  assert.equal(badCalls, 1, 'throwing subscriber dropped after its first failure');
  assert.deepEqual(good, ['one', 'two']);
  await logger.close();
});

test('unsubscribe stops delivery and is idempotent', async () => {
  const logger = createLogger({ level: 'debug', directory: null, runId: 'unsub', quiet: true });
  const received = [];
  const unsubscribe = logger.subscribe((record) => received.push(record.event));
  logger.info('before');
  unsubscribe();
  unsubscribe();
  logger.info('after');
  assert.deepEqual(received, ['before']);
  await logger.close();
});

test('the ring keeps the newest LOG_RING_LIMIT records, oldest first', async () => {
  const logger = createLogger({ level: 'debug', directory: null, runId: 'ring', quiet: true });
  const total = LOG_RING_LIMIT + 25;
  for (let index = 0; index < total; index += 1) logger.debug('tick', { index });
  const recent = logger.recent();
  assert.equal(recent.length, LOG_RING_LIMIT);
  assert.equal(recent[0].seq, 26);
  assert.equal(recent.at(-1).seq, total);
  const tail = logger.recent(3);
  assert.deepEqual(tail.map((record) => record.seq), [total - 2, total - 1, total]);
  assert.deepEqual(logger.recent(0), []);
  await logger.close();
});
