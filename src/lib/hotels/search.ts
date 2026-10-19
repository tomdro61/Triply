/**
 * Park & Stay search and hotel quote (plan v3 §6, PRD M3). Phase A:
 * read-only — nothing here can book.
 *
 * Flow per request (the route has already checked the flag, validated the
 * inputs, applied the per-IP limit and TAKEN THE ONE BUDGET TICKET):
 *   4. resolve each mapped hotel's own lot (no sweep), guard it, apply the
 *      window rules (notice period, minimum stay);
 *   5. in parallel: one LiteAPI `/hotels/rates` for the eligible hotels
 *      (spends the ticket) and one bounded ResLab min-price per eligible lot;
 *   6. classify each parking quote and run the quote checks;
 *   7. price that hotel's USD rates with THAT hotel's own quote (its
 *      grand_total, service fee and the lot's commission C);
 *   8. join: a hotel shows only with a priced rate AND a valid parking quote.
 *
 * Telemetry: none. This module never calls searchParking, logAvailability or
 * logSearchEvent (the import guard and a runtime spy test pin it).
 */

import { calculateServiceFee } from "@/lib/utils/service-fee";
import type { BudgetTicket } from "./liteapi/budget";
import { fetchParkStayRates, type HotelContent, type HotelRatesMapped, type MappedRate } from "./liteapi/rates";
import type { HotelLotEntry } from "./hotel-lots";
import { reslabIdFor } from "./reslab-account";
import {
  channelListNoSweep,
  currentReslabAccount,
  guardHotelContent,
  guardLot,
  lookupLot,
  lotCommissionTerms,
  lotDisplay,
  lotWindowFacts,
  quoteLotParking,
  reportOnce,
  type LotDisplay,
  type ParkingQuoteOutcome,
  type ReslabLot,
} from "./hotel-lot-resolve";
import { lotWindowVerdict, type ParkStayWindow } from "./parking-window";
import { packagePrice, parkingCommission, priceRoom, type PackagePrice, type PriceBasis } from "./pricing";
import type { ParkingQuote } from "./parking-quote";
import { roomRefundabilitySummary, type RoomRefundability } from "./refundability";

// ───────────────────────────── types ─────────────────────────────

export type HiddenReason =
  | "no_account_id"
  | "lot_missing"
  | "lot_transient"
  | "lot_blocked"
  | "lot_wrong_id"
  | "lot_renamed"
  | "lot_moved"
  | "lot_wrong_type"
  | "lot_due_at_location"
  | "lot_refund"
  | "notice_period"
  | "min_stay"
  | "booking_window"
  | "parking_sold_out"
  | "parking_unknown_4xx"
  | "parking_quote_check"
  | "parking_transient"
  | "no_room"
  | "non_usd_collected_fee"
  | "liteapi_mismatch";

/** An honest-empty reason the page can name (§11: "the empty state names the reason"). */
export type EmptyReason = "min_stay" | "booking_window" | "sold_out" | "none_available";

/** 503-class conditions: the route answers "temporarily unavailable". */
export class ParkStayUnavailableError extends Error {
  constructor(
    public reason: "unknown_reslab_account" | "no_ids_for_account" | "all_parking_transient",
    message: string
  ) {
    super(message);
    this.name = "ParkStayUnavailableError";
  }
}

export interface ParkStayOfferRef {
  hotelKey: string;
  roomKey: string;
  offerId: string;
  rateId: string;
  parking: { reslabLotId: number; from: string; to: string };
  parts: { roomSell: number; parking: number; serviceFee: number; atHotel: number };
}

export interface ParkStayRoomOffer {
  roomKey: string;
  roomName: string;
  boardName: string | null;
  refundability: RoomRefundability;
  refundabilitySummary: string;
  priceBasis: PriceBasis;
  price: PackagePrice;
  /** Unsigned, display-only in Phase A (B1 signs it). */
  offerRef: ParkStayOfferRef;
}

export interface ParkStayHotelSummary {
  hotelKey: string;
  liteapiHotelId: string;
  name: string;
  /** True when LiteAPI sent no content for the hotel: the map's name and a placeholder photo are shown. */
  contentFromMap: boolean;
  photoUrl: string | null;
  stars: number | null;
  rating: number | null;
  reviewCount: number | null;
  address: string;
  lot: LotDisplay;
  parking: {
    fromDate: string;
    toDate: string;
    grandTotalCents: number;
    taxTotalCents: number;
    serviceFeeCents: number;
  };
}

export interface ParkStayCard extends ParkStayHotelSummary {
  /** The leading room: the cheapest refundable by headline total if any (D5), else the cheapest. */
  room: ParkStayRoomOffer;
}

export interface ParkStayRunInput {
  airport: { code: string; timezone: string };
  window: ParkStayWindow;
  adults: number;
  ticket: BudgetTicket;
  now: Date;
  /** The route, for Sentry labels. */
  caller: string;
}

export type HiddenCounts = Partial<Record<HiddenReason, number>>;

export type ParkStaySearchOutcome =
  | { kind: "notice_period" }
  | {
      kind: "results";
      cards: ParkStayCard[];
      /** Some hotels could not be checked right now (transient) — never cached. */
      partial: boolean;
      emptyReason: EmptyReason | null;
      sandbox: boolean | null;
      hidden: HiddenCounts;
    };

export type ParkStayHotelOutcome =
  | { kind: "notice_period" }
  | { kind: "unavailable"; reason: HiddenReason }
  | {
      kind: "hotel";
      hotel: ParkStayHotelSummary;
      leading: ParkStayRoomOffer;
      rooms: ParkStayRoomOffer[];
      sandbox: boolean | null;
    };

// ───────────────────────────── pure helpers (exported for tests) ─────────────────────────────

interface PricedRate {
  rate: MappedRate;
  offer: ParkStayRoomOffer;
}

function byHeadlineThenId(a: PricedRate, b: PricedRate): number {
  const d = a.offer.price.headlineTotalCents - b.offer.price.headlineTotalCents;
  return d !== 0 ? d : a.rate.rateId < b.rate.rateId ? -1 : a.rate.rateId > b.rate.rateId ? 1 : 0;
}

const isRefundable = (p: PricedRate) => p.offer.refundability.kind === "free_until";

/** D5: the cheapest refundable rate by HEADLINE total, else the cheapest overall (B14). */
export function chooseLeadingRate<T extends PricedRate>(priced: readonly T[]): T | null {
  if (priced.length === 0) return null;
  const sorted = [...priced].sort(byHeadlineThenId);
  return sorted.find(isRefundable) ?? sorted[0];
}

/**
 * The hotel page's rate list: the cheapest rate per roomKey, by headline, at
 * most `max` — always including the leading refundable rate and the cheapest
 * overall (D5: "hotel page lists both").
 */
export function hotelPageRates<T extends PricedRate>(priced: readonly T[], max: number): T[] {
  const sorted = [...priced].sort(byHeadlineThenId);
  const perKey = new Map<string, T>();
  for (const p of sorted) if (!perKey.has(p.offer.roomKey)) perKey.set(p.offer.roomKey, p);
  const list = [...perKey.values()].slice(0, Math.max(1, max));
  const leading = chooseLeadingRate(sorted);
  if (leading && !list.some((p) => p.offer.roomKey === leading.offer.roomKey)) {
    list[list.length - 1] = perKey.get(leading.offer.roomKey) ?? leading;
    list.sort(byHeadlineThenId);
  }
  return list;
}

function emptyReasonFrom(hidden: HiddenCounts): EmptyReason {
  const reasons = (Object.keys(hidden) as HiddenReason[]).filter((r) => (hidden[r] ?? 0) > 0);
  if (reasons.length > 0 && reasons.every((r) => r === "min_stay")) return "min_stay";
  if (reasons.length > 0 && reasons.every((r) => r === "booking_window")) return "booking_window";
  if (reasons.length > 0 && reasons.every((r) => r === "parking_sold_out" || r === "no_room")) return "sold_out";
  return "none_available";
}

// ───────────────────────────── the run ─────────────────────────────

interface Candidate {
  entry: HotelLotEntry;
  lotId: number;
  location: ReslabLot;
  display: LotDisplay;
}

interface HotelResult {
  candidate: Candidate;
  summary: ParkStayHotelSummary;
  priced: PricedRate[];
}

interface RunResult {
  results: HotelResult[];
  hidden: HiddenCounts;
  considered: number;
  transient: number;
  sandbox: boolean | null;
  /** True when every considered hotel was hidden for the notice period alone. */
  noticeOnly: boolean;
}

function hide(hidden: HiddenCounts, reason: HiddenReason): void {
  hidden[reason] = (hidden[reason] ?? 0) + 1;
}

async function resolveCandidates(
  entries: readonly HotelLotEntry[],
  input: ParkStayRunInput,
  hidden: HiddenCounts
): Promise<{ candidates: Candidate[]; considered: number }> {
  const account = currentReslabAccount();
  if (!account) {
    reportOnce("park_stay_unknown_reslab_account", "Park & Stay: unknown ResLab account fingerprint — failing closed", {
      caller: input.caller,
      stage: "reslab_account",
    });
    throw new ParkStayUnavailableError("unknown_reslab_account", "ResLab account not recognised");
  }
  const withIds: { entry: HotelLotEntry; lotId: number }[] = [];
  for (const entry of entries) {
    const lotId = reslabIdFor(entry, account);
    if (lotId === null) hide(hidden, "no_account_id");
    else withIds.push({ entry, lotId });
  }
  if (withIds.length === 0) {
    reportOnce(`park_stay_no_ids:${account}:${input.airport.code}`, `Park & Stay: no ${account} ResLab ids for ${input.airport.code}`, {
      caller: input.caller,
      stage: "reslab_account",
      extra: { account, airport: input.airport.code },
    });
    throw new ParkStayUnavailableError("no_ids_for_account", `no ${account} ids for ${input.airport.code}`);
  }

  const list = await channelListNoSweep();
  const lookups = await Promise.all(withIds.map(async (w) => ({ ...w, lookup: await lookupLot(w.lotId, list) })));
  const candidates: Candidate[] = [];
  for (const { entry, lotId, lookup } of lookups) {
    if (lookup.kind === "transient") {
      hide(hidden, "lot_transient");
      continue;
    }
    if (lookup.kind === "missing") {
      hide(hidden, "lot_missing");
      reportOnce(`park_stay_map_drift:${entry.key}:missing`, `Park & Stay map drift: ResLab lot ${lotId} (${entry.key}) not found`, {
        caller: input.caller,
        stage: "park_stay_map_drift",
        extra: { hotelKey: entry.key, lotId, account },
      });
      continue;
    }
    const g = guardLot(entry, lotId, lookup.location);
    if (!g.ok) {
      hide(hidden, `lot_${g.reason}`);
      reportOnce(`park_stay_map_drift:${entry.key}:${g.reason}`, `Park & Stay map drift (${g.reason}) on ${entry.key}: ${g.detail}`, {
        caller: input.caller,
        stage: "park_stay_map_drift",
        extra: { hotelKey: entry.key, lotId, reason: g.reason },
      });
      continue;
    }
    const verdict = lotWindowVerdict(input.window, lotWindowFacts(lookup.location), input.airport.timezone, input.now);
    if (verdict !== "ok") {
      hide(hidden, verdict);
      continue;
    }
    candidates.push({ entry, lotId, location: lookup.location, display: lotDisplay(lookup.location) });
  }
  return { candidates, considered: withIds.length };
}

function hideForQuote(o: ParkingQuoteOutcome, c: Candidate, input: ParkStayRunInput, hidden: HiddenCounts): ParkingQuote | null {
  switch (o.kind) {
    case "priced":
      return o.quote;
    case "sold_out":
      hide(hidden, "parking_sold_out");
      return null;
    case "known_4xx":
      hide(hidden, o.reason);
      return null;
    case "unknown_4xx":
      hide(hidden, "parking_unknown_4xx");
      reportOnce(`park_stay_parking_4xx:${o.status}:${o.message}`, `Park & Stay: unrecognised ResLab min-price ${o.status}: ${o.message}`, {
        caller: input.caller,
        stage: "parking_unknown_4xx",
        extra: { hotelKey: c.entry.key, lotId: c.lotId },
      });
      return null;
    case "check_failed":
      hide(hidden, "parking_quote_check");
      reportOnce(`park_stay_quote_check:${c.entry.key}:${o.reason}`, `Park & Stay quote check failed (${o.reason}) on ${c.entry.key}: ${o.detail}`, {
        caller: input.caller,
        stage: "parking_quote_check",
        extra: { hotelKey: c.entry.key, lotId: c.lotId, reason: o.reason },
      });
      return null;
    case "transient":
      hide(hidden, "parking_transient");
      return null;
  }
}

function serviceFeeCentsFor(quote: ParkingQuote): number {
  return Math.round(calculateServiceFee(quote.serviceFeeBaseCents / 100) * 100);
}

function priceHotelRates(
  c: Candidate,
  quote: ParkingQuote,
  serviceFeeCents: number,
  mapped: HotelRatesMapped,
  input: ParkStayRunInput
): PricedRate[] {
  const terms = lotCommissionTerms(c.location);
  const commission = parkingCommission({
    baseCents: quote.commissionBaseCents,
    commissionType: terms.commissionType,
    lotSharePercent: terms.lotSharePercent,
    quoteLocationCommissionCents: quote.locationCommissionCents,
  });
  if (!commission.known) {
    // C = 0: the room prices above SSP; the hotel is never hidden for this.
    reportOnce(`park_stay_commission_unknown:${c.lotId}:${commission.reason}`, `Park & Stay: commission unknown for lot ${c.lotId} (${commission.reason}) — priced with C = 0`, {
      caller: input.caller,
      stage: "commission_unknown",
      extra: { hotelKey: c.entry.key, lotId: c.lotId, reason: commission.reason, ...terms, quoteLocationCommissionCents: quote.locationCommissionCents },
    });
  }
  const out: PricedRate[] = [];
  for (const rate of mapped.rates) {
    if (rate.sspCents === null) {
      reportOnce(`park_stay_no_ssp:${c.entry.liteapi.hotelId}`, `Park & Stay: LiteAPI sent no SSP for hotel ${c.entry.liteapi.hotelId} — sold at the order floor`, {
        caller: input.caller,
        stage: "no_ssp",
      });
    }
    const room = priceRoom({
      roomNetCents: rate.roomNetCents,
      sspCents: rate.sspCents,
      propertyFeesDueAtHotelCents: rate.propertyFeesDueAtHotelCents,
      parkingGrandTotalCents: quote.grandTotalCents,
      serviceFeeCents,
      commissionCents: commission.cents,
    });
    const price = packagePrice({
      room,
      parkingOnlineCents: quote.grandTotalCents,
      serviceFeeCents,
      promoDiscountCents: 0,
      protectionPremiumCents: 0,
    });
    out.push({
      rate,
      offer: {
        roomKey: rate.roomKey,
        roomName: rate.roomName,
        boardName: rate.boardName,
        refundability: rate.refundability,
        refundabilitySummary: roomRefundabilitySummary(rate.refundability),
        priceBasis: room.priceBasis,
        price,
        offerRef: {
          hotelKey: c.entry.key,
          roomKey: rate.roomKey,
          offerId: rate.offerId,
          rateId: rate.rateId,
          parking: { reslabLotId: c.lotId, from: input.window.fromDate, to: input.window.toDate },
          parts: {
            roomSell: price.roomSellCents,
            parking: price.parkingOnlineCents,
            serviceFee: price.serviceFeeCents,
            atHotel: price.propertyFeesDueAtHotelCents,
          },
        },
      },
    });
  }
  return out;
}

function summaryFor(c: Candidate, content: HotelContent | undefined, contentFromMap: boolean, quote: ParkingQuote, serviceFeeCents: number, w: ParkStayWindow): ParkStayHotelSummary {
  return {
    hotelKey: c.entry.key,
    liteapiHotelId: c.entry.liteapi.hotelId,
    name: !contentFromMap && content && content.name.length > 0 ? content.name : c.entry.liteapi.name,
    contentFromMap,
    photoUrl: contentFromMap ? null : (content?.photoUrl ?? null),
    stars: contentFromMap ? null : (content?.stars ?? null),
    rating: contentFromMap ? null : (content?.rating ?? null),
    reviewCount: contentFromMap ? null : (content?.reviewCount ?? null),
    address: !contentFromMap && content && content.address.length > 0 ? content.address : c.display.address,
    lot: c.display,
    parking: {
      fromDate: w.fromDate,
      toDate: w.toDate,
      grandTotalCents: quote.grandTotalCents,
      taxTotalCents: quote.taxTotalCents,
      serviceFeeCents,
    },
  };
}

async function run(entries: readonly HotelLotEntry[], input: ParkStayRunInput, onAnomalies: (a: string[]) => void): Promise<RunResult> {
  const hidden: HiddenCounts = {};
  const { candidates, considered } = await resolveCandidates(entries, input, hidden);

  const noticeOnly = candidates.length === 0 && (hidden.notice_period ?? 0) === considered;
  if (candidates.length === 0) {
    const transient = (hidden.lot_transient ?? 0) + (hidden.parking_transient ?? 0);
    return { results: [], hidden, considered, transient, sandbox: null, noticeOnly };
  }

  // Step 5: both suppliers in parallel. A LiteAPI failure propagates (503);
  // a ResLab failure is per lot.
  const [rates, quotes] = await Promise.all([
    fetchParkStayRates({
      hotelIds: candidates.map((c) => c.entry.liteapi.hotelId),
      checkin: input.window.night,
      checkout: input.window.departureDate,
      adults: input.adults,
      hotelTimeZone: input.airport.timezone,
      ticket: input.ticket,
    }),
    Promise.all(candidates.map((c) => quoteLotParking(c.lotId, input.window.fromDate, input.window.toDate))),
  ]);
  onAnomalies(rates.anomalies);

  const results: HotelResult[] = [];
  candidates.forEach((c, i) => {
    const quote = hideForQuote(quotes[i], c, input, hidden);
    if (!quote) return;
    const mapped = rates.rates.get(c.entry.liteapi.hotelId);
    if (mapped?.hiddenReason) {
      hide(hidden, mapped.hiddenReason);
      return;
    }
    if (!mapped || mapped.rates.length === 0) {
      hide(hidden, "no_room");
      return;
    }
    const content = rates.content.get(c.entry.liteapi.hotelId);
    const verdict = guardHotelContent(c.entry, content);
    if (verdict.kind === "mismatch") {
      hide(hidden, "liteapi_mismatch");
      reportOnce(`park_stay_liteapi_mismatch:${c.entry.key}`, `Park & Stay: LiteAPI hotel does not match the map on ${c.entry.key}: ${verdict.detail}`, {
        caller: input.caller,
        stage: "park_stay_map_drift",
        extra: { hotelKey: c.entry.key, liteapiHotelId: c.entry.liteapi.hotelId },
      });
      return;
    }
    if (verdict.kind === "absent" || verdict.kind === "ok_no_coordinates") {
      reportOnce(`park_stay_liteapi_content:${c.entry.key}:${verdict.kind}`, `Park & Stay: LiteAPI content ${verdict.kind === "absent" ? "missing" : "has no coordinates"} for ${c.entry.key}`, {
        caller: input.caller,
        stage: "liteapi_content",
        extra: { hotelKey: c.entry.key, liteapiHotelId: c.entry.liteapi.hotelId },
      });
    }
    const serviceFeeCents = serviceFeeCentsFor(quote);
    const priced = priceHotelRates(c, quote, serviceFeeCents, mapped, input);
    results.push({
      candidate: c,
      summary: summaryFor(c, content, verdict.kind === "absent", quote, serviceFeeCents, input.window),
      priced,
    });
  });

  const transient = (hidden.lot_transient ?? 0) + (hidden.parking_transient ?? 0);
  return { results, hidden, considered, transient, sandbox: rates.sandbox, noticeOnly: false };
}

function assertNotAllTransient(r: RunResult): void {
  if (r.considered > 0 && r.transient === r.considered) {
    throw new ParkStayUnavailableError("all_parking_transient", `all ${r.considered} hotel lots failed transiently`);
  }
}

/** Results for one airport: every enabled hotel with its own lot. */
export async function searchParkStay(
  entries: readonly HotelLotEntry[],
  input: ParkStayRunInput,
  onAnomalies: (a: string[]) => void
): Promise<ParkStaySearchOutcome> {
  const r = await run(entries, input, onAnomalies);
  if (r.noticeOnly) return { kind: "notice_period" };
  assertNotAllTransient(r);
  const cards: ParkStayCard[] = [];
  for (const h of r.results) {
    const leading = chooseLeadingRate(h.priced);
    if (leading) cards.push({ ...h.summary, room: leading.offer });
  }
  cards.sort((a, b) => a.room.price.headlineTotalCents - b.room.price.headlineTotalCents || (a.hotelKey < b.hotelKey ? -1 : 1));
  return {
    kind: "results",
    cards,
    partial: r.transient > 0,
    emptyReason: cards.length === 0 ? emptyReasonFrom(r.hidden) : null,
    sandbox: r.sandbox,
    hidden: r.hidden,
  };
}

/** One hotel, priced fresh (the hotel page never reuses the search's price, §8.4). */
export async function quoteParkStayHotel(
  entry: HotelLotEntry,
  input: ParkStayRunInput,
  maxRates: number,
  onAnomalies: (a: string[]) => void
): Promise<ParkStayHotelOutcome> {
  const r = await run([entry], input, onAnomalies);
  if (r.noticeOnly) return { kind: "notice_period" };
  assertNotAllTransient(r);
  const h = r.results[0];
  if (!h) {
    const reason = (Object.keys(r.hidden) as HiddenReason[]).find((k) => (r.hidden[k] ?? 0) > 0) ?? "no_room";
    return { kind: "unavailable", reason };
  }
  const leading = chooseLeadingRate(h.priced);
  if (!leading) return { kind: "unavailable", reason: "no_room" };
  return {
    kind: "hotel",
    hotel: h.summary,
    leading: leading.offer,
    rooms: hotelPageRates(h.priced, maxRates).map((p) => p.offer),
    sandbox: r.sandbox,
  };
}

