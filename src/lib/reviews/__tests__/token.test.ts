import { describe, it, expect, afterEach } from "vitest";
import {
  REVIEW_LINK_VALID_DAYS,
  isReviewConfigError,
  reviewLinkExpiry,
  reviewUrl,
  signReviewToken,
  verifyReviewToken,
} from "../token";

const BOOKING = "3f2b8c1e-9a4d-4e2b-8c7a-1d2e3f4a5b6c";
const NOW = Date.UTC(2026, 9, 9, 23, 0); // 2026-10-09 23:00 UTC
const exp = (daysFromNow: number) => Math.floor(NOW / 1000) + daysFromNow * 86_400;

describe("review token", () => {
  const original = process.env.REVIEW_SIGNING_SECRET;
  afterEach(() => {
    process.env.REVIEW_SIGNING_SECRET = original;
  });

  it("verifies a token it signed and returns the booking id", () => {
    const token = signReviewToken(BOOKING, exp(30));
    expect(verifyReviewToken(token, NOW)).toEqual({ ok: true, bookingId: BOOKING, expSeconds: exp(30) });
  });

  it("normalises an upper-case booking id", () => {
    const token = signReviewToken(BOOKING.toUpperCase(), exp(30));
    const r = verifyReviewToken(token, NOW);
    expect(r.ok && r.bookingId).toBe(BOOKING);
  });

  it("rejects a tampered booking id", () => {
    const [, e, sig] = signReviewToken(BOOKING, exp(30)).split(".");
    const other = "00000000-0000-4000-8000-000000000000";
    expect(verifyReviewToken(`${other}.${e}.${sig}`, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered expiry (cannot extend a link)", () => {
    const [id, e, sig] = signReviewToken(BOOKING, exp(1)).split(".");
    expect(verifyReviewToken(`${id}.${Number(e) + 86_400 * 365}.${sig}`, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a tampered signature", () => {
    const token = signReviewToken(BOOKING, exp(30));
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyReviewToken(flipped, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a token signed with a different secret", () => {
    process.env.REVIEW_SIGNING_SECRET = "some-other-secret-entirely-xxxxxxxx";
    const token = signReviewToken(BOOKING, exp(30));
    process.env.REVIEW_SIGNING_SECRET = original;
    expect(verifyReviewToken(token, NOW)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an expired token, and only after its signature checks out", () => {
    const token = signReviewToken(BOOKING, exp(-1));
    expect(verifyReviewToken(token, NOW)).toEqual({ ok: false, reason: "expired" });
    // Exactly at the expiry instant it is already expired.
    const atEdge = signReviewToken(BOOKING, Math.floor(NOW / 1000));
    expect(verifyReviewToken(atEdge, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it.each([
    ["", "empty"],
    ["abc", "no dots"],
    [`${BOOKING}.123`, "two parts"],
    [`not-a-uuid.${exp(1)}.${"A".repeat(43)}`, "bad id"],
    [`${BOOKING}.12x.${"A".repeat(43)}`, "bad expiry"],
    [`${BOOKING}.${exp(1)}.short`, "bad signature length"],
    [`${BOOKING}.${exp(1)}.${"A".repeat(43)}.extra`, "four parts"],
  ])("rejects a malformed token (%s: %s)", (token) => {
    expect(verifyReviewToken(token, NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("throws a ReviewConfigError — not 'invalid' — when the secret is missing", () => {
    const token = signReviewToken(BOOKING, exp(30));
    delete process.env.REVIEW_SIGNING_SECRET;
    let caught: unknown;
    try {
      verifyReviewToken(token, NOW);
    } catch (e) {
      caught = e;
    }
    expect(isReviewConfigError(caught)).toBe(true);
    expect(() => signReviewToken(BOOKING, exp(30))).toThrow(/REVIEW_SIGNING_SECRET/);
  });

  it("refuses to sign a non-UUID id or a bad expiry", () => {
    expect(() => signReviewToken("123", exp(1))).toThrow();
    expect(() => signReviewToken(BOOKING, 0)).toThrow();
    expect(() => signReviewToken(BOOKING, 1.5)).toThrow();
  });
});

describe("reviewLinkExpiry", () => {
  it("is the end of day 60 after the check-out date, independent of 'now'", () => {
    const e = reviewLinkExpiry("2026-10-08");
    expect(e).toBe(Date.UTC(2026, 9, 8) / 1000 + (REVIEW_LINK_VALID_DAYS + 1) * 86_400);
    expect(reviewLinkExpiry("2026-10-08")).toBe(e); // byte-stable across retries
  });

  it("rejects anything but YYYY-MM-DD", () => {
    expect(() => reviewLinkExpiry("2026-10-08T10:00:00")).toThrow();
  });
});

describe("reviewUrl", () => {
  it("builds /review/{token} with an optional ?r", () => {
    const token = signReviewToken(BOOKING, exp(30));
    expect(reviewUrl(token)).toBe(`https://www.triplypro.com/review/${token}`);
    expect(reviewUrl(token, 4)).toBe(`https://www.triplypro.com/review/${token}?r=4`);
  });
});
