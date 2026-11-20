import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/logging/logger.js';
import { emitRunStart, emitRunEnd } from '../src/logging/lifecycle.js';
import {
  loadSettings,
  SETTINGS_VERSION,
} from '../src/config/settings.js';
import { VERSION } from '../src/version.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cfqoe-lifecycle-'));
}

function readRecords(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function captureLogger() {
  const records = [];
  return {
    records,
    counters: { debug: 0, info: 0, warn: 0, error: 0, fileErrors: 0 },
    info: (event, details) => records.push({ level: 'info', event, ...details }),
    warn: (event, details) => records.push({ level: 'warn', event, ...details }),
  };
}

test('bootstrap: a missing settings file is recorded as a defaults load', () => {
  const logger = captureLogger();
  const settings = loadSettings(path.join(tempDir(), 'settings.json'), { logger });
  assert.equal(settings.version, SETTINGS_VERSION);
  assert.deepEqual(
    logger.records.map((record) => record.event),
    ['settings.loaded'],
  );
  assert.equal(logger.records[0].source, 'defaults');
  assert.equal(logger.records[0].reason, 'no-file');
});

test('bootstrap: a v6 settings file records its migration', () => {
  const directory = tempDir();
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ version: 6, hard: { saveEvery: 7 } }));
  const logger = captureLogger();
  const settings = loadSettings(file, { logger });
  assert.equal(settings.hard.saveEvery, 7);
  assert.equal(settings.version, SETTINGS_VERSION);
  assert.deepEqual(
    logger.records.map((record) => record.event),
    ['settings.migrated', 'settings.loaded'],
  );
  assert.equal(logger.records[0].from, 6);
  assert.equal(logger.records[0].to, SETTINGS_VERSION);
  assert.equal(logger.records[1].source, 'file');
});

test('bootstrap: a corrupt settings file warns with a standardized error', () => {
  const directory = tempDir();
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(file, '{ not json');
  const logger = captureLogger();
  const settings = loadSettings(file, { logger });
  assert.equal(settings.version, SETTINGS_VERSION);
  assert.equal(logger.records.length, 1);
  assert.equal(logger.records[0].level, 'warn');
  assert.equal(logger.records[0].event, 'settings.loaded');
  assert.equal(logger.records[0].source, 'defaults');
  assert.equal(logger.records[0].error.class, 'settings_load');
  assert.equal(typeof logger.records[0].error.message, 'string');
});

test('run lifecycle: start carries versions and mode, end carries status and counters', async () => {
  const directory = tempDir();
  const logger = createLogger({
    level: 'info',
    directory,
    quiet: true,
    runId: 'lifecycle-run',
  });
  const startedAt = Date.now();
  emitRunStart(logger, { mode: 'hard', resume: true });
  logger.info('hard.start', { blocks: 7697 });
  emitRunEnd(logger, {
    status: 'canceled',
    startedAt,
    totals: { eligible: 12, stoppedReason: 'canceled' },
  });
  await logger.close();

  const records = readRecords(logger.filePath);
  assert.deepEqual(
    records.map((record) => record.event),
    ['run.start', 'hard.start', 'run.end'],
  );
  const [start, , end] = records;
  assert.equal(start.appVersion, VERSION);
  assert.equal(start.settingsVersion, SETTINGS_VERSION);
  assert.equal(start.mode, 'hard');
  assert.equal(start.resume, true);
  assert.equal(typeof start.platform, 'string');
  assert.equal(typeof start.nodeVersion, 'string');
  assert.equal(end.status, 'canceled');
  assert.ok(Number.isFinite(end.durationMs) && end.durationMs >= 0);
  assert.equal(end.eligible, 12);
  assert.equal(end.stoppedReason, 'canceled');
  // The counters snapshot predates run.end itself: two info records
  // (run.start + hard.start) were written before it.
  assert.equal(end.counters.info, 2);
});
