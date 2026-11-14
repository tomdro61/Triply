// Turns Playwright's JSON report into a short text summary for the job page.
// Every red is labelled: APP (our code), UPSTREAM (staging ResLab or Stripe,
// or the test lot sold out) or CONFIG (the job could not test at all). A test
// that only passed on its retry is reported, not hidden.
//
// Text only: no request data, no headers. Exits 1 if the guard recorded a
// violation, or if any required test did not run and pass (skipped counts as
// not run), whatever Playwright's own exit code was.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const lines = [];
const passedTitles = new Set();
let failed = false;

const violations = existsSync("guard-violations.txt") ? readFileSync("guard-violations.txt", "utf8").trim() : "";
if (violations) {
  failed = true;
  lines.push("**[APP] GUARD VIOLATION: the page tried something the smoke test must never do.**", "", "```", violations, "```", "");
}

if (!existsSync("smoke-report.json")) {
  failed = true;
  lines.push("No test report: the run stopped before the tests (the failing step above says why).");
} else {
  const report = JSON.parse(readFileSync("smoke-report.json", "utf8"));
  for (const error of report.errors ?? []) {
    failed = true;
    lines.push(`- ERROR outside a test: ${String(error.message ?? "").split("\n")[0].slice(0, 300)}`);
  }
  const specs = [];
  const walk = (suite) => {
    specs.push(...(suite.specs ?? []));
    (suite.suites ?? []).forEach(walk);
  };
  (report.suites ?? []).forEach(walk);

  for (const spec of specs) {
    for (const test of spec.tests ?? []) {
      const results = test.results ?? [];
      const last = results[results.length - 1];
      // Each failed attempt is labelled by its own first error (no label =
      // APP). The line shows the worst label of any attempt, so an UPSTREAM
      // first attempt cannot hide an APP failure on the retry.
      const failedAttempts = results
        .filter((r) => r.status !== "passed" && r.status !== "skipped")
        .map((r) => String(r.errors?.[0]?.message ?? ""));
      const kinds = failedAttempts.map((message) => /\[(UPSTREAM|CONFIG|APP)\]/.exec(message)?.[1] ?? "APP");
      const kind = ["APP", "CONFIG", "UPSTREAM"].find((k) => kinds.includes(k)) ?? "APP";
      // The latest failure's first line, colour codes removed.
      const reason = (failedAttempts[failedAttempts.length - 1] ?? "")
        .replace(/\u001b\[[0-9;]*m/g, "")
        .split("\n")[0]
        .slice(0, 300);
      // "Ran and passed" means the last attempt really passed: a skipped test,
      // or one marked as an expected failure, has tested nothing.
      const ranAndPassed = last?.status === "passed" && (test.status === "expected" || test.status === "flaky");
      // Passing on a retry is only accepted when every failed attempt was an
      // upstream one. An APP failure that comes and goes is still a failure.
      const acceptable = ranAndPassed && (test.status === "expected" || kind === "UPSTREAM");
      if (acceptable) passedTitles.add(spec.title);
      // Any test in the file, not only the required ones below.
      else failed = true;
      if (ranAndPassed && test.status === "expected") lines.push(`- PASS: ${spec.title}`);
      else if (acceptable) lines.push(`- PASSED ON RETRY (UPSTREAM): ${spec.title}: ${reason}`);
      else if (ranAndPassed) lines.push(`- FAIL (${kind}, passed only on retry): ${spec.title}: ${reason}`);
      else if (last?.status === "interrupted") lines.push(`- INTERRUPTED (CONFIG): ${spec.title}`);
      else if (test.status === "skipped" || last?.status === "skipped") lines.push(`- SKIPPED (CONFIG): ${spec.title}`);
      else lines.push(`- FAIL (${kind}, last attempt ${last?.status ?? "unknown"}): ${spec.title}: ${reason}`);
    }
  }
}

// Green means all of these ran and passed. Renaming one here and in the spec
// is fine; a run where one is missing or skipped is red.
const REQUIRED = [
  "the preview is reachable with this job's credential and serves a static page",
  "checkout refuses a link with no times, before asking the server",
  "checkout reaches the payment form and the amount agrees three ways",
];
for (const title of REQUIRED) {
  if (!passedTitles.has(title)) {
    failed = true;
    lines.push(`- NOT PROVEN: "${title}" did not run and pass`);
  }
}

const text = ["### Checkout smoke test", "", ...lines, ""].join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
process.exit(failed ? 1 : 0);
