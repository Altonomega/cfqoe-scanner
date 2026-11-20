# Web UI — client↔server contract notes for W3

The front-end in `src/web/public/` (W4) is built against the design
study's §5 contract (`GET /api/state` snapshot + SSE on `/api/events` +
POST actions), with Shield's resolutions applied (cookie session from
the one-time bootstrap — the client never touches a token;
`X-CFQoE-Request: 1` on state-changing POSTs; settings writes through
the server's `mergeSettings` → `saveSettings` boundary only).

The study left a few shapes implicit. The client assumes the following;
W3 should implement them as written or renegotiate here, in writing:

1. **Snapshot genome at rest.** `GET /api/state` carries a top-level
   `genome` object (same shape as `run.genome`) even when no Hard run
   is active, so the dashboard's plate-at-rest and the genome view can
   render the reputation overlay before any run starts.
2. **Quadrant heats.** Genome vectors include `quadHeat` (base64
   `Uint32Array`, packed like `quads`) alongside `state`, `heat`,
   `quads`, `known`. Block deltas (`blocks` events) are tuples
   `[index, state, heat]` or, for split cells,
   `[index, 7, heat, quads, quadHeat]`.
3. **Catalog.** `GET /api/catalog` →
   `{ ranges: [{ cidr, firstBlock, blocks }], blocksTotal, rangesTotal, addressesTotal }`
   in `buildBlockPlan` order. Field types are part of the contract:
   `cidr` is the range's CIDR **string**; `firstBlock` is the numeric
   **index** of the range's first block in catalog order (not an
   address). Clients derive a block's /24 from `cidr` plus the
   block's offset within the range.
4. **Settings read + estimate.** `GET /api/settings` →
   `{ settings, catalog }` where `catalog` is the workloads catalog
   (`{ browsing: [{name, description}], streaming: [...] }`).
   `POST /api/settings/estimate { settings }` → `{ perCandidateBytes }`
   (server-side `estimateTrafficBytes`). Workload selection and custom
   workloads ride the settings object (and therefore the R-12 write
   path); the client does not call `/api/workloads`.
5. **Block inspector.** `GET /api/block/:index` → per-block detail
   (this-run attempts/successes/halves, split state + p-value,
   reputation summary, best candidates). If it 404s, the client falls
   back to snapshot-derived data — degraded, never broken.
6. **Results/reports/system/logs** follow the study's §6 table:
   `GET /api/results/latest`, `/api/results/:runId`, `/api/reports`,
   `/api/reports/:runId/download`, `/api/reports/:runId/best-ips`,
   `GET /api/system`, `GET /api/logs`, `GET /api/logs/:name/summary`.
   The log tail rides the `log` SSE event type, enabled per-connection
   with `?tail=1` on `/api/events`.
7. **Errors** are `{ error, message }` with the terminal's own wording;
   `run_active` and `config_missing` error codes are rendered by the
   client in its own words, everything else shows `message`.
8. **Candidates arrive at completion.** The engines produce final
   candidate rows only at the end of a run — no mid-run row stream
   exists to forward — so `candidate` events fire in a burst at run
   end, in the report's own ranked order, just before the terminal
   `run-state`. During a run the ledger is empty by design; progress
   is carried by the `phase` / `counters` / `blocks` events, not by
   rows. A client must not read an empty mid-run ledger as "no
   candidates found".

9. **One source of truth (0.9.1).** The shipped client has exactly
   one data source: this server. There is no simulated feed and no
   boot fallback — when the server is unreachable the client shows a
   plain offline state with a retry action, and renders nothing else.
   The page renders only the snapshot + event stream; it invents no
   run state. Three consequences are contractual:
   - **Terminal agreement.** `run-state` events, the snapshot's
     `run` view, and `currentRunState` agree on a run's status at
     all times. At rest, the snapshot serves the last finished run's
     terminal view (`complete` / `canceled` / `failed`, with
     `error` carrying the failure reason) until a new run begins;
     a paused Hard checkpoint takes precedence as `paused-done`.
     Scan-mode stops are `canceled`; Hard stops are `paused-done`.
   - **Narration fields.** `counters` frames carry `round` (the
     screening round in flight) and `currentIp` (the candidate the
     newest progress event belongs to) alongside
     `completed/total/eligible/failed/elapsedMs`; both are null
     outside the phases that know them. `log` frames carry `n`
     (the record's requested/selected concurrency) when the record
     has one, so calibration verdicts — including the
     `*.calibration.no_control` degradation — can be narrated in
     plain words with the speed the run continued at.
   - **No path links.** Filesystem paths from the server (log file
     names, system rows, report metadata) are rendered as text,
     never as links; downloads flow only through the authenticated
     `/api/reports/:runId/...` endpoints above.
