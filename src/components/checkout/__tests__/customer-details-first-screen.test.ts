import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckoutTripStrip } from "../checkout-trip-strip";
import { CustomerDetailsStep } from "../customer-details-step";
import { totalRowLabel, tripStripPrice, type TripStripPrice } from "@/lib/checkout/total-label";

/**
 * What a shopper sees on the details step before typing. 32% left it without
 * touching a field (GA4, 12-17 Nov). Tested here: the trip strip's price
 * (same total, label and split as the order summary), and the details step's
 * order (trust chips before the inputs, email first, phone's reason before
 * its field). Not tested: that checkout-form renders the strip above the step
 * (a JSX position, checked by hand on the preview).
 */

const pb = { total: 123.4, dueNow: 123.4, dueAtLocation: 0 };

describe("tripStripPrice", () => {
  it("shows the summary's total and label on a normal lot", () => {
    expect(tripStripPrice({ priced: true, priceBreakdown: pb, vehicleEstimate: null, usdLabel: false })).toEqual({
      totalLabel: "Total",
      total: 123.4,
      atLotNote: null,
      sign: "$",
    });
  });

  it("shows no total before the server price is in (the fallback guesses the tax)", () => {
    const p = tripStripPrice({ priced: false, priceBreakdown: pb, vehicleEstimate: null, usdLabel: false });
    expect(p.total).toBeNull();
    expect(p.atLotNote).toBeNull();
  });

  it("labels a converted lot in US$", () => {
    const p = tripStripPrice({ priced: true, priceBreakdown: pb, vehicleEstimate: null, usdLabel: true });
    expect(p.totalLabel).toBe("Total (USD)");
    expect(p.sign).toBe("US$");
  });

  it("never calls the card charge 'Total' when money is also due at the lot, and says how much", () => {
    const p = tripStripPrice({
      priced: true,
      priceBreakdown: pb,
      vehicleEstimate: { atLotCents: 2150 },
      usdLabel: false,
    });
    expect(p.totalLabel).toBe("Charged today");
    expect(p.atLotNote).toBe("+ $21.50 due at the lot (est.)");
  });

  it("splits due now and due at the lot when the lot collects part of the price", () => {
    const p = tripStripPrice({
      priced: true,
      priceBreakdown: { total: 100, dueNow: 20, dueAtLocation: 80 },
      vehicleEstimate: null,
      usdLabel: false,
    });
    expect(p.totalLabel).toBe("Total");
    expect(p.atLotNote).toBe("$20.00 due now, $80.00 at the lot");
  });

  it("uses the one label rule the order summary uses", () => {
    expect(totalRowLabel({ atLotCents: 1 }, true)).toBe("Charged today");
    expect(totalRowLabel({ atLotCents: 0 }, true)).toBe("Total (USD)");
    expect(totalRowLabel(null, false)).toBe("Total");
  });
});

const strip = (price: TripStripPrice) =>
  renderToStaticMarkup(
    createElement(CheckoutTripStrip, {
      lotName: "Lot A",
      checkIn: "2026-11-26",
      checkOut: "2026-11-30",
      price,
      summaryId: "order-summary",
    })
  );

describe("CheckoutTripStrip", () => {
  it("shows the lot, the literal booking days and the total", () => {
    const html = strip({ totalLabel: "Total", total: 123.4, atLotNote: null, sign: "$" });
    expect(html).toContain("Lot A");
    expect(html).toContain("Thu, Nov 26");
    expect(html).toContain("Mon, Nov 30");
    expect(html).toContain("$123.40");
    expect(html).toContain('href="#order-summary"');
  });

  it("is hidden on desktop, where the summary sits beside the form", () => {
    expect(strip({ totalLabel: "Total", total: 1, atLotNote: null, sign: "$" })).toMatch(/class="[^"]*\blg:hidden\b/);
  });

  it("shows no price at all without a total", () => {
    const html = strip({ totalLabel: "Total", total: null, atLotNote: null, sign: "$" });
    expect(html).not.toContain("$");
    expect(html).not.toContain("Total");
  });

  it("shows the at-lot amount when there is one", () => {
    expect(
      strip({ totalLabel: "Charged today", total: 50, atLotNote: "+ $21.50 due at the lot (est.)", sign: "$" })
    ).toContain("+ $21.50 due at the lot (est.)");
  });
});

describe("CustomerDetailsStep first screen", () => {
  const render = (showFreeCancellation: boolean) =>
    renderToStaticMarkup(
      createElement(CustomerDetailsStep, {
        data: { firstName: "", lastName: "", email: "", phone: "" },
        onChange: () => {},
        onNext: () => {},
        errors: {},
        showFreeCancellation,
      })
    );

  it("puts the trust chips before the first input, and the cancellation detail after the button", () => {
    const html = render(true);
    const firstInput = html.indexOf("<input");
    expect(html.indexOf("No account needed")).toBeGreaterThan(-1);
    expect(html.indexOf("No account needed")).toBeLessThan(firstInput);
    expect(html.indexOf("Free cancellation (24h)")).toBeLessThan(firstInput);
    expect(html.indexOf("partly non-refundable")).toBeGreaterThan(html.indexOf("Continue to Vehicle Info"));
  });

  it("asks email first, then names, then phone", () => {
    const order = Array.from(render(false).matchAll(/data-funnel-field="([^"]+)"/g), (m) => m[1]);
    expect(order).toEqual(["email", "firstName", "lastName", "phone"]);
  });

  it("says why it asks for the phone before the field, and links it", () => {
    const html = render(false);
    const why = html.indexOf('id="phone-why"');
    expect(why).toBeGreaterThan(-1);
    expect(why).toBeLessThan(html.indexOf('type="tel"'));
    expect(html).toContain('aria-describedby="phone-why"');
  });

  it("drops every free-cancellation line when the booking can't use it", () => {
    expect(render(false)).not.toMatch(/Free cancellation/i);
  });
});
