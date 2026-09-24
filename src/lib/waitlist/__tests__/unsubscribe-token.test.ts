import { describe, it, expect, afterEach } from "vitest";

/**
 * Pass-3 review item 1: `next build` failed in ANY env missing
 * WAITLIST_SIGNING_SECRET because the old code read/threw at module scope,
 * and Next evaluates every route module (including this one, imported by all
 * three waitlist routes) during page-data collection regardless of whether
 * the route ever runs. The fix moved the read+throw into the two functions
 * that actually need the secret — this test is the regression guard for
 * that: importing the module must never throw, only CALLING signWaitlistId /
 * verifyWaitlistToken without the var configured should.
 *
 * `vitest.setup.ts` sets WAITLIST_SIGNING_SECRET globally so the rest of the
 * waitlist suite can sign/verify real tokens — this file deletes it locally,
 * for these tests only, and restores it afterward so it doesn't leak into
 * any other test file.
 */

const ORIGINAL_SECRET = process.env.WAITLIST_SIGNING_SECRET;

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) {
    delete process.env.WAITLIST_SIGNING_SECRET;
  } else {
    process.env.WAITLIST_SIGNING_SECRET = ORIGINAL_SECRET;
  }
});

describe("unsubscribe-token — missing WAITLIST_SIGNING_SECRET", () => {
  it("importing the module does not throw even with the var unset", async () => {
    delete process.env.WAITLIST_SIGNING_SECRET;
    // A fresh import (bypassing the module cache) is the closest unit-test
    // equivalent of Next's page-data collection evaluating this module cold.
    // Built from a concatenation, not a string literal, so tsc treats this as
    // an opaque dynamic import (type `any`) instead of trying to resolve a
    // "../unsubscribe-token?..." module that doesn't exist on disk.
    const modulePath = "../unsubscribe-token" + "?no-secret-import-test";
    await expect(import(/* @vite-ignore */ modulePath)).resolves.toBeDefined();
  });

  it("signWaitlistId throws once the var is missing and the function is actually called", async () => {
    const { signWaitlistId } = await import("../unsubscribe-token");
    delete process.env.WAITLIST_SIGNING_SECRET;
    expect(() => signWaitlistId("row_1")).toThrow(/WAITLIST_SIGNING_SECRET/);
  });

  it("verifyWaitlistToken throws (does not silently return false) when the var is missing", async () => {
    const { verifyWaitlistToken } = await import("../unsubscribe-token");
    delete process.env.WAITLIST_SIGNING_SECRET;
    // Must NOT be swallowed into the same `return false` path as a forged
    // token — a config error and an invalid token are different failures.
    expect(() => verifyWaitlistToken("row_1", "deadbeef")).toThrow(
      /WAITLIST_SIGNING_SECRET/
    );
  });

  it("waitlistUnsubscribeUrl throws when the var is missing", async () => {
    const { waitlistUnsubscribeUrl } = await import("../unsubscribe-token");
    delete process.env.WAITLIST_SIGNING_SECRET;
    expect(() => waitlistUnsubscribeUrl("row_1")).toThrow(/WAITLIST_SIGNING_SECRET/);
  });

  it("signing/verifying works normally again once the var is set", async () => {
    const { signWaitlistId, verifyWaitlistToken } = await import("../unsubscribe-token");
    process.env.WAITLIST_SIGNING_SECRET = "test-waitlist-secret-at-least-32-chars";
    const token = signWaitlistId("row_1");
    expect(verifyWaitlistToken("row_1", token)).toBe(true);
  });
});
