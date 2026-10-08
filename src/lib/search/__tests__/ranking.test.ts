import { describe, it, expect } from "vitest";
import type { UnifiedLot } from "@/types/lot";
import {
  compareByTotal,
  compareByTotalDesc,
  lotTotal,
  lowestTotalLot,
  pickMostBookedLot,
  rankRecommended,
} from "../ranking";
import { sortLots } from "@/lib/reslab/search";

// Prices mirror the live JFK search for a 7-day stay (2026-10-08).
function lot(id: number, grandTotal: number | undefined, distance: number, extra: Partial<UnifiedLot> = {}): UnifiedLot {
  return {
    id: `reslab-${id}`,
    source: "reslab",
    sourceId: String(id),
    reslabLocationId: id,
    name: `Lot ${id}`,
    slug: `lot-${id}`,
    address: "",
    city: "",
    state: "",
    latitude: 0,
    longitude: 0,
    amenities: [],
    photos: [],
    distanceFromAirport: distance,
    availability: "available",
    pricing:
      grandTotal === undefined
        ? undefined
        : { minPrice: grandTotal / 7, currency: "$", parkingTypes: [], grandTotal, subtotal: grandTotal * 0.87, feesTotal: 0 },
    ...extra,
  };
}

const a1 = lot(561, 161.12, 1.7);
const safePark = lot(428, 245.19, 1.8);
const purchase = lot(199, 153.46, 1.9);
const arb = lot(237, 119.69, 2.5);
const parkAc = lot(275, 88.43, 2.5);
const JFK = [a1, safePark, purchase, arb, parkAc];

describe("lotTotal / compareByTotal", () => {
  it("compares the card's total (grand total + service fee), cheapest first, unpriced last", () => {
    const unpriced = lot(1, undefined, 0.1);
    const sorted = [unpriced, a1, parkAc, arb].sort(compareByTotal).map((l) => l.reslabLocationId);
    expect(sorted).toEqual([275, 237, 561, 1]);
    expect(lotTotal(parkAc)).toBeGreaterThan(88.43); // includes the service fee
    expect(lotTotal(unpriced)).toBe(Number.POSITIVE_INFINITY);
  });

  it("ties break on distance, then id — deterministic", () => {
    const x = lot(10, 100, 2);
    const y = lot(11, 100, 1);
    const z = lot(12, 100, 1);
    expect([x, z, y].sort(compareByTotal).map((l) => l.id)).toEqual(["reslab-11", "reslab-12", "reslab-10"]);
  });

  it("descending keeps unpriced lots last", () => {
    const unpriced = lot(1, undefined, 0.1);
    expect([unpriced, parkAc, a1].sort(compareByTotalDesc).map((l) => l.reslabLocationId)).toEqual([561, 275, 1]);
  });
});

describe("pickMostBookedLot", () => {
  const ids = JFK.map((l) => l.reslabLocationId!);

  it("pins the clear leader", () => {
    expect(pickMostBookedLot(JFK, ids, new Map([[275, 11], [561, 3]]))?.id).toBe("reslab-275");
  });

  it("no pin below the threshold", () => {
    expect(pickMostBookedLot(JFK, ids, new Map([[275, 2]]))).toBeNull();
  });

  it("no pin on a tie at the top", () => {
    expect(pickMostBookedLot(JFK, ids, new Map([[275, 5], [561, 5], [199, 1]]))).toBeNull();
  });

  it("no pin when the leader is not among the returned lots (sold out) — the runner-up does not inherit it", () => {
    const returned = JFK.filter((l) => l !== parkAc);
    const considered = [...ids]; // still includes 275
    expect(pickMostBookedLot(returned, considered, new Map([[275, 11], [561, 4]]))).toBeNull();
  });

  it("no pin when the leader's total is more than 1.25x the median shown", () => {
    // Safe Park $245 vs a median of ~$153.
    expect(pickMostBookedLot(JFK, ids, new Map([[428, 9]]))).toBeNull();
  });

  it("counts for lots outside this airport are ignored", () => {
    expect(pickMostBookedLot(JFK, ids, new Map([[388, 50], [275, 4]]))?.id).toBe("reslab-275");
  });

  it("never pins a direct lot", () => {
    const direct = { ...lot(900, 90, 1), id: "direct-1", source: "direct" as const };
    expect(pickMostBookedLot([...JFK, direct], [...ids, 900], new Map([[900, 20]]))).toBeNull();
  });
});

describe("rankRecommended / sortLots('popularity')", () => {
  it("JFK today: PARK AC first, then cheapest-first", () => {
    const pinned = pickMostBookedLot(JFK, JFK.map((l) => l.reslabLocationId!), new Map([[275, 11]]));
    expect(sortLots(JFK, "popularity", { recommended: true, pinnedId: pinned?.id ?? null }).map((l) => l.reslabLocationId)).toEqual([
      275, 237, 199, 561, 428,
    ]);
  });

  it("EWR shape: a pinned mid-priced leader stays first, the rest cheapest-first", () => {
    const hilton = lot(320, 117.66, 1);
    const redCarpet = lot(184, 38.32, 3.8);
    const motel6 = lot(62, 91.49, 1.3);
    const ewr = [hilton, motel6, redCarpet];
    expect(rankRecommended(ewr, hilton.id).map((l) => l.reslabLocationId)).toEqual([320, 184, 62]);
  });

  it("no pin → pure cheapest-first", () => {
    expect(rankRecommended(JFK, null)[0].reslabLocationId).toBe(275);
  });

  it("a pinnedId that is not among the lots pins nothing and adds nothing", () => {
    const out = rankRecommended(JFK, "reslab-999");
    expect(out).toHaveLength(JFK.length);
    expect(out[0].reslabLocationId).toBe(275);
  });

  it("ranking switched off → the old distance order", () => {
    expect(sortLots(JFK, "popularity", { recommended: false }).map((l) => l.reslabLocationId)).toEqual([
      561, 428, 199, 237, 275,
    ]);
  });

  it("price_asc uses the same key as the badge", () => {
    expect(sortLots(JFK, "price_asc", { recommended: false })[0].id).toBe(
      lowestTotalLot(JFK, { resultComplete: true })?.id
    );
  });

  it("price sorts put unpriced lots last both ways", () => {
    const unpriced = lot(1, undefined, 0.1);
    const asc = sortLots([unpriced, ...JFK], "price_asc", { recommended: false });
    const desc = sortLots([unpriced, ...JFK], "price_desc", { recommended: false });
    expect(asc.map((l) => l.reslabLocationId)).toEqual([275, 237, 199, 561, 428, 1]);
    expect(desc.map((l) => l.reslabLocationId)).toEqual([428, 561, 199, 237, 275, 1]);
  });
});

describe("lowestTotalLot", () => {
  it("picks the lowest total", () => {
    expect(lowestTotalLot(JFK, { resultComplete: true })?.reslabLocationId).toBe(275);
  });

  it("null when the result is not complete", () => {
    expect(lowestTotalLot(JFK, { resultComplete: false })).toBeNull();
  });

  it("null when nothing is priced", () => {
    expect(lowestTotalLot([lot(1, undefined, 1)], { resultComplete: true })).toBeNull();
  });

  it("never a direct lot that can't be booked yet", () => {
    const direct = { ...lot(900, 10, 1), id: "direct-1", source: "direct" as const };
    expect(lowestTotalLot([...JFK, direct], { resultComplete: true })?.reslabLocationId).toBe(275);
  });
});
