import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../src/platform/paths.js';
import { VERSION } from '../src/version.js';
import { buildDebugBundle, writeDebugBundle } from '../src/logging/bundle.js';

// Debug bundle (Signal §3.6, W5): one redacted JSON file per run —
// environment, digest, full log, report, settings — with the secret
// hygiene pinned adversarially: secret-shaped strings planted in the
// log, the settings and the report must not survive into the bundle.

const FAKE_UUID = '99999999-8888-7777-6666-555555555555';
const FAKE_URI = `vless://${FAKE_UUID}@edge.example.com:2052?type=ws&path=%2Fws`;

const createdRoots = [];
after(() => {
  for (const root of createdRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfqoe-bundle-'));
  createdRoots.push(root);
  const layout = paths(root);
  for (const directory of [layout.data, layout.results, layout.logs]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return layout;
}

function writeRun(layout, { runId = 'bundle-run' } = {}) {
  const logFile = path.join(layout.logs, `run-${runId}.ndjson`);
  const lines = [
    { v: 2, time: '2026-11-20T10:00:00.000Z', elapsedMs: 0, seq: 1, runId, level: 'info', phase: null, event: 'run.start', mode: 'full', appVersion: '0.9.0' },
    { v: 2, time: '2026-11-20T10:00:01.000Z', elapsedMs: 900, seq: 2, runId, level: 'error', phase: 'tunnel', event: 'xray.failed', error: { class: 'xray_start', message: `cannot use ${FAKE_URI}` } },
    { v: 2, time: '2026-11-20T10:01:00.000Z', elapsedMs: 60000, seq: 3, runId, level: 'info', phase: null, event: 'run.end', status: 'failed', durationMs: 60000 },
  ];
  fs.writeFileSync(logFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  // Planted secrets outside the log: a settings file and a report
  // that (hypothetically, adversarially) carry secret-shaped strings.
  fs.writeFileSync(
    layout.settingsFile,
    JSON.stringify({ version: 7, note: `imported from ${FAKE_URI}`, scan: { concurrency: 12 } }),
  );
  fs.writeFileSync(
    path.join(layout.results, `run-${runId}.json`),
    JSON.stringify({ runId, generatorNote: FAKE_URI, results: [] }),
  );
  return logFile;
}

test('bundle packs environment, digest, log, report and settings for the run', () => {
  const layout = tempLayout();
  const logFile = writeRun(layout);
  const bundle = buildDebugBundle({ layout, logFile });
  assert.equal(bundle.bundleVersion, 1);
  assert.equal(bundle.environment.appVersion, VERSION);
  assert.equal(bundle.run.runId, 'bundle-run');
  assert.equal(bundle.run.digest.endStatus, 'failed');
  assert.equal(bundle.run.digest.total, 3);
  assert.equal(bundle.log.length, 3);
  assert.equal(bundle.log[0].event, 'run.start');
  assert.equal(bundle.report.runId, 'bundle-run');
  assert.equal(bundle.settings.scan.concurrency, 12);
});

test('bundle never carries secret material — planted URI/UUID strings are redacted everywhere', () => {
  const layout = tempLayout();
  const logFile = writeRun(layout);
  const filePath = writeDebugBundle({ layout, logFile });
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.equal(raw.includes('vless://'), false, 'no VLESS URI anywhere in the bundle');
  assert.equal(raw.includes(FAKE_UUID), false, 'no UUID anywhere in the bundle');
  assert.ok(raw.includes('[REDACTED_VLESS_URI]'), 'the redaction marker shows where material was stripped');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.run.logFile, 'run-bundle-run.ndjson');
  assert.match(filePath, /debug-bundle-bundle-run\.json$/);
});

test('bundle tolerates a run with no report and no settings file', () => {
  const layout = tempLayout();
  const logFile = path.join(layout.logs, 'run-lonely.ndjson');
  fs.writeFileSync(
    logFile,
    `${JSON.stringify({ time: '2026-11-20T10:00:00.000Z', runId: 'lonely', level: 'info', event: 'hard.start' })}\n`,
  );
  const bundle = buildDebugBundle({ layout, logFile });
  assert.equal(bundle.run.runId, 'lonely');
  assert.equal(bundle.report, null);
  assert.equal(bundle.settings, null);
  assert.equal(bundle.hardState, null);
  assert.equal(bundle.run.digest.endStatus, 'no-progress-information');
});
