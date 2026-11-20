// Web state store: the sync contract as executable pins (0.9.1).
// The page renders only this store's snapshot + event stream, so
// the store is where front↔back agreement is proven: narration
// fields on counters, terminal-status agreement between the event
// stream and the at-rest snapshot (defect 7), the catalog payload
// shape the plate label depends on (defect 8), and the calibration
// concurrency riding log frames (defect 6).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirectories } from "../src/platform/paths.js";
import { createWebState } from "../src/web/state.js";

const RANGES_FILE = fileURLToPath(new URL("../config/cloudflare-ipv4.txt", import.meta.url));

function makeState() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfqoe-state-test-"));
  const layout = ensureDirectories(root);
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.copyFileSync(RANGES_FILE, layout.rangesFile);
  return createWebState({ layout });
}

const FACTS = { configReady: true, xrayFound: true, verifyEnabled: false, resumeAvailable: false };

test("counters carry the narration fields: screening round + current candidate IP", () => {
  const state = makeState();
  state.beginRun({ mode: "quick", runId: "run-1", settings: {} });
  state.onProgress({ phase: "screening", completed: 3, total: 32, round: 2, ip: "203.0.113.7" });
  const snap = state.buildSnapshot(FACTS);
  assert.equal(snap.run.status, "running");
  assert.equal(snap.run.counters.round, 2);
  assert.equal(snap.run.counters.currentIp, "203.0.113.7");
  assert.equal(snap.run.counters.completed, 3);
  // A later frame without an IP keeps the last known candidate —
  // the narration never blanks back to nothing mid-phase.
  state.onProgress({ phase: "screening", completed: 4, total: 32, round: 2 });
  assert.equal(state.buildSnapshot(FACTS).run.counters.currentIp, "203.0.113.7");
});

test("defect 7: after finishRun the snapshot serves the terminal status — event, snapshot and greeting agree", () => {
  const state = makeState();
  state.beginRun({ mode: "quick", runId: "run-2", settings: {} });
  state.onProgress({ phase: "screening", completed: 1, total: 32 });
  state.finishRun({ status: "canceled", mode: "quick", runId: "run-2", report: null });
  const snap = state.buildSnapshot(FACTS);
  assert.ok(snap.run, "the at-rest snapshot still describes the finished run");
  assert.equal(snap.run.status, "canceled", "a stopped scan run is canceled at rest, never running, never decayed to idle");
  assert.equal(snap.run.runId, "run-2");
  assert.deepEqual(state.currentRunState(), { status: "canceled", mode: "quick", runId: "run-2" });
  // A client connecting after the stop hears the same truth in its
  // greeting frame — no path exists where the banner can resurrect.
  const greetings = [];
  state.addClient({ wantsTail: false, send: (type, payload) => greetings.push({ type, payload }) });
  const greeting = greetings.find((g) => g.type === "run-state");
  assert.equal(greeting.payload.status, "canceled");
  // A new run supersedes the terminal view.
  state.beginRun({ mode: "full", runId: "run-3", settings: {} });
  assert.equal(state.buildSnapshot(FACTS).run.status, "running");
  assert.equal(state.buildSnapshot(FACTS).run.runId, "run-3");
});

test("defect 6c: a failed run keeps its reason in the at-rest snapshot", () => {
  const state = makeState();
  state.beginRun({ mode: "full", runId: "run-4", settings: {} });
  state.finishRun({ status: "failed", mode: "full", runId: "run-4", report: null, error: "engine exploded" });
  const snap = state.buildSnapshot(FACTS);
  assert.equal(snap.run.status, "failed");
  assert.equal(snap.run.error, "engine exploded");
});

test("defect 8 pair: the real catalog builder serves cidr as a string and firstBlock as a numeric index", () => {
  const state = makeState();
  const catalog = state.tracker.catalog();
  assert.ok(catalog.ranges.length > 0);
  const first = catalog.ranges[0];
  assert.equal(typeof first.cidr, "string", "cidr carries the range CIDR string");
  assert.match(first.cidr, /^\d+\.\d+\.\d+\.\d+\/\d+$/);
  assert.equal(typeof first.firstBlock, "number", "firstBlock is the block index, not an address");
  assert.equal(first.firstBlock, 0, "the first range starts at block index 0");
  assert.ok(Number.isInteger(first.blocks) && first.blocks >= 1);
  // The derivation the front-end performs (base from cidr + offset)
  // is well-defined against this payload.
  const base = first.cidr.split("/")[0].split(".").map(Number);
  assert.equal(base.length, 4);
  assert.ok(base.every((n) => n >= 0 && n <= 255));
});

test("defect 6a: log frames carry the calibration concurrency (n) for plain-words narration", () => {
  const state = makeState();
  const record = {
    time: new Date().toISOString(),
    level: "warn",
    event: "scan.calibration.no_control",
    requestedConcurrency: 24,
    message: "",
  };
  const logger = {
    subscribe: () => () => {},
    recent: () => [record],
  };
  state.attachLogger(logger);
  const frames = [];
  state.addClient({ wantsTail: true, send: (type, payload) => frames.push({ type, payload }) });
  const log = frames.find((f) => f.type === "log");
  assert.ok(log, "the replayed calibration record reaches a tail client");
  assert.equal(log.payload.event, "scan.calibration.no_control");
  assert.equal(log.payload.n, 24, "the speed the run continued at rides the frame");
});
