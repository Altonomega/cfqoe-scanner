# Measurement methodology

## Why not ping

A TCP handshake tells you how quickly a packet reaches the nearest Cloudflare edge. It says
nothing about whether that edge will deliver a web page quickly, or whether it can sustain a
video bitrate. Edges with excellent ping frequently deliver poor throughput, and edges with
mediocre ping are often the most stable.

CFQoE therefore records connect time as a **diagnostic field only**. It never enters the score.

## Why not a parallel speed test

Opening eight or sixteen parallel connections measures how much bandwidth you can grab in a
burst. A video player does not behave that way: it downloads segments one after another and
refills a buffer. A burst test can report 200 Mbps on a link that still stalls during playback.

CFQoE downloads segments **sequentially**, exactly like a player, then simulates the buffer.

## Stage 1 — Eligibility

For each candidate IP the scanner performs a real WebSocket upgrade using the host, path and TLS
parameters from your own configuration.

- Accepted only on HTTP `101` with an `Upgrade: websocket` response header and a valid
  `Sec-WebSocket-Accept` header.
- `cf-ray` is recorded when present.
- Every candidate is probed once per round in shuffled order.
- Candidates below the configured success rate never reach the expensive stages.

Recorded: handshake median, handshake p90, handshake MAD, connect median (diagnostic),
success rate.

## Stage 2 — Real tunnel

For the surviving candidates the scanner writes a temporary Xray configuration that keeps your
WebSocket metadata but dials the specific candidate IP, and starts a short-lived Xray process
with a private SOCKS inbound on `127.0.0.1`.

All further traffic for that candidate goes through that tunnel, so measurements reflect the
full path your client will actually use.

## Stage 3 — Web Transfer

This stage measures portable HTTP transfer quality, not browser QoE: there is no DOM, no
JavaScript execution and no rendering. One socket per host is used, and each observation is
capped at runtime — 10 assets and 5 MiB on desktop, 8 assets and 3 MiB on Android.

1. **Cold load** — the HTML document over a fresh connection.
2. **Sub-resources** — scripts, stylesheets and images discovered in the document, or the
   explicit asset list of a custom workload.
3. **Warm load** — the same document over the reused keep-alive connection.

Score components: resource success rate (40), cold load (15), warm load (20), TTFB p90 (15),
timing stability measured as MAD (10).

## Stage 4 — Streaming

1. The `.m3u8` manifest is fetched. Master playlists are resolved to a media playlist.
   `EXT-X-MAP`, `EXT-X-KEY`, byte ranges and discontinuities are supported, and startup
   includes the manifest, the variant, the init segment and the key.
2. Segments are downloaded **one at a time** — four by default on desktop, three on Android —
   under a runtime byte cap of 12 MiB on desktop and 8 MiB on Android. The `fixed` rendition
   closest to the target bitrate is selected, or the `lowest` rendition in conservative mode;
   no full ABR simulation is claimed.
3. A player buffer is simulated: the startup buffer must fill before playback begins, and the
   buffer then drains by download time and refills by segment duration. Only successful
   segments enter the playable buffer.

Recorded: startup delay, stall count, rebuffer ratio, median throughput, P10 throughput, and a
sustainable bitrate defined as `P10 / safetyFactor`. P10 is reported only with at least 29
samples; with fewer samples the sustainable bitrate is estimated from the harmonic mean
instead. The sustainable bitrate maps to a quality label such as 720p or 1080p.

Score components: segment success rate (35), startup delay (15), rebuffer ratio (30),
sustainable bitrate (20).

## Stage 5 — Real Load

The surviving candidates are driven with real traffic: sustained download and upload,
latency measured both idle and under load, traffic shaping, fan-out requests and requests
per minute (RPM). Absolute gates cap the resulting score, so a candidate that chokes under
real load cannot keep a high score on the strength of the other stages.

Recorded: `sustainedMbps`, `shapingRatio`, `idleRttMs`, `loadedRttMs`, `rpm`, `jitterMs`,
`lossRate`, `fanoutSuccess` and `uplinkMbps`.

## Overall score

With Real Load enabled (the default):

```
overall = 0.30 * webTransfer + 0.30 * streaming + 0.25 * realLoad + 0.15 * reliability
```

When Real Load is disabled, the load weight is removed and the profile falls back to
`0.45 * webTransfer + 0.40 * streaming + 0.15 * reliability`.

A component that was not measured is dropped and the remaining weights are renormalized, but
partial evidence is not treated as equivalent to a complete measurement: a candidate missing
any weighted component is reported as `partial`, its missing components are listed, and its
score is capped at 70. Complete rows always rank above partial rows. A candidate that only
passed eligibility receives no QoE score at all.

## Robust statistics

Medians, percentiles and median absolute deviation are used everywhere instead of averages.
One slow observation caused by local congestion cannot dominate a candidate's score.

Eligibility reliability is reported with a Wilson 95% confidence interval, and ranking uses
the interval's lower bound, so a candidate with a few lucky successes cannot outrank one with
many consistent ones. Each candidate also carries a confidence label — `provisional`, `low`,
`medium` or `high` — based on sample count and temporal spread; the label describes the
stability of the measurement, not the quality of the IP.

Finalists are verified adaptively with a sequential probability ratio test (SPRT, defaults
`p0 = 0.60`, `p1 = 0.90`, `alpha = 0.05`, `beta = 0.10`). The decision — `accept`, `reject`
or `inconclusive` — is stored in the report.

## Run-relative scope

Every report is published with `scope: "run-relative"`. Scores rank candidates within a
single run, on one device and one connection; comparing scores across runs, devices or ISPs
is not supported.
