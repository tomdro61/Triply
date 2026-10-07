import { describe, it, expect } from "vitest";
import { getAirportByCode } from "@/config/airports";
import { directLotFromRow } from "../store";
import { directLotToUnified } from "../adapter";
import { directLotRow } from "./fixtures";

const JFK = getAirportByCode("JFK")!;
const lotOf = (overrides: Record<string, unknown> = {}) => {
  const out = directLotFromRow(directLotRow(overrides));
  if (!out.lot) throw new Error(out.reason);
  return out.lot;
};
// 10 Oct 10:00 → 14 Oct 14:00 = 100 h = 5 billed days.
const WINDOW = { fromDate: "2026-10-10 10:00:00", toDate: "2026-10-14 14:00:00" };

describe("directLotToUnified", () => {
  it("never carries partner-facing fields to the browser", () => {
    const json = JSON.stringify(directLotToUnified(lotOf(), JFK, WINDOW));
    expect(json).not.toMatch(/partnerShare/i);
    expect(json).not.toMatch(/notificationEmails/i);
    expect(json).not.toMatch(/tom@triplypro\.com/);
    expect(json).not.toMatch(/80/); // the share percentage itself
  });

  it("identifies the lot as direct, with its CMS slug and airport code", () => {
    const u = directLotToUnified(lotOf(), JFK, WINDOW);
    expect(u).toMatchObject({
      id: "direct-1",
      source: "direct",
      sourceId: "1",
      slug: "the-parking-point-jfk",
      airportCode: "JFK",
      availability: "available",
      dueAtLocation: false,
      extraFields: [],
    });
    expect(u.reslabLocationId).toBeUndefined();
    expect(u.cancellationPolicies).toBeUndefined();
  });

  it("prices the searched window through computeDirectQuote (5 days × $9.95, 10.375 % tax)", () => {
    const u = directLotToUnified(lotOf(), JFK, WINDOW);
    expect(u.pricing).toMatchObject({
      minPrice: 9.95,
      numberOfDays: 5,
      subtotal: 49.75,
      taxTotal: 5.16,
      feesTotal: 0,
      grandTotal: 54.91,
      currencyCode: "USD",
    });
  });

  it("keeps the daily rate but no totals when there is no window or it does not parse — never a $0 lot, never a fabricated total", () => {
    for (const window of [
      null,
      { fromDate: "garbage", toDate: "2026-10-14 14:00:00" },
      { fromDate: "2026-10-14 14:00:00", toDate: "2026-10-10 10:00:00" },
    ]) {
      const p = directLotToUnified(lotOf(), JFK, window).pricing!;
      expect(p.minPrice).toBe(9.95);
      expect(p.grandTotal).toBeUndefined();
      expect(p.subtotal).toBeUndefined();
      expect(p.numberOfDays).toBeUndefined();
    }
  });

  it("puts the featured image first and does not repeat it from the gallery", () => {
    const u = directLotToUnified(lotOf(), JFK, WINDOW);
    expect(u.photos.map((p) => p.url.replace(/^.*\/api\/media\/file\//, ""))).toEqual(["shuttles.webp", "lot.webp"]);
  });

  it("falls back to the placeholder photo when the lot has no images", () => {
    const u = directLotToUnified(lotOf({ featured_image_url: null, featured_image_alt: null, gallery_urls: [] }), JFK, WINDOW);
    expect(u.photos).toEqual([{ id: "placeholder", url: "/placeholder-parking.jpg", alt: "The Parking Point JFK" }]);
  });

  it("measures distance from the airport it was found for, and maps the ops fields the page renders", () => {
    const u = directLotToUnified(lotOf(), JFK, WINDOW);
    expect(u.distanceFromAirport).toBeGreaterThan(0);
    expect(u.distanceFromAirport).toBeLessThan(10);
    expect(u.shuttleInfo).toEqual({ summary: "Shuttle to the terminal (about 10 min)", details: "Every 15–20 min, 24/7" });
    expect(u.directions).toBe("Shuttle runs 24/7");
    expect(u.specialConditions).toContain("No oversized vehicles");
    expect(u.phone).toBe("+1 (347) 960-7065");
    expect(u.amenities).toEqual([{ id: 1, name: "Shuttle", displayName: "Shuttle", icon: "bus" }]);
  });

  it("surfaces a minimum stay only when it is more than one day", () => {
    expect(directLotToUnified(lotOf(), JFK, WINDOW).minimumBookingDays).toBeUndefined();
    expect(directLotToUnified(lotOf({ min_stay_days: 3 }), JFK, WINDOW).minimumBookingDays).toBe(3);
  });
});
