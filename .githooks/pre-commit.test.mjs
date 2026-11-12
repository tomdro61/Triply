// End-to-end: real commits in a throwaway repo, through the real sh shim.
// The hook fails open without a sound if its wiring breaks (a bug that skips
// the checks looks just like a docs-only commit), so the wiring is tested.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repos = [];
after(() => repos.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// A hook started by git inherits GIT_* variables; drop them so `git` below
// talks to the throwaway repo (this file also runs inside the real hook).
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "triply-hook-"));
  repos.push(dir);
  const git = (args, env = {}) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...cleanEnv, CLAUDECODE: "1", ...env } });
  const write = (file, text) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  // Must succeed: without a repo here, the git calls below would climb out
  // of the temp folder into whatever repo encloses it.
  assert.equal(git(["init", "-q", "-b", "main"]).status, 0, "git init failed");
  git(["config", "user.email", "hook-test@example.invalid"]);
  git(["config", "user.name", "Hook Test"]);
  git(["config", "core.hooksPath", ".githooks"]);
  mkdirSync(join(dir, ".githooks"));
  // Not this test file: a commit here would run it again, without end.
  for (const f of ["pre-commit", "pre-commit.mjs", "lib.mjs"]) copyFileSync(join(here, f), join(dir, ".githooks", f));
  chmodSync(join(dir, ".githooks", "pre-commit"), 0o755);
  return { dir, git, write };
}

test("a commit on main is refused; the same commit by a person is not", () => {
  const { git, write } = makeRepo();
  write("README.md", "hello\n");
  git(["add", "README.md"]);

  const blocked = git(["commit", "-q", "-m", "docs: x"]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /BLOCKED: this commit is on `main`/);

  const person = git(["commit", "-q", "-m", "docs: x"], { CLAUDECODE: "" });
  assert.equal(person.status, 0, person.stderr);
});

test("on a branch: docs commit passes, a failing hook test blocks, a passing one commits", () => {
  const { git, write } = makeRepo();
  git(["checkout", "-q", "-b", "feat/x"]);

  write("README.md", "hello\n");
  git(["add", "README.md"]);
  const docs = git(["commit", "-q", "-m", "docs: x"]);
  assert.equal(docs.status, 0, docs.stderr);
  assert.doesNotMatch(docs.stderr, /hook tests/);

  write(".githooks/probe.test.mjs", 'import { test } from "node:test";\ntest("no", () => { throw new Error("boom"); });\n');
  git(["add", ".githooks/probe.test.mjs"]);
  const failing = git(["commit", "-q", "-m", "test: failing"]);
  assert.notEqual(failing.status, 0);
  assert.match(failing.stderr, /BLOCKED: hook tests failed \(exit 1/);

  write(".githooks/probe.test.mjs", 'import { test } from "node:test";\ntest("yes", () => {});\n');
  git(["add", ".githooks/probe.test.mjs"]);
  const passing = git(["commit", "-q", "-m", "test: passing"]);
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stderr, /hook tests: ok/);
  assert.match(passing.stderr, /FULL SWEEP/);
});

test("a file moved out of src still counts as an app change", () => {
  const { git, write } = makeRepo();
  git(["checkout", "-q", "-b", "feat/x"]);
  write("src/lib/helper.ts", "export const a = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "feat: helper"], { CLAUDECODE: "" });

  git(["mv", "src/lib/helper.ts", "archive-helper.txt"]);
  const moved = git(["commit", "-q", "-m", "chore: move"]);
  // No node_modules here, so the app checks announce themselves by skipping.
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stderr, /app checks SKIPPED/);
});
