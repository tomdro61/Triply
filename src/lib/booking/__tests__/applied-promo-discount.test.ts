/**
 * appliedPromoDiscount (fulfill.ts) — the ONE derivation of a ResLab booking's
 * recorded promo discount, shared by the booking row and the emails. Pure;
 * fulfill.ts is imported for real with only its I/O boundaries stubbed.
 * Promo plan Part 1 + the PR 1 review (a present stamp is never recorded as
 * "no discount"; warnings name what was written).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/booking/reconciliation-alert", () => ({
  RECONCILIATION_ALERT_COLUMNS: "stripe_payment_intent_id",
  alertNeedsReconciliation: vi.fn(),
  scheduleReconciliationAlert: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => ({}) }));
vi.mock("@/lib/reslab/client", () => ({ reslab: {}, stripHtml: (s: string | null) => s ?? "" }));
vi.mock("@/lib/resend/send-booking-confirmation", () => ({ sendBookingConfirmation: vi.fn() }));
vi.mock("@/lib/resend/send-admin-booking-notification", () => ({ sendAdminBookingNotification: vi.fn() }));
vi.mock("@/lib/sentry", () => ({
  capturePaymentError: vi.fn(),
  captureBookingError: vi.fn(),
  captureParkGuardError: vi.fn(),
  captureAPIError: vi.fn(),
}));

const { appliedPromoDiscount } = await import("../fulfill");
const { PROTECTION_PLANS } = await import("@/lib/parkguard/plans");
type AppliedPromo = import("../fulfill").AppliedPromo;
type ReslabFulfilledReservation = import("../fulfilled-reservation").ReslabFulfilledReservation;

// Grand 88, 20 due at the location, fee 6: online parking 68.00, the card
// before the promo 74.00. JFK5 → 69.00.
const fr = (money: Partial<ReslabFulfilledReservation["money"]> = {}): ReslabFulfilledReservation => ({
  number: "RTL1",
  source: "reslab",
  cancelled: false,
  historyId: 1,
  money: { subtotal: 80, taxTotal: 5, feesTotal: 3, grandTotal: 88, dueAtLocation: 20, longTermDiscount: null, ...money },
  dates: null,
  location: null,
});
const payload = { grandTotal: 88, triplyServiceFee: 6 };
const promo = (over: Partial<AppliedPromo> = {}): AppliedPromo => ({
  code: "JFK5",
  discountPercent: 0,
  stampedDiscount: { kind: "cents", cents: 500 },
  checkoutFigures: { kind: "absent" },
  chargedCents: 6900,
  ...over,
});

describe("appliedPromoDiscount — a usable stamp", () => {
  it("records exactly the stamp, with the code, and nothing to report", () => {
    expect(appliedPromoDiscount(payload, fr(), null, promo())).toEqual({ discountAmount: 5, promoCode: "JFK5", stampWarnings: [] });
  });

  it("a charge more than 1¢ away: still the stamp, and a mismatch naming what was recorded vs what Stripe charged", () => {
    const out = appliedPromoDiscount(payload, fr(), null, promo({ chargedCents: 6950 }));
    expect(out.discountAmount).toBe(5);
    expect(out.stampWarnings).toEqual([
      {
        kind: "mismatch",
        detail: "recorded discount_amount 5.00 (discountCents 500), but Stripe charged 6950 of a pre-discount 7400, i.e. 450 off",
      },
    ]);
  });

  it("with checkout figures the bound is checkout's online parking — a reservation priced lower does not refuse it", () => {
    // The reservation's online parking is 4.00 (grand 24, due 20), checkout's was 68.00.
    const out = appliedPromoDiscount(
      payload,
      fr({ grandTotal: 24 }),
      null,
      promo({ checkoutFigures: { kind: "figures", onlineParkingCents: 6800, preDiscountOnlineCents: 7400 } })
    );
    expect(out.discountAmount).toBe(5);
    expect(out.promoCode).toBe("JFK5");
    // Nor is it a mismatch: the charge is measured against checkout's own price.
    expect(out.stampWarnings).toEqual([]);
  });

  it("with checkout figures, a charge that disagrees with THEM is the mismatch (Park Guard counted)", () => {
    const figures = { kind: "figures" as const, onlineParkingCents: 6800, preDiscountOnlineCents: 7400 };
    const plan = { plan: PROTECTION_PLANS.A, premium: 12.99 };
    expect(appliedPromoDiscount(payload, fr(), plan, promo({ checkoutFigures: figures, chargedCents: 8199 })).stampWarnings).toEqual([]);
    const out = appliedPromoDiscount(payload, fr(), plan, promo({ checkoutFigures: figures, chargedCents: 8249 }));
    expect(out.discountAmount).toBe(5);
    expect(out.stampWarnings).toEqual([
      {
        kind: "mismatch",
        detail: "recorded discount_amount 5.00 (discountCents 500), but Stripe charged 8249 of a pre-discount 8699, i.e. 450 off",
      },
    ]);
  });
});

describe("appliedPromoDiscount — the backstop: a REFUSED stamp still proves a discount was applied", () => {
  it("an unusable stamp, no percent: the discount is derived from the charge (never $0) and the code recorded", () => {
    const out = appliedPromoDiscount(payload, fr(), null, promo({ stampedDiscount: { kind: "invalid", raw: "5.00" } }));
    expect(out.discountAmount).toBe(5); // 74.00 − 69.00
    expect(out.promoCode).toBe("JFK5");
    expect(out.stampWarnings).toEqual([
      {
        kind: "refused",
        detail:
          'discountCents "5.00" is not a positive whole number of cents; recorded discount_amount 5.00 derived from Stripe\'s charge (7400 − 6900) and promo_code JFK5',
      },
    ]);
  });

  it("an unusable stamp AND a percent present: still derived from the charge, the percent is not what decides", () => {
    const out = appliedPromoDiscount(
      payload,
      fr(),
      null,
      promo({ discountPercent: 10, stampedDiscount: { kind: "invalid", raw: "0" }, chargedCents: 6950 })
    );
    expect(out.discountAmount).toBe(4.5); // 74.00 − 69.50, not 10 % of 80
    expect(out.promoCode).toBe("JFK5");
    expect(out.stampWarnings.map((w) => w.kind)).toEqual(["refused"]);
  });

  it("a stamp above the online parking: refused, derived from the charge", () => {
    const out = appliedPromoDiscount(payload, fr(), null, promo({ stampedDiscount: { kind: "cents", cents: 6801 }, chargedCents: 599 }));
    expect(out.discountAmount).toBe(68.01);
    expect(out.promoCode).toBe("JFK5");
    expect(out.stampWarnings[0]).toMatchObject({ kind: "refused", detail: expect.stringContaining("exceeds the online parking 6800") });
  });

  it("malformed checkout figures refuse the stamp", () => {
    const out = appliedPromoDiscount(payload, fr(), null, promo({ checkoutFigures: { kind: "invalid", detail: "only one of the pair" } }));
    expect(out.discountAmount).toBe(5);
    expect(out.stampWarnings[0]).toMatchObject({ kind: "refused", detail: expect.stringMatching(/^only one of the pair; recorded discount_amount 5\.00/) });
  });

  it("a refused stamp whose charge shows no discount records none and no code — and says so", () => {
    const out = appliedPromoDiscount(payload, fr(), null, promo({ stampedDiscount: { kind: "invalid", raw: "x" }, chargedCents: 7400 }));
    expect(out).toMatchObject({ discountAmount: 0, promoCode: null });
    expect(out.stampWarnings[0].detail).toMatch(/recorded discount_amount 0\.00 .* and promo_code none$/);
  });
});

describe("appliedPromoDiscount — a stamped discount with no code", () => {
  it.each([null, ""])("code %j: the discount is recorded, no code, and it is reported (the use would not be counted)", (code) => {
    const out = appliedPromoDiscount(payload, fr(), null, promo({ code }));
    expect(out).toMatchObject({ discountAmount: 5, promoCode: null });
    expect(out.stampWarnings).toEqual([
      { kind: "no_code", detail: "discount_amount 5.00 recorded with no promoCode stamped — the booking counts as a use of no code" },
    ]);
  });
});

describe("appliedPromoDiscount — no stamp: exactly the rule before it", () => {
  it("a percent: derived from the charge", () => {
    expect(
      appliedPromoDiscount(payload, fr(), null, promo({ stampedDiscount: { kind: "absent" }, discountPercent: 10, code: "SAVE10", chargedCents: 6601 }))
    ).toEqual({ discountAmount: 7.99, promoCode: "SAVE10", stampWarnings: [] });
  });

  it("no percent: no discount, no code, nothing reported", () => {
    expect(appliedPromoDiscount(payload, fr(), null, promo({ stampedDiscount: { kind: "absent" }, code: "NOPE", chargedCents: 7000 }))).toEqual({
      discountAmount: 0,
      promoCode: null,
      stampWarnings: [],
    });
  });

  it("no promo at all", () => {
    expect(appliedPromoDiscount(payload, fr(), null)).toEqual({ discountAmount: 0, promoCode: null, stampWarnings: [] });
  });
});
