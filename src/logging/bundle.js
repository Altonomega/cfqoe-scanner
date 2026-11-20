import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from '../version.js';
import { SETTINGS_VERSION } from '../config/settings.js';
import { eachLogRecord, redact, summarizeLogFile } from './logger.js';

// Debug bundle (Signal §3.6): ONE redacted JSON file a user can
// attach to a bug report instead of being walked through "send me
// your logs folder — no, the other file". It packs the environment
// facts, the chosen run's digest, the run's full log, its report if
// one exists, the Hard checkpoint summary if it belongs to the same
// run, and the settings.
//
// Secret hygiene is belt-and-braces by construction: the log's own
// records were already redacted once at write time, and the WHOLE
// bundle passes through redact() again before it is returned, so
// artifacts written by other code paths (report, settings, state)
// are scrubbed by the same choke point. No VLESS material can ride
// along: the secret file itself is never read here.

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function buildDebugBundle({ layout, logFile }) {
  const digest = summarizeLogFile(logFile);
  const records = [];
  eachLogRecord(logFile, (record) => records.push(record));

  const settings = readJson(layout.settingsFile);

  // The run's report, found by the same naming writeReport uses;
  // latest.json is deliberately NOT substituted — a bundle about one
  // run must not silently pack another run's results.
  const report = digest.runId
    ? readJson(path.join(layout.results, `run-${digest.runId}.json`))
    : null;

  // The Hard checkpoint summary, only when it is this run's own
  // checkpoint (a stale state file from an older run would mislead).
  let hardState = null;
  const state = readJson(layout.hardStateFile);
  if (state && (!digest.runId || state.runId === digest.runId)) {
    hardState = {
      runId: state.runId ?? null,
      phase: state.phase ?? null,
      counts: state.counts ?? null,
      stoppedReason: state.stoppedReason ?? null,
    };
  }

  return redact({
    bundleVersion: 1,
    createdAt: new Date().toISOString(),
    environment: {
      appVersion: VERSION,
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.version,
      settingsVersion: SETTINGS_VERSION,
    },
    run: {
      runId: digest.runId,
      logFile: path.basename(logFile),
      digest,
    },
    settings,
    report,
    hardState,
    log: records,
  });
}

export function writeDebugBundle({ layout, logFile }) {
  const bundle = buildDebugBundle({ layout, logFile });
  const filePath = path.join(
    layout.results,
    `debug-bundle-${bundle.run.runId || 'unknown'}.json`,
  );
  fs.mkdirSync(layout.results, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}
