import { describe, it, expect } from "vitest";
import { parseRatingParam, reviewDisplayName, reviewSubmitSchema } from "../schema";

const B = "3f2b8c1e-9a4d-4e2b-8c7a-1d2e3f4a5b6c";

const details = {
  shuttleWait: "5_15",
  extraCharges: false,
  comment: "Quick shuttle, friendly driver.",
  publishConsent: true,
};

describe("reviewSubmitSchema", () => {
  it("accepts a bare star tap", () => {
    const r = reviewSubmitSchema.safeParse({ bookingId: B, rating: 5 });
    expect(r.success && r.data).toEqual({ bookingId: B, rating: 5 });
  });

  it("accepts the full form", () => {
    const r = reviewSubmitSchema.safeParse({ bookingId: B, rating: 2, details });
    expect(r.success).toBe(true);
  });

  it("accepts every detail as null / no consent", () => {
    const r = reviewSubmitSchema.safeParse({
      bookingId: B,
      rating: 3,
      details: { shuttleWait: null, extraCharges: null, comment: null, publishConsent: false },
    });
    expect(r.success).toBe(true);
  });

  it.each([0, 6, 3.5, "5", null])("rejects rating %s", (rating) => {
    expect(reviewSubmitSchema.safeParse({ bookingId: B, rating }).success).toBe(false);
  });

  it("rejects a missing rating or booking id — no defaults", () => {
    expect(reviewSubmitSchema.safeParse({ bookingId: B }).success).toBe(false);
    expect(reviewSubmitSchema.safeParse({ rating: 4 }).success).toBe(false);
    expect(reviewSubmitSchema.safeParse({ bookingId: "nope", rating: 4 }).success).toBe(false);
  });

  it("rejects a token in the body (it travels only in the HttpOnly cookie)", () => {
    expect(reviewSubmitSchema.safeParse({ bookingId: B, token: "t", rating: 4 }).success).toBe(false);
  });

  it("rejects an unknown shuttle wait", () => {
    const r = reviewSubmitSchema.safeParse({ bookingId: B, rating: 4, details: { ...details, shuttleWait: "30_plus" } });
    expect(r.success).toBe(false);
  });

  it("rejects a details object missing a field (the form always sends all four)", () => {
    const { publishConsent: _omit, ...partial } = details;
    void _omit;
    expect(reviewSubmitSchema.safeParse({ bookingId: B, rating: 4, details: partial }).success).toBe(false);
  });

  it("caps the comment at 500 characters (after trimming)", () => {
    const ok = reviewSubmitSchema.safeParse({
      bookingId: B,
      rating: 4,
      details: { ...details, comment: `  ${"x".repeat(500)}  ` },
    });
    expect(ok.success).toBe(true);
    const tooLong = reviewSubmitSchema.safeParse({ bookingId: B, rating: 4, details: { ...details, comment: "x".repeat(501) } });
    expect(tooLong.success).toBe(false);
  });

  it("stores an all-whitespace comment as null", () => {
    const r = reviewSubmitSchema.safeParse({ bookingId: B, rating: 4, details: { ...details, comment: "   " } });
    expect(r.success && r.data.details?.comment).toBeNull();
  });

  it("rejects unknown keys (e.g. a client trying to set display_name)", () => {
    expect(reviewSubmitSchema.safeParse({ bookingId: B, rating: 4, displayName: "Bob" }).success).toBe(false);
    expect(
      reviewSubmitSchema.safeParse({ bookingId: B, rating: 4, details: { ...details, displayName: "Bob" } }).success
    ).toBe(false);
  });
});

describe("parseRatingParam", () => {
  it.each([
    ["1", 1],
    ["5", 5],
    ["0", null],
    ["6", null],
    ["4.5", null],
    ["", null],
    [undefined, null],
    [["3", "4"], null],
  ])("%s → %s", (raw, expected) => {
    expect(parseRatingParam(raw)).toBe(expected);
  });
});

describe("reviewDisplayName", () => {
  it("is the first word of the first name, only with consent", () => {
    expect(reviewDisplayName("  Maria Elena ", true)).toBe("Maria");
    expect(reviewDisplayName("Maria", false)).toBeNull();
    expect(reviewDisplayName(null, true)).toBeNull();
    expect(reviewDisplayName("   ", true)).toBeNull();
  });
});
