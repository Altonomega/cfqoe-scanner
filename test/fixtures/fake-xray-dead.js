#!/usr/bin/env node
// Test double for an Xray binary that cannot start: it answers `version`
// like the real thing but exits non-zero on `run`, so the process manager
// rejects every start attempt fast. Used to drive the tunnel backfill
// path (Probe P-3), where an Xray start failure must free the slot for
// the next eligible candidate — no network involved on either side.
const args = process.argv.slice(2);

if (args[0] === 'version') {
  console.log('Xray 0.0.0-fake-dead (test fixture)');
  process.exit(0);
}

console.error('fake xray: simulated startup failure');
process.exit(1);
