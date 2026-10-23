import { describe, expect, it } from "vitest";
import { calculateDistance } from "@/lib/utils/geo";
import { ROOM_NON_REFUNDABLE_SUMMARY, roomRefundabilitySummary, roomRefundabilityTag } from "@/lib/hotels/refundability";
import type { PackagePrice } from "@/lib/hotels/pricing";
import type { ParkStayRoomOffer } from "@/lib/hotels/search";
import {
  cancellationTag,
  metaParts,
  milesToAirport,
  packageLabel,
  priceChangeNote,
  priceLines,
  scoreBadgeLabel,
  ratingLabel,
  roomChoices,
  roomTags,
  shuttleFact,
  tripSteps,
} from "../card-facts";

const JFK = { latitude: 40.6413, longitude: -73.7781 };
const doubletreeLot = { latitude: 40.6673095, longitude: -73.7984598 };

const lot = {
  shuttleAvailable: true,
  shuttleSummary: "Every 30 min, 24/7",
  roomCheckinTime: "3:00 PM" as string | null,
  roomCheckoutTime: "11:00 AM" as string | null,
};
const search = { night: "2026-11-10", departureDate: "2026-11-11", arrivalTime: "7:00 PM", returnDate: "2026-11-14", returnTime: "6:00 PM" };

function room(over: Partial<ParkStayRoomOffer> & { rateId: string; atHotel?: number }): ParkStayRoomOffer {
  const { rateId, atHotel = 0, ...rest } = over;
  return {
    roomKey: `rk-${rateId}`,
    roomName: "King room",
    boardName: null,
    refundability: { kind: "non_refundable" },
    refundabilitySummary: ROOM_NON_REFUNDABLE_SUMMARY,
    priceBasis: "ssp",
    price: {
      dueNowCents: 21_200,
      roomSellCents: 14_120,
      roomTaxCents: 0,
      parkingOnlineCents: 6_485,
      serviceFeeCents: 595,
      promoDiscountCents: 0,
      protectionPremiumCents: 0,
      propertyFeesDueAtHotelCents: atHotel,
      headlineTotalCents: 21_200 + atHotel,
    },
    offerRef: {
      hotelKey: "doubletree-jfk",
      roomKey: `rk-${rateId}`,
      offerId: "o",
      rateId,
      parking: { reslabLotId: 132, from: "2026-11-10 19:00:00", to: "2026-11-14 18:00:00" },
      parts: { roomSell: 14_120, parking: 6_485, serviceFee: 595, atHotel },
    },
    ...rest,
  };
}

describe("rating word: a fixed mapping of the 0–10 score", () => {
  it("names only 7 and up; otherwise the number stands alone", () => {
    expect(ratingLabel(9.2)).toBe("Excellent");
    expect(ratingLabel(9)).toBe("Excellent");
    expect(ratingLabel(8.4)).toBe("Very good");
    expect(ratingLabel(7)).toBe("Good");
    expect(ratingLabel(6.9)).toBeNull();
    expect(ratingLabel(null)).toBeNull();
    expect(ratingLabel(Number.NaN)).toBeNull();
  });
});

describe("distance: the same straight-line miles the parking cards show", () => {
  it("is calculateDistance from the airport to the lot, one decimal", () => {
    const miles = milesToAirport(doubletreeLot, JFK);
    expect(miles).toBe(calculateDistance(JFK.latitude, JFK.longitude, doubletreeLot.latitude, doubletreeLot.longitude));
    expect(miles).toBeGreaterThan(1);
    expect(miles).toBeLessThan(3);
  });

  it("no airport point or an unusable lot point → no distance", () => {
    expect(milesToAirport(doubletreeLot, null)).toBeNull();
    expect(milesToAirport({ latitude: 0, longitude: 0 }, JFK)).toBeNull();
    expect(milesToAirport({ latitude: Number.NaN, longitude: 1 }, JFK)).toBeNull();
  });
});

describe("the meta line shows only what we have", () => {
  it("stars as ★ (whole stars), distance, reviews", () => {
    expect(metaParts({ stars: 4, miles: 1.8, airportCode: "JFK", reviewCount: 1920 })).toEqual([
      { text: "★★★★", label: "4-star hotel" },
      { text: "1.8 mi to JFK" },
      { text: "1,920 reviews" },
    ]);
  });

  it("a half star is written out; missing facts are dropped", () => {
    expect(metaParts({ stars: 3.5, miles: null, airportCode: "JFK", reviewCount: null })).toEqual([{ text: "3.5-star" }]);
    expect(metaParts({ stars: null, miles: null, airportCode: "JFK", reviewCount: 0 })).toEqual([]);
  });
});

describe("tags", () => {
  it("free cancellation ONLY for a refundable room with a known deadline, and only for the room", () => {
    expect(cancellationTag({ kind: "free_until", deadlineLocal: "2026-11-09 18:00", timeZone: "America/New_York" })).toEqual({
      tone: "ok",
      text: "Room: free cancellation until Nov 9, 2026 at 6:00 PM (hotel time)",
    });
    expect(cancellationTag({ kind: "free_until", deadlineLocal: "soon", timeZone: "America/New_York" })).toEqual({ tone: "no", text: ROOM_NON_REFUNDABLE_SUMMARY });
    expect(cancellationTag({ kind: "non_refundable" })).toEqual({ tone: "no", text: ROOM_NON_REFUNDABLE_SUMMARY });
  });

  it("money paid at the hotel adds an amber tag; none when it is zero", () => {
    expect(roomTags(room({ rateId: "a" }))).toEqual([{ tone: "no", text: ROOM_NON_REFUNDABLE_SUMMARY }]);
    expect(roomTags(room({ rateId: "a", atHotel: 1_800 }))).toEqual([
      { tone: "no", text: ROOM_NON_REFUNDABLE_SUMMARY },
      { tone: "warn", text: "$18.00 paid at the hotel" },
    ]);
  });

  it("the tag wording IS refundability.ts's summary (year and hotel time kept); a malformed deadline is non-refundable", () => {
    const free = { kind: "free_until" as const, deadlineLocal: "2026-12-31 00:30", timeZone: "America/New_York" };
    expect(roomRefundabilityTag(free)).toEqual({ refundable: true, text: roomRefundabilitySummary(free) });
    expect(roomRefundabilityTag(free).text).toBe("Room: free cancellation until Dec 31, 2026 at 12:30 AM (hotel time)");
    expect(roomRefundabilityTag({ ...free, deadlineLocal: "2026-12-31" })).toEqual({ refundable: false, text: ROOM_NON_REFUNDABLE_SUMMARY });
  });
});

describe("price and shuttle lines", () => {
  it("no parking-day count (ResLab bills 24-hour blocks from the arrival time): 'parking to {date}'", () => {
    expect(packageLabel("2026-11-14")).toBe("1 night + parking to Sat, Nov 14");
  });

  it("shuttle: to the airport with ResLab's hours, '(hours not listed)', or none", () => {
    expect(shuttleFact(lot, "JFK")).toEqual({ lead: "Shuttle to JFK", rest: "Every 30 min, 24/7" });
    expect(shuttleFact({ ...lot, shuttleSummary: "  " }, "JFK")).toEqual({ lead: "Shuttle to JFK", rest: "(hours not listed)" });
    expect(shuttleFact({ ...lot, shuttleAvailable: false }, "JFK")).toEqual({ lead: "No airport shuttle", rest: "" });
  });
});

describe("Your trip: three steps from the search and the lot only", () => {
  it("with a shuttle and known room times", () => {
    expect(tripSteps({ search, lot, airportCode: "JFK" })).toEqual([
      { title: "Tue, Nov 10 · arrive from 7:00 PM", body: "Check in at the hotel (room ready from 3:00 PM) and leave your car in the hotel's parking." },
      { title: "Wed, Nov 11 · check out", body: "Check out by 11:00 AM and take the shuttle to JFK. Shuttle: Every 30 min, 24/7." },
      { title: "Sat, Nov 14 · 6:00 PM", body: "Take the shuttle back from JFK and collect your car." },
    ]);
  });

  it("no shuttle and no room times: no shuttle and no invented time", () => {
    const steps = tripSteps({ search, lot: { shuttleAvailable: false, shuttleSummary: "", roomCheckinTime: null, roomCheckoutTime: null }, airportCode: "EWR" });
    expect(steps.map((s) => s.body)).toEqual(["Check in at the hotel and leave your car in the hotel's parking.", "Check out.", "Collect your car."]);
    expect(JSON.stringify(steps)).not.toMatch(/shuttle|ready from/i);
  });

  it("crosses a month end with calendar dates", () => {
    const steps = tripSteps({ search: { ...search, night: "2026-11-30", departureDate: "2026-12-01", returnDate: "2026-12-03" }, lot, airportCode: "LGA" });
    expect(steps.map((s) => s.title)).toEqual(["Mon, Nov 30 · arrive from 7:00 PM", "Tue, Dec 1 · check out", "Thu, Dec 3 · 6:00 PM"]);
  });
});

describe("room choices", () => {
  it("the leading room is in the list once; added first when the list lacks it", () => {
    const lead = room({ rateId: "lead" });
    const other = room({ rateId: "other" });
    expect(roomChoices(lead, [other, lead]).map((r) => r.offerRef.rateId)).toEqual(["other", "lead"]);
    expect(roomChoices(lead, [other]).map((r) => r.offerRef.rateId)).toEqual(["lead", "other"]);
  });
});

describe("the score badge for screen readers", () => {
  it("reads the score out of 10, with the word when there is one", () => {
    expect(scoreBadgeLabel(8.4)).toBe("Guest rating 8.4 out of 10, Very good");
    expect(scoreBadgeLabel(6.5)).toBe("Guest rating 6.5 out of 10");
  });
});

describe("the price box lines (review of 310f033, item 6)", () => {
  const every: PackagePrice = {
    dueNowCents: 14_120 + 1_130 + 6_485 + 595 - 500 + 1_299,
    roomSellCents: 14_120,
    roomTaxCents: 1_130,
    parkingOnlineCents: 6_485,
    serviceFeeCents: 595,
    promoDiscountCents: 500,
    protectionPremiumCents: 1_299,
    propertyFeesDueAtHotelCents: 1_800,
    headlineTotalCents: 14_120 + 1_130 + 6_485 + 595 - 500 + 1_299 + 1_800,
  };

  it("with every component non-zero, the lines add up to the headline total (promo negative)", () => {
    const lines = priceLines(every, "King room");
    expect(lines.map((l) => l.label)).toEqual(["King room, 1 night", "Room tax", "Parking, incl. tax", "Service fee", "Promo discount", "Parking protection", "Paid at the hotel"]);
    expect(lines.find((l) => l.label === "Promo discount")?.cents).toBe(-500);
    expect(lines.reduce((a, l) => a + l.cents, 0)).toBe(every.headlineTotalCents);
  });

  it("zero components are left out and the rest still add up", () => {
    const plain: PackagePrice = { ...every, roomTaxCents: 0, promoDiscountCents: 0, protectionPremiumCents: 0, propertyFeesDueAtHotelCents: 0, dueNowCents: 21_200, headlineTotalCents: 21_200 };
    const lines = priceLines(plain, "King room");
    expect(lines.map((l) => l.label)).toEqual(["King room, 1 night", "Parking, incl. tax", "Service fee"]);
    expect(lines.reduce((a, l) => a + l.cents, 0)).toBe(plain.headlineTotalCents);
  });
});

describe("the price-changed note follows the room it is about (review of 310f033, item 1)", () => {
  const lead = room({ rateId: "lead" });
  const other = room({ rateId: "other", roomName: "Two queen beds" });

  it("unchanged or no seen value → no note", () => {
    expect(priceChangeNote({ seen: null, leading: lead, selected: lead })).toBeNull();
    expect(priceChangeNote({ seen: lead.price.headlineTotalCents, leading: lead, selected: other })).toBeNull();
  });

  it("the leading room selected → the plain note; another room → names the leading room and both totals", () => {
    expect(priceChangeNote({ seen: 19_900, leading: lead, selected: lead })).toBe("Price updated since your search (was $199.00).");
    expect(priceChangeNote({ seen: 19_900, leading: lead, selected: other })).toBe("The King room was $199.00 in your search (it's now $212.00).");
  });
});
