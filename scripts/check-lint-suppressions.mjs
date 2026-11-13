// Ratchet for eslint-suppressions.json (the list of known, pre-existing ESLint
// errors). Lint passes when nothing NEW appears; this script closes the other
// door: re-recording a new error as "known". It fails when the total count for
// any rule is higher than on the base branch.
//
// Totals are per rule, not per file, so moving or renaming a file is fine.
// Fixed an old error? Run `npx eslint --prune-suppressions` and commit the file.
//
// Usage: node scripts/check-lint-suppressions.mjs [base-ref]   (default origin/main)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FILE = "eslint-suppressions.json";
const baseRef = process.argv[2] || "origin/main";

function totals(json) {
  const out = {};
  for (const rules of Object.values(JSON.parse(json))) {
    for (const [rule, { count }] of Object.entries(rules)) {
      out[rule] = (out[rule] || 0) + count;
    }
  }
  return out;
}

let baseJson;
try {
  execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], { stdio: "ignore" });
} catch {
  console.error(`Base ref ${baseRef} not found. Fetch it first (git fetch origin main).`);
  process.exit(2);
}
try {
  baseJson = execFileSync("git", ["show", `${baseRef}:${FILE}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
} catch {
  console.log(`${FILE} is not on ${baseRef} yet: nothing to compare.`);
  process.exit(0);
}

const base = totals(baseJson);
const head = totals(readFileSync(FILE, "utf8"));
const raised = Object.keys(head).filter((rule) => head[rule] > (base[rule] || 0));

if (raised.length) {
  console.error(`Known-error counts went up versus ${baseRef}:`);
  for (const rule of raised) console.error(`  ${rule}: ${base[rule] || 0} -> ${head[rule]}`);
  console.error("Fix the new errors instead of adding them to eslint-suppressions.json.");
  process.exit(1);
}
const sum = (t) => Object.values(t).reduce((a, b) => a + b, 0);
console.log(`Known ESLint errors: ${sum(head)} (base ${sum(base)}). No rule went up.`);
