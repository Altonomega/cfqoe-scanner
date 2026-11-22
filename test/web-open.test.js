// Browser-open command builder (plan ch. 3.6, Shield R-16): the URL
// is handed to the platform handler as a single argv element via an
// execFile-style spawn — never through a shell — and a missing or
// failing handler resolves false so the caller falls back to the
// printed URL. Every platform row is pinned here.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildOpenAttempts, bootstrapUrlForPlatform, openInBrowser } from "../src/web/open.js";

const URL = "http://127.0.0.1:8797/?t=TOKEN";

test("windows: rundll32 FileProtocolHandler with the URL as one argv element", () => {
  assert.deepEqual(buildOpenAttempts("win32", URL, {}), [
    { file: "rundll32", args: ["url.dll,FileProtocolHandler", URL] },
  ]);
});

test("macOS: open", () => {
  assert.deepEqual(buildOpenAttempts("darwin", URL, {}), [{ file: "open", args: [URL] }]);
});

test("linux: xdg-open then gio, and nothing when headless", () => {
  assert.deepEqual(buildOpenAttempts("linux", URL, { DISPLAY: ":0" }), [
    { file: "xdg-open", args: [URL] },
    { file: "gio", args: ["open", URL] },
  ]);
  assert.deepEqual(buildOpenAttempts("linux", URL, { WAYLAND_DISPLAY: "wayland-1" }).length, 2);
  assert.deepEqual(buildOpenAttempts("linux", URL, {}), []);
});

test("android/Termux: three diverse dispatches — termux-open-url, termux-open, the shaped intent", () => {
  // The old two attempts were one mechanism twice (termux-open-url
  // wraps `am start`); the list now walks three different routes to
  // the browser, and the raw intent is shaped like a real link tap.
  assert.deepEqual(buildOpenAttempts("android", URL, {}), [
    { file: "termux-open-url", args: [URL] },
    { file: "termux-open", args: ["--view", URL] },
    {
      file: "am",
      args: [
        "start",
        "--user",
        "0",
        "-a",
        "android.intent.action.VIEW",
        "-c",
        "android.intent.category.BROWSABLE",
        "-f",
        "0x10000000",
        "-d",
        URL,
      ],
    },
  ]);
});

test("unknown platforms get no attempts", () => {
  assert.deepEqual(buildOpenAttempts("freebsd", URL, {}), []);
});

test("bootstrapUrlForPlatform: only the Android opener receives the fragment spelling (0.9.6, Shield A2)", () => {
  const session = {
    bootstrapUrl: "http://127.0.0.1:8797/?t=TOKEN",
    bootstrapFragmentUrl: "http://127.0.0.1:8797/#TOKEN",
  };
  assert.equal(bootstrapUrlForPlatform("android", session), session.bootstrapFragmentUrl);
  for (const platform of ["win32", "darwin", "linux", "freebsd"]) {
    assert.equal(bootstrapUrlForPlatform(platform, session), session.bootstrapUrl, platform);
  }
});

function fakeSpawn(plan) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    // A real child process is a ref'd handle until it exits, errors,
    // or is unref'd — and that handle is what keeps the opener's
    // unref'd settle timer reachable while an attempt is in flight.
    // A bare EventEmitter has no handle, so on Node ≤22 the test
    // process drains its loop and exits mid-await, cancelling every
    // timer-dependent test. Model the handle with a ref'd interval
    // the child holds until it errors, exits, or is unref'd.
    const hold = setInterval(() => {}, 1000);
    const release = () => clearInterval(hold);
    child.unref = () => {
      child.unrefCalled = true;
      release();
    };
    const behavior = plan[calls.length - 1] ?? "spawn";
    queueMicrotask(() => {
      // "exit<N>" emits the exit event with code N; every other
      // behavior name is emitted as the event itself.
      if (behavior.startsWith("exit")) {
        release();
        child.emit("exit", Number(behavior.slice(4)));
      } else {
        if (behavior === "error") release();
        child.emit(behavior);
      }
    });
    return child;
  };
  return { calls, spawnImpl };
}

test("openInBrowser resolves true for a handler still running at the settle window, detached with stdio ignored", async () => {
  const { calls, spawnImpl } = fakeSpawn(["spawn"]);
  const ok = await openInBrowser(URL, { platform: "darwin", env: {}, spawnImpl });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { detached: true, stdio: "ignore" });
});

test("openInBrowser falls through to the next attempt when a handler is missing", async () => {
  const { calls, spawnImpl } = fakeSpawn(["error", "spawn"]);
  const ok = await openInBrowser(URL, { platform: "android", env: {}, spawnImpl });
  assert.equal(ok, true);
  assert.deepEqual(
    calls.map((call) => call.file),
    ["termux-open-url", "termux-open"],
  );
});

test("openInBrowser falls through when a handler spawns and immediately exits non-zero", async () => {
  // A spawn is not a delivery: the handler that dies inside the
  // settle window delivered nothing, so the walk continues.
  const { calls, spawnImpl } = fakeSpawn(["exit1", "spawn"]);
  const ok = await openInBrowser(URL, { platform: "android", env: {}, spawnImpl });
  assert.equal(ok, true);
  assert.deepEqual(
    calls.map((call) => call.file),
    ["termux-open-url", "termux-open"],
  );
});

test("openInBrowser does not fall through on a clean exit 0", async () => {
  const { calls, spawnImpl } = fakeSpawn(["exit0"]);
  const ok = await openInBrowser(URL, { platform: "darwin", env: {}, spawnImpl });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
});

test("openInBrowser resolves false when the only handler exits non-zero", async () => {
  const { calls, spawnImpl } = fakeSpawn(["exit1"]);
  const ok = await openInBrowser(URL, { platform: "darwin", env: {}, spawnImpl });
  assert.equal(ok, false);
  assert.equal(calls.length, 1);
});

test("openInBrowser resolves false when every handler fails — it never throws", async () => {
  const { spawnImpl } = fakeSpawn(["error", "error"]);
  assert.equal(await openInBrowser(URL, { platform: "linux", env: { DISPLAY: ":0" }, spawnImpl }), false);
  const throwing = () => {
    throw new Error("spawn blew up");
  };
  assert.equal(await openInBrowser(URL, { platform: "darwin", env: {}, spawnImpl: throwing }), false);
  assert.equal(await openInBrowser(URL, { platform: "linux", env: {}, spawnImpl: throwing }), false);
});
