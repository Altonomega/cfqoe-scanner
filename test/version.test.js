import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';
import {
  GENERATOR_VERSION,
  REPORT_SCHEMA,
  writeReport,
} from '../src/report.js';
import { banner } from '../src/ui.js';

// The version pin: package.json is the single source (src/version.js),
// and every surface that shows or stamps the version must agree with it.
// This guards against a hand-written literal creeping back — the exact
// failure mode (a bare "0.8.6" inside writeReport, beside the constant
// it bypassed) that the single-sourcing removed.
const packageJson = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json',
    ),
    'utf8',
  ),
);

test('VERSION is read from package.json and feeds the report constant', () => {
  assert.equal(VERSION, packageJson.version);
  assert.equal(GENERATOR_VERSION, VERSION);
});

test('the banner shows the package version', () => {
  assert.ok(banner().includes(`v${packageJson.version}`));
});

test('writeReport stamps the single-sourced version and schema', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cfqoe-version-'));
  const written = writeReport({
    directory,
    runId: 'version-pin',
    target: {},
    settings: {},
    candidates: [],
    startedAt: new Date().toISOString(),
  });
  const parsed = JSON.parse(fs.readFileSync(written.jsonPath, 'utf8'));
  assert.equal(parsed.version, packageJson.version);
  assert.equal(parsed.schema, REPORT_SCHEMA);
});
