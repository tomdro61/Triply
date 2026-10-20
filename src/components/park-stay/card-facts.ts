/**
 * What the redesigned Park & Stay card and hotel page say (mockup screens 7
 * and 8, approved by Tom 20 Oct 2026). Pure, so every derived line is
 * testable.
 *
 * Data honesty: every line is built from fields we HAVE (ParkStayCard /
 * ParkStayHotelSummary, LotDisplay, the hotel API answer). A fact we don't
 * have is omitted, never estimated:
 *   - distance: straight-line miles from the lot to the airport, the same
 *     haversine (calculateDistance) the parking LotCard shows;
 *   - valet / self-park: NOT shown — ResLab only tags it as a lot amenity,
 *     which doesn't say which kind this booking gets;
 *   - parking days: NOT counted — ResLab bills 24-hour blocks from the
 *     arrival time, so the dates alone don't give the number exactly;
 *     "1 night + parking to {date}" instead;
 *   - the rating word comes from a fixed mapping of the 0–10 score.
 */

import { calculateDistance } from "@/lib/utils/geo";
import { roomRefundabilityTag, type RoomRefundability } from "@/lib/hotels/refundability";
import type { PackagePrice } from "@/lib/hotels/pricing";
import type { ParkStayRoomOffer } from "@/lib/hotels/search";
import type { LotDisplay } from "@/lib/hotels/hotel-lot-resolve";
import { formatCents, formatNightLabel } from "./format";

/** A fixed mapping of LiteAPI's 0–10 score; below 7 the number stands alone. */
export function ratingLabel(score: number | null): string | null {
  if (score === null || !Number.isFinite(score)) return null;
  if (score >= 9) return "Excellent";
  if (score >= 8) return "Very good";
  if (score >= 7) return "Good";
  return null;
}

/** Straight-line miles, one decimal (as the parking cards), or null when a point is missing. */
export function milesToAirport(lot: { latitude: number; longitude: number }, airport: { latitude: number; longitude: number } | null): number | null {
  if (!airport) return null;
  const pts = [lot.latitude, lot.longitude, airport.latitude, airport.longitude];
  if (!pts.every(Number.isFinite) || (lot.latitude === 0 && lot.longitude === 0)) return null;
  return calculateDistance(airport.latitude, airport.longitude, lot.latitude, lot.longitude);
}

/** What a screen reader hears for the score badge: "Guest rating 8.4 out of 10, Very good". */
export function scoreBadgeLabel(score: number): string {
  const word = ratingLabel(score);
  return `Guest rating ${score.toFixed(1)} out of 10${word ? `, ${word}` : ""}`;
}

export interface MetaPart {
  text: string;
  /** Screen-reader text when `text` is symbols. */
  label?: string;
}

/** The muted line under the name: stars (whole stars only as ★), distance, reviews. Missing facts are left out. */
export function metaParts(input: { stars: number | null; miles: number | null; airportCode: string; reviewCount: number | null }): MetaPart[] {
  const out: MetaPart[] = [];
  const { stars, miles, reviewCount } = input;
  if (stars !== null && stars > 0) {
    out.push(Number.isInteger(stars) && stars <= 5 ? { text: "★".repeat(stars), label: `${stars}-star hotel` } : { text: `${stars}-star` });
  }
  if (miles !== null) out.push({ text: `${miles.toFixed(1)} mi to ${input.airportCode}` });
  if (reviewCount !== null && reviewCount > 0) out.push({ text: `${reviewCount.toLocaleString("en-US")} reviews` });
  return out;
}

export type TagTone = "ok" | "no" | "warn";
export interface RoomTag {
  tone: TagTone;
  text: string;
}

/**
 * The room's cancellation tag: the wording, the "Room:" prefix, the year
 * and "(hotel time)" all come from refundability.ts (every refundability
 * string lives there — the FTC 16 CFR 464 / CA AB 537 item). Free
 * cancellation only for a refundable rate with a well-formed deadline.
 */
export function cancellationTag(r: RoomRefundability): RoomTag {
  const t = roomRefundabilityTag(r);
  return { tone: t.refundable ? "ok" : "no", text: t.text };
}

/** Every tag for a room: its cancellation terms, then money paid at the hotel when there is any. */
export function roomTags(room: Pick<ParkStayRoomOffer, "refundability" | "price">): RoomTag[] {
  const tags = [cancellationTag(room.refundability)];
  if (room.price.propertyFeesDueAtHotelCents > 0) tags.push({ tone: "warn", text: `${formatCents(room.price.propertyFeesDueAtHotelCents)} paid at the hotel` });
  return tags;
}

/** The price column's lead line (no day count: see the header). */
export function packageLabel(returnDate: string): string {
  return `1 night + parking to ${formatNightLabel(returnDate)}`;
}

/** The shuttle fact: a bold lead and the rest. */
export function shuttleFact(lot: Pick<LotDisplay, "shuttleAvailable" | "shuttleSummary">, airportCode: string): { lead: string; rest: string } {
  if (!lot.shuttleAvailable) return { lead: "No airport shuttle", rest: "" };
  return { lead: `Shuttle to ${airportCode}`, rest: lot.shuttleSummary.trim().length > 0 ? lot.shuttleSummary.trim() : "(hours not listed)" };
}

export interface TripStep {
  title: string;
  body: string;
}

/**
 * "Your trip" in three steps, from the search and the lot only. "Room ready
 * from" only when ResLab gives the time; the shuttle only when there is one.
 * No time is invented.
 */
export function tripSteps(input: {
  search: { night: string; departureDate: string; arrivalTime: string; returnDate: string; returnTime: string };
  lot: Pick<LotDisplay, "shuttleAvailable" | "shuttleSummary" | "roomCheckinTime" | "roomCheckoutTime">;
  airportCode: string;
}): TripStep[] {
  const { search, lot, airportCode } = input;
  const ready = lot.roomCheckinTime ? ` (room ready from ${lot.roomCheckinTime})` : "";
  const by = lot.roomCheckoutTime ? ` by ${lot.roomCheckoutTime}` : "";
  const hours = lot.shuttleSummary.trim().length > 0 ? ` Shuttle: ${lot.shuttleSummary.trim()}.` : "";
  return [
    {
      // The arrival time is when PARKING STARTS, not a deadline (review of 310f033, item 5).
      title: `${formatNightLabel(search.night)} · arrive from ${search.arrivalTime}`,
      body: `Check in at the hotel${ready} and leave your car in the hotel's parking.`,
    },
    {
      title: `${formatNightLabel(search.departureDate)} · check out`,
      body: lot.shuttleAvailable ? `Check out${by} and take the shuttle to ${airportCode}.${hours}` : `Check out${by}.`,
    },
    {
      title: `${formatNightLabel(search.returnDate)} · ${search.returnTime}`,
      body: lot.shuttleAvailable ? `Take the shuttle back from ${airportCode} and collect your car.` : "Collect your car.",
    },
  ];
}

/** The rooms to choose from: the leading room first if the list doesn't already carry it. Keyed by rate id. */
export function roomChoices(leading: ParkStayRoomOffer, rooms: readonly ParkStayRoomOffer[]): ParkStayRoomOffer[] {
  return rooms.some((r) => r.offerRef.rateId === leading.offerRef.rateId) ? [...rooms] : [leading, ...rooms];
}

export interface PriceLine {
  label: string;
  /** Negative for a discount. */
  cents: number;
}

/**
 * The price box lines for a room, matching packagePrice() (pricing.ts):
 * headline = roomSell + roomTax + parkingOnline + serviceFee − promoDiscount
 * + protectionPremium + propertyFeesDueAtHotel. A line that is zero is left
 * out (room tax, promo, protection and fees at the hotel are zero in Phase A),
 * so the shown lines always add up to the total.
 */
export function priceLines(price: PackagePrice, roomName: string): PriceLine[] {
  const lines: PriceLine[] = [{ label: `${roomName}, 1 night`, cents: price.roomSellCents }];
  if (price.roomTaxCents > 0) lines.push({ label: "Room tax", cents: price.roomTaxCents });
  lines.push({ label: "Parking, incl. tax", cents: price.parkingOnlineCents });
  lines.push({ label: "Service fee", cents: price.serviceFeeCents });
  if (price.promoDiscountCents > 0) lines.push({ label: "Promo discount", cents: -price.promoDiscountCents });
  if (price.protectionPremiumCents > 0) lines.push({ label: "Parking protection", cents: price.protectionPremiumCents });
  if (price.propertyFeesDueAtHotelCents > 0) lines.push({ label: "Paid at the hotel", cents: price.propertyFeesDueAtHotelCents });
  return lines;
}

/**
 * The "price changed" note. `seen` is the LEADING room's total on the
 * results card, so the plain note only belongs under the leading room; with
 * another room selected it names the leading room, never implying the
 * selected room's total changed. Null when nothing changed.
 */
export function priceChangeNote(input: { seen: number | null; leading: Pick<ParkStayRoomOffer, "roomName" | "price" | "offerRef">; selected: Pick<ParkStayRoomOffer, "offerRef"> }): string | null {
  const { seen, leading, selected } = input;
  const now = leading.price.headlineTotalCents;
  if (seen === null || seen === now) return null;
  if (selected.offerRef.rateId === leading.offerRef.rateId) return `Price updated since your search (was ${formatCents(seen)}).`;
  return `The ${leading.roomName} was ${formatCents(seen)} in your search (it's now ${formatCents(now)}).`;
}
