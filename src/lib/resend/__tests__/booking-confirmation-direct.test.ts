import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookingConfirmationEmail } from "../templates/booking-confirmation";

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
