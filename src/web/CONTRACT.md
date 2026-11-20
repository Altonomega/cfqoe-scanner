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
   in `buildBlockPlan` order; `firstBlock` is the range's first /24.
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

Simulation mode (in `app.js`) implements this entire contract locally
and is the reference for the shapes above.
