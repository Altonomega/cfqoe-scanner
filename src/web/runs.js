// Web run manager: owns the one run the web layer may have in
// flight, and drives it through exactly the terminal menu's flow
// (plan ch. 3.4) — bootstrap logger before settings load, profile
// transform for Quick/Research, run.start/run.end lifecycle records,
// logger closed in a finally. The only additions are the cancel
// token (the stop button) and the state store's observers.
//
// A run started here is invisible to a terminal menu running in
// another process and vice versa: the two surfaces share files, not
// memory, and no cross-surface registry exists. The 409 below is
// therefore exact for web-started runs — the honest scope of the
// control this layer can offer.
import fs from "node:fs";
import { createLogger } from "../logging/logger.js";
import { emitRunStart, emitRunEnd } from "../logging/lifecycle.js";
import { loadSettings } from "../config/settings.js";
import { readSecretFile } from "../platform/paths.js";
import { locateXray } from "../platform/xray.js";
import { runScan } from "../scan.js";
import { runHardScan, hasHardScanState, readHardCheckpointRunId } from "../hard-scan.js";
import { quickProfile, researchProfile } from "../menu/index.js";

export const RUN_MODES = ["quick", "full", "research", "hard"];

function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export function createRunManager({ layout, state, webLog }) {
  let active = null;

  // A refused control action is a material event in the run's story
  // (Signal log audit, 0.9.1): before this, a rejected start or stop
  // answered the client and left no trace in any log, so "the user
  // pressed Start and nothing happened" was unreconstructible after
  // the fact. One event name for every refusal the control plane
  // issues: web.control.reject { action, reason, mode? } — the reason
  // is the same code the client received.
  function logReject(action, reason, extra = {}) {
    webLog?.warn("web.control.reject", { action, reason, ...extra });
  }

  function laneFor(row) {
    if (!row || typeof row.range !== "string") return undefined;
    try {
      const plan = state.tracker.ensurePlan();
      const index = plan.ranges.findIndex((range) => range.cidr === row.range);
      return index >= 0 ? index + 1 : undefined;
    } catch {
      return undefined;
    }
  }

  async function start({ mode, resume = false }) {
    if (!RUN_MODES.includes(mode)) {
      logReject("run-start", "bad_mode", { mode: typeof mode === "string" ? mode : null });
      throw codedError("bad_mode", "Unknown scan mode.");
    }
    if (active) {
      logReject("run-start", "run_active", { mode });
      throw codedError("run_active", "A scan is already running.", { runId: active.runId });
    }
    if (!fs.existsSync(layout.secretFile)) {
      logReject("run-start", "config_missing", { mode });
      throw codedError("config_missing", "Import your VLESS configuration first.");
    }
    if (mode === "hard" && resume && !hasHardScanState(layout)) {
      logReject("run-start", "no_resume", { mode });
      throw codedError("no_resume", "No paused hard scan was found.");
    }

    // A resumed Hard run adopts its checkpoint's runId: the engine
    // files the report under the checkpoint's id (its state carries
    // it), so a fresh logger id would split one run into two
    // identities — the terminal snapshot naming an id no report
    // answers to, and the resumed run's records landing in a second
    // log file. Adopting it keeps the log records, the terminal
    // state and the report on the run's one id.
    const adoptedRunId =
      mode === "hard" && resume ? readHardCheckpointRunId(layout) : null;
    // Bootstrap logger before settings load, exactly like the menu:
    // a settings failure is then on record in the run's own log.
    const logger = createLogger({
      level: "info",
      directory: layout.logs,
      ...(adoptedRunId ? { runId: adoptedRunId } : {}),
    });
    let settings;
    try {
      settings = loadSettings(layout.settingsFile, { logger });
    } catch (error) {
      await logger.close();
      webLog?.error("web.control.scan-start", {
        mode,
        error: { class: "settings", message: error.message },
      });
      throw codedError("settings_invalid", "The saved settings could not be loaded.");
    }
    logger.setLevel(settings.logging.level);

    const controller = new AbortController();
    const runId = logger.runId;
    const startedAt = Date.now();
    const entry = { mode, runId, controller, logger, startedAt, promise: null };
    active = entry;
    state.attachLogger(logger);
    state.beginRun({ mode, runId, settings });
    logger.info("web.control.scan-start", { mode, runId, resume: Boolean(resume) });
    emitRunStart(logger, { mode, resume: mode === "hard" ? Boolean(resume) : false });

    const vlessUri = readSecretFile(layout.secretFile);
    const onProgress = (event) =>
      state.onProgress({ ...event, elapsedMs: Date.now() - startedAt });
    const promise = (async () => {
      try {
        let result;
        if (mode === "hard") {
          result = await runHardScan({
            vlessUri,
            settings,
            layout,
            logger,
            runId,
            resume: Boolean(resume),
            signal: controller.signal,
            onProgress,
            onSummary: (summary, observations) => state.onSummary(summary, observations),
          });
        } else {
          const profile =
            mode === "quick"
              ? quickProfile(settings)
              : mode === "research"
                ? researchProfile(settings)
                : settings;
          result = await runScan({
            vlessUri,
            settings: profile,
            layout,
            logger,
            runId,
            mode,
            onProgress,
            signal: controller.signal,
          });
        }
        const status = result.canceled ? "canceled" : "completed";
        emitRunEnd(logger, {
          status,
          startedAt,
          totals: {
            eligible: result.eligibleCount,
            ...(mode === "hard"
              ? { stoppedReason: result.stoppedReason ?? null }
              : { candidates: result.candidateCount }),
          },
        });
        // The engines produce final rows only at the end (no mid-run
        // row stream exists to forward), so the ledger fills here, in
        // the report's own ranked order.
        for (const row of result.report?.results ?? []) {
          state.emitCandidate(row, laneFor(row));
        }
        state.ticker(
          result.canceled
            ? "Run stopped — progress is saved."
            : `Run complete — ${result.eligibleCount} eligible IPs.`,
        );
        state.finishRun({
          // The client's run-state vocabulary has no "paused" for
          // scan modes: a stopped Hard run is resumable, a stopped
          // scan run is simply canceled.
          status: result.canceled ? (mode === "hard" ? "paused-done" : "canceled") : "complete",
          mode,
          runId,
          report: result.report,
        });
        return result;
      } catch (error) {
        emitRunEnd(logger, {
          status: "failed",
          startedAt,
          error: { class: "internal", message: error.message },
        });
        // The run-state vocabulary includes "failed" (W5, Proof's
        // F-2): a crashed run must not masquerade as a user stop.
        // The client shows its failure notice on this status, and
        // the failure itself is on record in run.end and the log.
        state.ticker("Run failed — see Diagnostics for the log.");
        state.finishRun({ status: "failed", mode, runId, report: null, error: error.message });
        throw error;
      } finally {
        await logger.close();
        state.detachLogger();
        if (active === entry) active = null;
      }
    })();
    entry.promise = promise;
    // The manager owns the run's outcome; HTTP handlers never await
    // it, so its rejection must never surface as unhandled.
    promise.catch(() => {});
    return { runId };
  }

  function stop() {
    if (!active) {
      logReject("run-stop", "no_active_run");
      throw codedError("no_active_run", "No scan is running.");
    }
    active.logger.info("web.control.scan-stop", { mode: active.mode, runId: active.runId });
    active.controller.abort();
    return { ok: true };
  }

  return {
    start,
    stop,
    isActive: () => active !== null,
    activeRunId: () => active?.runId ?? null,
    // Snapshot status facts, read fresh from the same sources the
    // terminal's system check reads (CONTRACT §1).
    statusFacts() {
      let settings = null;
      try {
        settings = loadSettings(layout.settingsFile);
      } catch {
        settings = null;
      }
      return {
        configReady: fs.existsSync(layout.secretFile),
        xrayFound: settings ? Boolean(locateXray(settings, layout).found) : false,
        verifyEnabled: settings ? Boolean(settings.verification?.enabled) : false,
        resumeAvailable: hasHardScanState(layout),
      };
    },
  };
}
