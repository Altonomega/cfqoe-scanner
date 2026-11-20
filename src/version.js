import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The application version has exactly one source: package.json. Every
// surface that displays or records the version (terminal banner, scan
// reports, the run.start log record) reads VERSION from here, so a
// release bump stays a one-line edit and the copies can never drift
// apart again — the failure mode this replaces was four hand-maintained
// literals, one of them a bare string inside writeReport in the same
// file that already defined the constant it bypassed.
const here = path.dirname(fileURLToPath(import.meta.url));

function readPackageVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(here, "..", "package.json"), "utf8"),
    );
    return "string" == typeof pkg.version && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

// The fallback exists only so a damaged install still starts and can
// say something honest in its banner and reports; release builds always
// resolve the real version through package.json.
export const VERSION = readPackageVersion() ?? "0.0.0-dev";
