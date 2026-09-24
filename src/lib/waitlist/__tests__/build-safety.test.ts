import { describe, it, expect, afterEach } from "vitest";

/**
 * Pass-3 review item 1, build-time half: `next build` evaluates every route
 * module during page-data collection, so importing these three route files
 * with WAITLIST_SIGNING_SECRET unset is the unit-test equivalent of that
 * step. It must not throw — verified locally against a real `next build`
 * with the var removed (see the review notes); this pins the fix so it
 * can't silently regress back to a module-scope read.
 */

const ORIGINAL_SECRET = process.env.WAITLIST_SIGNING_SECRET;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.WAITLIST_SIGNING_SECRET;
  } else {
    process.env.WAITLIST_SIGNING_SECRET = ORIGINAL_SECRET;
  }
});

describe("waitlist routes — importable without WAITLIST_SIGNING_SECRET", () => {
  // A cold import of a route module (rather than the already-cached one the
  // rest of the suite imports) forces Vitest to transform its whole import
  // graph from scratch, which is genuinely slow here — generous timeouts,
  // not a sign of a hang.
  // Each import path is built from a concatenation, not a string literal, so
  // tsc treats these as opaque dynamic imports (type `any`) instead of trying
  // to resolve a "...?no-secret-build-test" module that doesn't exist on disk.
  it(
    "POST /api/waitlist",
    async () => {
      delete process.env.WAITLIST_SIGNING_SECRET;
      const modulePath = "@/app/api/waitlist/route" + "?no-secret-build-test";
      await expect(import(/* @vite-ignore */ modulePath)).resolves.toBeDefined();
    },
    60_000
  );

  it(
    "GET/POST /api/waitlist/unsubscribe",
    async () => {
      delete process.env.WAITLIST_SIGNING_SECRET;
      const modulePath = "@/app/api/waitlist/unsubscribe/route" + "?no-secret-build-test";
      await expect(import(/* @vite-ignore */ modulePath)).resolves.toBeDefined();
    },
    60_000
  );

  it(
    "GET /api/cron/waitlist-notify",
    async () => {
      delete process.env.WAITLIST_SIGNING_SECRET;
      const modulePath = "@/app/api/cron/waitlist-notify/route" + "?no-secret-build-test";
      await expect(import(/* @vite-ignore */ modulePath)).resolves.toBeDefined();
    },
    60_000
  );
});
