// Finds the Vercel PREVIEW deployment for one commit and prints its URL.
//
// Usage (CI): node find-preview.mjs   with GITHUB_TOKEN, GITHUB_REPOSITORY, HEAD_SHA set.
// Writes `url=<https url>` to $GITHUB_OUTPUT. Exits 1 with a labelled reason
// when there is nothing to test, so the job is red, never a silent pass.
//
// The deployment is chosen by what Vercel told GitHub about it: created by
// Vercel's app, for exactly this commit, in the "Preview" environment. Never
// by guessing a hostname: production deployments also have *.vercel.app URLs.
import { appendFileSync } from "node:fs";

const { GITHUB_TOKEN, GITHUB_REPOSITORY, HEAD_SHA, GITHUB_OUTPUT } = process.env;
const WAIT_MINUTES = 20;
const POLL_SECONDS = 15;

function stop(kind, message) {
  console.error(`::error title=checkout-smoke ${kind}::[${kind}] ${message}`);
  process.exit(1);
}

if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !/^[0-9a-f]{40}$/.test(HEAD_SHA ?? "")) {
  stop("CONFIG", "find-preview needs GITHUB_TOKEN, GITHUB_REPOSITORY and a full HEAD_SHA");
}

async function github(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) stop("CONFIG", `GitHub API ${path.split("?")[0]} returned HTTP ${response.status} (the job needs \`deployments: read\`)`);
  return response.json();
}

const deadline = Date.now() + WAIT_MINUTES * 60_000;
let lastSeen = "no deployment record yet";

while (Date.now() < deadline) {
  const deployments = await github(`/repos/${GITHUB_REPOSITORY}/deployments?sha=${HEAD_SHA}&per_page=30`);
  const previews = deployments.filter(
    (d) => d.creator?.login === "vercel[bot]" && d.environment === "Preview" && d.sha === HEAD_SHA
  );

  if (previews.length > 1) stop("CONFIG", `${previews.length} Preview deployments for this commit; expected one`);
  if (previews.length === 1) {
    const statuses = await github(`/repos/${GITHUB_REPOSITORY}/deployments/${previews[0].id}/statuses?per_page=10`);
    const latest = statuses[0]; // newest first
    lastSeen = latest ? `deployment is "${latest.state}"` : "deployment has no status yet";

    if (latest?.state === "success") {
      const url = new URL(latest.environment_url || latest.target_url);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".vercel.app")) {
        stop("CONFIG", "the Preview deployment's URL is not an https *.vercel.app address");
      }
      console.log(`Preview for ${HEAD_SHA.slice(0, 7)}: ${url.origin}`);
      if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `url=${url.origin}\n`);
      process.exit(0);
    }
    if (latest?.state === "failure" || latest?.state === "error") {
      stop("APP", "the preview build failed on Vercel (the `app` check usually shows why)");
    }
    if (latest?.state === "inactive") {
      stop("CONFIG", "this commit's preview was superseded by a newer deployment; push again or re-run");
    }
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
}

stop("CONFIG", `no ready Preview deployment for this commit after ${WAIT_MINUTES} minutes (${lastSeen})`);
