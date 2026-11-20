#!/usr/bin/env node
// Test-suite entry point behind `npm test`.
//
// The suite used to be invoked as `node --test test/*.test.js`, relying on
// the shell to expand the glob before Node saw it. Windows shells do not
// expand globs, and Node only learned to expand them itself in 21/22 — so
// on Windows with Node 20 (a supported platform) the literal pattern
// reached Node, which treated it as a missing file path and ran nothing.
//
// The two "obvious" portable forms are traps of their own: directory
// arguments (`node --test test/`) stopped being scanned in Node 23+, and
// bare `node --test` discovery also executes helper modules under
// test/fixtures/ as if they were test files. So this script does the
// expansion itself — enumerate test/*.test.js and hand the runner the
// explicit file list, the exact argv a POSIX shell used to produce, on
// every platform and every supported Node version.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "test");
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error("run-tests: no test files found under test/");
  process.exit(1);
}

// Extra arguments are forwarded to the runner
// (e.g. `npm test -- --test-name-pattern=blocks`).
const args = [
  "--test",
  "--test-timeout=20000",
  ...files,
  ...process.argv.slice(2),
];
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
if (result.error) {
  console.error(`run-tests: could not start the test runner: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
