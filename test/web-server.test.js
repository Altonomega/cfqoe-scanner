// Web server: Shield's R-01…R-17 as executable pins, plus the
// CONTRACT behaviors the merged front-end depends on. Every test
// runs a real server on a loopback port against a throwaway layout;
// nothing here mocks the transport, because the requirements are
// about the transport.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDirectories, writeSecretFile } from "../src/platform/paths.js";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "../src/config/settings.js";
import { createWebServer } from "../src/web/server.js";

const RANGES_FILE = fileURLToPath(new URL("../config/cloudflare-ipv4.txt", import.meta.url));
const WORKLOADS_FILE = fileURLToPath(new URL("../config/workloads.default.json", import.meta.url));
const TEST_UUID = "11111111-2222-3333-4444-555555555555";
const TEST_URI = `vless://${TEST_UUID}@edge.example.com:443?encryption=none&security=none&type=ws&host=edge.example.com&path=%2Fws#test`;

function makeLayout({ rangesText = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfqoe-web-test-"));
  const layout = ensureDirectories(root);
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  if (rangesText === null) fs.copyFileSync(RANGES_FILE, layout.rangesFile);
  else fs.writeFileSync(layout.rangesFile, rangesText);
  fs.copyFileSync(WORKLOADS_FILE, layout.workloadsFile);
  return { root, layout };
}

// Raw HTTP so tests control the exact request line and headers
// (fetch normalizes traversal paths and forbids the Host header).
//
// agent:false is load-bearing, not a preference: since Node 19 the
// default global agent pools keep-alive sockets per host:port, and
// every test in this file binds the SAME port (8797) with a fresh
// server. A socket pooled from a stopped server can be handed to the
// next test's first request before the agent processes its close —
// the write lands on a dead connection and the request dies with
// ECONNRESET "socket hang up" even though the new server is healthy
// (CI 0.9.0: 9 failures on Node 20 ubuntu, the same signature as the
// rare sandbox flake; the production server was never at fault — it
// served the live field test on Node 20 without an error). One fresh
// socket per request removes the mechanism; no assertion in this file
// pins connection reuse, and the server-stop test's closing
// ECONNREFUSED expectation is only well-defined without pooling.
function rawRequest({ port, method = "GET", path: requestPath, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: requestPath, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function startServer(layout, options = {}) {
  const api = createWebServer({ layout, ...options });
  const started = await api.start();
  return { api, ...started };
}

async function bootstrap(port, bootstrapUrl) {
  const url = new URL(bootstrapUrl);
  const res = await rawRequest({ port, path: `${url.pathname}${url.search}` });
  return { res, cookie: (res.headers["set-cookie"]?.[0] ?? "").split(";")[0] };
}

function authed(cookie, extra = {}) {
  return { cookie, ...extra };
}

function mutation(cookie, extra = {}) {
  return {
    cookie,
    "content-type": "application/json",
    "x-cfqoe-request": "1",
    ...extra,
  };
}

test("bootstrap: the token URL 302s to a clean URL and sets an HttpOnly SameSite=Strict cookie (R-04, R-05)", async () => {
  const { layout } = makeLayout();
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { res, cookie } = await bootstrap(port, bootstrapUrl);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/");
    const setCookie = res.headers["set-cookie"][0];
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.doesNotMatch(setCookie, /Secure|Domain/);
    // The cookie is the session: it opens the API.
    const state = await rawRequest({ port, path: "/api/state", headers: authed(cookie) });
    assert.equal(state.status, 200);
    // And so does the token header (programmatic clients, R-03).
    const token = new URL(bootstrapUrl).searchParams.get("t");
    assert.ok(token.length >= 22, "token carries at least 128 bits");
    const viaHeader = await rawRequest({ port, path: "/api/state", headers: { "x-cfqoe-token": token } });
    assert.equal(viaHeader.status, 200);
  } finally {
    await api.stop("test");
  }
});

test("without a session every route class is 403 — static, API, events, mutations (R-03)", async () => {
  const { layout } = makeLayout();
  const { api, port } = await startServer(layout);
  try {
    for (const requestPath of ["/", "/app.css", "/app.js", "/api/state", "/api/catalog", "/api/events"]) {
      const res = await rawRequest({ port, path: requestPath });
      assert.equal(res.status, 403, requestPath);
    }
    const post = await rawRequest({
      port,
      method: "POST",
      path: "/api/run",
      headers: { "content-type": "application/json", "x-cfqoe-request": "1" },
      body: "{}",
    });
    assert.equal(post.status, 403);
  } finally {
    await api.stop("test");
  }
});

test("a wrong bootstrap token and a forged cookie are refused (R-02, R-03)", async () => {
  const { layout } = makeLayout();
  const { api, port } = await startServer(layout);
  try {
    const bad = await rawRequest({ port, path: "/?t=AAAAAAAAAAAAAAAAAAAAAA" });
    assert.equal(bad.status, 403);
    const forged = await rawRequest({
      port,
      path: "/api/state",
      headers: { cookie: "cfqoe_session=AAAAAAAAAAAAAAAAAAAAAA" },
    });
    assert.equal(forged.status, 403);
  } finally {
    await api.stop("test");
  }
});

test("the Host authority must equal 127.0.0.1:<actual port> on every request (R-06)", async () => {
  const { layout } = makeLayout();
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    for (const host of ["127.0.0.1:1", "example.com", `localhost:${port}`, `[::1]:${port}`]) {
      const res = await rawRequest({ port, path: "/api/state", headers: { cookie, host } });
      assert.equal(res.status, 403, host);
    }
    // Even the bootstrap itself dies on a foreign Host.
    const url = new URL(bootstrapUrl);
    const boot = await rawRequest({
      port,
      path: `${url.pathname}${url.search}`,
      headers: { host: "example.com" },
    });
    assert.equal(boot.status, 403);
  } finally {
    await api.stop("test");
  }
});

test("mutations need the custom header, and an exact Origin when one is sent (R-07)", async () => {
  const { layout } = makeLayout();
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const noHeader = await rawRequest({
      port,
      method: "POST",
      path: "/api/run/stop",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(noHeader.status, 403);
    const badOrigin = await rawRequest({
      port,
      method: "POST",
      path: "/api/run/stop",
      headers: mutation(cookie, { origin: "http://evil.example" }),
      body: "{}",
    });
    assert.equal(badOrigin.status, 403);
    // Correct header + exact origin passes the gates (and reaches the
    // handler, which honestly reports that no run is active).
    const good = await rawRequest({
      port,
      method: "POST",
      path: "/api/run/stop",
      headers: mutation(cookie, { origin: `http://127.0.0.1:${port}` }),
      body: "{}",
    });
    assert.equal(good.status, 400);
    assert.equal(JSON.parse(good.body).error, "no_active_run");
    // A plain form post (no JSON content type, no header) is refused.
    const form = await rawRequest({
      port,
      method: "POST",
      path: "/api/run/stop",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: "x=1",
    });
    assert.equal(form.status, 403);
  } finally {
    await api.stop("test");
  }
});

test("no CORS allowances anywhere; a wrong method on a known route is a 405 (R-08)", async () => {
  const { layout } = makeLayout();
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const preflight = await rawRequest({
      port,
      method: "OPTIONS",
      path: "/api/state",
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(preflight.status, 405);
    const state = await rawRequest({ port, path: "/api/state", headers: authed(cookie) });
    for (const res of [preflight, state]) {
      assert.equal(res.headers["access-control-allow-origin"], undefined);
      assert.equal(res.headers["access-control-allow-credentials"], undefined);
    }
    const wrongMethod = await rawRequest({ port, path: "/api/run", headers: authed(cookie) });
    assert.equal(wrongMethod.status, 405);
    const getStop = await rawRequest({ port, path: "/api/server/stop", headers: authed(cookie) });
    assert.equal(getStop.status, 405, "GETs are side-effect-free: there is no GET stop");
  } finally {
    await api.stop("test");
  }
});

test("security headers ride on API, static, and error responses alike (R-11)", async () => {
  const { layout } = makeLayout();
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const responses = [
      await rawRequest({ port, path: "/api/state", headers: authed(cookie) }),
      await rawRequest({ port, path: "/", headers: authed(cookie) }),
      await rawRequest({ port, path: "/api/state" }),
      await rawRequest({ port, path: "/nope", headers: authed(cookie) }),
    ];
    for (const res of responses) {
      assert.match(res.headers["content-security-policy"], /default-src 'self'/);
      assert.match(res.headers["content-security-policy"], /script-src 'self'/);
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      assert.equal(res.headers["cache-control"], "no-store");
    }
  } finally {
    await api.stop("test");
  }
});

test("body caps are enforced while streaming; malformed JSON and wrong media types are refused (R-14, R-13)", async () => {
  const { layout } = makeLayout();
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const bigConfig = await rawRequest({
      port,
      method: "POST",
      path: "/api/config",
      headers: mutation(cookie),
      body: JSON.stringify({ uri: `vless://${"a".repeat(17 * 1024)}` }),
    });
    assert.equal(bigConfig.status, 413);
    const bigSettings = await rawRequest({
      port,
      method: "POST",
      path: "/api/settings",
      headers: mutation(cookie),
      body: JSON.stringify({ settings: { pad: "x".repeat(257 * 1024) } }),
    });
    assert.equal(bigSettings.status, 413);
    const malformed = await rawRequest({
      port,
      method: "POST",
      path: "/api/run",
      headers: mutation(cookie),
      body: "{not json",
    });
    assert.equal(malformed.status, 400);
    assert.equal(JSON.parse(malformed.body).error, "invalid_json");
    const wrongType = await rawRequest({
      port,
      method: "POST",
      path: "/api/run",
      headers: mutation(cookie, { "content-type": "text/plain" }),
      body: "{}",
    });
    assert.equal(wrongType.status, 415);
  } finally {
    await api.stop("test");
  }
});

test("static confinement: no traversal path reaches a file (R-15)", async () => {
  const { layout } = makeLayout();
  writeSecretFile(layout.secretFile, TEST_URI);
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const attempts = [
      "/../data/settings.json",
      "/%2e%2e/data/settings.json",
      "/..%2fdata%2fconfig.secret.uri",
      "/data/settings.json",
      "/api/results/..%2f..%2fdata%2fconfig.secret.uri",
      "/api/logs/..%2f..%2fdata%2fconfig.secret.uri/summary",
      "/api/block/..%2fsecret",
      "/public/../data/settings.json",
    ];
    for (const requestPath of attempts) {
      const res = await rawRequest({ port, path: requestPath, headers: authed(cookie) });
      assert.equal(res.status, 404, requestPath);
      assert.ok(!res.body.includes(TEST_UUID), requestPath);
    }
  } finally {
    await api.stop("test");
  }
});

test("VLESS by reference only: the URI and UUID never appear in responses, errors, or logs (R-09, R-10)", async () => {
  const { layout } = makeLayout();
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const imported = await rawRequest({
      port,
      method: "POST",
      path: "/api/config",
      headers: mutation(cookie),
      body: JSON.stringify({ uri: TEST_URI }),
    });
    assert.equal(imported.status, 200);
    const parsed = JSON.parse(imported.body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.descriptor.address, "edge.example.com");
    assert.equal(parsed.descriptor.idPresent, true);
    assert.ok(!imported.body.includes(TEST_UUID));
    assert.ok(!imported.body.includes("vless://"));

    const shown = await rawRequest({ port, path: "/api/config", headers: authed(cookie) });
    assert.equal(JSON.parse(shown.body).stored, true);
    assert.ok(!shown.body.includes(TEST_UUID));

    // A rejected import (TCP transport) answers with the web layer's
    // static message — no echo of the submitted link, and none of the
    // terminal parser's fragment-quoting wording either (R-13).
    const rejected = await rawRequest({
      port,
      method: "POST",
      path: "/api/config",
      headers: mutation(cookie),
      body: JSON.stringify({
        uri: `vless://${TEST_UUID}@edge.example.com:443?encryption=none&security=none&type=tcp#x`,
      }),
    });
    assert.equal(rejected.status, 400);
    assert.ok(!rejected.body.includes(TEST_UUID));
    assert.ok(!rejected.body.includes("vless://"));

    // Nor in any log the server wrote along the way.
    await api.stop("test");
    const logText = fs
      .readdirSync(layout.logs)
      .map((name) => fs.readFileSync(path.join(layout.logs, name), "utf8"))
      .join("\n");
    assert.ok(logText.includes("web.control.config-import"));
    assert.ok(!logText.includes(TEST_UUID));
    assert.ok(!logText.includes("vless://"));
  } finally {
    await api.stop("test");
  }
});

test("import errors are static: submitted fragments never reflect into the error body (R-13)", async () => {
  const { layout } = makeLayout();
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const post = (uri) =>
      rawRequest({
        port,
        method: "POST",
        path: "/api/config",
        headers: mutation(cookie),
        body: JSON.stringify({ uri }),
      });

    // The shared terminal parser quotes the offending fragment in two
    // of its messages ("VLESS port is invalid: <port>", "Only
    // WebSocket transport is supported for scanning, found: <type>").
    // That wording is right for the terminal, but on this surface the
    // fragments are request body — and request bodies never appear in
    // error bodies. Both failures must answer with the one static
    // web-layer message, markers nowhere in the response.
    const STATIC_MESSAGE =
      "The link could not be imported. Check that it is a complete VLESS WebSocket link.";

    const badPort = await post(
      `vless://${TEST_UUID}@edge.example.com:PORTMARKERZZZ?encryption=none&security=none&type=ws#x`,
    );
    assert.equal(badPort.status, 400);
    assert.equal(JSON.parse(badPort.body).error, "invalid_config");
    assert.equal(JSON.parse(badPort.body).message, STATIC_MESSAGE);
    assert.ok(!badPort.body.includes("PORTMARKERZZZ"));

    const badType = await post(
      `vless://${TEST_UUID}@edge.example.com:443?encryption=none&security=none&type=typemarkerzzz#x`,
    );
    assert.equal(badType.status, 400);
    assert.equal(JSON.parse(badType.body).error, "invalid_config");
    assert.equal(JSON.parse(badType.body).message, STATIC_MESSAGE);
    assert.ok(!badType.body.includes("typemarkerzzz"));

    // A rejected import stores nothing.
    const shown = await rawRequest({ port, path: "/api/config", headers: authed(cookie) });
    assert.equal(JSON.parse(shown.body).stored, false);
  } finally {
    await api.stop("test");
  }
});

test("settings: a no-op PUT leaves the file byte-identical; edits round-trip; defaults match the terminal write (R-12)", async () => {
  const { layout } = makeLayout();
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const get = async () =>
      JSON.parse((await rawRequest({ port, path: "/api/settings", headers: authed(cookie) })).body);
    const put = async (settings) =>
      rawRequest({
        port,
        method: "POST",
        path: "/api/settings",
        headers: mutation(cookie),
        body: JSON.stringify({ settings }),
      });

    const first = await get();
    assert.ok(first.settings && first.catalog.browsing.length > 0);
    await put(first.settings);
    const bytesBefore = fs.readFileSync(layout.settingsFile);
    const second = await get();
    const noop = await put(second.settings);
    assert.equal(noop.status, 200);
    assert.deepEqual(fs.readFileSync(layout.settingsFile), bytesBefore, "no-op PUT must not change a byte");

    const edited = structuredClone(second.settings);
    edited.scan.timeoutMs = 6100;
    await put(edited);
    const third = await get();
    assert.equal(third.settings.scan.timeoutMs, 6100);
    // The save was logged with the changed key NAME only (Shield §4).
    // The logger's file sink is a buffered write stream by design —
    // logging must never block a measurement — so the record reaches
    // disk asynchronously and a one-shot read races its flush (CI
    // 0.9.0: this assertion alone failed on Node 22 windows while the
    // byte-parity assertions around it, all synchronous and
    // platform-independent, passed on every leg). The pin is about
    // the record's content, so wait for the content with a deadline,
    // the same bounded-poll shape this file uses for run state.
    const readLogText = () =>
      fs
        .readdirSync(layout.logs)
        .map((name) => fs.readFileSync(path.join(layout.logs, name), "utf8"))
        .join("\n");
    let logText = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      logText = readLogText();
      if (logText.includes("web.control.settings-save")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(logText.includes("web.control.settings-save"));
    assert.ok(logText.includes("scan.timeoutMs"));

    // Restore-defaults writes exactly what the terminal's own
    // saveSettings(DEFAULT_SETTINGS) writes.
    const defaults = await rawRequest({
      port,
      method: "POST",
      path: "/api/settings/defaults",
      headers: mutation(cookie),
      body: "{}",
    });
    assert.equal(defaults.status, 200);
    const other = makeLayout();
    saveSettings(other.layout.settingsFile, structuredClone(DEFAULT_SETTINGS));
    assert.deepEqual(fs.readFileSync(layout.settingsFile), fs.readFileSync(other.layout.settingsFile));
  } finally {
    await api.stop("test");
  }
});

test("settings estimate answers from the same estimator the settings view uses", async () => {
  const { layout } = makeLayout();
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const res = await rawRequest({
      port,
      method: "POST",
      path: "/api/settings/estimate",
      headers: mutation(cookie),
      body: JSON.stringify({ settings: loadSettings(layout.settingsFile) }),
    });
    assert.equal(res.status, 200);
    const { perCandidateBytes } = JSON.parse(res.body);
    assert.ok(Number.isFinite(perCandidateBytes) && perCandidateBytes > 0);
  } finally {
    await api.stop("test");
  }
});

test("snapshot at rest: catalog totals are the real catalog and genome vectors are well-formed", async () => {
  const { layout } = makeLayout();
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const catalog = JSON.parse(
      (await rawRequest({ port, path: "/api/catalog", headers: authed(cookie) })).body,
    );
    assert.equal(catalog.rangesTotal, 753);
    assert.equal(catalog.blocksTotal, 7697);
    assert.equal(catalog.addressesTotal, 1970432);
    assert.equal(catalog.ranges.length, 753);
    assert.deepEqual(catalog.ranges[0], { cidr: "1.0.0.0/24", firstBlock: 0, blocks: 1 });

    const snap = JSON.parse(
      (await rawRequest({ port, path: "/api/state", headers: authed(cookie) })).body,
    );
    assert.equal(snap.run, null);
    assert.equal(snap.latest, null);
    assert.equal(snap.genome.blocksTotal, 7697);
    assert.equal(Buffer.from(snap.genome.state, "base64").length, 7697);
    assert.equal(Buffer.from(snap.genome.heat, "base64").length, 7697);
    assert.equal(Buffer.from(snap.genome.quads, "base64").length, 7697 * 4);
    assert.equal(snap.status.configReady, false);
    assert.equal(snap.status.resumeAvailable, false);

    // The workloads endpoint is not part of the contract (workloads
    // ride the settings object) — it stays an honest 404.
    const workloads = await rawRequest({ port, path: "/api/workloads", headers: authed(cookie) });
    assert.equal(workloads.status, 404);
  } finally {
    await api.stop("test");
  }
});

test("snapshot at rest: a paused checkpoint becomes the resumable run view, with split quadrants packed", async () => {
  const { layout } = makeLayout();
  const runId = "12345678-1234-4234-9234-1234567890ab";
  const checkpoint = {
    version: 4,
    runId,
    status: "paused",
    phase: "hard-expansion",
    stoppedReason: "canceled",
    createdAt: "2026-11-20T10:00:00.000Z",
    counts: { tested: 12, eligible: 3, failed: 9, primerProbes: 9, expansionProbes: 3, blocksPrimed: 2, blocksExpanded: 1 },
    blockState: {
      version: 1,
      totals: { probesSpent: 4242, primerProbes: 3000, expansionProbes: 1242, reserveProbes: 0 },
      blocks: [
        { blockId: "1.0.0.0/24", blockIndex: 0, parentBlockId: null, splitDepth: 0, runAttempts: 8, runSuccesses: 4, tier: "full", primerTarget: 3, primerDone: 3, hardDead: false, addressesExhausted: false },
        { blockId: "1.0.0.0/25", blockIndex: 0, parentBlockId: "1.0.0.0/24", splitDepth: 1, runAttempts: 4, runSuccesses: 4 },
        { blockId: "1.0.0.128/25", blockIndex: 0, parentBlockId: "1.0.0.0/24", splitDepth: 1, runAttempts: 4, runSuccesses: 0 },
      ],
    },
  };
  fs.writeFileSync(layout.hardStateFile, JSON.stringify(checkpoint));
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const snap = JSON.parse(
      (await rawRequest({ port, path: "/api/state", headers: authed(cookie) })).body,
    );
    assert.equal(snap.status.resumeAvailable, true);
    assert.equal(snap.run.mode, "hard");
    assert.equal(snap.run.status, "paused-done");
    assert.equal(snap.run.runId, runId);
    assert.equal(snap.run.counters.probesSpent, 4242);
    assert.equal(snap.run.counters.blocksSplit, 1);
    const state = Buffer.from(snap.genome.state, "base64");
    const quads = Buffer.from(snap.genome.quads, "base64");
    const quadHeat = Buffer.from(snap.genome.quadHeat, "base64");
    assert.equal(state[0], 7, "split parent paints state 7");
    // Lower child 4/4 alive (state 3, heat 255) in q0+q1; upper child
    // 0/4 absent (state 4, heat 0) in q2+q3 — CONTRACT §1 packing.
    assert.equal(quads.readUInt32LE(0), 3 | (3 << 8) | (4 << 16) | (4 << 24));
    assert.equal(quadHeat.readUInt32LE(0), 255 | (255 << 8));

    const detail = JSON.parse(
      (await rawRequest({ port, path: "/api/block/0", headers: authed(cookie) })).body,
    );
    assert.equal(detail.cidr, "1.0.0.0/24");
    assert.equal(detail.halves.split, true);
    const missing = await rawRequest({ port, path: "/api/block/99999", headers: authed(cookie) });
    assert.equal(missing.status, 404);
  } finally {
    await api.stop("test");
  }
});

// One full pass through the run-control contract against the real
// engine: start, the three 409s, live events with a strict sequence,
// stop via the cancel token, the paused checkpoint, and the
// reports/results/logs surfaces the finished run leaves behind.
// Determinism: the catalog is loopback /24s and a blackhole listener
// accepts every probe connection without ever answering, so each
// probe burns its full (shortened) timeout; calibration is disabled
// in the test settings so the run goes straight into a ~30 s primer
// and is guaranteed to still be sweeping when the stop lands — on
// any machine, at any speed.
test("run lifecycle: start, 409 while active, strict event sequence, stop, paused-done, artifacts", async () => {
  const blackholeSockets = new Set();
  const blackhole = net.createServer((socket) => {
    blackholeSockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => blackholeSockets.delete(socket));
  });
  await new Promise((resolve) => blackhole.listen(18443, "0.0.0.0", resolve));
  const ranges = [];
  for (let i = 0; i < 300; i += 1) ranges.push(`127.${(i >> 8) & 255}.${i & 255}.0/24`);
  const { layout } = makeLayout({ rangesText: `${ranges.join("\n")}\n` });
  writeSecretFile(
    layout.secretFile,
    `vless://${TEST_UUID}@edge.example.com:18443?encryption=none&security=none&type=ws&host=edge.example.com&path=%2Fws#test`,
  );
  const testSettings = loadSettings(layout.settingsFile);
  testSettings.calibration.enabled = false;
  testSettings.scan.timeoutMs = 400;
  saveSettings(layout.settingsFile, testSettings);
  const { api, port, bootstrapUrl } = await startServer(layout);
  const events = [];
  let terminalResolve;
  const terminalSeen = new Promise((resolve) => {
    terminalResolve = resolve;
  });
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const sse = http.get(
      { host: "127.0.0.1", port, path: "/api/events?tail=1", headers: { cookie }, agent: false },
      (res) => {
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const type = /event: (\S+)/.exec(frame)?.[1];
            const dataLine = /data: (.*)/s.exec(frame)?.[1];
            if (!type || !dataLine) continue;
            const payload = JSON.parse(dataLine);
            events.push({ type, payload });
            if (type === "run-state" && payload.status === "paused-done") terminalResolve();
          }
        });
      },
    );
    sse.on("error", () => {});

    const started = await rawRequest({
      port,
      method: "POST",
      path: "/api/run",
      headers: mutation(cookie),
      body: JSON.stringify({ mode: "hard" }),
    });
    assert.equal(started.status, 200);
    const { runId } = JSON.parse(started.body);
    assert.ok(runId);

    const second = await rawRequest({
      port,
      method: "POST",
      path: "/api/run",
      headers: mutation(cookie),
      body: JSON.stringify({ mode: "full" }),
    });
    assert.equal(second.status, 409);
    assert.equal(JSON.parse(second.body).error, "run_active");
    assert.equal(JSON.parse(second.body).runId, runId);

    const removeDuring = await rawRequest({
      port,
      method: "POST",
      path: "/api/config/remove",
      headers: mutation(cookie),
      body: "{}",
    });
    assert.equal(removeDuring.status, 409);
    const serverStopDuring = await rawRequest({
      port,
      method: "POST",
      path: "/api/server/stop",
      headers: mutation(cookie),
      body: "{}",
    });
    assert.equal(serverStopDuring.status, 409);

    // The run is visibly alive in the snapshot.
    let snap = null;
    for (let attempt = 0; attempt < 75 && !snap; attempt += 1) {
      const res = await rawRequest({ port, path: "/api/state", headers: authed(cookie) });
      const parsed = JSON.parse(res.body);
      if (parsed.run && parsed.run.status === "running" && parsed.run.phase) snap = parsed;
      else await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(snap, "the run reaches a named phase in the snapshot");
    assert.equal(snap.run.mode, "hard");
    assert.ok(snap.run.genome, "hard snapshots carry the live genome");

    const stopped = await rawRequest({
      port,
      method: "POST",
      path: "/api/run/stop",
      headers: mutation(cookie),
      body: "{}",
    });
    assert.equal(stopped.status, 200);
    let deadline;
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("no paused-done within 60s")), 60000);
    });
    await Promise.race([terminalSeen, timeout]);
    clearTimeout(deadline);
    sse.destroy();

    // Broadcast events carry a strict +1 sequence (the resync
    // contract); log frames ride the loss-tolerant tail and may only
    // repeat the current value.
    const broadcast = events.filter((event) => event.type !== "log");
    for (let i = 1; i < broadcast.length; i += 1) {
      assert.equal(
        broadcast[i].payload.seq,
        broadcast[i - 1].payload.seq + 1,
        `seq gap at ${broadcast[i].type}`,
      );
    }
    const types = new Set(events.map((event) => event.type));
    for (const expected of ["run-state", "phase", "counters", "blocks"]) {
      assert.ok(types.has(expected), `event type ${expected} observed`);
    }

    const after = JSON.parse(
      (await rawRequest({ port, path: "/api/state", headers: authed(cookie) })).body,
    );
    assert.equal(after.run.status, "paused-done");
    assert.equal(after.status.resumeAvailable, true);

    const reports = JSON.parse(
      (await rawRequest({ port, path: "/api/reports", headers: authed(cookie) })).body,
    );
    const mine = reports.find((entry) => entry.runId === runId);
    assert.ok(mine, "the finished run is listed");
    assert.equal(mine.mode, "hard");

    const result = await rawRequest({ port, path: `/api/results/${runId}`, headers: authed(cookie) });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).runId, runId);
    const download = await rawRequest({
      port,
      path: `/api/reports/${runId}/download`,
      headers: authed(cookie),
    });
    assert.equal(download.status, 200);
    assert.match(download.headers["content-disposition"], new RegExp(`run-${runId}\\.json`));
    const bestIps = await rawRequest({
      port,
      path: `/api/reports/${runId}/best-ips`,
      headers: authed(cookie),
    });
    assert.equal(bestIps.status, 200);

    const logs = JSON.parse(
      (await rawRequest({ port, path: "/api/logs", headers: authed(cookie) })).body,
    );
    const runLog = logs.find((entry) => entry.name === `run-${runId}.ndjson`);
    assert.ok(runLog, "the run's log is listed");
    const summary = JSON.parse(
      (
        await rawRequest({
          port,
          path: `/api/logs/${runLog.name}/summary`,
          headers: authed(cookie),
        })
      ).body,
    );
    assert.ok(summary.total > 0);
    assert.equal(typeof summary.errors, "number");
    assert.equal(typeof summary.warnings, "number");
    const unknownLog = await rawRequest({
      port,
      path: "/api/logs/run-00000000-0000-4000-8000-000000000000.ndjson/summary",
      headers: authed(cookie),
    });
    assert.equal(unknownLog.status, 404);
  } finally {
    await api.stop("test");
    // Accepted probe sockets can outlive the run (a timed-out probe
    // does not always send a FIN); destroy them or close() waits
    // for them forever.
    for (const socket of blackholeSockets) socket.destroy();
    await new Promise((resolve) => blackhole.close(resolve));
  }
});

test("scan-mode stop lifecycle: canceled event, snapshot agreement, second stop is a 400 (defect 7 regression)", async () => {
  const blackholeSockets = new Set();
  const blackhole = net.createServer((socket) => {
    blackholeSockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => blackholeSockets.delete(socket));
  });
  await new Promise((resolve) => blackhole.listen(18444, "0.0.0.0", resolve));
  const ranges = [];
  for (let i = 0; i < 300; i += 1) ranges.push(`127.${(i >> 8) & 255}.${i & 255}.0/24`);
  const { layout } = makeLayout({ rangesText: `${ranges.join("\n")}\n` });
  writeSecretFile(
    layout.secretFile,
    `vless://${TEST_UUID}@edge.example.com:18444?encryption=none&security=none&type=ws&host=edge.example.com&path=%2Fws#test`,
  );
  const testSettings = loadSettings(layout.settingsFile);
  testSettings.calibration.enabled = false;
  testSettings.scan.timeoutMs = 400;
  saveSettings(layout.settingsFile, testSettings);
  const { api, port, bootstrapUrl } = await startServer(layout);
  const runStates = [];
  let terminalResolve;
  const terminalSeen = new Promise((resolve) => { terminalResolve = resolve; });
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const sse = http.get(
      { host: "127.0.0.1", port, path: "/api/events?tail=1", headers: { cookie } },
      (res) => {
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const type = /event: (\S+)/.exec(frame)?.[1];
            const dataLine = /data: (.*)/s.exec(frame)?.[1];
            if (!type || !dataLine) continue;
            const payload = JSON.parse(dataLine);
            if (type === "run-state") {
              runStates.push(payload);
              if (payload.status === "canceled") terminalResolve();
            }
          }
        });
      },
    );
    sse.on("error", () => {});

    const started = await rawRequest({
      port, method: "POST", path: "/api/run", headers: mutation(cookie),
      body: JSON.stringify({ mode: "quick" }),
    });
    assert.equal(started.status, 200);
    const { runId } = JSON.parse(started.body);
    assert.ok(runId);

    // The run is visibly alive before we stop it.
    let alive = false;
    for (let attempt = 0; attempt < 75 && !alive; attempt += 1) {
      const parsed = JSON.parse((await rawRequest({ port, path: "/api/state", headers: authed(cookie) })).body);
      if (parsed.run && parsed.run.status === "running") alive = true;
      else await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(alive, "the quick run reaches running in the snapshot");

    const stopped = await rawRequest({
      port, method: "POST", path: "/api/run/stop", headers: mutation(cookie), body: "{}",
    });
    assert.equal(stopped.status, 200);
    let deadline;
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("no canceled run-state within 60s")), 60000);
    });
    await Promise.race([terminalSeen, timeout]);
    clearTimeout(deadline);
    sse.destroy();

    // THE regression pair: the terminal event and the snapshot must
    // agree about the same run. The snapshot must not report
    // "running" (the banner-resurrection defect), and must not
    // erase the stop by decaying to null/idle either.
    const after = JSON.parse((await rawRequest({ port, path: "/api/state", headers: authed(cookie) })).body);
    assert.ok(after.run, "the stopped run keeps a terminal view at rest");
    assert.equal(after.run.status, "canceled");
    assert.equal(after.run.runId, runId);
    assert.equal(after.run.mode, "quick");
    const cancelAt = runStates.findIndex((e) => e.status === "canceled");
    assert.ok(cancelAt >= 0);
    assert.ok(
      !runStates.slice(cancelAt + 1).some((e) => e.status === "running" && e.runId === runId),
      "no running event for the same run after its terminal event",
    );

    // A second stop is a clean, explained refusal.
    const secondStop = await rawRequest({
      port, method: "POST", path: "/api/run/stop", headers: mutation(cookie), body: "{}",
    });
    assert.equal(secondStop.status, 400);
    assert.equal(JSON.parse(secondStop.body).error, "no_active_run");
  } finally {
    await api.stop("test");
    for (const socket of blackholeSockets) socket.destroy();
    await new Promise((resolve) => blackhole.close(resolve));
  }
});

test("run start refuses cleanly: no config is a 400 config_missing, a bogus mode a 400 bad_mode", async () => {
  const { layout } = makeLayout();
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const noConfig = await rawRequest({
      port,
      method: "POST",
      path: "/api/run",
      headers: mutation(cookie),
      body: JSON.stringify({ mode: "full" }),
    });
    assert.equal(noConfig.status, 400);
    assert.equal(JSON.parse(noConfig.body).error, "config_missing");
    writeSecretFile(layout.secretFile, TEST_URI);
    const bogus = await rawRequest({
      port,
      method: "POST",
      path: "/api/run",
      headers: mutation(cookie),
      body: JSON.stringify({ mode: "bogus" }),
    });
    assert.equal(bogus.status, 400);
    assert.equal(JSON.parse(bogus.body).error, "bad_mode");
    const noResume = await rawRequest({
      port,
      method: "POST",
      path: "/api/run",
      headers: mutation(cookie),
      body: JSON.stringify({ mode: "hard", resume: true }),
    });
    assert.equal(noResume.status, 400);
    assert.equal(JSON.parse(noResume.body).error, "no_resume");
  } finally {
    await api.stop("test");
  }
});

test("server stop: POST /api/server/stop ends the surface and fires the host callback", async () => {
  const { layout } = makeLayout();
  let stoppedResolve;
  const stoppedSeen = new Promise((resolve) => {
    stoppedResolve = resolve;
  });
  const { api, port, bootstrapUrl } = await startServer(layout, {
    onStopRequest: () => stoppedResolve(),
  });
  const { cookie } = await bootstrap(port, bootstrapUrl);
  const res = await rawRequest({
    port,
    method: "POST",
    path: "/api/server/stop",
    headers: mutation(cookie),
    body: "{}",
  });
  assert.equal(res.status, 200);
  let deadline;
  const timeout = new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error("host callback not fired")), 5000);
  });
  await Promise.race([stoppedSeen, timeout]);
  clearTimeout(deadline);
  await assert.rejects(
    rawRequest({ port, path: "/api/state", headers: authed(cookie) }),
    /ECONNREFUSED/,
  );
  await api.stop("test");
});

test("port fallback: a second server on a taken 8797 binds an ephemeral port and reports the truth (R-01)", async () => {
  const first = makeLayout();
  const second = makeLayout();
  const a = await startServer(first.layout);
  const b = await startServer(second.layout);
  try {
    // Whichever port `a` holds (8797 when free), `b` cannot share
    // it: it must fall back and report its own real authority.
    assert.ok(a.port > 0);
    assert.notEqual(b.port, a.port);
    assert.ok(b.port > 0);
    // The fallback server is fully functional on its real authority,
    // and its token never reaches its own log file.
    const { res, cookie } = await bootstrap(b.port, b.bootstrapUrl);
    assert.equal(res.status, 302);
    const state = await rawRequest({ port: b.port, path: "/api/state", headers: authed(cookie) });
    assert.equal(state.status, 200);
    const token = new URL(b.bootstrapUrl).searchParams.get("t");
    await b.api.stop("test");
    const logText = fs
      .readdirSync(second.layout.logs)
      .map((name) => fs.readFileSync(path.join(second.layout.logs, name), "utf8"))
      .join("\n");
    assert.ok(logText.includes("web.start"));
    assert.ok(!logText.includes(token), "the session token is never logged (R-02)");
  } finally {
    await a.api.stop("test");
    await b.api.stop("test");
  }
});

test("fault containment: a throwing handler answers a static 500 and the server lives on (R-17)", async () => {
  const { root, layout } = makeLayout();
  fs.rmSync(layout.rangesFile); // snapshot building now throws inside the handler
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const state = await rawRequest({ port, path: "/api/state", headers: authed(cookie) });
    assert.equal(state.status, 500);
    assert.deepEqual(JSON.parse(state.body), { error: "internal", message: "Internal error" });
    // Neither the server nor the session died with the request.
    const index = await rawRequest({ port, path: "/", headers: authed(cookie) });
    assert.equal(index.status, 200);
    const config = await rawRequest({ port, path: "/api/config", headers: authed(cookie) });
    assert.equal(config.status, 200);
    void root;
  } finally {
    await api.stop("test");
  }
});

test("control rejections are logged: every refused start/stop/import/remove/server-stop leaves web.control.reject (Signal log audit)", async () => {
  const blackholeSockets = new Set();
  const blackhole = net.createServer((socket) => {
    blackholeSockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => blackholeSockets.delete(socket));
  });
  await new Promise((resolve) => blackhole.listen(18443, "0.0.0.0", resolve));
  const ranges = [];
  for (let i = 0; i < 300; i += 1) ranges.push(`127.${(i >> 8) & 255}.${i & 255}.0/24`);
  const { layout } = makeLayout({ rangesText: `${ranges.join("\n")}\n` });
  const testSettings = loadSettings(layout.settingsFile);
  testSettings.calibration.enabled = false;
  testSettings.scan.timeoutMs = 400;
  saveSettings(layout.settingsFile, testSettings);
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const post = (requestPath, body) =>
      rawRequest({ port, method: "POST", path: requestPath, headers: mutation(cookie), body: JSON.stringify(body) });

    // No config yet.
    assert.equal((await post("/api/run", { mode: "quick" })).status, 400);
    // A rejected import (grpc is refused by the web layer itself).
    assert.equal((await post("/api/config", { uri: `vless://${TEST_UUID}@edge.example.com:443?encryption=none&security=none&type=grpc&host=edge.example.com#test` })).status, 400);
    // A rejected import through the other branch: no URI at all (the
    // handler's early return must leave the same record — the two
    // branches are counted separately below, not just keyed).
    assert.equal((await post("/api/config", {})).status, 400);
    // A good import, pointed at the blackhole.
    assert.equal((await post("/api/config", { uri: `vless://${TEST_UUID}@edge.example.com:18443?encryption=none&security=none&type=ws&host=edge.example.com&path=%2Fws#test` })).status, 200);
    // Resume with no paused state; unknown mode.
    assert.equal((await post("/api/run", { mode: "hard", resume: true })).status, 400);
    assert.equal((await post("/api/run", { mode: "bogus" })).status, 400);
    // A real start, then every conflict refusal.
    const started = await post("/api/run", { mode: "hard" });
    assert.equal(started.status, 200);
    const { runId } = JSON.parse(started.body);
    assert.equal((await post("/api/run", { mode: "full" })).status, 409);
    assert.equal((await post("/api/config/remove", {})).status, 409);
    assert.equal((await post("/api/server/stop", {})).status, 409);
    assert.equal((await post("/api/run/stop", {})).status, 200);
    // Wait for the run to settle, then a stop with nothing running.
    let settled = false;
    for (let attempt = 0; attempt < 120 && !settled; attempt += 1) {
      const res = await rawRequest({ port, path: "/api/state", headers: authed(cookie) });
      const snap = JSON.parse(res.body);
      if (snap.run && snap.run.status === "paused-done") settled = true;
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(settled, "the stopped hard run settles as paused-done");
    assert.equal((await post("/api/run/stop", {})).status, 400);

    // The server's own log carries one precise record per refusal.
    const files = fs.readdirSync(layout.logs).filter((name) => name.endsWith(".ndjson"));
    const allRecords = files.flatMap((name) =>
      fs.readFileSync(path.join(layout.logs, name), "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)),
    );
    const rejects = allRecords.filter((record) => record.event === "web.control.reject");
    const keys = new Set(rejects.map((record) => `${record.action}:${record.reason}`));
    for (const expected of [
      "run-start:config_missing",
      "config-import:invalid_config",
      "run-start:no_resume",
      "run-start:bad_mode",
      "run-start:run_active",
      "config-remove:run_active",
      "server-stop:run_active",
      "run-stop:no_active_run",
    ]) {
      assert.ok(keys.has(expected), `missing reject record ${expected}; got ${JSON.stringify([...keys])}`);
    }
    // Both import-refusal branches logged: the grpc catch branch and
    // the empty-URI early return — one record each, not just the key.
    assert.equal(
      rejects.filter((record) => record.action === "config-import" && record.reason === "invalid_config").length,
      2,
      "each refused import branch leaves its own reject record",
    );
    assert.ok(rejects.every((record) => record.level === "warn"));
    assert.ok(rejects.filter((record) => record.action === "run-start").every((record) => typeof record.mode === "string"));

    // And the run's own log: every record carries the run's real id —
    // the envelope fix, end to end (records like web.control.scan-start
    // and scan.start pass runId as a detail; it must not shadow).
    const runRecords = allRecords.filter((record) => record.event === "run.start");
    assert.equal(runRecords.length, 1);
    const runFile = files.find((name) => name === `run-${runId}.ndjson`);
    assert.ok(runFile, "run log file is named by the run id");
    const own = fs.readFileSync(path.join(layout.logs, runFile), "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
    assert.ok(own.length > 0 && own.every((record) => record.runId === runId), "every record in the run log carries the run id verbatim");
  } finally {
    await api.stop("test");
    blackhole.close();
    for (const socket of blackholeSockets) socket.destroy();
  }
});

test("run failure: a run whose engine throws ends in run-state failed, with run.end failed in its log (F-2)", async () => {
  const { layout } = makeLayout();
  // A stored config the engines refuse at the door (non-WebSocket
  // transport): the run starts, the engine throws immediately, and
  // the failure path — not the cancel path — must answer for it.
  writeSecretFile(
    layout.secretFile,
    `vless://${TEST_UUID}@edge.example.com:443?encryption=none&security=none&type=grpc&host=edge.example.com#test`,
  );
  const { api, port, bootstrapUrl } = await startServer(layout);
  let resolveFailed;
  const failedEvent = new Promise((resolve) => { resolveFailed = resolve; });
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const sse = http.get(
      { host: "127.0.0.1", port, path: "/api/events?tail=1", headers: { cookie }, agent: false },
      (res) => {
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const type = /event: (\S+)/.exec(frame)?.[1];
            const dataLine = /data: (.*)/s.exec(frame)?.[1];
            if (!type || !dataLine) continue;
            const payload = JSON.parse(dataLine);
            if (type === "run-state" && payload.status === "failed") resolveFailed(payload);
          }
        });
      },
    );
    sse.on("error", () => {});

    const started = await rawRequest({
      port,
      method: "POST",
      path: "/api/run",
      headers: mutation(cookie),
      body: JSON.stringify({ mode: "full" }),
    });
    assert.equal(started.status, 200);
    const { runId } = JSON.parse(started.body);
    assert.ok(runId);

    let deadline;
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("no failed run-state within 15s")), 15000);
    });
    const payload = await Promise.race([failedEvent, timeout]);
    clearTimeout(deadline);
    sse.destroy();
    assert.equal(payload.runId, runId);
    assert.equal(payload.mode, "full");

    // The run's own log closes the story the stream told: run.end
    // with status "failed" (not "canceled"). The stream event fires
    // before the logger's close flush lands, so poll for the record.
    const logPath = path.join(layout.logs, `run-${runId}.ndjson`);
    let runEnd = null;
    for (let attempt = 0; attempt < 50 && !runEnd; attempt += 1) {
      try {
        const records = fs
          .readFileSync(logPath, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
        runEnd = records.find((record) => record.event === "run.end") ?? null;
      } catch {
        // The file may not exist yet on the first polls.
      }
      if (!runEnd) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(runEnd, "run.end exists");
    assert.equal(runEnd.status, "failed");

    // And the snapshot agrees with the event: the failed run's
    // terminal view, with its reason — never a phantom "running",
    // never a silent decay to idle that erases the failure (0.9.1
    // CONTRACT §9 terminal agreement).
    const after = JSON.parse(
      (await rawRequest({ port, path: "/api/state", headers: authed(cookie) })).body,
    );
    assert.equal(after.run.status, "failed");
    assert.equal(after.run.runId, runId);
    assert.equal(typeof after.run.error, "string");
    assert.ok(after.run.error.length > 0, "the failure reason rides the snapshot");
    assert.equal(typeof payload.error, "string", "the failure reason rides the terminal event too");
  } finally {
    await api.stop("test");
  }
});

test("hard stop → resume adopts the checkpoint runId: response, terminal state, report, results API and log all carry the original id", async () => {
  const blackholeSockets = new Set();
  const blackhole = net.createServer((socket) => {
    blackholeSockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => blackholeSockets.delete(socket));
  });
  await new Promise((resolve) => blackhole.listen(18444, "0.0.0.0", resolve));
  const ranges = [];
  for (let i = 0; i < 300; i += 1) ranges.push(`127.${(i >> 8) & 255}.${i & 255}.0/24`);
  const { layout } = makeLayout({ rangesText: `${ranges.join("\n")}\n` });
  const testSettings = loadSettings(layout.settingsFile);
  testSettings.calibration.enabled = false;
  testSettings.scan.timeoutMs = 400;
  saveSettings(layout.settingsFile, testSettings);
  const { api, port, bootstrapUrl } = await startServer(layout);
  try {
    const { cookie } = await bootstrap(port, bootstrapUrl);
    const post = (requestPath, body) =>
      rawRequest({ port, method: "POST", path: requestPath, headers: mutation(cookie), body: JSON.stringify(body) });
    const snapshot = async () =>
      JSON.parse((await rawRequest({ port, path: "/api/state", headers: authed(cookie) })).body);
    const waitForPaused = async (runId) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const snap = await snapshot();
        if (snap.run && snap.run.status === "paused-done" && snap.run.runId === runId) return snap;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`run ${runId} did not settle as paused-done`);
    };

    assert.equal(
      (await post("/api/config", { uri: `vless://${TEST_UUID}@edge.example.com:18444?encryption=none&security=none&type=ws&host=edge.example.com&path=%2Fws#test` })).status,
      200,
    );
    // First run: start Hard, stop it, let it settle as paused-done.
    const started = await post("/api/run", { mode: "hard" });
    assert.equal(started.status, 200);
    const { runId: originalId } = JSON.parse(started.body);
    assert.equal((await post("/api/run/stop", {})).status, 200);
    await waitForPaused(originalId);

    // Resume: the response must name the checkpoint's id — the run
    // keeps its identity instead of minting a second one.
    let resumed = null;
    for (let attempt = 0; attempt < 40 && !resumed; attempt += 1) {
      const res = await post("/api/run", { mode: "hard", resume: true });
      if (res.status === 200) resumed = res;
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(resumed, "the resume start was accepted");
    assert.equal(JSON.parse(resumed.body).runId, originalId, "the resumed run adopts the checkpoint runId");

    // Stop the resumed run; the terminal state keeps the same id.
    assert.equal((await post("/api/run/stop", {})).status, 200);
    const terminal = await waitForPaused(originalId);
    assert.equal(terminal.run.runId, originalId);

    // The report is filed under that one id and the results API
    // serves it — the pre-fix split (snapshot id ≠ report id) 404'd.
    const resultRes = await rawRequest({ port, path: `/api/results/${originalId}`, headers: authed(cookie) });
    assert.equal(resultRes.status, 200, "the terminal snapshot's id resolves to its report");
    assert.equal(JSON.parse(resultRes.body).runId, originalId);

    // And the resumed run's records live in the original run's log
    // file, under the original envelope id — one run, one story.
    const records = fs
      .readFileSync(path.join(layout.logs, `run-${originalId}.ndjson`), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const resumeStart = records.find((record) => record.event === "run.start" && record.resume === true);
    assert.ok(resumeStart, "the resumed run's run.start is in the original run's log file");
    assert.equal(resumeStart.runId, originalId);
    assert.equal(records.filter((record) => record.event === "run.start").length, 2, "both starts belong to the one run id");
  } finally {
    await api.stop("test");
    for (const socket of blackholeSockets) socket.destroy();
    await new Promise((resolve) => blackhole.close(resolve));
  }
});
