// Runs from the npm `prepare` script: points this clone's git at .githooks/.
// It must never fail an install, so every problem is swallowed and CI and
// Vercel builds are skipped. `core.hooksPath` lives in the shared git config,
// so one install covers every worktree of the clone.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

try {
  if (!process.env.CI && !process.env.VERCEL) {
    const here = process.cwd();
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Only when this package IS the repo root (not a dependency, not a subfolder).
    if (resolve(top).toLowerCase() === resolve(here).toLowerCase()) {
      execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: here, stdio: "ignore" });
    }
  }
} catch {
  // Not a git checkout, or git is missing: nothing to install.
}
