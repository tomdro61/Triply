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

  if (previews.length > 0) {
    // More than one when the commit was redeployed: the list is newest first.
    // Only statuses Vercel itself posted count: anyone who can write
    // deployments could otherwise point this job (and its token) elsewhere.
    const statuses = (
      await github(`/repos/${GITHUB_REPOSITORY}/deployments/${previews[0].id}/statuses?per_page=30`)
    ).filter((status) => status.creator?.login === "vercel[bot]");
    // A later "inactive" only means a newer deployment exists; this one is still served.
    const latest = statuses.find((status) => status.state === "success") ?? statuses[0];
    lastSeen = latest ? `deployment is "${latest.state}"` : "deployment has no status yet";

    if (latest?.state === "success") {
      const url = new URL(latest.environment_url || latest.target_url);
      // Same rule as e2e/lib/preview-access.ts (PREVIEW_HOST).
      if (url.protocol !== "https:" || !/^triply-[a-z0-9-]+\.vercel\.app$/.test(url.hostname)) {
        stop("CONFIG", "the Preview deployment's URL is not an https triply-*.vercel.app address");
      }
      console.log(`Preview for ${HEAD_SHA.slice(0, 7)}: ${url.origin}`);
      if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `url=${url.origin}\n`);
      process.exit(0);
    }
    if (latest?.state === "failure" || latest?.state === "error") {
      stop("APP", "the preview build failed on Vercel (the `app` check usually shows why)");
    }
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_SECONDS * 1000));
}

stop("CONFIG", `no ready Preview deployment for this commit after ${WAIT_MINUTES} minutes (${lastSeen})`);
