import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOG_RETENTION,
  createLogger,
  pruneRunLogs,
} from '../src/logging/logger.js';

// Retention (Signal §3.5, W5): newest 20 run files AND a total size
// cap (50 MB desktop / 20 MB Android), whichever bites first; the
// current run's file is never pruned. Fixtures are fabricated files
// with controlled sizes and mtimes — no logger needs to write 50 MB
// for the policy to be pinned.

const MIB = 1024 * 1024;
const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

// The byte-cap fixtures are tens of megabytes each; every directory
// created here is registered and removed when the file finishes, so
// repeated suite runs cannot fill the temp volume.
const createdDirs = [];
after(() => {
  for (const directory of createdDirs) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfqoe-retention-'));
  createdDirs.push(directory);
  return directory;
}

// Writes `count` run-log files, oldest first in `names` order, each
// `sizeBytes` long, with mtimes one minute apart starting at BASE_TIME.
function fabricate(directory, count, sizeBytes) {
  const names = [];
  for (let index = 0; index < count; index += 1) {
    const name = `run-fabricated-${String(index).padStart(2, '0')}.ndjson`;
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, Buffer.alloc(sizeBytes, 0x61));
    const when = new Date(BASE_TIME + index * 60000);
    fs.utimesSync(filePath, when, when);
    names.push(name);
  }
  return names;
}

function remaining(directory) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.ndjson'))
    .sort();
}

test('count cap: 25 fabricated runs prune to the newest 20', () => {
  const directory = tempDir();
  const names = fabricate(directory, 25, 128);
  const removed = pruneRunLogs(directory, { platform: 'linux' });
  assert.equal(removed.length, 5);
  assert.deepEqual(remaining(directory), names.slice(5));
});

test('the current file is never pruned — even when it is the oldest', () => {
  const directory = tempDir();
  const names = fabricate(directory, 25, 128);
  const currentFile = path.join(directory, names[0]);
  const removed = pruneRunLogs(directory, { currentFile, platform: 'linux' });
  assert.ok(fs.existsSync(currentFile), 'the current run survives');
  assert.equal(removed.length, 5, 'the count cap still bites the rest');
  assert.equal(remaining(directory).length, LOG_RETENTION.maxFiles);
  assert.ok(remaining(directory).includes(names[0]));
});

test('size cap: the Android 20 MB cap bites before the count cap', () => {
  const directory = tempDir();
  // 10 files x 3 MB: count (10 < 20) never binds; bytes decide.
  fabricate(directory, 10, 3 * MIB);
  const removed = pruneRunLogs(directory, { platform: 'android' });
  const kept = remaining(directory);
  const keptBytes = kept.reduce(
    (sum, name) => sum + fs.statSync(path.join(directory, name)).size,
    0,
  );
  assert.ok(removed.length > 0, 'the size cap removed something');
  assert.ok(keptBytes <= LOG_RETENTION.maxBytesAndroid, `kept ${keptBytes} bytes within the Android cap`);
  assert.equal(kept.length, 6, 'six 3 MB files fit under 20 MB; the seventh does not');
});

test('size cap: the desktop 50 MB cap admits what Android rejects', () => {
  const directory = tempDir();
  fabricate(directory, 10, 3 * MIB);
  const removed = pruneRunLogs(directory, { platform: 'linux' });
  assert.equal(removed.length, 0, '30 MB total is within the desktop cap');
  assert.equal(remaining(directory).length, 10);
});

test('non-run files in the directory are never touched', () => {
  const directory = tempDir();
  fabricate(directory, 25, 128);
  const other = path.join(directory, 'notes.txt');
  const otherLog = path.join(directory, 'summary.ndjson');
  fs.writeFileSync(other, 'keep me');
  fs.writeFileSync(otherLog, 'keep me too');
  pruneRunLogs(directory, { platform: 'linux' });
  assert.ok(fs.existsSync(other));
  assert.ok(fs.existsSync(otherLog));
});

test('logger creation enforces retention and keeps its own file', async () => {
  const directory = tempDir();
  const names = fabricate(directory, 25, 128);
  const logger = createLogger({
    level: 'info',
    directory,
    quiet: true,
    runId: 'retention-run',
  });
  logger.info('run.start', { mode: 'full' });
  await logger.close();
  assert.ok(fs.existsSync(logger.filePath), 'the new run log exists');
  const kept = remaining(directory);
  assert.equal(kept.length, LOG_RETENTION.maxFiles, 'directory is within the count policy');
  assert.ok(kept.includes('run-retention-run.ndjson'), 'the new file is among the kept');
  assert.ok(!kept.includes(names[0]), 'the oldest fabricated run was pruned');
});
