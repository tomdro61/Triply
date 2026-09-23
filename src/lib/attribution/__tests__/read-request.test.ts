import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const sentry = vi.hoisted(() => ({ captureException: vi.fn(), withScope: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  captureException: sentry.captureException,
  withScope: (fn: (scope: unknown) => void) => {
    sentry.withScope();
    fn({ setFingerprint: vi.fn(), setTag: vi.fn(), setContext: vi.fn() });
  },
}));
vi.mock("@/lib/sentry", () => ({ captureBookingError: vi.fn() }));

import { __resetInvalidReportForTests, readAttributionFromRequest } from "../read-request";
import { encodeCookieValue, type AttributionCookie } from "../schema";

const value: AttributionCookie = {
  v: 1,
  first: { src: "google", med: "cpc", click: "gclid:x", land: "/", at: 1 },
  last: { src: "fb", med: "paid_social", click: "fbclid:y", land: "/search", at: 2 },
  apt: "JFK",
};

function req(cookies: Record<string, string>) {
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return new NextRequest("http://localhost/api/reservations/pending", {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });
}
const OPT_OUT = encodeURIComponent(JSON.stringify({ dismissed: true, analyticsOptOut: true, timestamp: "x" }));

beforeEach(() => {
  vi.clearAllMocks();
  __resetInvalidReportForTests();
});

describe("readAttributionFromRequest", () => {
  it("absent → null, no Sentry", () => {
    expect(readAttributionFromRequest(req({}), {})).toBeNull();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("valid → the cookie + GA client id", () => {
    const out = readAttributionFromRequest(
      req({ triply_attr: encodeCookieValue(value), _ga: "GA1.1.1234567890.1700000000" }),
      { stripePaymentIntentId: "pi_1" }
    );
    expect(out).toEqual({ ...value, ga_client_id: "1234567890.1700000000" });
  });

  it("analytics opt-out drops the GA client id AND click ids already in the cookie; UTM/referrer are kept", () => {
    // The privacy page promises "advertising click identifiers are not
    // recorded" — that must hold for a gclid captured BEFORE the opt-out.
    const out = readAttributionFromRequest(
      req({ triply_attr: encodeCookieValue(value), _ga: "GA1.1.1.2", triply_cookie_consent: OPT_OUT }),
      {}
    );
    expect(out).toEqual({
      v: 1,
      first: { src: "google", med: "cpc", land: "/", at: 1 },
      last: { src: "fb", med: "paid_social", land: "/search", at: 2 },
      apt: "JFK",
    });
    expect(out && "ga_client_id" in out).toBe(false);
  });

  it("a newer cookie version → null (absent), no Sentry", () => {
    const v2 = Buffer.from(JSON.stringify({ v: 2, first: value.first })).toString("base64url");
    expect(readAttributionFromRequest(req({ triply_attr: v2 }), {})).toBeNull();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("invalid → the invalid marker, ONE Sentry event per instance", () => {
    const out1 = readAttributionFromRequest(req({ triply_attr: "garbage" }), { stripePaymentIntentId: "pi_1" });
    const out2 = readAttributionFromRequest(req({ triply_attr: "garbage" }), { stripePaymentIntentId: "pi_2" });
    expect(out1).toEqual({ v: null, invalid: true });
    expect(out2).toEqual({ v: null, invalid: true });
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  describe("surface parameter", () => {
    it("defaults to 'checkout' — an invalid cookie still reports, matching every call site before this parameter existed", () => {
      const out = readAttributionFromRequest(req({ triply_attr: "garbage" }), {});
      expect(out).toEqual({ v: null, invalid: true });
      expect(sentry.captureException).toHaveBeenCalledTimes(1);
    });

    it("surface='search': an invalid cookie still resolves to the invalid marker, but is NEVER reported to Sentry", () => {
      const out = readAttributionFromRequest(req({ triply_attr: "garbage" }), {}, "search");
      expect(out).toEqual({ v: null, invalid: true });
      expect(sentry.captureException).not.toHaveBeenCalled();
    });

    it("surface='search' still parses a valid cookie identically to 'checkout'", () => {
      const out = readAttributionFromRequest(
        req({ triply_attr: encodeCookieValue(value), _ga: "GA1.1.1234567890.1700000000" }),
        {},
        "search"
      );
      expect(out).toEqual({ ...value, ga_client_id: "1234567890.1700000000" });
    });

    it("surface='search' does not report a thrown reader bug to Sentry either", async () => {
      const { captureBookingError } = await import("@/lib/sentry");
      // Absent cookie never throws in the reader — assert the guard exists by
      // calling with a malformed request-like object that would throw before
      // reaching the try's normal returns, exercising the catch branch.
      const badRequest = {
        cookies: {
          get: () => {
            throw new Error("boom");
          },
        },
      } as unknown as NextRequest;

      const out = readAttributionFromRequest(badRequest, {}, "search");
      expect(out).toBeNull();
      expect(captureBookingError).not.toHaveBeenCalled();
    });
  });
});
