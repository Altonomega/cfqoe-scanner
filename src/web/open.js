// Browser-open command construction (plan ch. 3.6, Shield R-16).
//
// The opener is the one place the web layer spawns anything, and it
// spawns exactly one thing: the platform's URL handler, with the URL
// as a single argv element (execFile-style — never a shell string,
// so nothing in the URL can be reinterpreted). The URL itself is
// built by the server from its own parts (literal loopback host, the
// port it actually bound, the in-memory token); nothing from a
// request reaches this module.
//
// buildOpenAttempts is pure so every platform row of the plan's
// table is unit-testable from any host; openInBrowser walks the
// attempts in order and resolves false when every handler is missing
// or the platform is headless — the caller then relies on the
// printed URL, which is always shown regardless (R-16: a failed
// opener never fails the app).
import { spawn } from "node:child_process";

export function buildOpenAttempts(platform, url, env = process.env) {
  switch (platform) {
    case "win32":
      // rundll32 with the FileProtocolHandler entry point: the stock
      // Windows way to hand a URL to the default browser without a
      // shell (cmd's `start` would parse & and ^ in the URL).
      return [{ file: "rundll32", args: ["url.dll,FileProtocolHandler", url] }];
    case "darwin":
      return [{ file: "open", args: [url] }];
    case "android":
      // Termux: three genuinely different dispatches. The old list
      // was one mechanism twice — termux-open-url is itself a thin
      // `am start` wrapper, so a handler chain that mangled its
      // delivery mangled the fallback identically (the 0.9.5
      // auto-open defect: the browser arrived without the session
      // key). termux-open reaches the browser through the Termux
      // app's own broadcast receiver instead, and the raw intent is
      // shaped like a real link tap (BROWSABLE category, NEW_TASK —
      // the documented requirement for startActivity from a
      // non-Activity context), with the same explicit user the
      // Termux script passes.
      return [
        { file: "termux-open-url", args: [url] },
        { file: "termux-open", args: ["--view", url] },
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
            url,
          ],
        },
      ];
    case "linux": {
      // No display server means no browser to open: stay silent and
      // let the printed URL do the work (SSH/headless case).
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return [];
      return [
        { file: "xdg-open", args: [url] },
        { file: "gio", args: ["open", url] },
      ];
    }
    default:
      return [];
  }
}

// Try each attempt detached with stdio ignored and unref'd, so the
// browser's lifetime is fully decoupled from the scanner process
// (closing the browser cannot perturb a run, and the scanner never
// waits on the browser). Resolves true when a handler accepted the
// URL, false when none did — never rejects.
//
// "Accepted" is judged inside a short settle window, because a
// spawn alone is not a delivery: a handler can spawn and fail
// immediately (an `am` erroring under its wrapper script, whose
// output is /dev/null'd — the spawn looked like success and the
// fallback never ran). A child that exits non-zero before the
// window closes counts as a failed attempt and the walk falls
// through; an exit 0, or a child still running when the window
// closes, keeps the accepted semantics — most handlers daemonize
// or linger, so a later exit says nothing about delivery.
export function openInBrowser(url, { platform = process.platform, env = process.env, spawnImpl = spawn } = {}) {
  const attempts = buildOpenAttempts(platform, url, env);
  return new Promise((resolve) => {
    let index = 0;
    const tryNext = () => {
      if (index >= attempts.length) {
        resolve(false);
        return;
      }
      const attempt = attempts[index];
      index += 1;
      let child;
      try {
        child = spawnImpl(attempt.file, attempt.args, { detached: true, stdio: "ignore" });
      } catch {
        tryNext();
        return;
      }
      if (!child || typeof child.on !== "function") {
        resolve(true);
        return;
      }
      let settled = false;
      const settle = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) {
          try {
            child.unref();
          } catch {
            // A handler that cannot unref still launched; ignore.
          }
          resolve(true);
        } else {
          tryNext();
        }
      };
      child.on("error", () => settle(false));
      child.on("exit", (code) => settle(code === 0));
      // The spawn event alone settles nothing (see the header
      // comment): the window below decides for a child that is
      // still running, and covers minimal handlers that never emit
      // any event under a fake or exotic spawn — do not hang the
      // caller on them.
      const timer = setTimeout(() => settle(true), 300);
      if (typeof timer.unref === "function") timer.unref();
    };
    tryNext();
  });
}
