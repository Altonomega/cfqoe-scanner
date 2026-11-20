import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "../src/platform/paths.js";
import {
  REPUTATION_VERSION,
  createReputationStore,
  decayedCounts,
  isStale,
  loadReputation,
  mergeRunIntoReputation,
  primerTierForRecord,
  saveReputation,
} from "../src/hard-reputation.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-20T00:00:00.000Z");
const iso = (timeMs) => new Date(timeMs).toISOString();

function tempReputationFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cfqoe-rep-"));
  return path.join(directory, "block-reputation.json");
}

function recordAt({ attempts, successes, ageDays, countsAgeDays = ageDays }) {
  return {
    attempts,
    successes,
    lastSeenAt: iso(T0 - ageDays * DAY_MS),
    countsAsOf: iso(T0 - countsAgeDays * DAY_MS),
    lastRunId: null,
    best: [],
    colo: null,
    parent: null,
    children: null,
  };
}

test("paths exposes reputationFile under the data directory", () => {
  assert.equal(
    paths("/some/root").reputationFile,
    path.join("/some/root", "data", "block-reputation.json"),
  );
});

test("save then load round trips the store", () => {
  const file = tempReputationFile();
  const store = createReputationStore("catalog-a");
  mergeRunIntoReputation(
    store,
    [
      {
        block: "104.16.0.0/24",
        attempts: 9,
        successes: 8,
        runId: "run-1",
        colo: "FRA",
        best: [{ ip: "104.16.0.7", attempts: 3, successes: 3, handshakeMedianMs: 182 }],
      },
    ],
    T0,
  );
  saveReputation(file, store, { now: T0 });
  const loaded = loadReputation(file, { now: T0, catalogHash: "catalog-a" });
  assert.deepEqual(loaded, store);
});

test("save is atomic: no temp file remains and a failed write keeps the old file", () => {
  const file = tempReputationFile();
  const store = createReputationStore("catalog-a");
  mergeRunIntoReputation(store, [{ block: "104.16.0.0/24", attempts: 3, successes: 3 }], T0);
  saveReputation(file, store, { now: T0 });
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  const before = fs.readFileSync(file, "utf8");

  // Squat on the temp path so the write step fails before the rename: the
  // previously published store must survive byte for byte.
  fs.mkdirSync(`${file}.tmp`);
  assert.throws(() => saveReputation(file, createReputationStore("catalog-b"), { now: T0 }));
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("load tolerates missing, corrupt, and foreign-version files", () => {
  const file = tempReputationFile();
  assert.deepEqual(loadReputation(file).blocks, {});
  fs.writeFileSync(file, "{ not json");
  assert.deepEqual(loadReputation(file).blocks, {});
  fs.writeFileSync(file, JSON.stringify({ version: 99, blocks: { "1.2.3.0/24": {} } }));
  const foreign = loadReputation(file);
  assert.equal(foreign.version, REPUTATION_VERSION);
  assert.deepEqual(foreign.blocks, {});
  fs.writeFileSync(file, JSON.stringify({ version: REPUTATION_VERSION, blocks: "nope" }));
  assert.deepEqual(loadReputation(file).blocks, {});
});

test("decayedCounts halves evidence every 14 days", () => {
  const record = recordAt({ attempts: 100, successes: 80, ageDays: 0 });
  assert.deepEqual(decayedCounts(record, T0 + 14 * DAY_MS), { attempts: 50, successes: 40 });
  assert.deepEqual(decayedCounts(record, T0 + 28 * DAY_MS), { attempts: 25, successes: 20 });
  // 19 * 2^(-7/14) = 13.4 -> 13: rounding follows the spec formula.
  const small = recordAt({ attempts: 19, successes: 19, ageDays: 0 });
  assert.deepEqual(decayedCounts(small, T0 + 7 * DAY_MS), { attempts: 13, successes: 13 });
  // The record itself is never mutated, and future timestamps never grow it.
  assert.equal(record.attempts, 100);
  assert.deepEqual(decayedCounts(record, T0 - DAY_MS), { attempts: 100, successes: 80 });
});

test("load applies decay and rebases countsAsOf without touching lastSeenAt", () => {
  const file = tempReputationFile();
  const store = createReputationStore("catalog-a");
  store.blocks["104.16.0.0/24"] = recordAt({ attempts: 100, successes: 80, ageDays: 0 });
  saveReputation(file, store, { now: T0 });

  const loaded = loadReputation(file, { now: T0 + 14 * DAY_MS });
  const record = loaded.blocks["104.16.0.0/24"];
  assert.equal(record.attempts, 50);
  assert.equal(record.successes, 40);
  assert.equal(record.countsAsOf, iso(T0 + 14 * DAY_MS));
  assert.equal(record.lastSeenAt, iso(T0));

  // Saving and reloading at the same instant must not decay a second time.
  saveReputation(file, loaded, { now: T0 + 14 * DAY_MS });
  const reloaded = loadReputation(file, { now: T0 + 14 * DAY_MS });
  assert.equal(reloaded.blocks["104.16.0.0/24"].attempts, 50);
});

test("primer tiers match the spec's next-day and weekly examples", () => {
  // Next-day re-run: fresh evidence, primer skipped entirely (0 probes).
  assert.equal(primerTierForRecord(recordAt({ attempts: 20, successes: 18, ageDays: 1 }), T0), "skip");
  // Weekly re-run: one confirmation probe per block.
  assert.equal(primerTierForRecord(recordAt({ attempts: 20, successes: 18, ageDays: 7 }), T0), "confirm");
  // Tier boundaries are inclusive on the younger side.
  assert.equal(primerTierForRecord(recordAt({ attempts: 20, successes: 18, ageDays: 3 }), T0), "skip");
  assert.equal(primerTierForRecord(recordAt({ attempts: 20, successes: 18, ageDays: 21 }), T0), "confirm");
  assert.equal(primerTierForRecord(recordAt({ attempts: 20, successes: 18, ageDays: 22 }), T0), "full");
});

test("primer tiers fall back to full when evidence is thin or decayed away", () => {
  assert.equal(primerTierForRecord(null, T0), "full");
  // Below the skip minimum of 3 attempts a fresh block still gets confirmed.
  assert.equal(primerTierForRecord(recordAt({ attempts: 2, successes: 2, ageDays: 1 }), T0), "confirm");
  // One attempt 15 days ago decays to round(2^(-15/14)) = 0: nothing to seed.
  assert.equal(primerTierForRecord(recordAt({ attempts: 1, successes: 1, ageDays: 15 }), T0), "full");
  // Freshness ages from the last real observation, not from the decay base:
  // counts rebased today but last probed 15 days ago is a confirmation, not a skip.
  const rebased = recordAt({ attempts: 20, successes: 18, ageDays: 15, countsAgeDays: 0 });
  assert.equal(primerTierForRecord(rebased, T0), "confirm");
});

test("isStale compares lastSeenAt against the given window", () => {
  assert.equal(isStale(recordAt({ attempts: 5, successes: 5, ageDays: 13 }), T0, 14), false);
  assert.equal(isStale(recordAt({ attempts: 5, successes: 5, ageDays: 15 }), T0, 14), true);
  assert.equal(isStale(null, T0, 14), true);
});

test("merge keeps only the top 4 candidates, ranked by successes", () => {
  const store = createReputationStore("catalog-a");
  const candidates = [1, 2, 3, 4, 5, 6].map((index) => ({
    ip: `104.16.0.${index}`,
    attempts: 6,
    successes: index,
    handshakeMedianMs: 100 + index,
  }));
  mergeRunIntoReputation(store, [{ block: "104.16.0.0/24", attempts: 36, successes: 21, best: candidates }], T0);
  const best = store.blocks["104.16.0.0/24"].best;
  assert.equal(best.length, 4);
  assert.deepEqual(best.map((entry) => entry.ip), ["104.16.0.6", "104.16.0.5", "104.16.0.4", "104.16.0.3"]);

  // Re-observing the same IP adds its counts instead of duplicating it.
  mergeRunIntoReputation(
    store,
    [{ block: "104.16.0.0/24", attempts: 2, successes: 2, best: [{ ip: "104.16.0.3", attempts: 2, successes: 2, handshakeMedianMs: 90 }] }],
    T0,
  );
  const merged = store.blocks["104.16.0.0/24"].best.find((entry) => entry.ip === "104.16.0.3");
  assert.equal(merged.attempts, 8);
  assert.equal(merged.successes, 5);
});

test("merge stores colo verbatim, keeps it when omitted, replaces it when new", () => {
  const store = createReputationStore("catalog-a");
  mergeRunIntoReputation(store, [{ block: "104.16.0.0/24", attempts: 3, successes: 3, colo: "FRA" }], T0);
  assert.equal(store.blocks["104.16.0.0/24"].colo, "FRA");
  mergeRunIntoReputation(store, [{ block: "104.16.0.0/24", attempts: 3, successes: 2 }], T0);
  assert.equal(store.blocks["104.16.0.0/24"].colo, "FRA");
  mergeRunIntoReputation(store, [{ block: "104.16.0.0/24", attempts: 3, successes: 2, colo: "AMS" }], T0);
  assert.equal(store.blocks["104.16.0.0/24"].colo, "AMS");
});

test("merge caps stored attempts at 64 with proportional successes", () => {
  const store = createReputationStore("catalog-a");
  store.blocks["104.16.0.0/24"] = recordAt({ attempts: 60, successes: 60, ageDays: 0 });
  mergeRunIntoReputation(store, [{ block: "104.16.0.0/24", attempts: 32, successes: 16 }], T0);
  const record = store.blocks["104.16.0.0/24"];
  assert.equal(record.attempts, 64);
  assert.equal(record.successes, 53); // round(76 * 64 / 92)
  // Results with no probes and no candidates carry no evidence.
  mergeRunIntoReputation(store, [{ block: "104.17.0.0/24", attempts: 0, successes: 0 }], T0);
  assert.equal(store.blocks["104.17.0.0/24"], undefined);
});

test("catalog guard drops blocks the changed catalog no longer contains", () => {
  const file = tempReputationFile();
  const store = createReputationStore("catalog-a");
  store.blocks["104.16.0.0/24"] = recordAt({ attempts: 10, successes: 9, ageDays: 0 });
  store.blocks["104.17.0.0/24"] = recordAt({ attempts: 10, successes: 9, ageDays: 0 });
  saveReputation(file, store, { now: T0 });

  const same = loadReputation(file, { now: T0, catalogHash: "catalog-a" });
  assert.deepEqual(Object.keys(same.blocks).sort(), ["104.16.0.0/24", "104.17.0.0/24"]);

  const pruned = loadReputation(file, {
    now: T0,
    catalogHash: "catalog-b",
    knownBlocks: ["104.16.0.0/24"],
  });
  assert.deepEqual(Object.keys(pruned.blocks), ["104.16.0.0/24"]);
  assert.equal(pruned.catalogHash, "catalog-b");

  // Without the block list the mismatch stays visible instead of silently
  // adopting the records under the new catalog's hash.
  const unadopted = loadReputation(file, { now: T0, catalogHash: "catalog-b" });
  assert.equal(Object.keys(unadopted.blocks).length, 2);
  assert.equal(unadopted.catalogHash, "catalog-a");
});
