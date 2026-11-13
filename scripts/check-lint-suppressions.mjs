// Ratchet for eslint-suppressions.json (the list of known, pre-existing ESLint
// errors). Lint passes when nothing NEW appears; this script closes the other
// door: re-recording a new error as "known". It fails when
//   - a file's count for a rule is higher than on the base commit
//     (a renamed file inherits the allowance of its old path), or
//   - an entry names a file that no longer exists, or
//   - an entry has no valid count.
//
// Fixed an old error? Run `npx eslint --prune-suppressions` and commit the file.
// Never run `--suppress-all` or `--suppress-rule`: they record new errors as known.
//
// Usage: node scripts/check-lint-suppressions.mjs [base-ref]   (default origin/main)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const FILE = "eslint-suppressions.json";
const baseRef = process.argv[2] || "origin/main";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

function fail(code, lines) {
  for (const line of lines) console.error(line);
  process.exit(code);
}

function load(json, label) {
  const data = JSON.parse(json);
  const bad = [];
  for (const [file, rules] of Object.entries(data)) {
    for (const [rule, entry] of Object.entries(rules ?? {})) {
      if (!Number.isInteger(entry?.count) || entry.count < 1) bad.push(`  ${file} ${rule}`);
    }
  }
  if (bad.length) fail(1, [`${label}: entries without a valid count:`, ...bad]);
  return data;
}

try {
  git("rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`);
} catch {
  fail(2, [`Base ref ${baseRef} not found. Fetch it first (git fetch origin main).`]);
}

const head = load(readFileSync(FILE, "utf8"), FILE);

const missing = Object.keys(head).filter((file) => !existsSync(file));
if (missing.length) {
  fail(1, [
    "Entries for files that no longer exist:",
    ...missing.map((f) => `  ${f}`),
    "Run `npx eslint --prune-suppressions` and commit the file.",
  ]);
}

// Any git error here throws and fails the run; an empty listing means the file
// is not on the base commit (only true for the PR that introduces it).
if (!git("ls-tree", "--name-only", baseRef, "--", FILE).trim()) {
  console.log(`${FILE} is not on ${baseRef} yet: nothing to compare.`);
  process.exit(0);
}
const base = load(git("show", `${baseRef}:${FILE}`), `${baseRef}:${FILE}`);

// new path -> old path, for files renamed since the base commit.
const renamedFrom = {};
for (const line of git("diff", "-M", "--name-status", baseRef).split("\n")) {
  const [status, from, to] = line.split("\t");
  if (status?.startsWith("R")) renamedFrom[to] = from;
}

const raised = [];
let headTotal = 0;
for (const [file, rules] of Object.entries(head)) {
  const baseRules = base[file] ?? base[renamedFrom[file]] ?? {};
  for (const [rule, { count }] of Object.entries(rules)) {
    headTotal += count;
    const allowed = baseRules[rule]?.count ?? 0;
    if (count > allowed) raised.push(`  ${file}  ${rule}: ${allowed} -> ${count}`);
  }
}

if (raised.length) {
  fail(1, [
    `Known-error counts went up versus ${baseRef}:`,
    ...raised,
    "Fix the new errors instead of adding them to eslint-suppressions.json.",
  ]);
}
console.log(`Known ESLint errors: ${headTotal}. No file's count went up versus ${baseRef}.`);
