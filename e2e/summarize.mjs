// Turns Playwright's JSON report into a short text summary for the job page.
// Every red is labelled: APP (our code), UPSTREAM (staging ResLab or Stripe,
// or the test lot sold out) or CONFIG (the job could not test at all). A test
// that only passed on its retry is reported, not hidden.
//
// Text only: no request data, no headers. Exits 1 if the guard recorded a
// violation, whatever the tests say.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const lines = [];
let failed = false;

const violations = existsSync("guard-violations.txt") ? readFileSync("guard-violations.txt", "utf8").trim() : "";
if (violations) {
  failed = true;
  lines.push("**[APP] GUARD VIOLATION: the page tried something the smoke test must never do.**", "", "```", violations, "```", "");
}

if (!existsSync("smoke-report.json")) {
  lines.push("No test report: the run stopped before the tests (see the earlier steps).");
} else {
  const report = JSON.parse(readFileSync("smoke-report.json", "utf8"));
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
      const firstError = results.flatMap((r) => r.errors ?? []).map((e) => String(e.message ?? ""))[0] ?? "";
      // First line only, colour codes removed.
      const reason = firstError.replace(/\u001b\[[0-9;]*m/g, "").split("\n")[0].slice(0, 300);
      const kind = /\[(UPSTREAM|CONFIG|APP)\]/.exec(firstError)?.[1] ?? "APP";
      if (test.status === "expected") lines.push(`- PASS: ${spec.title}`);
      else if (test.status === "flaky") lines.push(`- PASSED ON RETRY (${kind}): ${spec.title}: ${reason}`);
      else if (test.status === "skipped") lines.push(`- SKIPPED: ${spec.title}`);
      else lines.push(`- FAIL (${kind}, last attempt ${last?.status ?? "unknown"}): ${spec.title}: ${reason}`);
    }
  }
}

const text = ["### Checkout smoke test", "", ...lines, ""].join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
process.exit(failed ? 1 : 0);
