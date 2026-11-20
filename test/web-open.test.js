// Browser-open command builder (plan ch. 3.6, Shield R-16): the URL
// is handed to the platform handler as a single argv element via an
// execFile-style spawn — never through a shell — and a missing or
// failing handler resolves false so the caller falls back to the
// printed URL. Every platform row is pinned here.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildOpenAttempts, openInBrowser } from "../src/web/open.js";

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

test("android/Termux: termux-open-url then the generic intent", () => {
  assert.deepEqual(buildOpenAttempts("android", URL, {}), [
    { file: "termux-open-url", args: [URL] },
    { file: "am", args: ["start", "-a", "android.intent.action.VIEW", "-d", URL] },
  ]);
});

test("unknown platforms get no attempts", () => {
  assert.deepEqual(buildOpenAttempts("freebsd", URL, {}), []);
});

function fakeSpawn(plan) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.unref = () => {
      child.unrefCalled = true;
    };
    const behavior = plan[calls.length - 1] ?? "spawn";
    queueMicrotask(() => child.emit(behavior));
    return child;
  };
  return { calls, spawnImpl };
}

test("openInBrowser resolves true on spawn, detached with stdio ignored, and unrefs", async () => {
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
    ["termux-open-url", "am"],
  );
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
