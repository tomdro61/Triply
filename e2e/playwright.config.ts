import { defineConfig, devices } from "@playwright/test";

/**
 * Checkout smoke test (docs: CLAUDE.md "CI is the merge gate", `checkout-smoke`).
 *
 * No trace, no HAR, no video, no HTML report: this repository is public, its
 * CI artifacts are downloadable, and all of those record request headers,
 * which here include the token that opens protected previews. Screenshots
 * and a text summary only.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "checkout-smoke.spec.ts",
  // One browser, one test at a time: each attempt creates one Stripe test
  // PaymentIntent, and the steps depend on each other.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  forbidOnly: !!process.env.CI,
  outputDir: "test-results",
  reporter: [["list"], ["json", { outputFile: "smoke-report.json" }]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
    // The PWA service worker would fetch outside the guard's sight.
    serviceWorkers: "block",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
});
