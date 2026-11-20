# Criterion 5b Root-Cause Analysis — Map D Split Detection (0.557 vs 0.80)

**Author:** Metric (measurement science) · **Status:** recommendation for TARS /
Forge · **Scope:** why pre-registered criterion 5b failed in the Wave B
simulation, and the minimal design adjustment that fixes it.

All numbers below were measured by the author against the shipped engine
code (`src/hard-engine.js`, `src/measurement/bandit.js`,
`test/fixtures/virtual-catalog.js`, merged to main at `c4e5fac`), using the
harness's own parameters: 2,048 blocks (64 ranges × 32), seed 777,
`budgetProbes` 19,158 (the 72,000 desktop budget scaled by 2,048/7,697),
`finalTop` 53, primer 3, depth cap 32, wave 120, chunk 4, range cap 0.25.
Two instruments were used: (1) an instrumented full engine run on Map D
with per-block classification of every undetected heterogeneous block, and
(2) a policy mini-driver that replays each block's seeded permutation
against the deterministic fake probe to measure candidate fixes *before*
recommending them. The fake probe is a pure function of (block, host
offset, round), so permutation replays reproduce the engine's primer
outcomes exactly — the mini-driver's primer census and the engine's probe
log agree block for block.

---

## 1. Verdicts in brief

- **Forge's diagnosis: CONFIRMED in mechanism, refined in count and in
  emphasis.** 23 of the 27 undetected heterogeneous blocks never satisfied
  the split trigger (Forge's "21" is the subset that ended below 8 total
  attempts: 14 at exactly 3, 7 at 4–7; 2 more reached ≥ 8 attempts with one
  half below 4). The remaining 4 reached the trigger and failed the
  Fisher/effect tests — exactly Forge's "only 4". The sharpest form of the
  mechanism is one Forge's counters did not isolate: **starvation is
  perfectly predicted by the primer outcome.** Every heterogeneous block
  whose primer came back 0/3 received *zero* expansion probes (14 blocks);
  every block with ≥ 1 primer success received some. The run's effective
  service frontier sat between Wilson-UCB index 0.561 (0/3) and 0.792 (1/3)
  for its entire length.
- **R1 (recall over the §6.1 pool): CORRECT.** §9.4 criterion 1's own text
  reads "recall@77 *(pool)*"; §6.3's 200 is a verification/report retention
  cut, not the screening pool. Forge's latency-noise argument is also
  substantively right (§4.1 below).
- **R2 (criterion 4 one-sided): CORRECT in substance; the spec text owes an
  erratum, and the error is mine.** §9.4.4's "within ± 0.05" is jointly
  unsatisfiable with R1's pool definition on the null map (§4.2 below).
  §9.4.4 should read "≥ baseline − 0.05". Forge encoded the criterion's
  stated purpose (§9.1: "must not *lose*") over its defective letter.
- **Recommendation: a bounded split-coverage pass** (allocation shape; §6)
  — a half-coverage extension for 0/3 blocks, then guaranteed trigger
  depth for every block with a mixed primer, then a second stage for
  near-misses — capped at 85% of the post-primer headroom by one new
  settings key. Measured on the real fixture (pass only, no UCB phase):
  **49/61 = 0.803 detection**; combined with the surviving UCB path,
  **predicted 0.85–0.89** on re-run. Total budget unchanged. None of the
  four parameters §9.4 names (primer depth, depth cap, split thresholds,
  budget) is the primary failure, and none needs to change (§5).

---

## 2. Evidence: where the 27 undetected blocks actually stopped

Instrumented Map D engine run: budget 19,158, spent 19,158,
`stoppedReason = "budget"` (neither the marginal-gain stop nor the pool
threshold ended the run). Primer 6,144 probes; expansion 13,014.
Heterogeneous blocks: 61; split by run end: 34 (0.557).

Classification of the 27 undetected (final per-block counters):

| Class | Count | Final state |
| --- | --- | --- |
| Starved at primer depth | 14 | attempts = 3 (zero expansion probes) |
| Partially served | 7 | attempts 4–7 (below trigger) |
| Unbalanced at trigger depth | 2 | attempts ≥ 8, one half < 4 |
| Trigger reached, test failed | 4 | halves ≥ 4/4, Fisher/effect did not fire |
| **Never satisfied the trigger** | **23** | |

Primer outcomes (successes of 3) by detection:

| Primer s | Detected (34) | Undetected (27) |
| --- | --- | --- |
| 0 | 0 | **14** |
| 1 | 11 | 10 |
| 2 | 18 | 3 |
| 3 | 5 | 0 |

Two independent counts close the accounting. The mini-driver's primer
replay finds **999 blocks** (of 2,048) ending the primer with s = 0. The
engine's final state finds **999 blocks** ending the *run* at exactly 3
attempts. Up to a handful of split children, these are the same set: **no
block with a 0/3 primer was ever served, and every block with ≥ 1 primer
success was served at least once.** (Aggregate counters include ≤ 68 split
children; all per-heterogeneous-block figures are exact by blockId.)

Where the 13,014 expansion probes went:

- 217 blocks drained to the depth cap 32, absorbing 217 × 29 = **6,293
  probes (48%)**.
- Homogeneous hot blocks (true q ≥ 0.7) absorbed only **1,717** — the
  "greedy UCB feeds the gems" story is 13% of spend.
- Heterogeneous blocks absorbed **438** in total.
- The remainder (≈ 10,900) went to the broad upper-middle mass: 1,049
  blocks with ≥ 1 primer success rotating through the wave window
  (~12.4 probes each). Only **560 of 2,048 blocks (27%) ever reached the
  8 attempts the split trigger needs.**

Why the frontier froze: after the primer, 1,049 blocks carry index ≥ 0.792
(s ≥ 1) and 999 carry 0.561 (s = 0). Each wave is 120 probes served in
rank order in chunks of 4 — roughly the top 30 blocks per wave. A served
mid block's index decays only toward its true rate plus a shrinking
bonus (a homogeneous q ≈ 0.45 block still shows upper ≈ 0.66 at n = 20,
above 0.561), so the 0/3 tier is never reached before the budget ends.
The pool threshold τ is not the cause: at `screeningRounds = 1` every
successful candidate ties at Wilson lower 0.2066, so τ = 0.2066 once the
pool fills, and a 0/3 block's index 0.561 clears it all run — these blocks
were *eligible* every wave and lost purely on rank order.
`stoppedReason = "budget"` confirms no stopping rule intervened.

## 3. Root cause, stated structurally

A heterogeneous block's halves run at q ≈ 0.855 / 0.0475 (the map's
0.9 / 0.05, diluted by the fixture's 5% individually-dead IPs), mean
≈ 0.451. Its block-level success count is therefore distributionally
identical to a homogeneous q ≈ 0.45 block's. **The allocation index is a
function of block totals (s, n) only, so no index-only policy can route
probes to heterogeneous blocks preferentially — the split signal lives
exclusively in the per-half counters, and the only bridge between the
halves and the allocator is the split trigger, which sits at a depth
(both halves ≥ 4) that pure index order delivers to barely a quarter of
the catalog at the approved budget/depth-cap ratio.** The primer outcome
distribution makes it worse at the bottom: a heterogeneous block shows
0/3 with probability ≈ 0.17–0.23 (draws concentrate in the cold half),
and 0/3 is precisely the outcome the allocator starves.

The four parameters §9.4 names are each examined and exonerated as the
*primary* cause in §5; the parameter that failed is the allocation shape
(§4.2) — the one §9.4's parenthetical did not enumerate. §9.4's list
should gain "allocation shape" by erratum.

## 4. The two spec interpretations

### 4.1 R1 — recall over the §6.1 pool: CONFIRMED

§9.3 defines Recall@77 over "the finalist pool, and separately in the
SPRT recheck set"; §9.4 criterion 1 pins it as "recall@77 (pool)".
§6.1 defines that pool as the per-block-contributed candidate set
(≤ `poolPerBlock` per block); §6.3's `finalTop` = 200 is what is
"retained for verification and the final report" — a downstream cut.
Forge measured the object the criterion names. The supporting argument
is also correct: at `screeningRounds = 1` every candidate holds one
observation, all successes tie at Wilson lower 0.2066 and success rate
1.0, so the finalTop truncation ranks by handshake-median — on the
fixture, by a lognormal draw. Recall over the truncated set would grade
latency luck, not the block design. One honest caveat, recorded for the
next spec revision: pool recall saturates (1.000 on every map) precisely
because the pool is untruncated — criteria 1–2 as encoded verify
*representation*, not ranking. That is the spec's intent (ranking quality
is the SPRT stage's contract), not a harness defect.

### 4.2 R2 — criterion 4 one-sided: CONFIRMED, with a spec erratum owed

§9.4.4 as written demands DNA recall within ± 0.05 of the baseline on
Map C. Under R1's (correct) pool definition this is unsatisfiable *by
construction*: on the null map the DNA design's total primer coverage
puts pool recall at ≈ 1.0, while the round-robin baseline — which at
equal budget touches a fraction of blocks — sits at ≈ 0.15. A symmetric
band fails the design for winning on the map whose stated purpose
(§9.1) is "the design must not *lose* to the baseline". Forge's
one-sided encoding (DNA ≥ baseline − 0.05) is the faithful reading.
**Erratum (mine, not Forge's):** §9.4.4 should read "DNA recall@77 ≥
baseline (1) − 0.05 (must not lose)". The harness header already
documents the reading; the spec text should be corrected to match, in
the Wave D docs pass.

## 5. Lever evaluation

### (a) Split-coverage reserve — RECOMMENDED (form in §6)

Guarantee split-trigger depth to the blocks the primer flags, as a
bounded slice of the expansion headroom, before pure UCB allocation.
Measured end-to-end in §6 — this is the only lever that reaches the bar,
because it is the only one that routes probes by the half-level signal.

A mixed-only reserve (my first sketch, and the obvious form) is
**provably insufficient**, and the data shows why: heterogeneous blocks
with mixed primers number 42 of 61, so even perfect detection of all of
them plus the 5 s = 3 blocks caps at 47/61 = 0.770 < 0.80. The 14 blocks
at s = 0 — the largest undetected class — must be covered too; §6's
step E does it for ≈ 1.25 probes per s = 0 block.

### (b) Lowering the split trigger (8 → 6, halves ≥ 3) — REFUTED

Computed with the shipped `fisherExactTwoSided` / `shouldSplitBlock`:

| Table | Fisher p | Fires at α = 0.05, Δ ≥ 0.5? |
| --- | --- | --- |
| 3/3 perfect: (3,0) vs (0,3), n = 6 | 0.1000 | **No — no 3/3 table can fire** |
| (4,0) vs (0,3), n = 7 | 0.0286 | Only if min-half ≤ 3 |
| (5,0) vs (0,3), n = 8 | 0.0179 | Only if min-half ≤ 3 |
| 4/4 perfect: (4,0) vs (0,4), n = 8 | 0.0286 | Yes (current rule) |
| 4/4 near: (4,1) vs (1,4) | 0.1429 | No |
| 5/4 near: (5,1) | 0.0476 | Yes |
| 8/8 typical hetero: (7,1) | 0.0101 | Yes |

At halves of 3 the most extreme table attainable gives p = 0.10 > α:
the lever is *mathematically inert* unless α is also raised, and raising
α breaks criterion 5a by construction (the per-test false-split rate is
α). The weaker variant (min-half 4 → 3 at n ≥ 8) fires on unbalanced
landings, but that rescues only class C (2 blocks) and is moot once
top-ups draw until *both* halves reach 4. The current trigger sits
exactly at the Fisher feasibility boundary for α = 0.05 — **the split
thresholds are exonerated.** Note the second lesson of the table: at
exactly 4/4 only perfect separation fires (0.44 of covered heterogeneous
blocks in expectation), while at 5/4 and 8/8 near-separation also fires
— trigger *depth*, not trigger *shape*, is what detection is starved of.
That is why §6 has a stage 2.

### (c) Allocation-shape change via the index (heterogeneity bonus) — REJECTED

A variance/homogeneity bonus added to the Wilson-UCB index is the
reserve idea with worse accounting, and it breaks two load-bearing
definitions: the index is §4.4's eligibility currency (`U_b ≥ τ`, with τ
a Wilson lower bound — the "spend above τ is provably wasted" argument
requires both sides to be the same statistic), and criterion 3 is
*stated over* these same upper bounds at primer exit. A bonus also has
no budget bound — it distorts every wave until the depth cap — where
the reserve is a capped, auditable slice with its own totals. The
reserve *is* lever (c), done with a bound and a paper trail.

### (d) Raising budget / depth — COSTED, REJECTED as primary

The budget is sufficient in total: full split coverage of every suspect
plus the s = 0 extension costs 10,300 probes against 13,014 of headroom
(§6). The failure is distributional, so buying more of the same
distribution is the most expensive way to fix it. Doubling the sim
budget (≈ real-scale 144,000 — twice the Q2-approved cap; §4.5
wall-clock roughly doubles, to ~16 h pessimistic) still routes by the
blind index: the frontier must chew through ~1,049 higher-index blocks,
each absorbing up to 29 probes, before the 0/3 tier is served; expected
detection ≈ 0.65–0.72, short of the bar. Cutting the depth cap (32 → 16)
frees at most ≈ 2,800 sim probes of cap drain and widens service, but
remains half-blind — heterogeneous and homogeneous mid blocks are still
indistinguishable to it — for an estimated +0.03–0.06. Neither reaches
0.80 at any approved budget; both are dominated by (a), which reaches
it at **zero** additional budget (total probes, hence §4.5 wall-clock,
unchanged).

**Named-parameter audit (§9.4):** primer depth 3 — the signal exists
(69% of heterogeneous blocks show a mixed primer, 8% show 3/3, and 0/3
is itself informative once halves are examined); not the failure.
Depth cap 32 — contributes drain (48% of expansion spend) but is not
binding: with zero drain, index order still cannot prioritize
heterogeneous blocks. Split thresholds — at the Fisher boundary (§5b).
Budget — sufficient (§5d). The failure is the allocation shape.

## 6. Recommended adjustment: the split-coverage pass

One new phase, `runSplitCoveragePass`, executed after the primer phase
and before UCB expansion waves, iterating root blocks in primer-sweep
(stratified) order. All draws are ordinary engine draws; the split test
is evaluated through the existing `applySplits` machinery as the pass
proceeds. Children created by pass splits join expansion normally and
are not themselves pass subjects this run.

- **Step E — half-coverage extension.** Every root block whose run
  primer ended with 0 successes gets targeted draws into its
  less-observed half until that half has **2 attempts**
  (= `splitMinHalfAttempts` / 2). A block whose successes reach ≥ 1 is
  *promoted* to suspect. (Measured: 999 blocks extended on Map D,
  1,244 probes, 1.25/block; all 14 starved heterogeneous blocks were
  promoted — the less-observed half is the hot half in ≈ 95% of cases
  (binomial decomposition of the 0/3 outcome over half allocations),
  and 12 of the 14 went on to split in the pass.)
- **Suspects.** Blocks with run-primer successes in
  `[1, primerPerBlock − 1]` (1 or 2 at k = 3), including step-E
  promotions.
- **Stage 1.** Each suspect draws until **both halves ≥
  `splitMinHalfAttempts` (4)** — draw-until-balanced, which also cures
  the unbalanced-landing class (2 blocks) by construction.
- **Stage 2.** A suspect that has not split but whose halves give
  Fisher p ≤ `splitReserveAlpha` (0.25 — at 4/4 this is exactly the
  near-miss set {(4,0), (3,0), (4,1)} and mirrors) draws until **both
  halves ≥ 8** (= 2 × `splitMinHalfAttempts`), and is re-tested.
- **Bound.** Pass probes (E + stage 1 + stage 2) are counted in a new
  totals field `reserveProbes` and capped at
  `splitReserveFraction` × (budgetProbes − primerProbes). The slice is
  checked before each block's stage (bounded overshoot < one stage);
  when it is spent, unserved suspects simply remain for UCB — graceful,
  stratified, deterministic.

**New settings keys (exactly two):**
`hard.splitReserveFraction: 0.85`, `hard.splitReserveAlpha: 0.25`.
Stage targets derive from the existing `splitMinHalfAttempts` constant
— no new threshold keys. `src/measurement/bandit.js` needs **no
changes** (`fisherExactTwoSided`, `shouldSplitBlock` are reused
verbatim).

**What Forge changes:**

1. `src/config/settings.js` — add the two keys under `hard.*` (both
   platforms, same values); extend the settings tests under the Wave A
   deep-diff discipline (additions only).
2. `src/candidate/blocks.js` — add a per-half candidate stream
   (e.g. `blockHalfCandidate(block, half, probeIndex, seed)`:
   uniform without replacement over the half's usable addresses, from
   an independent seeded stream, `mulberry32(seed XOR base XOR
   halfTag)`), used only by step E. It must not share cursor state
   with the block's main permutation.
3. `src/hard-engine.js` — implement the pass between
   `runPrimerPhase` and `runExpansionPhase`:
   - Track `primerSuccesses` explicitly on block state during the
     primer phase (do not re-derive from run totals), and persist it
     plus a per-block pass-stage marker in the serialized block state,
     so a run resumed mid-pass does not re-spend the pass (on restore
     from older saves lacking the fields, `primerSuccesses` can be
     rebuilt from the first `primerDone` records, which are
     insertion-ordered).
   - Step E draws use the new per-half stream; stages 1–2 use the
     existing `drawCandidates`; splits are applied via the existing
     `applySplits` path after each suspect's stage.
   - The pass respects `budgetRemaining()`, cancellation, and the
     slice exactly as the other phases respect the budget.
   - Totals gain `reserveProbes` and counts (`blocksExtended`,
     `suspectsServed`, `blocksPromoted`) for Wave C's report fields.
     Report schema is untouched (engine totals are additive).
4. `test/hard-dna-simulation.test.js` — flip the criterion-5 spec test
   from todo to a live assertion at ≥ 0.80; update the R3 header note
   to cite this analysis. No changes to maps, seeds, budgets, baselines,
   or any other criterion. The ≥ 0.50 floor test stays as a regression
   guard.

**Measured cost and effect** (mini-driver, pass only — no UCB phase;
Map D unless noted):

| Quantity | Value |
| --- | --- |
| Pass probes, Map D | **10,300** (E 1,244 + S1 7,927 + S2 1,129) |
| Slice at 0.85 × 13,014 headroom | 11,062 — pass completes |
| Pass probes, Map A / B / C | 10,139 / 4,817 / 12,040 (C truncates at the slice — harmless, §7) |
| Heterogeneous split by the pass alone | **49 / 61 = 0.803** (37 original suspects + 12 promoted) |
| Heterogeneous not pass subjects (s = 3) | 5 — UCB path, 5/5 detected in the current run |
| Pass-attributable false splits | A: 22/1,134 = 1.9% · B: 6/353 = 1.7% · C: 22/1,351 = 1.6% · D-homogeneous: 22/1,095 = 2.0% |

Real-scale translation (7,697 blocks, desktop): the pass costs
≈ 38,700 probes against 48,909 of headroom (79%), inside the 85% slice
(41,573). **Android caveat, stated plainly:** at the approved 40,000
budget the headroom is 16,909 and the slice ≈ 14,373 — the pass would
truncate after ~37% of suspects and Android split detection would land
materially below 0.80. That is a consequence of the approved Android
budget cap (Q2), not of this adjustment; parity on Android is a budget
conversation, not part of this fix. The simulation contract is
desktop-parameterized and is what the re-run must satisfy.

## 7. Predicted outcomes on re-run

| Criterion | Prediction | Basis |
| --- | --- | --- |
| 1 (Map B recall) | Pass, unchanged | Primer and pool construction untouched; the pass only adds candidates |
| 2 (Map A recall) | Pass, unchanged | Same; margins were 1.000 vs 0.85 bar |
| 3 (primer safety) | Pass, unchanged | The snapshot is taken at primer exit, before the pass exists |
| 4 (Map C, one-sided per R2) | Pass | Pool representation is primer-driven; pass truncation on C is by slice, in stratified order |
| 5a (false splits ≤ 5%) | Pass, worst map ≈ 4% | Pass-attributable rate measured ≈ 2% on a ~2× larger triggered base; UCB-phase looks continue as today (Forge's reported range 2.4–4.2% on the small current base). **Pre-committed fallback if any map breaches:** restrict split evaluation to pass-stage boundaries and every-8-attempts checkpoints (fewer looks per block) |
| **5b (Map D detection ≥ 0.80)** | **Pass — predicted 0.85–0.89** | Pass alone measures 49/61 = 0.803 with zero UCB help; adding the s = 3 path (5 blocks, 5/5 today, haircut to 4) and residual UCB looks at the 7 pass-missed blocks gives 53–55/61 |
| 6 (warm start ≤ 45%) | Pass | The slice is headroom-relative and the global budget cap is untouched, so the 45% bound is structural; warm-run suspects are only blocks whose (possibly extended) run primer is mixed — disproportionately the drifted blocks, which is where warm recall is won |
| 7 (determinism) | Pass | Pass order is the primer sweep order; extension draws come from a seeded per-half stream; stage draws continue the seeded main permutation |

Uncertainty, honestly: 61 blocks is a small sample (binomial σ on the
detection count ≈ 2.8 blocks). The predicted margin over the bar is
+4–6 blocks (≈ 1.5–2σ) — solid, not lavish. The pass-only floor
(0.803, measured on the actual fixture rather than extrapolated) is
the load-bearing number: the adjustment clears the bar even if the
UCB path contributed nothing at all beyond it.

**The re-run must show, for the todo test to flip to a real pass:**
the criterion-5 spec test green as a live assertion at ≥ 0.80 on Map D;
the false-split test green on all four maps at ≤ 5%; criteria 1, 2, 3,
4, 6, 7 green at their existing, unmodified bars; the full suite green.
Anything less sends the fallback in the 5a row (for a 5a breach) or
this analysis back for revision (for a 5b shortfall) — not a quiet
re-baselining of the measured floor.

## 8. What this does not change

Primer depth, depth cap, split thresholds, total budgets, the index,
the pool and finalist machinery, the SPRT/tunnel/streaming/load stages,
and the report schema are all untouched. The trade being made is
explicit and bounded: at desktop scale the pass spends ≈ 79% of the
post-primer headroom on guaranteed split coverage, so UCB expansion
depth on the hottest blocks gets shallower (a top block may end at
trigger depth 8–16 rather than 32). In pool terms that costs little —
`poolPerBlock` caps a block's contribution at 8 candidates regardless —
and the 15%-of-headroom floor guarantees the adaptive phase always
retains a meaningful budget. That is the right exchange: the depth was
buying precision the pool cannot use, while the coverage buys a
pre-registered criterion the design currently fails.
