import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingConfirmationEmail } from "../templates/booking-confirmation";
import { buildCostBreakdown, type DirectCostInput } from "@/lib/booking/cost-breakdown";

const base = {
  customerName: "Ada Lovelace",
  customerEmail: "ada@example.com",
  confirmationNumber: "TRP-AAAA1111",
  lotName: "The Parking Point JFK",
  lotAddress: "150-57 183rd St, Springfield Gardens, NY 11413",
  checkInDate: "2026-10-20",
  checkOutDate: "2026-10-25",
  checkInTime: "10:00 AM",
  checkOutTime: "10:00 AM",
  totalAmount: 63.66,
  dueAtLocation: 0,
  vehicleInfo: "Ford F-150 (Black) - ABC123",
};
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(BookingConfirmationEmail, { ...base, ...props } as Parameters<typeof BookingConfirmationEmail>[0]));

describe("booking confirmation email — direct lots (4b plan §3.4)", () => {
  it("a direct booking: no Reservations Lab logo, the size, and the at-lot amount as a LINE ITEM under the card charge, never inside it", () => {
    const html = render({
      direct: { shuttlePhone: "+1 (347) 960-7065", vehicleSizeLabel: "Large SUV / truck", atLotEstimate: 58, discount: 0 },
      specialConditions: "- Show your confirmation at the booth\n- No buses",
    });
    expect(html).not.toContain("reslab-logo.png");
    expect(html).toContain("Large SUV / truck");
    // One payment block: card charge, then what the lot collects, then the trip total.
    expect(html).toContain("Charged today");
    expect(html).toContain("$63.66");
    expect(html).toContain("Due at the lot (est.)");
    expect(html).toContain("$58.00");
    expect(html).toContain("Trip total (est.)");
    expect(html).toContain("$121.66");
    expect(html.indexOf("Charged today")).toBeLessThan(html.indexOf("Due at the lot (est.)"));
    expect(html.indexOf("Due at the lot (est.)")).toBeLessThan(html.indexOf("Trip total (est.)"));
    // never the old standalone box, and the card charge is never called the total paid for the trip
    expect(html).not.toContain("Estimated due at the lot");
    expect(html).not.toContain("Total Paid");
    // Bullet notes render as a list.
    expect(html).toContain("<li>Show your confirmation at the booth</li>");
    expect(html).toContain("+1 (347) 960-7065");
  });

  it("a promo: its own discount line, and the parking line is BEFORE it — the lines add up to the card charge", () => {
    // charge 51.67 = parking/fees/tax 50.68 − promo 12.00 + Plan A 12.99
    const html = render({ totalAmount: 51.67, protectionPlan: "Plan A", protectionPlanPrice: 12.99, direct: { vehicleSizeLabel: "Small SUV", atLotEstimate: 11.6, discount: 12 } });
    expect(html).toContain("Parking, fees &amp; taxes");
    expect(html).toContain("$50.68");
    expect(html).toContain("Promo discount");
    expect(html).toContain("$12.00");
    expect(html).toContain("$51.67");
    expect(html).toContain("$63.27");
  });

  it("'No oversized vehicle': no at-lot block", () => {
    const html = render({ direct: { vehicleSizeLabel: "No oversized vehicle", atLotEstimate: null, discount: 0 } });
    expect(html).not.toContain("Due at the lot");
    expect(html).not.toContain("Trip total");
    expect(html).toContain("Total Paid");
    expect(html).toContain("No oversized vehicle");
  });

  it("a ResLab booking is unchanged: logo present, no direct blocks, free-text notes stay a paragraph", () => {
    const html = render({ confirmationNumber: "RTL1", specialConditions: "Arrive 15 minutes early." });
    expect(html).toContain("reslab-logo.png");
    expect(html).not.toContain("Due at the lot");
    expect(html).not.toContain("Vehicle size");
    expect(html).toContain("Arrive 15 minutes early.");
    expect(html).not.toContain("<li>Arrive");
  });
});

/** The amount cell next to a plain-text label cell. */
function amountFor(html: string, label: string): string | null {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`>${esc}</td><td[^>]*>([^<]+)</td>`).exec(html)?.[1] ?? null;
}

function direct(over: Partial<DirectCostInput> = {}) {
  const b = buildCostBreakdown({
    source: "direct",
    subtotal: 19.9,
    tax: 3.18,
    serviceFee: 5.95,
    promoDiscount: 0,
    promoCode: null,
    expectedPromoCents: null,
    protection: { name: "Plan A", premium: 12.99 },
    atLot: { surchargeCents: 1000, surchargeTaxCents: 160, vehicleSizeLabel: "Small SUV" },
    days: 2,
    anchorChargedCents: 4202,
    refundedCents: 0,
    cancelled: false,
    ...over,
  });
  if (!b.ok) throw new Error(`fixture breakdown not ok: ${b.reason}`);
  return b;
}

describe("booking confirmation email — direct lots, with the cost breakdown (plan 2026-10-12)", () => {
  it("TRP-D0K1KGXC (oversized): every line, Charged today $42.02, Due at the lot $11.60, Trip total $53.62", () => {
    const html = render({
      totalAmount: 42.02,
      protectionPlan: "Plan A",
      protectionPlanPrice: 12.99,
      direct: { vehicleSizeLabel: "Small SUV", atLotEstimate: 11.6, discount: 0 },
      breakdown: direct(),
    });
    expect(amountFor(html, "Parking — 2 days")).toBe("$19.90");
    expect(amountFor(html, "Taxes")).toBe("$3.18");
    expect(amountFor(html, "Triply service fee")).toBe("$5.95");
    expect(amountFor(html, "Parking Protection — Plan A")).toBe("$12.99");
    expect(html).toContain("Charged today");
    expect(html).toContain("$42.02");
    expect(amountFor(html, "Due at the lot (est.)")).toBe("$11.60");
    expect(html).toContain("Small SUV surcharge incl. tax, paid at drop-off. The lot confirms your vehicle’s size at the gate.");
    expect(amountFor(html, "Trip total (est.)")).toBe("$53.62");
    expect(html.indexOf("Charged today")).toBeLessThan(html.indexOf("Due at the lot (est.)"));
    expect(html.indexOf("Due at the lot (est.)")).toBeLessThan(html.indexOf("Trip total (est.)"));
    // The fallback layout is gone.
    expect(html).not.toContain("Parking, fees &amp; taxes");
    expect(html).not.toContain("Total Paid");
    expect(html).not.toContain("Charged to card");
  });

  it("a promo: its own credit line with the code, and the card charge is net of it", () => {
    // 50.00 + 8.00 tax + 5.95 fee − 5.00 promo = 58.95
    const html = render({
      totalAmount: 58.95,
      direct: { vehicleSizeLabel: "No oversized vehicle", atLotEstimate: null, discount: 5 },
      breakdown: direct({ subtotal: 50, tax: 8, promoDiscount: 5, promoCode: "SAVE10", expectedPromoCents: 500, protection: null, atLot: null, anchorChargedCents: 5895 }),
    });
    expect(amountFor(html, "Promo discount (SAVE10)")).toBe("−$5.00");
    expect(html).toContain("$58.95");
    expect(html).not.toContain("Due at the lot");
    expect(html).not.toContain("Trip total");
    expect(html).not.toContain("Total Paid");
  });

  it("ok:false with no known charge renders exactly the legacy layout", () => {
    const props = { direct: { vehicleSizeLabel: "Large SUV / truck", atLotEstimate: 58, discount: 0 } };
    expect(render({ ...props, breakdown: { ok: false, reason: "x" } })).toBe(render(props));
  });

  it("ok:false with the charge known: the card charge is the anchor, never a total re-added from the parts", () => {
    const html = render({
      totalAmount: 63.66,
      protectionPlan: "$1,000 Protection",
      protectionPlanPrice: 12.99,
      direct: { vehicleSizeLabel: "Large SUV / truck", atLotEstimate: 58, discount: 0 },
      breakdown: { ok: false, reason: "the parts do not add up to what the card was charged" },
      anchoredFallback: {
        chargedCents: 6366,
        due: { kind: "amount", cents: 5800 },
        protection: { label: "Plan A", premiumCents: 1299 },
        reason: "the parts do not add up to what the card was charged",
      },
    });
    expect(amountFor(html, "Charged to card")).toBe("$63.66");
    // The plan as the customer chose it, never the tier's display name.
    expect(amountFor(html, "Includes Parking Protection — Plan A")).toBe("$12.99");
    expect(html).not.toContain("Includes $1,000 Protection");
    // The at-lot surcharge is still shown, as the estimate it is.
    expect(html).toContain("Large SUV / truck surcharge incl. tax, paid at drop-off.");
    expect(html).not.toContain("Due at location");
    expect(html).not.toContain("The lot will confirm");
    expect(amountFor(html, "Due at the lot (est.)")).toBe("$58.00");
    expect(html).not.toContain("Parking, fees &amp; taxes");
    expect(html).not.toContain("Trip total");
    expect(html).not.toContain("Total Paid");
  });
});
