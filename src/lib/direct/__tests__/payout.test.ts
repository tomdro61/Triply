import { describe, it, expect } from "vitest";
import { classifyPayout, adjustmentCandidate, sameBasis, type PayoutBookingInput } from "../payout";

// 4 days × $9.95 = $39.80 parking, 16 % tax $6.37, fee $5.95 → $52.12 charged.
const booking = (o: Partial<PayoutBookingInput> = {}): PayoutBookingInput => ({
  stripePaymentIntentId: "pi_1",
  reservationNumber: "TRP-AAAA1111",
  directLotId: "1",
  livemode: true,
  status: "confirmed",
  cancelState: null,
  cancelClaimedAt: null,
  checkIn: "2026-10-20 10:00:00",
  checkOut: "2026-10-24 10:00:00",
  timezone: "America/New_York",
  subtotal: "39.80",
  taxTotal: "6.37",
  serviceFee: "5.95",
  pgWholesale: null,
  terms: { directLotId: "1", livemode: true, sharePercent: "80.00", taxCollectedBy: "lot" },
  stripe: { error: null, amountReceivedCents: 5212, amountRefundedCents: 0, piStatus: "succeeded", disputed: false, disputes: "" },
  ...o,
});

// 10:00 New York on 20 Oct (EDT, UTC−4) = 14:00Z.
const BEFORE_CHECK_IN = "2026-10-19T12:00:00Z";
const AFTER_CHECK_IN = "2026-10-20T15:00:00Z";

describe("classifyPayout", () => {
  it("pays 80 % of the list subtotal plus the tax the lot collects", () => {
    const r = classifyPayout(booking());
    expect(r).toMatchObject({ kind: "payable", amountCents: 3184 + 637 });
  });

  it("keeps the tax when Triply collects it", () => {
    const r = classifyPayout(booking({ terms: { directLotId: "1", livemode: true, sharePercent: "80.00", taxCollectedBy: "triply" } }));
    expect(r).toMatchObject({ kind: "payable", amountCents: 3184 });
  });

  it("pays on the list price even when a promo lowered the charge (Triply absorbs promos)", () => {
    const r = classifyPayout(booking({ stripe: { error: null, amountReceivedCents: 4212, amountRefundedCents: 0, piStatus: "succeeded", disputed: false, disputes: "" } }));
    expect(r).toMatchObject({ kind: "payable", amountCents: 3821 });
  });

  it("rounds half up per booking in integer cents", () => {
    // 80 % of 1 cent... 39.81 × 0.8 = 31.848 → 3185.
    expect(classifyPayout(booking({ subtotal: "39.81", taxTotal: "0" }))).toMatchObject({ amountCents: 3185 });
  });

  it.each([
    ["no terms", { terms: null }],
    ["terms of another lot", { terms: { directLotId: "2", livemode: true, sharePercent: "80.00", taxCollectedBy: "lot" } }],
    ["terms of the other mode", { terms: { directLotId: "1", livemode: false, sharePercent: "80.00", taxCollectedBy: "lot" } }],
    ["unreadable share", { terms: { directLotId: "1", livemode: true, sharePercent: "eighty", taxCollectedBy: "lot" } }],
    ["share above 100 %", { terms: { directLotId: "1", livemode: true, sharePercent: "100.01", taxCollectedBy: "lot" } }],
    ["unknown tax collector", { terms: { directLotId: "1", livemode: true, sharePercent: "80.00", taxCollectedBy: "" } }],
    ["unreadable subtotal", { subtotal: null }],
    ["unreadable tax", { taxTotal: "n/a" }],
    ["Stripe not read", { stripe: null }],
    ["Stripe read failed", { stripe: { error: "timeout", amountReceivedCents: null, amountRefundedCents: null, piStatus: null, disputed: false, disputes: "" } }],
    ["Stripe figures missing", { stripe: { error: null, amountReceivedCents: null, amountRefundedCents: 0, piStatus: "succeeded", disputed: false, disputes: "" } }],
    ["a hold not captured", { stripe: { error: null, amountReceivedCents: 0, amountRefundedCents: 0, piStatus: "requires_capture", disputed: false, disputes: "" } }],
    ["nothing received", { stripe: { error: null, amountReceivedCents: 0, amountRefundedCents: 0, piStatus: "succeeded", disputed: false, disputes: "" } }],
    ["a partial refund on a live stay", { stripe: { error: null, amountReceivedCents: 5212, amountRefundedCents: 500, piStatus: "succeeded", disputed: false, disputes: "" } }],
    ["disputed", { status: "disputed" }],
    ["mid-cancellation", { cancelState: "held_reslab_ambiguous" }],
    ["an unknown status", { status: "pending" }],
  ] as const)("never pays automatically: %s", (_label, o) => {
    expect(classifyPayout(booking(o as Partial<PayoutBookingInput>)).kind).toBe("manual");
  });

  describe("cancelled bookings", () => {
    const refunded = (refundedCents: number) => ({
      stripe: { error: null, amountReceivedCents: 5212, amountRefundedCents: refundedCents, piStatus: "succeeded", disputed: false, disputes: "" },
    });

    it("self-cancel before check-in, all but nothing kept → $0", () => {
      const r = classifyPayout(booking({ status: "refunded", cancelState: "refund_issued", cancelClaimedAt: BEFORE_CHECK_IN, ...refunded(5212) }));
      expect(r).toMatchObject({ kind: "zero", amountCents: 0 });
    });

    it("admin standard cancel (fee kept, cancel_state left at admin_claimed) → $0", () => {
      const r = classifyPayout(booking({ status: "refunded", cancelState: "admin_claimed", cancelClaimedAt: BEFORE_CHECK_IN, ...refunded(5212 - 595) }));
      expect(r).toMatchObject({ kind: "zero" });
    });

    it("Park Guard wholesale withheld as well → still $0", () => {
      const r = classifyPayout(booking({
        status: "refunded", cancelState: "admin_claimed", cancelClaimedAt: BEFORE_CHECK_IN, pgWholesale: "6.00",
        stripe: { error: null, amountReceivedCents: 5212 + 1299, amountRefundedCents: 5212 + 1299 - 595 - 600, piStatus: "succeeded", disputed: false, disputes: "" },
      }));
      expect(r).toMatchObject({ kind: "zero" });
    });

    it("cancelled without a refund → manual (the parking money is still with Triply)", () => {
      const r = classifyPayout(booking({ status: "cancelled", cancelState: "admin_claimed", cancelClaimedAt: BEFORE_CHECK_IN, ...refunded(0) }));
      expect(r).toMatchObject({ kind: "manual", reason: "cancelled but the parking was not fully refunded" });
    });

    it("cancelled after check-in → manual", () => {
      const r = classifyPayout(booking({ status: "refunded", cancelState: "admin_claimed", cancelClaimedAt: AFTER_CHECK_IN, ...refunded(5212) }));
      expect(r).toMatchObject({ kind: "manual", reason: "cancelled after check-in" });
    });

    it.each([
      ["no cancel time", { cancelClaimedAt: null }],
      ["no timezone", { timezone: null }],
      ["bad timezone", { timezone: "Not/AZone" }],
      ["bad check-in", { checkIn: "soon" }],
    ] as const)("cannot tell when it was cancelled (%s) → manual", (_l, o) => {
      const r = classifyPayout(booking({ status: "refunded", cancelState: "refund_issued", cancelClaimedAt: BEFORE_CHECK_IN, ...refunded(5212), ...o }));
      expect(r.kind).toBe("manual");
    });

    it("a dispute is never $0 even on a cancelled row's Stripe figures", () => {
      expect(classifyPayout(booking({ status: "disputed", ...refunded(5212) })).kind).toBe("manual");
    });
  });

  it("records the basis it decided from", () => {
    const r = classifyPayout(booking());
    expect(r.basis).toMatchObject({ subtotalCents: 3980, taxCents: 637, shareBp: 8000, taxCollectedBy: "lot", amountReceivedCents: 5212, amountRefundedCents: 0, checkOut: "2026-10-24 10:00:00" });
  });
});

describe("adjustmentCandidate", () => {
  const paid = classifyPayout(booking());
  it("nothing to do when still owed exactly what was paid", () => {
    expect(adjustmentCandidate(paid, 3821, null)).toBeNull();
  });
  it("a refund after payment → negative delta", () => {
    const zero = classifyPayout(booking({ status: "refunded", cancelState: "refund_issued", cancelClaimedAt: BEFORE_CHECK_IN, stripe: { error: null, amountReceivedCents: 5212, amountRefundedCents: 5212, piStatus: "succeeded", disputed: false, disputes: "" } }));
    expect(adjustmentCandidate(zero, 3821, null)).toEqual({ deltaCents: -3821, reason: "refunded or cancelled after payment" });
  });
  it("now owes more → positive delta", () => {
    expect(adjustmentCandidate(paid, 3000, null)).toMatchObject({ deltaCents: 821 });
  });
  it("a state that needs a person → candidate with no amount", () => {
    expect(adjustmentCandidate(classifyPayout(booking({ status: "disputed" })), 3821, null)).toMatchObject({ deltaCents: null });
  });
});

describe("review pass 1 fixes", () => {
  const refundedAll = { error: null, amountReceivedCents: 5212, amountRefundedCents: 5212, piStatus: "succeeded", disputed: false, disputes: "" };

  it("Stripe's own dispute flag routes to a person even when our row still says confirmed", () => {
    const r = classifyPayout(booking({ stripe: { error: null, amountReceivedCents: 5212, amountRefundedCents: 0, piStatus: "succeeded", disputed: true, disputes: "du_1:needs_response:5212" } }));
    expect(r).toMatchObject({ kind: "manual", reason: "disputed (Stripe: needs_response)" });
  });

  it("an unknown dispute state is never paid", () => {
    const r = classifyPayout(booking({ stripe: { error: null, amountReceivedCents: 5212, amountRefundedCents: 0, piStatus: "succeeded", disputed: null, disputes: null } }));
    expect(r).toMatchObject({ kind: "manual", reason: "dispute state unknown" });
  });

  it.each([["claimed"], [null], ["held_reslab_ambiguous"]] as const)(
    "a refund outside the two cancel paths (cancel_state %s) is never an automatic $0",
    (cancelState) => {
      const r = classifyPayout(booking({ status: "refunded", cancelState, cancelClaimedAt: BEFORE_CHECK_IN, stripe: refundedAll }));
      expect(r.kind).toBe("manual");
    }
  );

  it("one cent short of the parking + tax refund → a person decides", () => {
    const r = classifyPayout(booking({
      status: "refunded", cancelState: "admin_claimed", cancelClaimedAt: BEFORE_CHECK_IN,
      stripe: { ...refundedAll, amountRefundedCents: 5212 - 595 - 1 },
    }));
    expect(r).toMatchObject({ kind: "manual", reason: "cancelled but the parking was not fully refunded" });
  });

  it("a released hold cancelled before check-in → $0", () => {
    const r = classifyPayout(booking({
      status: "cancelled", cancelState: "refund_issued", cancelClaimedAt: BEFORE_CHECK_IN,
      stripe: { error: null, amountReceivedCents: 0, amountRefundedCents: 0, piStatus: "canceled", disputed: false, disputes: "" },
    }));
    expect(r).toMatchObject({ kind: "zero" });
  });

  it("unreadable kept service fee → a person decides", () => {
    const r = classifyPayout(booking({ status: "refunded", cancelState: "refund_issued", cancelClaimedAt: BEFORE_CHECK_IN, serviceFee: "abc", stripe: refundedAll }));
    expect(r).toMatchObject({ kind: "manual", reason: "kept fees unreadable" });
  });

  it("rounds a true half cent up (75 % of $0.10 → 7.5 → 8)", () => {
    const r = classifyPayout(booking({ subtotal: "0.10", taxTotal: "0", terms: { directLotId: "1", livemode: true, sharePercent: "75.00", taxCollectedBy: "lot" } }));
    expect(r).toMatchObject({ kind: "payable", amountCents: 8 });
  });

  describe("a person's decision is bound to its basis", () => {
    const disputed = classifyPayout(booking({ status: "disputed" }));
    it("not raised again while nothing changed", () => {
      expect(adjustmentCandidate(disputed, 3821, { ...disputed.basis, prior_lines_cents: 0 })).toBeNull();
    });
    it("raised again once anything in the basis changed", () => {
      const later = classifyPayout(booking({ status: "disputed", stripe: { ...refundedAll, amountRefundedCents: 1000 } }));
      expect(adjustmentCandidate(later, 3821, { ...disputed.basis })).toMatchObject({ deltaCents: null });
    });
    it("a dispute WON after a person withheld the payout raises the booking again (the flag alone stays true)", () => {
      const open = { error: null, amountReceivedCents: 5212, amountRefundedCents: 0, piStatus: "succeeded", disputed: true, disputes: "du_1:needs_response:5212" };
      const withheld = classifyPayout(booking({ status: "disputed", stripe: open }));
      const won = classifyPayout(booking({ status: "disputed", stripe: { ...open, disputes: "du_1:won:5212" } }));
      expect(won).toMatchObject({ kind: "manual", reason: "disputed: won" });
      expect(adjustmentCandidate(won, 0, { ...withheld.basis })).toMatchObject({ deltaCents: null });
      expect(adjustmentCandidate(withheld, 0, { ...withheld.basis })).toBeNull();
    });
    it("an automatic line binds nothing — a change in amount is always raised", () => {
      const zero = classifyPayout(booking({ status: "refunded", cancelState: "refund_issued", cancelClaimedAt: BEFORE_CHECK_IN, stripe: refundedAll }));
      expect(adjustmentCandidate(zero, 3821, null)).toMatchObject({ deltaCents: -3821 });
    });
    it("sameBasis ignores keys outside the basis", () => {
      expect(sameBasis(disputed.basis, { ...disputed.basis, priorLinesCents: 5, prior_lines_cents: 5 })).toBe(true);
      expect(sameBasis(disputed.basis, { ...disputed.basis, status: "confirmed" })).toBe(false);
    });
  });
});
