import { describe, it, expect } from "vitest";
import { mapHotelOffer, distanceMeters, type LiteApiHotelSummary, type LiteApiHotelRates } from "../liteapi/rates";

const JFK = { latitude: 40.6413, longitude: -73.7781, timezone: "America/New_York" };

// Shapes copied from the 2026-09-24 sandbox probe (Marriott New York JFK Airport).
const summary: LiteApiHotelSummary = {
  id: "lp6556bdfe",
  name: "Marriott New York JFK Airport",
  stars: 3,
  rating: 7.8,
  reviewCount: 1200,
  address: "135-25 142ND STREET",
  city: "Jamaica",
  latitude: 40.667572,
  longitude: -73.796833,
  main_photo: "https://static.cupid.travel/hotels/516916303.jpg",
  facilityIds: [492, 2, 17],
};

function rates(over: Partial<LiteApiHotelRates> = {}): LiteApiHotelRates {
  return {
    hotelId: "lp6556bdfe",
    roomTypes: [
      {
        offerId: "offer-1",
        rates: [
          {
            rateId: "rate-expensive",
            name: "King Suite",
            boardName: "Room Only",
            retailRate: { total: [{ amount: 300, currency: "USD" }], taxesAndFees: [] },
            cancellationPolicies: { refundableTag: "NRFN", cancelPolicyInfos: [] },
            paymentTypes: ["NUITEE_PAY"],
          },
          {
            rateId: "rate-cheap",
            name: "Run of House",
            boardName: "Breakfast Included",
            retailRate: {
              total: [{ amount: 232.97, currency: "USD" }],
              suggestedSellingPrice: [{ amount: 235.07, currency: "USD", source: "providerDirect" }],
              taxesAndFees: [
                { included: false, description: "City tax", amount: 3.5, currency: "USD" },
                { included: false, description: "TAX", amount: 34.36, currency: "USD" },
                { included: true, description: "VAT", amount: 10, currency: "USD" },
              ],
            },
            cancellationPolicies: { refundableTag: "NRFN", cancelPolicyInfos: [] },
            paymentTypes: ["NUITEE_PAY"],
          },
        ],
      },
    ],
    ...over,
  };
}

describe("mapHotelOffer", () => {
  it("picks the cheapest USD rate, maps money to integer cents, sums only NON-included fees", () => {
    const anomalies = new Set<string>();
    const o = mapHotelOffer(summary, rates(), JFK, anomalies);
    expect(o).not.toBeNull();
    expect(o!.offer.rateId).toBe("rate-cheap");
    expect(o!.offer.roomNetCents).toBe(23297);
    expect(o!.offer.sspCents).toBe(23507);
    expect(o!.offer.propertyFeesDueAtHotel).toEqual([
      { description: "City tax", cents: 350 },
      { description: "TAX", cents: 3436 },
    ]);
    expect(o!.offer.propertyFeesDueAtHotelCents).toBe(3786);
    expect(o!.offer.refundability).toEqual({ kind: "non_refundable" });
    expect(o!.offer.paymentTypes).toEqual(["NUITEE_PAY"]);
    expect(o!.photoUrl).toBe("https://static.cupid.travel/hotels/516916303.jpg");
    expect(o!.shuttle).toBe(true); // facility 17
    expect(o!.distanceM).toBeGreaterThan(2000);
    expect(o!.distanceM).toBeLessThan(4000);
    expect([...anomalies]).toEqual([]);
  });

  it("an unrecognised fee description is still payable-at-hotel AND an anomaly", () => {
    const anomalies = new Set<string>();
    const r = rates();
    r.roomTypes![0].rates![1].retailRate!.taxesAndFees = [{ included: false, description: "Resort levy", amount: 20, currency: "USD" }];
    const o = mapHotelOffer(summary, r, JFK, anomalies);
    expect(o!.offer.propertyFeesDueAtHotelCents).toBe(2000);
    expect([...anomalies]).toEqual([expect.stringMatching(/unrecognised taxesAndFees.description "Resort levy"/)]);
  });

  it("skips non-USD rates; a hotel with only non-USD rates is unpriceable", () => {
    const anomalies = new Set<string>();
    const r = rates();
    for (const rate of r.roomTypes![0].rates!) rate.retailRate!.total = [{ amount: 100, currency: "EUR" }];
    expect(mapHotelOffer(summary, r, JFK, anomalies)).toBeNull();
  });

  it("a photo on a non-allowlisted host renders the placeholder and reports the host once", () => {
    const anomalies = new Set<string>();
    const o = mapHotelOffer({ ...summary, main_photo: "https://cdn.other.example/a.jpg" }, rates(), JFK, anomalies);
    expect(o!.photoUrl).toBeNull();
    expect([...anomalies]).toEqual(["photo host rejected: cdn.other.example"]);
  });

  it("a hotel without coordinates is skipped with an anomaly (distance and map need them)", () => {
    const anomalies = new Set<string>();
    expect(mapHotelOffer({ ...summary, latitude: undefined }, rates(), JFK, anomalies)).toBeNull();
    expect([...anomalies]).toEqual([expect.stringMatching(/no coordinates/)]);
  });
});

describe("distanceMeters", () => {
  it("JFK terminal to the Marriott is ~3 km", () => {
    const d = distanceMeters(JFK.latitude, JFK.longitude, 40.667572, -73.796833);
    expect(d).toBeGreaterThan(2500);
    expect(d).toBeLessThan(3800);
  });
  it("zero for the same point", () => {
    expect(distanceMeters(1, 2, 1, 2)).toBe(0);
  });
});
