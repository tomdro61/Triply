import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/image", () => ({ default: (props: { alt: string }) => createElement("img", { alt: props.alt }) }));

import { BookingDetails, type PaymentFallback } from "../booking-details";
import { buildCostBreakdown, type CostBreakdownResult, type DirectCostInput, type ReslabCostInput } from "@/lib/booking/cost-breakdown";
import type { UnifiedLot } from "@/types/lot";

/**
 * The confirmation page's Payment summary renders the server's checked
 * breakdown (plan notes/2026-10-12-cost-breakdown-plan.md) — every figure here
 * comes from `buildCostBreakdown`, never a sum in the component — or, when the
 * breakdown was refused, the plain fallback ("Charged to card" only for
 * Stripe's own amount — never grandTotal, never a row-computed figure).
 */

const lot: UnifiedLot = {
  id: "direct-1",
  source: "direct",
  sourceId: "1",
  name: "The Parking Point JFK",
  slug: "the-parking-point-jfk",
  address: "150-57 183rd St",
  city: "Springfield Gardens",
  state: "NY",
  zipCode: "11413",
  latitude: 40.66,
  longitude: -73.77,
  amenities: [],
  photos: [],
  availability: "available",
};

const MINUS = "−";

const NO_FALLBACK: PaymentFallback = { card: { status: "unknown" }, due: { kind: "none" }, dueContext: { source: "reslab" } };

const render = (
  costBreakdown: CostBreakdownResult,
  over: { fallback?: PaymentFallback; cancelled?: boolean } = {}
) =>
  renderToStaticMarkup(
    createElement(BookingDetails, {
      lot,
      checkIn: "2026-10-14",
      checkOut: "2026-10-16",
      checkInTime: "9:00 AM",
      checkOutTime: "9:00 AM",
      days: 2,
      costBreakdown,
      fallback: over.fallback ?? NO_FALLBACK,
      cancelled: over.cancelled ?? false,
    })
  );

const reslab = (over: Partial<ReslabCostInput> = {}): CostBreakdownResult =>
  buildCostBreakdown({
    source: "reslab",
    days: 3,
    subtotal: "105.00",
    fees: "15.00",
    longTermDiscount: 0,
    tax: "14.40",
    grandTotal: "134.40",
    dueAtLocation: 0,
    serviceFee: "7.20",
    promoDiscount: "0.00",
    promoCode: null,
    expectedPromoCents: null,
    protection: null,
    anchorChargedCents: 14160,
    refundedCents: 0,
    cancelled: false,
    ...over,
  });

// TRP-D0K1KGXC (the 4b-2 staging walk).
const direct = (over: Partial<DirectCostInput> = {}): CostBreakdownResult =>
  buildCostBreakdown({
    source: "direct",
    days: 2,
    subtotal: "19.90",
    tax: "3.18",
    serviceFee: "5.95",
    promoDiscount: "0.00",
    promoCode: null,
    expectedPromoCents: null,
    protection: { name: "Plan A", premium: "12.99" },
    anchorChargedCents: 4202,
    refundedCents: 0,
    cancelled: false,
    atLot: { surchargeCents: 1000, surchargeTaxCents: 160, vehicleSizeLabel: "Small SUV" },
    ...over,
  });

const before = (html: string, a: string, b: string) => {
  expect(html).toContain(a);
  expect(html).toContain(b);
  expect(html.indexOf(a)).toBeLessThan(html.indexOf(b));
};

describe("BookingDetails — Payment summary from the checked breakdown", () => {
  it("ResLab, nothing due at the location: lines, then the card charge as the total", () => {
    const b = reslab();
    expect(b.ok).toBe(true);
    const html = render(b);
    expect(html).toContain("Payment summary");
    expect(html).toContain("Parking — 3 days");
    expect(html).toContain("$120.00"); // subtotal + fees, rolled in as checkout does
    expect(html).toContain("Taxes");
    expect(html).toContain("$14.40");
    expect(html).toContain("Triply service fee");
    expect(html).toContain("$7.20");
    expect(html).toContain("Paid online (card)");
    expect(html).toContain("$141.60");
    before(html, "Triply service fee", "Paid online (card)");
    expect(html).not.toContain("Due at location");
    expect(html).not.toContain("Total Paid");
    // Duration is kept.
    expect(html).toContain("Duration");
  });

  it("ResLab pay-at-lot: Total, then Paid online + Due at location (the due share is never added twice)", () => {
    // 134.40 grand of which 40.00 due at the location; card = 134.40 + 7.20 − 40.00.
    const html = render(reslab({ dueAtLocation: "40.00", anchorChargedCents: 10160 }));
    before(html, ">Total<", "Paid online (card)");
    expect(html).toContain("$141.60"); // Total
    expect(html).toContain("$101.60"); // Paid online
    before(html, "Paid online (card)", "Due at location");
    expect(html).toContain("$40.00");
    expect(html).toContain("Paid when you arrive.");
  });

  it("promo and long-stay discount render as credit lines with a leading minus", () => {
    const html = render(
      reslab({ longTermDiscount: "5.00", grandTotal: "129.40", promoDiscount: "10.00", promoCode: "SAVE10", expectedPromoCents: 1000, anchorChargedCents: 12660 })
    );
    expect(html).toContain("Long-stay discount");
    expect(html).toContain(`${MINUS}$5.00`);
    expect(html).toContain("Promo discount (SAVE10)");
    expect(html).toContain(`${MINUS}$10.00`);
    expect(html).toContain("$126.60");
  });

  it("direct with an oversized vehicle (TRP-D0K1KGXC): card charge, then the at-lot line, then the trip total", () => {
    const html = render(direct());
    expect(html).toContain("Parking Protection — Plan A");
    expect(html).toContain("$12.99");
    before(html, "Charged to card", "Due at the lot (est.)");
    expect(html).toContain("$42.02");
    expect(html).toContain("$11.60");
    expect(html).toContain("Small SUV: $10.00 + $1.60 tax, paid at drop-off");
    before(html, "Due at the lot (est.)", "Trip total (est.)");
    expect(html).toContain("$53.62");
    expect(html).not.toContain("Total Paid");
  });

  it("direct, no oversized vehicle: no at-lot or trip-total lines", () => {
    const html = render(direct({ atLot: null }));
    expect(html).toContain("Charged to card");
    expect(html).not.toContain("Due at the lot");
    expect(html).not.toContain("Trip total");
  });

  it("a refund shows Refunded (credit) and Net paid", () => {
    const html = render(direct({ refundedCents: 3602 }));
    before(html, "Charged to card", "Refunded");
    expect(html).toContain(`${MINUS}$36.02`);
    before(html, "Refunded", "Net paid");
    expect(html).toContain("$6.00");
  });

  it("cancelled direct booking: 'Booking total' (the card line is the total), the refund, nothing due at the lot", () => {
    const html = render(direct({ cancelled: true, refundedCents: 3602 }), { cancelled: true });
    expect(html).toContain("Booking total");
    expect(html).not.toContain("Charged to card");
    expect(html).toContain("Refunded");
    expect(html).toContain("Net paid");
    expect(html).not.toContain("Due at the lot");
    expect(html).not.toContain("Trip total");
  });

  it("cancelled ResLab pay-at-lot booking keeps 'Total' (the whole booking), drops Due at location, shows the refund", () => {
    const html = render(reslab({ dueAtLocation: "40.00", anchorChargedCents: 10160, cancelled: true, refundedCents: 10160 }), {
      cancelled: true,
    });
    expect(html).toContain(">Total<");
    expect(html).not.toContain("Booking total");
    expect(html).not.toContain("Due at location");
    expect(html).toContain("Refunded");
    expect(html).toContain("Net paid");
    expect(html).toContain("$0.00");
  });
});

describe("BookingDetails — the plain fallback (breakdown refused)", () => {
  const refused: CostBreakdownResult = { ok: false, reason: "promo discount does not match the code's percent" };
  const charged = (chargedCents: number, refundedCents = 0, netPaidCents: number | null = null): PaymentFallback["card"] => ({
    status: "charged",
    chargedCents,
    refundedCents,
    netPaidCents,
  });
  const RESLAB: PaymentFallback["dueContext"] = { source: "reslab" };
  const DIRECT: PaymentFallback["dueContext"] = {
    source: "direct",
    estimate: { vehicleSizeLabel: "Small SUV", surcharge: 10, surchargeTax: 1.6 },
  };

  it("'Charged to card' = Stripe's own amount, plus the recorded due at location; no itemised lines", () => {
    const html = render(refused, { fallback: { card: charged(6376), due: { kind: "amount", cents: 2000 }, dueContext: RESLAB } });
    expect(html).toContain("Charged to card");
    expect(html).toContain("$63.76");
    before(html, "Charged to card", "Due at location (as recorded)");
    expect(html).toContain("$20.00");
    expect(html).toContain("Paid when you arrive.");
    expect(html).not.toContain("Triply service fee");
    expect(html).not.toContain("Taxes");
    expect(html).not.toContain("Total Paid");
    expect(html).not.toContain("Refunded");
  });

  it("a live $40 due survives a mismatched anchor: still rendered beside Stripe's amount", () => {
    const html = render(
      { ok: false, reason: "the parts do not add up to what the card was charged" },
      { fallback: { card: charged(8976), due: { kind: "amount", cents: 4000 }, dueContext: RESLAB } }
    );
    expect(html).toContain("Due at location (as recorded)");
    expect(html).toContain("$40.00");
  });

  it("direct: the at-lot surcharge (outside the charge) is shown with its size/tax note", () => {
    const html = render(
      { ok: false, reason: "the parts do not add up to what the card was charged" },
      { fallback: { card: charged(4100), due: { kind: "amount", cents: 1160 }, dueContext: DIRECT } }
    );
    expect(html).toContain("Due at the lot (est.)");
    expect(html).toContain("$11.60");
    expect(html).toContain("Small SUV: $10.00 + $1.60 tax, paid at drop-off");
  });

  it("unconfirmed: never an amount, never 'nothing due' — the lot confirms, with a support contact", () => {
    const html = render(refused, { fallback: { card: charged(6976), due: { kind: "unconfirmed" }, dueContext: RESLAB } });
    expect(html).toContain("The lot will confirm any amount due when you arrive. Questions? support@triplypro.com");
    expect(html).not.toContain("Due at location");
    expect(html).not.toContain("booking details");
    expect(html).toContain("$69.76");
  });

  it("carries refunds: Refunded (credit) and Net paid under Stripe's amount", () => {
    const html = render(refused, {
      cancelled: true,
      fallback: { card: charged(4202, 3602, 600), due: { kind: "none" }, dueContext: DIRECT },
    });
    before(html, "Charged to card", "Refunded");
    expect(html).toContain(`${MINUS}$36.02`);
    before(html, "Refunded", "Net paid");
    expect(html).toContain("$6.00");
  });

  it("unknown card side (Stripe unreadable / not settled): NO charged figure — only the due line if known", () => {
    const html = render(refused, { fallback: { card: { status: "unknown" }, due: { kind: "amount", cents: 2000 }, dueContext: RESLAB } });
    expect(html).not.toContain("Charged to card");
    expect(html).toContain("confirmation email");
    expect(html).toContain("Due at location (as recorded)");
    expect(html).toContain("$20.00");
  });

  it("unknown and nothing due: no figure at all — never a placeholder or $0.00", () => {
    const html = render(refused, { fallback: NO_FALLBACK });
    expect(html).not.toContain("$");
    expect(html).toContain("confirmation email");
  });

  it("a released hold: 'Not charged — the card hold was released', with no amount", () => {
    const html = render(refused, {
      cancelled: true,
      fallback: { card: { status: "released" }, due: { kind: "none" }, dueContext: DIRECT },
    });
    expect(html).toContain("Not charged — the card hold was released.");
    expect(html).not.toContain("$");
    expect(html).not.toContain("Charged to card");
  });

  it("cancelled: nothing due at the lot / location", () => {
    const html = render(refused, {
      cancelled: true,
      fallback: { card: charged(4202), due: { kind: "amount", cents: 1160 }, dueContext: DIRECT },
    });
    expect(html).toContain("$42.02");
    expect(html).not.toContain("Due at the lot");
  });
});
