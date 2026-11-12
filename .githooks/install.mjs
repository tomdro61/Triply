// Runs from the npm `prepare` script: points this clone's git at .githooks/.
// It must never fail an install, so every problem is swallowed, and CI and
// Vercel builds are skipped. It prints one line saying what it did.
//
// `core.hooksPath` lives in the clone's shared git config, so every worktree
// reads it, but a worktree only HAS a hook once its branch contains
// .githooks/ (a branch cut before the hooks runs none until main is merged in).

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const WANT = ".githooks";
const say = (msg) => console.log(`[githooks] ${msg}`);
const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const same = (a, b) => realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();

try {
  if (process.env.CI || process.env.VERCEL) {
    say("skipped (CI or Vercel build).");
  } else if (!same(git(["rev-parse", "--show-toplevel"]), process.cwd())) {
    say("skipped (this folder is not the root of a git checkout).");
  } else {
    let current = "";
    try {
      current = git(["config", "--get", "core.hooksPath"]);
    } catch {
      // not set
    }
    if (current === WANT) {
      say("pre-commit hook already installed.");
    } else if (current) {
      // Someone's own hooks (a secret scanner, husky): never replace them silently.
      say(
        `NOT installed: core.hooksPath is already "${current}". To use this repo's hook instead ` +
          `(your current hooks then stop running in this repo): git config core.hooksPath ${WANT}`,
      );
    } else {
      git(["config", "core.hooksPath", WANT]);
      say("pre-commit hook installed (core.hooksPath = .githooks).");
    }
  }
} catch {
  say("skipped (not a git checkout, or git is not available).");
}
