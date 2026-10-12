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
  it("a direct booking: no Reservations Lab logo, the size, and the at-lot estimate OUTSIDE the paid total", () => {
    const html = render({
      direct: { shuttlePhone: "+1 (347) 960-7065", vehicleSizeLabel: "Large SUV / truck", atLotEstimate: 58 },
      specialConditions: "- Show your confirmation at the booth\n- No buses",
    });
    expect(html).not.toContain("reslab-logo.png");
    expect(html).toContain("Large SUV / truck");
    expect(html).toContain("Estimated due at the lot");
    expect(html).toContain("$58.00");
    expect(html).toContain("Total Paid");
    expect(html).toContain("$63.66");
    // Bullet notes render as a list.
    expect(html).toContain("<li>Show your confirmation at the booth</li>");
    expect(html).toContain("+1 (347) 960-7065");
  });

  it("'No oversized vehicle': no at-lot block", () => {
    const html = render({ direct: { vehicleSizeLabel: "No oversized vehicle", atLotEstimate: null } });
    expect(html).not.toContain("Estimated due at the lot");
    expect(html).toContain("No oversized vehicle");
  });

  it("a ResLab booking is unchanged: logo present, no direct blocks, free-text notes stay a paragraph", () => {
    const html = render({ confirmationNumber: "RTL1", specialConditions: "Arrive 15 minutes early." });
    expect(html).toContain("reslab-logo.png");
    expect(html).not.toContain("Estimated due at the lot");
    expect(html).not.toContain("Vehicle size");
    expect(html).toContain("Arrive 15 minutes early.");
    expect(html).not.toContain("<li>Arrive");
  });
});
