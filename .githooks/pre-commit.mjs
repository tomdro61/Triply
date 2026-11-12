// The pre-commit gate for commits made by Claude Code (docs: CLAUDE.md "Hooks").
//
// Runs from `.githooks/pre-commit`, which exits early unless CLAUDECODE=1, so
// a commit typed by a person is never slowed down. It:
//   1. refuses a commit on main or staging;
//   2. runs the checks the STAGED files can break (the same ones CI runs);
//   3. prints which review the staged paths call for.
//
// The checks run against the working tree, not the exact staged content, so
// unrelated half-done work can fail a good commit. CI tests the exact commit.
// The way past a stuck gate is `git commit --no-verify`, which the Claude
// guard hook (.claude/hooks/guard.mjs) turns into a prompt for a person.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classify, reviewReminder, tail } from "./lib.mjs";

const CHECK_TIMEOUT_MS = 240_000;

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}

const say = (msg) => process.stderr.write(`${msg}\n`);

function fail(msg) {
  say(`\n[pre-commit] BLOCKED: ${msg}`);
  say(
    "[pre-commit] Fix it and commit again. If the failure is not caused by this commit, " +
      "`git commit --no-verify` asks a person to approve skipping the gate.\n",
  );
  process.exit(1);
}

const root = git(["rev-parse", "--show-toplevel"], process.cwd()).trim();
if (!root) process.exit(0);

// 1. Never commit task work to main or staging.
const branch = git(["symbolic-ref", "--short", "-q", "HEAD"], root).trim();
if (branch === "main" || branch === "staging") {
  fail(`this commit is on \`${branch}\`. Cut a branch first: git checkout -b feat/<name>`);
}

// 2. What is staged decides what runs. (`git commit -a` has already staged
// its files by the time git calls this hook.)
const staged = git(["diff", "--cached", "--name-only", "-z"], root).split("\0").filter(Boolean);
const need = classify(staged);

// Child processes get a clean environment: git exports GIT_INDEX_FILE and
// friends to hooks, which would confuse any tool that calls git itself.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

/** Runs one check with Node directly (no shell, no npx: neither spawns cleanly on Windows). */
function run(label, cwd, script, args, env = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...baseEnv, ...env },
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const secs = Math.round((Date.now() - started) / 1000);
  if (r.status === 0) {
    say(`[pre-commit] ${label}: ok (${secs}s)`);
    return;
  }
  const why = r.error?.code === "ETIMEDOUT" ? `timed out after ${secs}s` : `failed (${secs}s)`;
  fail(`${label} ${why}.\n\n${tail(`${r.stdout ?? ""}\n${r.stderr ?? ""}`)}`);
}

const before = git(["status", "--porcelain"], root);

if (need.hooks) {
  const tests = [".githooks", ".claude/hooks"].flatMap((dir) =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir))
          .filter((f) => f.endsWith(".test.mjs"))
          .map((f) => join(root, dir, f))
      : [],
  );
  if (tests.length) run("hook tests", root, "--test", tests);
}

if (need.app) {
  const next = join(root, "node_modules/next/dist/bin/next");
  const tsc = join(root, "node_modules/typescript/bin/tsc");
  const vitest = join(root, "node_modules/vitest/vitest.mjs");
  if (![next, tsc, vitest].every(existsSync)) {
    say("[pre-commit] NOTICE: app checks SKIPPED (no node_modules in this checkout). CI is the only gate for this commit.");
  } else {
    // Same checks as CI's `app` job, minus the build. tsc keeps its own
    // incremental cache (a warm run is ~8 s; `npm run typecheck` is ~60 s).
    run("typegen", root, next, ["typegen"]);
    run("typecheck", root, tsc, [
      "--noEmit",
      "-p",
      ".",
      "--incremental",
      "--tsBuildInfoFile",
      "node_modules/.cache/claude-hook/tsconfig.tsbuildinfo",
    ]);
    // CI=1: a missing snapshot fails instead of being written into the tree.
    run("tests", root, vitest, ["run", "--reporter=dot"], { CI: "1" });
  }
}

if (need.blogEngine) {
  const dir = join(root, "scripts/blog-engine");
  const tsc = join(dir, "node_modules/typescript/bin/tsc");
  const tsx = join(dir, "node_modules/tsx/dist/cli.mjs");
  if (![tsc, tsx].every(existsSync)) {
    say("[pre-commit] NOTICE: blog-engine checks SKIPPED (no node_modules in scripts/blog-engine). CI is the only gate for this commit.");
  } else {
    const tests = readdirSync(join(dir, "src"))
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `src/${f}`);
    run("blog-engine typecheck", dir, tsc, ["--noEmit", "-p", "."]);
    // Dummies, as in CI. The engine loads its own .env (real keys, maybe the
    // production CMS URL) without overriding what is already set, so these win.
    if (tests.length) {
      run("blog-engine tests", dir, tsx, ["--test", ...tests], {
        ANTHROPIC_API_KEY: "hook_dummy",
        PAYLOAD_API_KEY: "hook_dummy",
        PAYLOAD_CMS_URL: "http://cms.invalid",
      });
    }
  }
}

// A check must not change the tree: a later `git add -A` would sweep it in.
if (git(["status", "--porcelain"], root) !== before) {
  say("[pre-commit] NOTICE: the checks changed files in the working tree. Run `git status` before the next `git add`.");
}

// 3. Review reminder (advice only).
const reminder = reviewReminder(staged);
if (reminder) say(`\n${reminder}\n`);
