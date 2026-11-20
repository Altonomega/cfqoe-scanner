# Hard Deep Scan — DNA Redesign (Algorithm Blueprint)

Status: **design blueprint for review — no code yet.**
Author: Metric (measurement science), CFQoE dev team. Lead: TARS.
Date: 2026-11-20. Base: main `69a79fd` (v0.8.6 + cleanup rounds 1–2).
Companion documents: `docs/HARD-DEEP-SCAN.md` (current design),
`docs/MEASUREMENT-ENGINE.md`, `docs/METHODOLOGY.md`.

Mahan's originating idea: model the scan on human DNA replication — many
origins firing in parallel, replication bubbles expanding bidirectionally and
merging, proofreading before a result is accepted. This blueprint is the
rigorous form of that idea:

| DNA replication | This design |
| --- | --- |
| Origins of replication, many, fired in parallel | **Primer phase**: every /24 block of the catalog is probed lightly, in stratified waves |
| Replication bubbles expanding from hot origins | **Expansion phase**: probe budget is allocated adaptively to blocks whose evidence is promising |
| Forks merging | Expanded blocks feed one global candidate pool |
| Polymerase proofreading | The **existing** SPRT verification + tunnel/streaming/load pipeline, unchanged |
| Genome memory / epigenetic state | **Block reputation** persisted across runs, with decay |

## 0. Decision summary

| # | Decision | Value |
| --- | --- | --- |
| D1 | Scan unit | /24 block (grid cell ∩ catalog); sub-/24 ranges stay whole |
| D2 | Primer depth | **3 probes per block**, uniform, both platforms (23,091 probes) |
| D3 | Within-block selection | Seeded random without replacement, per-block RNG stream `mulberry32(seed XOR blockBase)` |
| D4 | Allocation rule | **Wilson-UCB**: index = `wilsonInterval(s, n).upper` (existing code, z = 1.96) |
| D5 | Expansion shape | Waves of `10 × concurrency` probes; chunk of 4 per block per pass; per-range cap 25% of a wave |
| D6 | Max depth per block | `min(usableHosts, 32)` run probes |
| D7 | Total budget cap | 72,000 probes desktop / 40,000 Android (primer + expansion; ≈ 3.7% / 2.0% of exhaustive) |
| D8 | Diversity caps | ≤ 8 candidates per block into the 200-pool; ≤ 4 per block into SPRT recheck |
| D9 | Heterogeneity split | Fisher exact two-sided p ≤ 0.05 **and** \|Δp̂\| ≥ 0.5, halves ≥ 4 obs each; max depth 2 (→ /26) |
| D10 | Reputation | Per-block attempts/successes + best candidates; exponential decay, half-life 14 days; freshness tiers skip/reduce primers |
| D11 | Downstream pipeline | SPRT verification, delayed retry, tunnel/streaming/load: **unchanged** |
| D12 | Coverage claim | "100% of blocks primer-screened" + achieved deep-coverage %; per-IP coverage claims are removed |

All numbers below are computed from the shipped catalog
(`config/cloudflare-ipv4.txt`) and the repo's own `wilsonInterval`
implementation; the computation script is reproducible from the formulas
given in each section.

---

## 1. Problem in numbers

### 1.1 The catalog

Computed from `config/cloudflare-ipv4.txt` via `parseRangeList` /
`parseCidr` (`src/candidate/ipv4.js`):

| Quantity | Value |
| --- | --- |
| Catalog ranges | 753 |
| Total addresses | 1,970,432 |
| Usable addresses (existing size−2 rule, `buildRangePlan`) | 1,968,926 |
| Distinct /24 blocks | **7,697** |
| Prefix histogram | /13×1, /14×1, /15×3, /16×1, /17×2, /18×7, /19×8, /20×24, /21×43, /22×107, /23×161, /24×395 |

The current Hard scan's `state.total` is the usable-address count:
**1,968,926**. That is the denominator its progress display counts toward.

### 1.2 Cost model of one eligibility probe

One probe is `probeWebsocket({ ip, vless, timeoutMs })`
(`src/probe/websocket.js`) with `timeoutMs = settings.scan.timeoutMs = 6000`
by default: a TCP connect (or TLS connect with the configured SNI when
`security = tls`), one WebSocket Upgrade request, resolved by the first
complete response header block, a socket error, or the 6 s timeout. The probe
cost is therefore bimodal:

- **Success** (HTTP 101, valid upgrade): two network round trips + TLS 1.3
  handshake. Assumption: median **0.7 s** on the long-haul, filtered paths
  this tool is built for. (Platform radio overhead on Android is folded into
  the scenario means; the platform contrast in the tables comes from
  concurrency, as specified: 12 desktop / 6 Android.)
- **Failure**: either fast (refused / reset / TLS alert / immediate non-101
  status, ≈ **0.2 s**) or slow (packets dropped by filtering → the full
  **6.0 s** timeout).

Expected cost, with `q` = fraction of probed addresses that complete the
upgrade and `r` = fraction of failures that end in timeout:

```
E[cost] = q·0.7 + (1 − q)·( r·6.0 + (1 − r)·0.2 )
```

| Scenario | q | r | E[cost] |
| --- | --- | --- | --- |
| Optimistic (mild filtering) | 0.80 | 0.30 | 0.95 s |
| Typical (censored path) | 0.35 | 0.70 | 3.01 s |
| Pessimistic (heavy filtering) | 0.10 | 0.90 | 4.95 s |

### 1.3 Wall-clock: exhaustive per-IP pass vs primer pass

One screening round per address (the shipped default,
`hard.screeningRounds = 1`), wall-clock = probes × E[cost] / concurrency:

| Pass | Probes | Desktop (×12) opt / typ / pess | Android (×6) opt / typ / pess |
| --- | --- | --- | --- |
| Exhaustive (today's nominal target) | 1,968,926 | **43.2 h / 137.4 h / 225.5 h** | **86.4 h / 274.7 h / 451.0 h** |
| Primer, 3 per block (§3) | 23,091 | 0.5 h / 1.6 h / 2.6 h | 1.0 h / 3.2 h / 5.3 h |

Even under the friendliest assumptions — and even if calibration raised
concurrency to its highest level (16) — an exhaustive pass is **≥ 32 hours**
of continuous scanning; under typical filtering it is **5.7 days** on desktop
and **11.5 days** on Android. Traffic bytes are not the binding constraint
(each probe transfers ≲ 2 KB typically; the exhaustive total is a few GB);
**time is**.

### 1.4 Conclusion: per-IP coverage is a fiction today

No real Hard run finishes 1,968,926 probes. Runs are paused (the checkpoint /
resume machinery exists precisely because of this), and the finalists of an
interrupted run come from the round-robin prefix: host #0…#k of *every*
range — breadth without depth, one screening observation per candidate. The
report's `totals.tested` then reads as catalog coverage while the tested set
is a deterministic shallow slice, and `progress = tested / 1,968,926` implies
an exhaustive intent that is never met. The redesign replaces the unit of
coverage (block, §2), guarantees the cheap pass actually completes (§3), and
spends the remaining budget where the evidence points (§4). Section 8 defines
what the report may then honestly claim.

---

## 2. Block model

### 2.1 Definition

A **block** is a /24 grid cell intersected with the catalog:

- Partition each catalog range into /24-aligned cells
  (`cellBase = floor(base / 256) · 256`). A cell clipped by a range boundary
  keeps only its in-range addresses.
- A range smaller than a /24 (prefix > 24) is **not** split: it forms its own
  block, keyed by its CIDR.
- If two ranges ever share a cell, they merge into one block whose address
  set is the union of the in-catalog parts.
- Block id: `a.b.c.0/24` for grid cells; the range CIDR for sub-/24 blocks.
- Usable hosts follow the existing convention (`usableMeta` in
  `src/candidate/hard-order.js`, `drawIp` in `src/candidate/ipv4.js`): for
  size > 2, skip network and broadcast → a full cell has **254** usable
  hosts, offsets 1–254.

For the shipped catalog this degenerates to the clean case — verified by
computation: all 753 ranges are /24-aligned, none is smaller than a /24, no
cell is shared, and all **7,697 blocks are full 256-address cells**. The
general rules above exist so a future catalog edit cannot silently break the
model; the implementation must not hard-code the clean case.

### 2.2 Why /24

/24 is the smallest unit that (a) routing and anycast assignment treat
coherently in practice, (b) keeps the block count (7,697) two orders of
magnitude below the address count, making a guaranteed full pass affordable
(§1.3), and (c) is large enough (254 usable hosts) to support meaningful
within-block statistics and the heterogeneity split of §5. /16 would be too
coarse (a /16 mixes many independently-routed /24s); /25–/26 as the base
unit would multiply the primer cost by 2–4× for little triage gain — they
appear only as split children (§5).

### 2.3 Within-block probe selection: seeded random

**Decision: seeded random sampling without replacement**, reusing the
codebase's `mulberry32` (`src/random.js`, already used by
`sampleCandidates` with `seed = settings.scan.seed = 404`).

Each block owns an independent RNG stream:

```
stream(block) = mulberry32(seed XOR blockBaseInt)
```

drawing usable host offsets without replacement (per-block used-set, mirroring
`drawIp`). Justification over a deterministic spread (fixed offsets such as
.1/.85/.170, or a fixed stride):

1. **No aliasing.** Intra-block address allocation is structured (specific
   offsets are often special — e.g. .1 frequently differs from the block's
   bulk). Fixed offsets would measure the same atypical hosts in every block
   and bias every block estimate the same way; random offsets are unbiased.
2. **Reproducibility.** The primer/expansion set of a block is a pure
   function of (catalog, seed, block). Same seed + same catalog → identical
   probe plan → comparable runs, and the simulation plan of §9 can demand
   exact determinism.
3. **Order independence.** Because the stream is per-block, the adaptive
   traversal order of §4 cannot change *which* hosts a block contributes —
   a property the current global-stream sampler (`sampleCandidates`) does
   not have, and one that checkpoint/resume under an adaptive order requires.

Every probe record must carry `{ blockId, hostOffset }` in addition to
today's `{ ip, range }`; §5's split test and §7's reputation both key off it.

---

## 3. Primer phase ("origins")

### 3.1 Depth: 3 probes per block

Every block receives exactly `min(3, usable)` primer probes — **23,091
probes** for the shipped catalog. Uniform depth on both platforms is
deliberate: block indices (§4) are only comparable across blocks if they
start from the same evidence base, and platform budget differences are
handled by the expansion budget (§4.5), not by thinner primers.

### 3.2 What 3 samples can and cannot say — honestly

Wilson 95% intervals from the repo's `wilsonInterval` (z = 1.96), n = 3:

| Outcome | Interval | Reading |
| --- | --- | --- |
| 3/3 | [0.439, 1.000] | Promising: true rate plausibly ≥ 0.44 |
| 2/3 | [0.208, 0.939] | Alive, unresolved |
| 1/3 | [0.062, 0.792] | Probably cold, far from proven |
| 0/3 | [0.000, 0.562] | Cold — **not** dead: a block with true p = 0.3 produces 0/3 with probability 0.343; p = 0.5 with probability 0.125 |

So the primer phase is a **triage, not a ranking and never a death
certificate**: it orders blocks for expansion and cannot, by itself, justify
excluding any block. Two consequences are built into the design:

- **Nothing is discarded by the primer.** Exclusion pressure comes only from
  the budget-driven rules of §4.4, which compare a block's *upper* bound
  against the *lower* bound of what the finalist pool already holds — and
  even then only parks the block behind all eligible ones (§4.4).
- The primer's real guarantee is at the top end: a genuinely hot block
  (p ≥ 0.9) shows ≤ 1 success in 3 probes with probability 0.028, and 0/3
  with probability 0.001. Hot blocks essentially never look cold; §9 makes
  this a tested pass criterion, not a hope.

Primer observations are ordinary eligibility observations (one round each,
`probeWebsocket`), recorded per IP exactly as today's screening observations
are, and they count toward that IP's evidence if the IP later reaches the
pool (§6).

### 3.3 Traversal order: stratified waves over ranges

Primer order preserves the current design's stratified fairness, lifted from
host granularity to block granularity (the same idea as
`nextRoundRobinCandidate`, one level up):

- Blocks are grouped by their catalog range (ranges in catalog order, blocks
  by base address within a range).
- **Pass k** primers the k-th block of every range that has one, in range
  order; passes continue until every block is primed.
- Within a pass, probes run in parallel batches of `concurrency` through the
  existing `runEligibilityBatch`.

An interrupted primer phase has therefore touched a prefix of the blocks of
*every* range — after t complete passes, every range has
`min(t, blocksInRange)` blocks primed — instead of exhausting a few ranges
and ignoring the rest. This is the property that made range round-robin
worth keeping, preserved under the new unit.

### 3.4 Early termination

Per block: none. The primer is fixed-depth; variable primer depth would
destroy the comparability that §4's index relies on.

Global safety valves (both abort the primer with a diagnostic, checkpointed,
resumable):

1. **Dead-path valve.** After each wave of `10 × concurrency` probes, if
   cumulative primer successes are < 0.5% of probes with ≥ 1,000 probes
   spent, abort. Rationale: if the true mean success rate were even 2%,
   observing < 0.5% in 1,000 probes is a > 3.4σ event (binomial mean 20,
   sd ≈ 4.4; p ≈ 3 × 10⁻⁴). A near-zero success rate at catalog scale means
   the path or the configuration is broken, not that the catalog is dead.
2. **Hard-error valve.** If ≥ 95% of the first 200 probes fail with the
   *same* non-retryable error class (`classifyProbeError`,
   `src/probe/errors.js` — e.g. every probe returning the same unexpected
   HTTP status because the VLESS path is wrong), abort immediately and
   surface that error. A configuration error must not be allowed to burn
   23,091 probes.

Blocks whose primers return hard (non-retryable) errors are marked
`hard-dead` for this run: they stay out of expansion (§4) but the mark is
run-local and is **not** written to reputation (§7) — a fixed configuration
must find them alive on the next run.

---

## 4. Block scoring and budget allocation ("bubbles")

### 4.1 The index: Wilson-UCB

Each block b carries run counts (s_b successes, n_b attempts) plus, when
reputation seeded it (§7), prior counts (s₀, n₀). Effective counts:
`s = s_b + s₀`, `n = n_b + n₀`. The allocation index is

```
U_b = wilsonInterval(s, n).upper          (z = 1.959963984540054)
```

i.e. the upper end of the same Wilson 95% interval the codebase already
computes for every candidate (`src/measurement/confidence.js`) and already
ranks candidates by (via its lower end, in `compareEligibility`).

**Why this rule, against the alternatives:**

- **It is a UCB rule.** Selecting the block with the highest plausible true
  rate is exactly optimism under uncertainty: the Wilson upper bound widens
  as n shrinks (≈ z·√(p̂(1−p̂)/n)), so under-sampled blocks automatically
  carry an exploration bonus, and the bonus decays with evidence — the
  UCB1 principle, with the bonus supplied by the score interval instead of
  UCB1's `√(2 ln t / n)` term. No new statistical dialect is introduced.
- **It reuses the project's machinery verbatim.** One interval function
  drives candidate ranking (lower bound, conservative), block allocation
  (upper bound, optimistic), and the report. The SPRT stage downstream
  (§6) remains the frequentist decision procedure it already is.
- **Thompson sampling was considered and rejected** (see Q3, §10): sampling
  θ_b ~ Beta(s+1, n−s+1) is a fine rule, but it makes the probe order a
  function of RNG draws rather than of the evidence alone, weakening the
  exact-determinism property §2.3 guarantees and §9 tests, and it adds a
  Bayesian posterior dialect next to the existing Wilson/SPRT one for no
  measured benefit at this scale (7,697 arms, shallow depths).

Tie-breaking is deterministic: higher U_b, then lower n, then lower block
base address.

### 4.2 Expansion waves

Expansion proceeds in **waves** of `W = 10 × concurrency` probes
(120 desktop / 60 Android). Per wave:

1. Compute the pool threshold τ (§4.4) and the eligible set (§4.4).
2. Sort eligible blocks by the index order of §4.1.
3. Walk the sorted list in passes; each block receives a **chunk of 4**
   probes per pass (new hosts, drawn from its §2.3 stream) until the wave
   is filled or the eligible set is drained. The chunk keeps one hot block
   from consuming an entire wave before other blocks' indices are refreshed.
4. **Per-range fairness cap:** no single catalog range receives more than
   25% of a wave's probes, unless fewer than 4 ranges have eligible blocks.
   This preserves a floor of the current design's stratification inside the
   adaptive phase.
5. After the wave: update the candidate pool (§6), run the split test (§5)
   on blocks that crossed its trigger, checkpoint if the `saveEvery`
   cadence is reached, recompute indices.

### 4.3 Max depth

`depthCap(b) = min(usableHosts(b), 32)` run probes per block (primer +
expansion; reputation prior counts as evidence, not as run depth).

Justification from the interval widths (repo `wilsonInterval`): at n = 32
the 95% interval width is 0.107 for 32/32, 0.210 for 29/32, 0.327 for
16/32. Beyond n = 32 the width shrinks only as 1/√n — quadrupling spend to
128 probes merely halves it — while the marginal value of block-level
precision collapses once the block's candidates are in the pool, because
per-candidate precision is the SPRT stage's job (§6), not the block stage's.
32 probes also suffice to fire the §5 split test twice over.

### 4.4 Eligibility, parking, and the pool threshold

Let the **pool** be the global candidate pool of §6 (capacity `finalTop` =
200). Define

```
τ = Wilson lower bound of the candidate currently ranked #200 in the pool,
    or 0 while the pool holds fewer than 200 candidates.
```

- A block is **expansion-eligible** if it has unprobed usable hosts,
  `n_run < depthCap`, is not `hard-dead` (§3.4), and `U_b ≥ τ`.
- A block with `n_run ≥ 6` and `U_b < 0.30` is **parked** while τ = 0 (early
  expansion): with 6+ samples its upper bound already excludes the rates
  that produce finalists (finalist eligibility needs observed success
  ≥ `minimumSuccessRate` = 0.6, ranked by lower bound), so it yields to
  every other block. Parked blocks re-enter if all eligible blocks are
  exhausted or capped and budget remains (residual pass) — parking is
  prioritisation, never deletion, mirroring §3.2's honesty constraint.
- Once τ > 0, the `U_b ≥ τ` test subsumes parking: a block whose *best
  plausible* rate cannot beat the *proven* rate of the pool's weakest
  retained candidate cannot contribute a surviving finalist, and expansion
  spend on it is provably wasted.

### 4.5 Budget model and stopping rules

Total probe budget (primer + expansion; the delayed-retry queue keeps its
own existing `retryLimit`, §6):

| Platform | Primer | Expansion headroom | **Total cap** | Share of exhaustive |
| --- | --- | --- | --- | --- |
| Desktop | 23,091 | 48,909 | **72,000** | 3.7% |
| Android | 23,091 | 16,909 | **40,000** | 2.0% |

Estimated wall-clock at the caps (§1.2 scenarios): desktop 1.6 h / 5.0 h /
8.3 h (opt/typ/pess); Android 1.8 h / 5.6 h / 9.2 h. These are caps for a
resumable long scan, not targets — the stopping rules below are expected to
bind first on any quality map with real concentration, and §7's warm starts
cut repeat runs to a fraction of the primer cost. The budget is expressed
in probes (device-independent) and is user-configurable
(proposed setting: `hard.budgetProbes`).

**Expansion stops when any of:**

1. The total budget cap is spent.
2. No block is expansion-eligible and no parked block remains (all blocks
   exhausted, capped, or below threshold).
3. **Marginal-gain stop:** `max_b U_b < τ` for **2 consecutive waves** (the
   hysteresis guards against stopping on one unlucky wave).
4. The user cancels (Q / Ctrl+C) — state checkpoints and the run resumes
   later, exactly as today.

---

## 5. Heterogeneity guard ("when a block is not one block")

The /24-uniformity assumption is usually true and sometimes false: a block
can straddle two anycast assignments or a filtering boundary. The design
must detect that from the block's own samples and split the block, or the
block's averaged rate will mislead the index in both directions (a
half-great block looks mediocre; a half-dead block wastes expansion).

### 5.1 Bookkeeping

Per block, maintain two sub-counters split by host offset at the block's
midpoint (for a full /24: lower half = offsets 1–127, upper half =
128–254): `(s_lo, n_lo)`, `(s_hi, n_hi)`, accumulated from the block's
probe records (§2.3). No extra probes are spent on bookkeeping.

### 5.2 Split rule

Evaluate after every expansion wave for each unsplit block with
split-depth < 2 and usable ≥ 32. **Split** the block into its two halves
(/25 children; recursively /26) when **all** hold:

1. `n ≥ 8` with `n_lo ≥ 4` and `n_hi ≥ 4`;
2. Fisher's exact test (two-sided) on `[[s_lo, f_lo], [s_hi, f_hi]]`
   gives **p ≤ 0.05**;
3. Effect-size floor: **|p̂_lo − p̂_hi| ≥ 0.5**.

Calibration of the rule (computed): the canonical clean split 4/4 vs 0/4
gives p = 0.0286 → splits. 3/3 vs 0/3 gives p = 0.1000 → does **not** split
(correctly: six probes cannot carry that conclusion). The effect-size floor
exists because at larger n, Fisher alone can flag differences too small to
matter (e.g. 0.75 vs 0.42) — the guard is for *gross* heterogeneity only.
The per-block false-split rate is bounded by α = 0.05 per test by
construction; §9 measures it on homogeneous maps and requires ≤ 5%.

### 5.3 Cost and consequences

- A split costs **0 probes**: the children inherit the parent's observations,
  partitioned by host offset, and continue with independent indices and
  depth caps (§4.3 applies per child).
- The parent retires from allocation; its candidates already in the pool
  stay (they are per-IP records, unaffected).
- Worst-case cost of a *false* split is bounded: two children × depth cap
  32 instead of one block × 32 — at most 32 extra probes, plus bookkeeping.
- A secondary signal is recorded but **not** used as a trigger in v1: colo
  divergence. If a block's successful probes split across ≥ 2 colos with
  `summarizePops` consistency < 0.6, the fact is logged with the block's
  record; per-colo QoE differences are a downstream concern (§6), not a
  reason to split the eligibility unit.

---

## 6. Merge to finalists ("proofreading")

The downstream pipeline is **unchanged**. What changes is only how the
candidate pool is produced.

### 6.1 From blocks to the candidate pool

- Expansion always probes **new** hosts in a block (without replacement,
  §2.3). Re-probing an already-probed IP is never the block stage's job:
  per-IP temporal stability is exactly what SPRT verification measures.
- Every probed IP keeps its own observation list (primer and/or expansion
  observations — in v1 at most a handful, typically 1) and is summarised by
  the existing `buildEligibilitySummary` (Wilson interval, confidence label,
  POP summary).
- The **pool** holds at most `finalTop` = 200 candidates, built in two steps:
  1. **Per-block pre-filter (diversity):** each block contributes at most
     **8** of its candidates, its best by (success, then handshake median —
     the existing `compareEligibility` order).
  2. **Global merge:** the contributed candidates are ranked by the existing
     `compareEligibility` (Wilson lower, success rate, handshake, connect,
     IP) and truncated to 200.
- The diversity cap is a robustness measure, not a cosmetic one: IPs in one
  /24 are fate-sharing (same edge cluster, same filtering fate), so 200
  slots filled from two hot blocks would produce a finalist list that is
  one event away from useless. The cap forces ≥ 25 distinct blocks into a
  full pool.

### 6.2 Verification and QoE stages — unchanged

From the pool, today's flow runs verbatim:

1. **SPRT recheck** of the top `recheckTop` (20 desktop / 12 Android),
   with an added per-block cap of **4** (a full recheck then spans ≥ 5
   blocks), via `runAdaptiveEligibilityBatch` with
   `settings.verification.sprt` (p0 = 0.6, p1 = 0.9, α = 0.05, β = 0.10,
   minRounds 2, maxRounds 16) — or fixed rounds when verification is
   disabled, as today.
2. **Delayed retry** of transient failures from *both* new phases
   (`selectDelayedRetries` already filters by retryable error class),
   merged into the finalist list as today.
3. **Tunnel stage** (`tunnel.limit` = 5, `tunnel.rounds` = 1): Xray +
   browsing + streaming + load probes, `applyTunnelResults`, gates,
   `rankCandidates`, report — byte-for-byte the existing code path.

### 6.3 What `finalTop` means now

Unchanged in form — "the 200 candidates retained for verification and the
final report" — but changed in provenance: the 200 are now the best of an
*adaptively probed subset* (≤ 72,000 / 40,000 probes) instead of the best of
a round-robin prefix. The report must say so (§8): `totals` gains
`fromPrimerOnly` and `fromExpandedBlocks` counts, and each candidate's
record already carries its range; block provenance (`blockId`) is added to
the eligibility NDJSON so the pool's block diversity is auditable after the
run.

---

## 7. Reputation across runs ("genome memory")

### 7.1 What persists

A new long-lived file next to the Hard artifacts
(`results/hard-scan/block-reputation.json`, written with the same 0600 mode
as other outputs), schema version 1:

```json
{
  "version": 1,
  "catalogHash": "<sha256 of the ranges file, hex>",
  "updatedAt": "<ISO timestamp>",
  "blocks": {
    "104.16.0.0/24": {
      "attempts": 19, "successes": 17,
      "updatedAt": "<ISO timestamp>", "lastRunId": "…",
      "best": [ { "ip": "…", "attempts": 3, "successes": 3, "handshakeMedianMs": 412 } ],
      "parent": null, "children": null
    }
  }
}
```

Per block: aggregate attempts/successes (primer + expansion, all runs),
last-seen timestamp, up to **4 best candidate IPs** (by successes, then
handshake median), and split lineage (children if the block ever split —
children carry their own entries; a split parent's entry is kept as lineage
only and no longer seeds indices). No credentials, no per-probe data:
aggregate statistics only, the same redaction posture as the reports.

### 7.2 Decay

Stored counts are evidence about a network that changes. On load, counts
decay exponentially with **half-life 14 days**:

```
w = 2^(−ageDays / 14);   n_prior = round(attempts · w);   s_prior = round(successes · w)
```

The decayed counts enter §4.1's index as the prior (s₀, n₀) — and **only**
there. Candidate-level summaries remain strictly run-local; reputation is a
block-level prior and the report never presents it as a measurement.
On store, merged counts (`decayed stored + this run's counts`) are capped
at **64 attempts** per block, bounding the prior's weight to at most twice
one run's depth cap, so fresh evidence can always outvote stale history
within a single run.

### 7.3 Freshness tiers: skipping and reducing primers

| Reputation state at run start | Primer behaviour |
| --- | --- |
| Age ≤ 3 days and stored attempts ≥ 3 | **Skip primer**; block enters expansion directly, seeded by decayed counts |
| 3 days < age ≤ 21 days | **1 confirmation probe**: on success the block is seeded as above; on failure it falls back to the full 3-probe primer |
| Age > 21 days, or decayed n_prior < 1, or block unseen | **Full primer** (3 probes) |

Savings, quantified: a next-day re-run spends **0** primer probes on known
blocks (vs 23,091); a weekly re-run (all blocks in the confirmation tier)
spends **7,697** (a 67% primer saving). First runs and post-catalog-change
runs pay full price — that is the honest cost of cold knowledge.

### 7.4 Interaction with checkpoint / resume

- Reputation updates ride the existing checkpoint cadence (`saveEvery`,
  `persistState`) and are flushed on pause and on completion. Unlike the
  run state file — which completion deletes today (`removeStateFile`) —
  the reputation file is **never deleted by a run**.
- A resumed run's own run-state takes precedence: blocks it already probed
  this run use run counts; reputation only seeds blocks the run has not
  touched.
- Because the reputation file is long-lived, it must be written atomically
  (write temp + rename) — a deliberate upgrade over the current direct-write
  pattern, flagged here as an implementation requirement.
- Catalog drift: if `catalogHash` differs at load, entries for blocks that
  no longer exist in the catalog are dropped, new blocks are treated as
  unseen, and surviving blocks keep their (decayed) entries. Blocks are
  grid cells, so most edits short of a catalog replacement preserve most
  reputation.
- State versioning: the run state gains the block-phase fields (phase,
  primer pass, per-block run counters, split map) → `HARD_STATE_VERSION`
  bumps 3 → 4. Legacy v3 (and older) checkpoints keep resuming under the
  legacy traversal, exactly as `isLegacyState` handles them today; the new
  engine applies to fresh runs only (Q9, §10).

---

## 8. Coverage honesty

The redesign's reporting contract replaces the per-IP coverage fiction
(§1.4) with claims that are exactly true:

**The report and live snapshot gain a `coverage` object:**

```json
"coverage": {
  "unit": "block",
  "blocksTotal": 7697,
  "blocksPrimed": 7697,
  "blocksExpanded": 412,
  "blocksExhausted": 37,
  "blocksSplit": 11,
  "ipsProbed": 51208,
  "ipsTotal": 1968926,
  "probeBudget": 72000,
  "probesSpent": 51208
}
```

**Permitted claims** (only when the numbers say so):

- "100% of catalog blocks primer-screened (7,697 / 7,697)" — the primer
  phase either completes or the claim is scaled to the achieved count.
- "Deep coverage is adaptive: N blocks expanded to depth ≥ 8; M blocks
  exhausted" — always with the achieved numbers attached.
- Progress display: `probesSpent / probeBudget` and
  `blocksPrimed / blocksTotal` — denominators the run can actually reach.

**Forbidden claims**, in UI text, snapshot text, and docs:

- "All IPs tested / full catalog scanned" at IP granularity — never true
  under this design (nor, per §1, under the old one).
- Any coverage percentage whose denominator is `ipsTotal`. The
  `ipsProbed / ipsTotal` pair may be shown as raw counts for scale, never
  as a progress percentage.

The `scope: "run-relative"` label is unchanged and now doubly apt: results
are relative to this run, this path, and this run's accumulated reputation.

---

## 9. Simulation plan (paper / lab only)

No live traffic: the engine is validated against a **synthetic truth** with
an injected fake probe, using the fact that the existing schedulers already
accept an arbitrary `task` function (`runEligibilityBatch`,
`runAdaptiveEligibilityBatch` in `src/hard-scheduler.js`). The simulation
harness drives the new block engine with `task = fakeProbe` and compares it
against baselines at **equal probe budgets**. All randomness from
`mulberry32` with fixed seeds → simulations are exactly reproducible.

### 9.1 Synthetic block-quality maps

Per-IP truth: an IP in block b succeeds with probability q_b, except 5% of
IPs in every block are individually dead (q = 0) — host-level variance the
design must tolerate. Fake-probe latency: successes ~ LogNormal(median
0.7 s, σ = 0.4); failures: 70% timeout (6.0 s), 30% fast fail (0.2 s) —
the §1.2 "typical" scenario; simulated wall-clock = Σ durations /
concurrency, no real waiting.

| Map | Structure | What it tests |
| --- | --- | --- |
| A "clustered" | Range base rate ~ Beta(2, 8); block q = base + local noise (σ = 0.08, spatially smoothed); top blocks ≈ 0.9 | The expected real-world case |
| B "sparse gems" | 1% of blocks q = 0.95; 9% q = 0.5; 90% q = 0.03 | Finding rare hot blocks — the design's raison d'être |
| C "uniform null" | All blocks q = 0.25 | No structure: the design must not *lose* to the baseline |
| D "heterogeneous" | Map A + 3% of blocks internally split (one half q = 0.9, other half q = 0.05) | §5 split detection |
| A′ "drifted" | Map A with every q_b perturbed by N(0, 0.05), clipped to [0, 1] | Warm-start value under change (with A-run reputation aged 7 days) |

### 9.2 Baselines (equal budget B = 72,000 probes)

1. **Current design**: range round-robin order truncated at B probes,
   finalists = its top-200 pool by the existing ranking.
2. **Uniform random** IP sampling without replacement at B probes.

### 9.3 Metrics

- **Recall@77**: fraction of the true top-1% blocks (77 blocks by true q)
  represented in the finalist pool, and separately in the SPRT recheck set.
- **Recheck precision**: fraction of recheck IPs whose true q ≥ 0.6.
- **Probes-to-90%-recall** curve over budget.
- **Split detection rate** (Map D) and **false-split rate** (Maps A–C).
- **Simulated wall-clock** per design.
- **Determinism**: hash of the full probe sequence per run.

### 9.4 Pass criteria (pre-registered — the implementation must meet all)

1. **Map B:** DNA recall@77 (pool) ≥ 0.90 at B = 72,000, and ≥ baseline (1)
   by ≥ 0.25.
2. **Map A:** DNA recall@77 ≥ 0.85 at B = 72,000, and ≥ baseline (1) by
   ≥ 0.15.
3. **Primer safety (Maps A, B, D):** ≥ 99% of true top-77 blocks end the
   primer phase with upper bound ≥ the pool threshold τ at primer exit
   (i.e. the primer makes virtually no top block ineligible — §3.2).
4. **Map C (null):** DNA recall@77 within ± 0.05 of baseline (1).
5. **Map D:** ≥ 80% of heterogeneous blocks are split by run end;
   **Maps A–C:** false splits ≤ 5% of homogeneous blocks that reached the
   split trigger.
6. **Warm start (A → A′):** the reputation-seeded run reaches the cold
   run's recall@77 with ≤ 45% of the cold run's probes.
7. **Determinism:** identical seeds → identical probe-sequence hashes,
   across process restarts.

Failure of any criterion sends the design back for revision of the
implicated parameter (primer depth, depth cap, split thresholds, budget)
before any user-facing release — the criteria are the contract, not a
report card written afterwards.

---

## 10. Open questions for Mahan

Each with Metric's recommendation; TARS consolidates before implementation.

1. **Primer depth k = 3 on both platforms?** Android pays 23,091 probes
   before expansion starts. *Recommendation: yes — keep k uniform (index
   comparability, §3.1); Android saves through its smaller total budget
   and through reputation warm starts, not thinner primers.*
2. **Total budget caps: 72,000 desktop / 40,000 Android probes?**
   *Recommendation: yes as defaults for `hard.budgetProbes`; the stopping
   rules (§4.5) normally bind first, and both values are user-tunable.*
3. **Allocation rule: Wilson-UCB (this blueprint) vs Thompson sampling?**
   *Recommendation: Wilson-UCB — deterministic given the seed, reuses
   `wilsonInterval` verbatim, one statistical dialect across the codebase
   (§4.1).*
4. **Diversity caps: ≤ 8 per block into the pool, ≤ 4 into SPRT recheck?**
   *Recommendation: yes — fate-sharing within a /24 makes an uncapped
   finalist list fragile (§6.1).*
5. **Split rule: max depth 2 (→ /26), Fisher p ≤ 0.05 plus effect-size
   floor |Δp̂| ≥ 0.5?** *Recommendation: yes — splits stay rare, gross, and
   cheap (§5).*
6. **Reputation retention: keep indefinitely with 14-day half-life decay,
   as a plain JSON the user can inspect/move between devices (no sync)?**
   *Recommendation: yes (§7). If you prefer a hard expiry, 90 days is the
   shortest defensible one.*
7. **Delayed-retry queue: keep exactly as today, fed by both new phases?**
   *Recommendation: yes — it already encodes the hard/soft error taxonomy
   the primer's hard-error valve relies on (§§3.4, 6.2).*
8. **Allocation index uses success only; handshake latency stays a ranking
   tie-break, not an allocation input?** *Recommendation: yes for v1 —
   eligibility is the Hard stage's currency and quality is measured
   downstream; revisit only if §9 simulations show slow-but-alive blocks
   eating the budget.*
9. **State migration: `HARD_STATE_VERSION` 3 → 4, with v3 checkpoints
   finishing under the legacy traversal (no forced restart)?**
   *Recommendation: yes — matches the existing `isLegacyState` precedent
   (§7.4).*
10. **Record per-block colo (cf-ray) data from primers now, unused by the
    v1 index?** *Recommendation: yes — zero extra probes
    (`summarizePops` exists), and it is the obvious v2 signal for
    colo-aware expansion (§5.3).*

---

## Appendix A. Proposed settings (for Forge's engineering annex)

New keys, all under the existing settings object; defaults shown
desktop / Android where they differ:

| Key | Default | Source |
| --- | --- | --- |
| `hard.primerPerBlock` | 3 | §3.1 |
| `hard.budgetProbes` | 72,000 / 40,000 | §4.5 |
| `hard.expansionWaveFactor` | 10 (× concurrency) | §4.2 |
| `hard.expansionChunk` | 4 | §4.2 |
| `hard.rangeWaveCapFraction` | 0.25 | §4.2 |
| `hard.maxBlockDepth` | 32 | §4.3 |
| `hard.poolPerBlock` | 8 | §6.1 |
| `hard.recheckPerBlock` | 4 | §6.2 |
| `hard.splitMaxDepth` | 2 | §5.2 |
| `hard.splitAlpha` | 0.05 | §5.2 |
| `hard.splitMinEffect` | 0.5 | §5.2 |
| `reputation.halfLifeDays` | 14 | §7.2 |
| `reputation.confirmAgeDays` | 3 / 21 (tier bounds) | §7.3 |
| `reputation.maxStoredAttempts` | 64 | §7.2 |

Existing keys reused unchanged: `hard.concurrency`, `hard.screeningRounds`
(legacy path), `hard.recheckTop`, `hard.finalTop`, `hard.liveTop`,
`hard.saveEvery`, `hard.delayedRetry`, `hard.retryLimit`, `scan.seed`,
`scan.timeoutMs`, `scan.minimumSuccessRate`, `verification.sprt`.

## Appendix B. Reuse map (what the implementation should not rewrite)

| Need | Existing piece |
| --- | --- |
| The probe itself | `probeWebsocket` (`src/probe/websocket.js`) |
| Batched parallel eligibility | `runEligibilityBatch` (`src/hard-scheduler.js`) |
| SPRT verification | `runAdaptiveEligibilityBatch` + `src/measurement/sprt.js` |
| Wilson interval / labels / POPs | `src/measurement/confidence.js` |
| Candidate summary + ranking order | `buildEligibilitySummary`, `compareEligibility` (`src/report.js`, `src/hard-scan.js`) |
| Seeded RNG | `mulberry32` (`src/random.js`) |
| Range parsing / host drawing | `parseCidr`, `parseRangeList`, `drawIp` patterns (`src/candidate/ipv4.js`) |
| Error taxonomy / retry selection | `classifyProbeError`, `selectDelayedRetries` |
| Checkpoint cadence / snapshot shape | `persistState`, `writeSnapshot` (`src/hard-scan.js`) |

New code is confined to: block-plan construction, the block index +
allocator, the split test, the reputation store, state v4, and the
`coverage` reporting fields.

— Metric, 2026-11-20. *No code was changed by this document.*
