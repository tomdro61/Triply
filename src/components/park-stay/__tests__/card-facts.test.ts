import { describe, expect, it } from "vitest";
import { calculateDistance } from "@/lib/utils/geo";
import { ROOM_NON_REFUNDABLE_SUMMARY } from "@/lib/hotels/refundability";
import type { ParkStayRoomOffer } from "@/lib/hotels/search";
import {
  cancellationTag,
  metaParts,
  milesToAirport,
  packageLabel,
  ratingLabel,
  roomChoices,
  roomTags,
  shortDeadline,
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
      text: "Room: free cancellation until Nov 9, 6:00 PM",
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

  it("deadline formatting is pure string work", () => {
    expect(shortDeadline("2026-12-31 00:30")).toBe("Dec 31, 12:30 AM");
    expect(shortDeadline("2026-11-09 12:00")).toBe("Nov 9, 12:00 PM");
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
      { title: "Tue, Nov 10 · arrive by 7:00 PM", body: "Check in at the hotel (room ready from 3:00 PM) and leave your car in the hotel's parking." },
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
    expect(steps.map((s) => s.title)).toEqual(["Mon, Nov 30 · arrive by 7:00 PM", "Tue, Dec 1 · check out", "Thu, Dec 3 · 6:00 PM"]);
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
