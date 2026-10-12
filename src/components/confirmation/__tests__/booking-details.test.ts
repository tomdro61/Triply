import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/image", () => ({ default: (props: { alt: string }) => createElement("img", { alt: props.alt }) }));

import { BookingDetails } from "../booking-details";
import type { UnifiedLot } from "@/types/lot";

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

const render = (over: Partial<Parameters<typeof BookingDetails>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(BookingDetails, {
      lot,
      checkIn: "2026-10-14",
      checkOut: "2026-10-16",
      checkInTime: "9:00 AM",
      checkOutTime: "9:00 AM",
      days: 2,
      total: 42.02,
      dueAtLocation: 0,
      atLot: null,
      cancelled: false,
      ...over,
    })
  );

const ATLOT = { total: 11.6, surcharge: 10, surchargeTax: 1.6, vehicleSizeLabel: "Small SUV" };

describe("BookingDetails — what was paid and what is due at the lot", () => {
  it("a direct booking with an oversized vehicle: card charge, then the at-lot line, then the trip total — one block", () => {
    const html = render({ atLot: ATLOT });
    // "to card", not "today": the page is opened again days later.
    expect(html).toContain("Charged to card");
    expect(html).toContain("$42.02");
    expect(html).toContain("Due at the lot (est.)");
    expect(html).toContain("$11.60");
    expect(html).toContain("Small SUV: $10.00 + $1.60 tax, paid at drop-off");
    expect(html).toContain("Trip total (est.)");
    expect(html).toContain("$53.62");
    expect(html.indexOf("Charged to card")).toBeLessThan(html.indexOf("Due at the lot (est.)"));
    expect(html.indexOf("Due at the lot (est.)")).toBeLessThan(html.indexOf("Trip total (est.)"));
    expect(html).not.toContain("Total Paid");
  });

  it("nothing due at the lot: the plain 'Total Paid', no at-lot or trip-total lines", () => {
    const html = render({ atLot: null });
    expect(html).toContain("Total Paid");
    expect(html).not.toContain("Due at the lot");
    expect(html).not.toContain("Trip total");
  });

  it("a cancelled booking never shows money due at the lot", () => {
    const html = render({ atLot: ATLOT, cancelled: true });
    expect(html).toContain("Booking Total");
    expect(html).not.toContain("Due at the lot");
    expect(html).not.toContain("Trip total");
  });

  it("a ResLab pay-at-location booking is unchanged", () => {
    const html = render({ total: 80, dueAtLocation: 30 });
    expect(html).toContain("Pay at Location");
    expect(html).toContain("$30.00 will be collected when you arrive");
    expect(html).not.toContain("Due at the lot");
  });
});
