# Hard Deep Scan — DNA Redesign: Engineering Annex

Status: design annex, no code yet. Companion to `docs/HARD-SCAN-REDESIGN.md`
(Metric's algorithm specification: primer phase, bandit allocation, reputation
model). This document maps that redesign onto the current codebase at
`69a79fd` (v0.8.6 + cleanup merges): what exists today, what changes file by
file, how state migrates, and the order to build it in.

Design summary being mapped: the scan unit becomes the **/24 block**
(catalog: 753 ranges, 1,970,432 addresses, **7,697 blocks** — every catalog
prefix is /13–/24, so the split is exact). A primer phase probes every block
lightly, a UCB bandit allocator expands promising blocks, winners feed the
existing SPRT / tunnel / streaming / load pipeline unchanged, and per-block
reputation persists across runs.

---

## 1. Current-state map

### 1.1 Entry points and overall flow

- `runHardScan({ vlessUri, settings, layout, logger, onProgress, runId, resume })`
  and `hasHardScanState(layout)` in `src/hard-scan.js`; `HARD_STATE_VERSION = 3`
  is exported from the same file.
- CLI: `runHardCommand(parsed, { resume })` in `src/cli.js` backs both the
  `hard` (resume: false) and `resume` (resume: true) commands. Menu options 4
  ("Hard Deep Scan") and 5 ("Resume Hard Scan") in `src/menu/index.js` call the
  same functions. `onProgress` events carry free-form `phase` strings
  (`hard-scan`, `hard-retry`, `hard-verify`, `hard-finalize`) plus a `note`.
- `runHardScan` is one large function with inline sub-closures. Phases today:
  setup → concurrency calibration → screening sweep → delayed retries →
  finalist verification → tunnel QoE → report.

### 1.2 Traversal order

- Catalog: `config/cloudflare-ipv4.txt`, read via `layout.rangesFile`
  (`src/platform/paths.js`) and `parseRangeList` (`src/candidate/ipv4.js`).
- `buildRangePlan(ranges)` in `src/candidate/hard-order.js` precomputes per
  range: `usable = size - 2` (network/broadcast skipped; /31–/32 keep all),
  `startOffset`, plus plan `total` (sum of usable) and `maxDepth`.
- `nextRoundRobinCandidate(plan, cursor)` walks **breadth-first**: host #1 of
  every range, then host #2 of every range, … Cursor is
  `{ rangeIndex, passIndex }`; each returned candidate carries
  `{ ip, range, rangeIndex, hostIndex, nextCursor }`.
- `nextLegacyCandidate(plan, cursor)` walks one range to exhaustion before
  moving on, cursor `{ rangeIndex, hostIndex }`. It exists only so pre-v3
  checkpoints can resume; `isLegacyState(state)` in `src/hard-scan.js`
  (`state.version < 3 || Number.isInteger(state.cursor?.hostIndex)`) selects it.

### 1.3 Batching, concurrency, and the probe seam

- `src/hard-scheduler.js` is the execution engine — and it is **shared**:
  `src/scan.js` imports `runEligibilityBatch`, `runAdaptiveEligibilityBatch`,
  and `selectDelayedRetries` from it. Its exports are a contract for both
  scan modes.
  - `collectCandidateBatch({ plan, cursor, limit, nextCandidate })` pulls
    `limit` candidates by repeatedly applying the traversal function.
  - `runEligibilityBatch({ candidates, rounds, concurrency, minimumSuccessRate, task, onCandidateDone })`
    runs a worker pool (results returned in input order).
  - `probeCandidateRounds` early-stops a candidate once the success threshold
    is mathematically unreachable.
  - `runAdaptiveEligibilityBatch` is the SPRT variant (wraps `runSprt` from
    `src/measurement/sprt.js`).
  - `selectDelayedRetries(results, { maxRetries })` picks results containing
    at least one retryable error (`classifyProbeError`, `src/probe/errors.js`).
- **Probe seam:** every batch runner takes `task(candidate, round) =>
  observation`. `src/hard-scan.js` binds it to
  `probeWebsocket({ ip, vless, timeoutMs: settings.scan.timeoutMs })`
  (`src/probe/websocket.js`). Tests already inject fake tasks through this
  seam (see `test/hard-scheduler.test.js`). The redesign builds on this seam;
  no new abstraction is needed.
- Concurrency is calibrated, not taken raw: `sampleCandidates`
  (`src/candidate/ipv4.js`, seed 404) picks calibration candidates and
  `calibrateWebsocketConcurrency` (`src/measurement/scan-calibration.js`)
  selects the level that replaces `settings.hard.concurrency`
  (requested default 12 desktop / 6 Android, hard cap 64 via `clampInt`).
- `src/scheduler.js` (`runInterleaved`) is used by `src/scan.js` only. Hard
  Scan does not use it.

### 1.4 Screening, verification, finalize

- **Screening sweep:** batches of `concurrency` candidates, each probed
  `hard.screeningRounds` rounds (default 1) against
  `scan.minimumSuccessRate` (0.6). Per result, `buildEligibilitySummary`
  (`src/report.js`) is appended as one NDJSON line, the cursor advances to
  `candidate.nextCursor`, counts update, and `insertTop` maintains
  `state.topEligibility` (cap `hard.liveTop` = 30) ordered by
  `compareEligibility` (Wilson 95 lower bound → success rate → handshake
  median → connect median → IP).
- **Delayed-retry queue:** after each batch, `selectDelayedRetries` (capped at
  `concurrency` entries per batch) appends `{ ip, range }` lines to the run's
  `.retry.ndjson`; `counts.retryQueued` tracks the total. After the sweep
  (skipped when canceled), `runDelayedRetries` in `src/hard-scan.js` reads up
  to `hard.retryLimit` unique IPs (5,000 desktop / 1,000 Android), re-probes
  them with `scan.rounds` rounds, and summarizes with `temporalBlocks: 2`.
- **Finalists:** the eligibility NDJSON is re-read, deduplicated by IP (last
  record wins), sorted by `compareEligibility`, capped at `hard.finalTop`
  (200), then merged with retry summaries.
- **Verification (`recheckTop`):** the top `hard.recheckTop` finalists
  (20 desktop / 12 Android) are re-probed — SPRT via
  `runAdaptiveEligibilityBatch` (`verification.sprt`: p0 0.6, p1 0.9,
  alpha 0.05, beta 0.10, 2–16 rounds) when `verification.enabled`, else fixed
  rounds. Each verified summary gains
  `verification: { method, decision, rounds }`.
- **Tunnel QoE:** finalists with `successRate >= scan.minimumSuccessRate`,
  top `settings.tunnel.limit` (5) × `settings.tunnel.rounds` (1): per
  candidate, `startXray` (`src/xray/manager.js`) binds Xray to the candidate
  IP, then `probeBrowsing`, `probeStreaming`, and `runLoadProbe` run over its
  SOCKS proxy. `applyTunnelResults` (`src/report.js`) merges results and each
  candidate gains `selection: { eligibleForTunnel, tunnelTested, tunnelReason }`.
- **Report:** `rankCandidates` orders the final list; the report object is
  written to `results/run-<runId>.json`, `results/latest.json`, and
  `results/best-ips.txt`. Fields include `schema: REPORT_SCHEMA`,
  `mode: "hard"`, `traversal`, `totals: { tested, eligible, failed,
  retryQueued, retryRecovered, includedInReport, complete, highConfidence,
  withBrowsing, withStreaming }`, and `checkpoints: state.files`.

### 1.5 Checkpoint format and files

- Live state: `layout.hardStateFile` = `data/hard-scan.state.json`. Per-run
  artifacts under `results/hard-scan/`: `run-<runId>.state.json` (archive copy
  of the state), `.eligibility.ndjson`, `.retry.ndjson`, `.partial.json`
  (snapshot), `.partial.txt` (live top table). Paths are recorded in
  `state.files`.
- `persistState` writes the state JSON to both the live file and the archive
  copy. It runs every `hard.saveEvery` processed candidates (25 desktop /
  10 Android), on pause, and on completion. `writeSnapshot` regenerates the
  `.partial.*` pair at the same cadence.
- State v3 shape: `{ version: 3, runId, mode: "hard",
  traversal: "range-round-robin", execution: "parallel-batched", status,
  startedAt, target, settings (full snapshot), total, rangesCount,
  cursor: { rangeIndex, passIndex }, counts: { tested, eligible, failed,
  retryQueued, retryRecovered }, files: {...}, topEligibility: [...],
  lastReport? }`.
- Resume: the state is loaded, missing `retryFile` / retry counts are patched
  in for older files, `settings` is replaced with the current settings, and
  the traversal function is chosen from the state's shape. On non-canceled
  completion the live state file is deleted (`removeStateFile`); on cancel it
  is kept with `status: "paused"`. Cancel is via SIGINT or `Q`/`Ctrl+C` in raw
  TTY mode; the in-flight batch always finishes first.
- Report schema: `REPORT_SCHEMA = 10` and `GENERATOR_VERSION = "0.8.6"` in
  `src/report.js`. (Note: README and older docs say "schema 9" — that is
  pre-existing doc drift, flagged in §2.4, not part of this redesign.)

### 1.6 Key numbers at defaults

| Quantity | Desktop | Android/Termux |
| --- | --- | --- |
| Catalog | 753 ranges / 1,970,432 addresses / 7,697 blocks | same |
| Screening probes, full round-robin sweep | 1,970,432 × 1 round | same |
| Primer probes, DNA design (per-block × probes) | 7,697 × 3 = 23,091 | 7,697 × 2 = 15,394 |
| Concurrency (requested, pre-calibration) | 12 | 6 |
| saveEvery / liveTop / finalTop | 25 / 30 / 200 | 10 / 30 / 200 |
| recheckTop / retryLimit | 20 / 5,000 | 12 / 1,000 |


---

## 2. Change map

### 2.1 New modules

| Module | Contents | Why there |
| --- | --- | --- |
| `src/candidate/blocks.js` | `buildBlockPlan(ranges, { prefix = 24 })` → `{ blocks, totalBlocks }`, each block `{ blockId, block, range, base, size, usable, startOffset }`; `blockProbeOrder(block, seed)` — the block's full usable-offset permutation; `blockCandidate(block, probeIndex)` → `{ ip, range, block, blockIndex, probeIndex }` | Sits beside `ipv4.js` / `hard-order.js`; pure derivation from the catalog, reusing `parseCidr` / `intToIp` from `ipv4.js` and `mulberry32` from `src/random.js`. |
| `src/measurement/bandit.js` | Pure allocator: `blockScore(stats, totals, exploration)`, `rankBlocks(blockStats, totals, exploration)`, `pickBlocks(...)`. Consumes per-block `{ attempts, successes }` + global probe count; reward estimate is the Wilson lower bound (`wilsonInterval` from `src/measurement/confidence.js`) plus a UCB exploration bonus `c · sqrt(ln(totalProbes) / attempts)`; unprobed blocks score `+Infinity` so primer coverage is total. Exact reward semantics are Metric's spec (`HARD-SCAN-REDESIGN.md`); this module is the binding of that spec to code. | Sits beside `sprt.js` / `confidence.js`; pure and unit-testable, no I/O. |
| `src/hard-reputation.js` | Cross-run store: `loadReputation(file)`, `saveReputation(file, store)`, `mergeRunIntoReputation(store, blockResults, now)`, `isStale(record, now, staleDays)`. Own `REPUTATION_VERSION = 1`. | Hard-specific like `hard-scan.js` / `hard-scheduler.js`. Deliberately **not** part of the checkpoint (see §3.2). |
| `src/hard-engine.js` | The screening driver: `runBlockScreening({ blocks, settings, task, concurrency, reputation, initialBlockState, onSummary, onProgress, logger, isCanceled })` — runs primer then expansion phases over `runEligibilityBatch`, maintains per-block counters, asks `bandit.js` for expansion picks, returns final block state + counts. | Keeps `runHardScan` as orchestrator (files, finalize, report) and makes the new engine simulatable end-to-end through the existing `task` seam without touching Xray or the filesystem layout. |

One structural property keeps block state tiny: a block's probe order is a
**deterministic permutation** of its usable offsets, seeded by
`settings.scan.seed` (404) combined with the block base. Primer probes are
permutation entries `0 .. primerPerBlock-1`; expansion continues from there.
So the entire per-block progress is one integer — `probed`, the count of
permutation entries already consumed — plus `attempts`/`successes` counters.
No offset sets are ever serialized.

### 2.2 Changed files

- `src/hard-scan.js` — the main wiring change. `runHardScan` branches on
  `settings.hard.engine` after calibration: `"round-robin"` keeps today's
  loop verbatim; `"blocks"` writes a v4 state (§3.1) and delegates the sweep
  to `runBlockScreening`, feeding each produced summary through the **same**
  sink as today (eligibility NDJSON append, counts, `insertTop` into
  `topEligibility`, delayed-retry selection per batch). Everything after the
  sweep — delayed retries, finalist merge, `recheckTop` SPRT verification,
  tunnel QoE, `applyTunnelResults`, report writing — is shared code, reached
  identically by both engines. Snapshot/progress gain block fields (§3.1).
- `src/config/settings.js` — additive `hard.*` keys only (§4.1).
  `mergeSettings` deep-merges defaults into stored settings, so existing
  `data/settings.json` files pick the new keys up automatically; **no
  `SETTINGS_VERSION` bump** (still 7). This matches the additive-key
  precedent; the v6→v7 bump was for changed defaults, not additions.
- `src/platform/paths.js` — one new layout key:
  `reputationFile: path.join(root, 'data', 'block-reputation.json')`.
- `src/report.js` — `buildEligibilitySummary` learns one optional passthrough:
  when the candidate carries a block, the summary gains `block: "a.b.c.0/24"`.
  Additive in the summary object, the NDJSON lines, and the final report.
  `rankCandidates`, scoring, gates, verdicts: untouched.
- `src/cli.js` — no change for landing. (`hard` / `resume` already route to
  `runHardCommand`; an optional `--engine` override flag is a later nicety,
  explicitly out of the landing scope.)
- `src/menu/index.js` — no entry changes (§4.3). Surfacing the new keys in
  the Scan Settings editor is a follow-up, not a landing blocker: defaults
  plus `data/settings.json` are enough to run and to roll back.

### 2.3 Untouched (explicit)

- `src/probe/*` — `websocket.js`, `browsing/probe.js`, `streaming/probe.js`,
  `load.js`, `errors.js`. The redesign discovers candidates differently; it
  measures them identically.
- `src/xray/*`, `src/measurement/sprt.js`, `src/measurement/confidence.js`,
  `src/measurement/scan-calibration.js`, `src/measurement/gates.js`,
  `src/stats.js`, `src/scheduler.js`.
- `src/candidate/ipv4.js` (blocks build on it), `src/candidate/hard-order.js`
  (remains the fallback engine and the resume path for v3/legacy
  checkpoints), `src/hard-scheduler.js` (reused exactly as-is — important
  because `src/scan.js` shares it; any future change there must stay
  additive).

### 2.4 Report-schema impact

**`REPORT_SCHEMA` stays 10. No bump.** All report changes are additive:

- `report.traversal` gains a new possible value, `"block-adaptive"`
  (alongside `"range-round-robin"` / `"legacy-range-sequential"`).
- `report.totals` gains `blocksTotal`, `blocksPrimed`, `blocksExpanded`,
  `primerProbes`, `expansionProbes`.
- Candidate entries gain the optional `block` field (§2.2).

No field is removed, renamed, or retyped, and `totals` already varies by
mode, so existing consumers are unaffected. Separately: README still says
"schema 9" while the code constant is 10 — pre-existing drift for Scribe to
correct independently; this redesign neither causes nor fixes it.

---

## 3. State & migration

### 3.1 Checkpoint v4 (`HARD_STATE_VERSION` 3 → 4)

A state created by the blocks engine has `version: 4` and keeps every v3
field (including the full `settings` snapshot and `files` block), with these
changes:

- `engine: "blocks"` and `traversal: "block-adaptive"` are pinned at
  creation. (v3 states get an implicit engine of `"round-robin"` /
  `"legacy-range-sequential"` from their shape, as today.)
- `cursor: null` — there is no traversal cursor; block arrays below replace
  it. `isLegacyState` logic is extended, not replaced: engine selection on
  resume is by `state.engine ?? (legacy/round-robin from shape)`.
- `phase: "primer" | "expansion" | "finalize"` — the screening phase the run
  was in when persisted. Finalize itself is not checkpointed today and stays
  that way (it re-derives from the eligibility NDJSON).
- `blocks: { catalogHash, prefix: 24, attempts: [], successes: [],
  probed: [], status: [] }` — four positional arrays in `buildBlockPlan`
  order (7,697 entries each). `status` per block: 0 unprimed, 1 primed,
  2 expanding, 3 closed (exhausted or allocator-dead). Estimated JSON size
  ≈ 150–300 KB — acceptable next to today's state, which already embeds the
  full settings snapshot and live top list.
- `catalogHash` — sha256 of the ranges file text (`node:crypto`). The
  positional arrays are only meaningful for the exact catalog they were
  built from.
- `counts` gains `primerProbes`, `expansionProbes`, `blocksPrimed`,
  `blocksExpanded`. `state.total` for v4 is the **planned probe total**
  (`totalBlocks × primerPerBlock + expansionBudget`), not 1,970,432 — a
  progress denominator the run can actually reach.
- Snapshot (`writeSnapshot`): `progress` gains `phase`, `blocksPrimed`,
  `blocksTotal`; `rangeIndex`/`passIndex` are emitted as `null` for v4,
  extending the existing legacy/null pattern rather than inventing a new one.

Persist cadence is unchanged: every `hard.saveEvery` processed candidates,
on pause, and on completion — now driven by summaries coming out of
`runBlockScreening` instead of traversal batches.

### 3.2 Reputation store (separate from the checkpoint)

`data/block-reputation.json` (via `layout.reputationFile`), written with the
same 0600 JSON helper as state files:

```json
{
  "version": 1,
  "updatedAt": "2026-11-20T00:00:00.000Z",
  "blocks": {
    "104.16.0.0/24": {
      "attempts": 41, "successes": 37, "runs": 3,
      "lastTestedAt": "...", "lastSuccessAt": "...",
      "deadRuns": 0, "bestHandshakeMedianMs": 182.4
    }
  }
}
```

Why separate: a checkpoint is **deleted on successful completion**
(`removeStateFile`), while reputation must survive across runs and run IDs;
and reputation is keyed by block CIDR, so it stays valid when run IDs,
settings, or traversal details change. It is updated once per run, at the
end of the screening phases, from the run's per-block counters (merge, never
overwrite). A missing or corrupt file loads as an empty store and never
throws — reputation is an optimization, never a dependency.

How reputation is used (interface level; thresholds are Metric's spec):
blocks whose record is fresh (`lastTestedAt` within
`hard.reputationStaleDays`) start the primer with their historical
`attempts`/`successes` folded into the allocator's view, and blocks with
`deadRuns >= 2` and zero successes get a single confirmation probe instead
of a full primer (§4.1, `hard.reputationSkipDead`). Stale records are
treated as unknown: full primer, fresh evidence wins.

### 3.3 Old checkpoints: honor them (recommendation)

**Recommendation: honor — a checkpoint always finishes on the engine that
created it. No migration, no discard.**

- A v3 (or legacy) checkpoint resumed after this redesign lands continues
  the round-robin/legacy sweep through the existing code path, exactly as
  today. The `hard.engine` setting only affects **new** runs.
- Why not migrate: the round-robin cursor (`rangeIndex`/`passIndex`) has no
  faithful mapping into per-block primer/expansion state, and the earned
  results (eligibility NDJSON, counts) are per-IP while v4 block counters
  are per-block aggregates. A forced conversion would either double-count
  or silently drop earned evidence.
- Why not discard: a checkpoint can represent hours of probing on a slow
  link; resumability is a headline feature (menu option 5, the whole
  `results/hard-scan/` artifact set). Destroying it to force the new engine
  would break the product's promise for zero engineering need — the old
  sweep code remains in the tree as the fallback engine anyway (§4.4).
- Practical consequence: a user with a v3 checkpoint who wants DNA now
  finishes or abandons that run first; the next fresh Hard Scan uses the
  new engine. This is stated in the user docs step (§6, step 7).

### 3.4 Resume semantics mid-phase (v4)

- **Primer:** the block plan is re-derived deterministically from the
  catalog and `catalogHash` is compared. Blocks with `status >= 1` in the
  persisted arrays are skipped; probing resumes at the first unprimed block.
  If the hash differs (catalog edited between runs), the block arrays are
  discarded but the eligibility NDJSON, counts, and top list are kept —
  earned results are never thrown away; the primer simply restarts over the
  new block space.
- **Expansion:** the allocator is a pure function of the persisted per-block
  counters plus the budget counters, so resume recomputes the identical
  ranking and continues. There is no hidden allocator state to serialize.
- **In-flight batch:** as today, at most one batch (`concurrency`
  candidates) of un-persisted work is re-probed after a crash or kill.
- **Finalize:** unchanged from today — not checkpointed; it re-runs from
  the eligibility NDJSON after any resume.
- **Cancel (`Q` / Ctrl+C):** the current batch finishes, state persists
  with `status: "paused"` and the current `phase` retained — the same
  contract v3 offers today.

---

## 4. Config & surface

### 4.1 New `hard.*` settings keys

All keys live in `createDefaultSettings` (`src/config/settings.js`), additive
under the existing `hard` object. `t` below is the existing platform ternary
(`"android" === platform`).

| Key | Desktop | Android | Meaning |
| --- | --- | --- | --- |
| `hard.engine` | `"round-robin"` → `"blocks"` | same | Engine selector for **new** runs. Ships as `"round-robin"` at landing; flipped to `"blocks"` in the final sequencing step (§6, step 8). Existing checkpoints ignore it (§3.3). |
| `hard.primerPerBlock` | 3 | 2 | Primer probes per block (permutation entries `0..n-1`), each probed `hard.screeningRounds` rounds like today's screening. 7,697 blocks → 23,091 / 15,394 primer probes. |
| `hard.expansionBudget` | 12,000 | 6,000 | Max expansion probes per run, allocated by the bandit. Primer probes are not counted against it. The run's screening ends when the budget is spent or every block is closed. |
| `hard.banditExploration` | 1.0 | 1.0 | UCB exploration constant `c` (§2.1). 0 = pure exploitation of the Wilson lower bound. |
| `hard.reputationEnabled` | `true` | `true` | Read + update `data/block-reputation.json`. `false` = every run starts from zero knowledge. |
| `hard.reputationStaleDays` | 14 | 14 | Records older than this are treated as unknown (full primer). |
| `hard.reputationSkipDead` | `true` | `true` | Blocks with fresh reputation of `deadRuns >= 2` and zero successes get 1 confirmation primer probe instead of `primerPerBlock`. |

### 4.2 Keys reused unchanged

`hard.concurrency` (still calibration-adjusted), `hard.screeningRounds`,
`hard.recheckTop`, `hard.saveEvery`, `hard.liveTop`, `hard.finalTop`,
`hard.delayedRetry`, `hard.retryLimit`; `scan.minimumSuccessRate`,
`scan.timeoutMs`, `scan.rounds`, `scan.seed`; `verification.enabled` /
`verification.sprt`. The finalize pipeline (§1.4) reads exactly the same
keys in both engines.

### 4.3 CLI / menu impact

- Menu entries do not change: option 4 "Hard Deep Scan", option 5 "Resume
  Hard Scan". CLI commands `hard` / `resume` do not change. What changes is
  behind them: engine dispatch on `hard.engine` for new runs, and progress
  events gain the phase strings `hard-primer` / `hard-expansion` (the
  `onProgress` phase field is already free-form and the note text already
  carries human-readable detail, so renderers need at most a label mapping).
- The Scan Settings editor (menu option 12) does not need new rows for
  landing; the keys are settable via `data/settings.json`. Editor rows are a
  follow-up for Vista/Scribe once defaults settle.
- `docs/HARD-DEEP-SCAN.md` is rewritten in the docs step (§6, step 7): new
  pipeline description, new keys, and the "old checkpoint finishes on the
  old engine" rule from §3.3.

### 4.4 Rollout flag — recommendation

**Ship behind the flag: yes.** `hard.engine` defaults to `"round-robin"`
while the new code lands, and the default flips only in the last step.
Reasons: (1) old checkpoints must finish on the old engine anyway, so both
engines coexist regardless — the flag makes that explicit instead of
incidental; (2) rollback becomes a one-line settings change, not a code
revert (§6); (3) the same catalog can be A/B-run under both engines during
validation, which is exactly what the simulation harness (§5.3) compares in
miniature.

---

## 5. Test strategy

### 5.1 Baseline that must stay green

`npm test` (`node --test --test-timeout=20000 test/*.test.js`) at `69a79fd`:
**144 tests, 144 pass** (verified in the design worktree). Every sequencing
step (§6) must end with the full suite green. Guard tests by name:

- `test/hard-order.test.js` — traversal contract for the fallback engine and
  legacy resume; must pass untouched.
- `test/hard-scheduler.test.js` — batch order, concurrency, early stop; also
  guards `src/scan.js`, which shares the module.
- `test/settings.test.js`, `test/traffic-budget.test.js` — defaults and
  migration backfill (extended in step 4, §6).
- `test/report.test.js`, `test/report-v6.test.js` — summary shape and report
  invariants under the additive `block` field.
- `test/menu-output.test.js`, `test/menu-config.test.js`, `test/cli.test.js`
  — surface stability (entries, help text, option handling).
- `test/saturation.test.js` — load/gates seams; untouched by the redesign
  but part of the finalize chain.

### 5.2 New unit tests per module

- `test/blocks.test.js` — `buildBlockPlan` on synthetic ranges: a /24 yields
  1 block; a /22 yields 4; a /20 yields 16; block `usable`/`startOffset`
  match `hard-order.js`'s per-range semantics (network/broadcast skipped).
  Against the shipped catalog: exactly **7,697 blocks** and 1,970,432 total
  usable addresses. `blockProbeOrder` is deterministic for a fixed seed,
  contains every usable offset exactly once; `blockCandidate` at index *i*
  is stable across calls and never repeats an IP within a block.
- `test/bandit.test.js` — unprobed blocks outrank all probed ones; at equal
  attempts the higher Wilson lower bound wins; the exploration bonus decays
  as global probes grow; ranking is a pure function (identical input →
  identical output, input not mutated); `pickBlocks` respects its count.
- `test/hard-reputation.test.js` — save/load round-trip in a temp dir;
  `mergeRunIntoReputation` accumulates attempts/successes, increments
  `runs`, maintains `deadRuns` (increment on an all-fail run, reset on any
  success); staleness boundary at exactly `staleDays`; missing file, corrupt
  JSON, and wrong `version` all load as an empty store without throwing.
- `test/hard-engine.test.js` — driver-level, synthetic `task` (§5.3):
  primer visits every block exactly `primerPerBlock` times; expansion
  probes go only to allocator-picked blocks; an all-fail block receives no
  expansion probes beyond the allocator's exploration minimum; the expansion
  budget is respected exactly (never exceeded by one probe).

### 5.3 Simulation harness

The injection point already exists: the `task(candidate, round)` callback
accepted by `runEligibilityBatch` / `runAdaptiveEligibilityBatch` /
`probeCandidateRounds` in `src/hard-scheduler.js`. Production binds it to
`probeWebsocket`; tests bind fakes. `runBlockScreening` (§2.1) is therefore
specified to take the same `task` seam plus an `onSummary` sink — no network,
no Xray, no real catalog needed.

Harness placement, following the `test/fixtures/fake-xray.js` precedent:

- `test/fixtures/virtual-catalog.js` — builds a small synthetic catalog
  (e.g. `203.0.113.0/22` + `198.51.100.0/23` → 6 blocks) and a ground-truth
  quality map keyed by block: hot blocks `p(ok) = 0.9`, warm `0.5`, dead
  `0.0`, sampled deterministically with `mulberry32` seeded per
  (block, offset). Its `task` returns well-formed observations
  (`{ ok, handshakeMs, connectMs, error }`) indistinguishable in shape from
  `probeWebsocket` results.
- `test/hard-dna-simulation.test.js` — end-to-end assertions on the driver:
  1. Primer coverage is 100% of blocks.
  2. At least 70% of expansion probes land in hot blocks — and the same
     budget spent in round-robin order (computed in-test from
     `nextRoundRobinCandidate`) lands ~uniformly, giving a regression-proof
     baseline comparison.
  3. Every hot block contributes at least one candidate to the finalist set.
  4. Total probes ≤ primer total + `expansionBudget`, always.
  5. Crash/resume equivalence: serialize driver state mid-expansion,
     rebuild, resume — the finalist set equals the uninterrupted run's.

The harness runs in milliseconds (no sockets, no timers beyond microtask
scheduling) and stays inside the standard `npm test` invocation.

---

## 6. Implementation sequencing

Sizes: XS < 50 lines, S ≈ 150–300, M ≈ 300–600, L ≈ 600–900 (code + tests).
Every step is one commit (or a small stack), lands with the full suite
green, and is independently revertable.

| # | Step | Size | Rollback |
| --- | --- | --- | --- |
| 1 | `src/candidate/blocks.js` + `test/blocks.test.js`. Pure addition, zero callers. | S | Delete both files; nothing references them. |
| 2 | `src/measurement/bandit.js` + `test/bandit.test.js`. Pure addition. | S | Delete both files. |
| 3 | `layout.reputationFile` in `src/platform/paths.js` + `src/hard-reputation.js` + `test/hard-reputation.test.js`. Store exists but is unused. | S–M | Revert; a stray `data/block-reputation.json` on user machines is ignored by all other code. |
| 4 | Additive `hard.*` keys in `src/config/settings.js` (engine still `"round-robin"`) + defaults/backfill cases in `test/settings.test.js`. Behavior-neutral: nothing reads the keys yet. | XS | Revert; unknown keys persisted in user `settings.json` are harmlessly preserved by `mergeSettings` under older builds. |
| 5 | `src/hard-engine.js` driver (primer + expansion over `runEligibilityBatch`, reputation hooks, `task` seam) + `test/hard-engine.test.js` + simulation harness (`test/fixtures/virtual-catalog.js`, `test/hard-dna-simulation.test.js`). Still zero wiring into `runHardScan`. | L | Delete module, fixture, and tests. |
| 6 | Wire into `src/hard-scan.js`: engine dispatch, `HARD_STATE_VERSION` 4 state write/read, phase-aware persist/snapshot, shared finalize, additive report fields (§2.4); v3/legacy honor path (§3.3) covered by resume tests. Default engine still `"round-robin"`, so production behavior is unchanged until step 8. | M–L | Revert the commit; the flag default keeps every user on the old engine throughout. |
| 7 | Surface + docs: progress phase labels (`hard-primer` / `hard-expansion`), `docs/HARD-DEEP-SCAN.md` rewrite, CHANGELOG entry. | S | Revert; docs and labels only. |
| 8 | Flip the default: `hard.engine: "blocks"` in `createDefaultSettings` + updated defaults assertions. One line plus tests. | XS | Flip back to `"round-robin"` — the designed kill switch. The old engine remains in-tree as fallback and as the resume path for old checkpoints. |

Total estimate: ≈ 1,600–2,100 lines including tests, across 8 commits.
Steps 1–4 are additive dead code until step 5, and steps 5–7 are inert
until step 8 — there is no point in the sequence where a half-landed
redesign can change a user's scan.

> **Status note — 2026-11-20.** All 8 steps have landed. Step 8 (the
> default flip to `hard.engine: "blocks"`) is done, so the block-adaptive
> engine is the default traversal for new Hard Deep Scan runs; the
> round-robin engine remains in-tree as the selectable fallback and the
> resume path for v3 checkpoints, exactly as sequenced above. This annex
> is retained as the historical plan record.
