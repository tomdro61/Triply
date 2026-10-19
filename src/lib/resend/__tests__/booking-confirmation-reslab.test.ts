import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingConfirmationEmail } from "../templates/booking-confirmation";
import { buildCostBreakdown, type ReslabCostInput } from "@/lib/booking/cost-breakdown";

/**
 * The ResLab booking confirmation's Payment Summary rendered from the cost
 * breakdown (plan notes/2026-10-12-cost-breakdown-plan.md §1), and the
 * fallback layout when there is none.
 */

const base = {
  customerName: "Ada Lovelace",
  customerEmail: "ada@example.com",
  confirmationNumber: "RTL900",
  lotName: "ResLab Lot",
  lotAddress: "99 ResLab Avenue",
  checkInDate: "2026-10-20",
  checkOutDate: "2026-10-25",
  checkInTime: "10:00 AM",
  checkOutTime: "2:00 PM",
  totalAmount: 51.7,
  dueAtLocation: 0,
};
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(BookingConfirmationEmail, { ...base, ...props } as Parameters<typeof BookingConfirmationEmail>[0]));

/** The amount cell next to a plain-text label cell. */
function amountFor(html: string, label: string): string | null {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`>${esc}</td><td[^>]*>([^<]+)</td>`).exec(html)?.[1] ?? null;
}
const cents = (usd: string | null) => (usd === null ? Number.NaN : Math.round(Number(usd.replace(/[$,]/g, "")) * 100));
const occurrences = (html: string, text: string) => html.split(text).length - 1;

function reslab(over: Partial<ReslabCostInput>) {
  const b = buildCostBreakdown({
    source: "reslab",
    subtotal: 40,
    fees: 2.25,
    longTermDiscount: 0,
    tax: 3.5,
    grandTotal: 45.75,
    dueAtLocation: 0,
    days: null,
    serviceFee: 5.95,
    promoDiscount: 0,
    promoCode: null,
    expectedPromoCents: null,
    protection: null,
    anchorChargedCents: 5170,
    refundedCents: 0,
    cancelled: false,
    ...over,
  });
  if (!b.ok) throw new Error(`fixture breakdown not ok: ${b.reason}`);
  return b;
}

describe("booking confirmation email — ResLab, with the cost breakdown", () => {
  it("plain: parking (fees rolled in), taxes, fee, then 'Paid online (card)' as the total", () => {
    const html = render({ breakdown: reslab({}) });
    expect(amountFor(html, "Parking")).toBe("$42.25");
    expect(amountFor(html, "Taxes")).toBe("$3.50");
    expect(amountFor(html, "Triply service fee")).toBe("$5.95");
    expect(amountFor(html, "Paid online (card)")).toBe("$51.70");
    expect(html).not.toContain("Due at location");
    expect(html).not.toContain("Total Paid");
    expect(html).toContain("reslab-logo.png");
  });

  it("pay-at-lot: the due amount appears once, and Paid online + Due at location = Total", () => {
    // 81 + 2.25 + 6.50 = 89.75 (21.50 of it due at the lot) + fee 6 + Plan A 12.99 = 108.74; card 87.24
    const breakdown = reslab({
      subtotal: 81,
      fees: 2.25,
      tax: 6.5,
      grandTotal: 89.75,
      dueAtLocation: 21.5,
      serviceFee: 6,
      protection: { name: "Plan A", premium: 12.99 },
      anchorChargedCents: 8724,
    });
    const html = render({ totalAmount: 108.74, dueAtLocation: 21.5, protectionPlan: "Plan A", protectionPlanPrice: 12.99, breakdown });
    expect(amountFor(html, "Total")).toBe("$108.74");
    expect(amountFor(html, "Paid online (card)")).toBe("$87.24");
    expect(amountFor(html, "Due at location")).toBe("$21.50");
    expect(occurrences(html, "$21.50")).toBe(1);
    expect(cents(amountFor(html, "Paid online (card)")) + cents(amountFor(html, "Due at location"))).toBe(
      cents(amountFor(html, "Total"))
    );
    expect(amountFor(html, "Parking Protection — Plan A")).toBe("$12.99");
    // The fallback's subtraction-style rows are gone.
    expect(html).not.toContain("(Paid online)");
  });

  it("a promo with its code and a long-stay discount: both credit lines, and the card total is net of them", () => {
    // 90 + 3 − 9 long-stay + 6 tax = 90 grand; + 6 fee − 9 promo (10 % of 90) = 87
    const breakdown = reslab({
      subtotal: 90,
      fees: 3,
      longTermDiscount: 9,
      tax: 6,
      grandTotal: 90,
      serviceFee: 6,
      promoDiscount: 9,
      promoCode: "SAVE10",
      expectedPromoCents: 900,
      anchorChargedCents: 8700,
    });
    const html = render({ totalAmount: 87, breakdown });
    expect(amountFor(html, "Parking")).toBe("$93.00");
    expect(amountFor(html, "Long-stay discount")).toBe("−$9.00");
    expect(amountFor(html, "Promo discount (SAVE10)")).toBe("−$9.00");
    expect(amountFor(html, "Paid online (card)")).toBe("$87.00");
  });

  it("ok:false with the charge known: 'Charged to card' = the anchor and the recorded due amount, no re-added total", () => {
    const reason = "promo discount does not match the code's percent";
    const html = render({
      totalAmount: 94,
      dueAtLocation: 20,
      breakdown: { ok: false, reason },
      anchoredFallback: { chargedCents: 6600, due: { kind: "amount", cents: 2000 }, protection: null, reason },
    });
    expect(amountFor(html, "Charged to card")).toBe("$66.00");
    expect(amountFor(html, "Due at location (as recorded)")).toBe("$20.00");
    expect(html).not.toContain("$94.00");
    expect(html).not.toContain("$74.00");
    expect(html).not.toContain(">Total<");
    expect(html).not.toContain("(Paid online)");
    // Nothing due → no due line, and no pointer either.
    const noDue = render({
      totalAmount: 94,
      dueAtLocation: 0,
      breakdown: { ok: false, reason: "x" },
      anchoredFallback: { chargedCents: 6600, due: { kind: "none" }, protection: null, reason: "x" },
    });
    expect(noDue).not.toContain("Due at location");
    expect(noDue).not.toContain("The lot will confirm");
    expect(amountFor(noDue, "Charged to card")).toBe("$66.00");
  });

  it("ok:false with the due amount unconfirmed: no 'Due at location $X' — the lot confirms it on arrival, with support's address", () => {
    const reason = "the parts do not add up to what the card was charged";
    const html = render({
      totalAmount: 94,
      dueAtLocation: 20,
      breakdown: { ok: false, reason },
      anchoredFallback: { chargedCents: 6600, due: { kind: "unconfirmed" }, protection: null, reason },
    });
    expect(amountFor(html, "Charged to card")).toBe("$66.00");
    expect(html).not.toContain("Due at location");
    expect(html).not.toContain("$20.00");
    expect(html).toContain("The lot will confirm any amount due when you arrive. Questions?");
    expect(html).toContain('href="mailto:support@triplypro.com"');
    expect(html).not.toContain("booking page");
  });

  it("without a breakdown (or ok:false with no known charge): exactly today's layout", () => {
    const plain = render({});
    expect(plain).toContain("Total Paid");
    expect(plain).toContain("$51.70");
    expect(render({ breakdown: { ok: false, reason: "x" } })).toBe(plain);

    const payAtLot = render({ totalAmount: 94, dueAtLocation: 20 });
    expect(payAtLot).toContain("(Paid online)");
    expect(payAtLot).toContain("$74.00");
    expect(payAtLot).toContain("Due at location");
    expect(render({ totalAmount: 94, dueAtLocation: 20, breakdown: { ok: false, reason: "x" } })).toBe(payAtLot);
  });
});
