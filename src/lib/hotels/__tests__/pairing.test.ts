import { describe, expect, it } from "vitest";
import { airportsByCode } from "@/config/airports";
import { pickParkingLot } from "@/lib/hotels/pairing";
import type { UnifiedLot } from "@/types/lot";

const JFK = airportsByCode.JFK;
const LGA = airportsByCode.LGA;

/** A priced, prepaid, fully refundable ResLab lot sitting on the given airport. */
function lot(id: number, at: { latitude: number; longitude: number }, grandTotal: number, overrides: Partial<UnifiedLot> = {}): UnifiedLot {
  return {
    id: `reslab-${id}`,
    source: "reslab",
    sourceId: String(id),
    reslabLocationId: id,
    name: `Lot ${id}`,
    slug: `lot-${id}`,
    address: "1 Test Rd",
    city: "Queens",
    state: "NY",
    latitude: at.latitude + 0.005,
    longitude: at.longitude + 0.005,
    amenities: [],
    photos: [],
    pricing: { minPrice: 10, currency: "$", parkingTypes: [], grandTotal, subtotal: grandTotal - 5 },
    availability: "available",
    cancellationPolicies: [{ numberOfDays: 1, percentage: 100 }],
    ...overrides,
  };
}

describe("pickParkingLot", () => {
  it("pairs the searched airport's own lot even when a neighbour's lot is cheaper", () => {
    const own = lot(1, JFK, 60);
    const lgaLot = lot(2, LGA, 40);
    const { paired, rejected } = pickParkingLot([lgaLot, own], JFK);
    expect(paired?.lot.id).toBe(own.id);
    expect(paired?.parkingOnlineCents).toBe(6000);
    expect(rejected.other_airport).toBe(1);
  });

  it("returns no pairing rather than a neighbour's lot when every own lot is out", () => {
    // searchParking's own-airport fallback can hand us exactly this list.
    const soldOut = lot(1, JFK, 60, { availability: "unavailable" });
    const lgaLot = lot(2, LGA, 40);
    const { paired, rejected } = pickParkingLot([soldOut, lgaLot], JFK);
    expect(paired).toBeNull();
    expect(rejected).toMatchObject({ unavailable: 1, other_airport: 1 });
  });

  it("never pairs a direct lot, however cheap", () => {
    const direct = lot(3, JFK, 20, { id: "direct-1", source: "direct", sourceId: "1", reslabLocationId: undefined });
    const reslab = lot(1, JFK, 60);
    const { paired, rejected } = pickParkingLot([direct, reslab], JFK);
    expect(paired?.lot.id).toBe(reslab.id);
    expect(rejected.not_reslab).toBe(1);
  });

  it("checks each ResLab disqualifier on its own", () => {
    // Each lot fails exactly one of the two checks.
    const directWithId = lot(4, JFK, 20, { source: "direct" });
    const reslabWithoutId = lot(5, JFK, 21, { reslabLocationId: undefined });
    const { paired, rejected } = pickParkingLot([directWithId, reslabWithoutId], JFK);
    expect(paired).toBeNull();
    expect(rejected.not_reslab).toBe(2);
  });

  it("keeps the existing prepaid / refundable / priced rules", () => {
    const { paired, rejected } = pickParkingLot(
      [
        lot(1, JFK, 30, { dueAtLocation: true }),
        lot(2, JFK, 31, { cancellationPolicies: [{ numberOfDays: 1, percentage: 50 }] }),
        lot(3, JFK, 32, { cancellationPolicies: [] }),
        lot(4, JFK, 0),
        lot(5, JFK, 70),
      ],
      JFK
    );
    expect(paired?.lot.reslabLocationId).toBe(5);
    expect(rejected).toEqual({
      not_reslab: 0,
      other_airport: 0,
      unavailable: 0,
      due_at_location: 1,
      not_fully_refundable: 2,
      unpriced: 1,
    });
  });
});
