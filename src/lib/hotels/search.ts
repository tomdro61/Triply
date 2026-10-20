/**
 * Park & Stay search and hotel quote (plan v3 §6, PRD M3). Phase A:
 * read-only — nothing here can book.
 *
 * Flow per request:
 *   0. `prepareParkStay` (BEFORE the route takes a budget ticket): the ResLab
 *      account and this airport's ids — an unknown account or no ids fails
 *      closed without spending a LiteAPI call;
 *   4. resolve each mapped hotel's own lot (no sweep), guard it, apply the
 *      window rules (notice period, minimum stay);
 *   5. in parallel: one LiteAPI `/hotels/rates` for the eligible hotels
 *      (spends the ticket) and one bounded ResLab min-price per eligible lot;
 *   6. classify each parking quote and run the quote checks;
 *   7. price that hotel's USD rates with THAT hotel's own quote (its
 *      grand_total, service fee and the lot's commission C);
 *   8. join: a hotel shows only with a priced rate AND a valid parking quote.
 *
 * Two kinds of hidden hotel:
 *   - POLICY / availability (min stay, notice, sold out, due at the lot, a
 *     non-USD hotel fee, map drift): deterministic — the answer is complete;
 *   - DEGRADED (ResLab transient / auth / unexpected, an unreadable quote or
 *     rates): we don't actually know — the answer is `partial` (never
 *     cached) and, when nothing reliable remains, a 503.
 *
 * Telemetry: none. This module never calls searchParking, logAvailability or
 * logSearchEvent (the import guard and runtime spy tests pin it).
 */

import { calculateServiceFee } from "@/lib/utils/service-fee";
import type { BudgetTicket } from "./liteapi/budget";
import { fetchParkStayRates, type HotelContent, type HotelRatesMapped, type MappedRate } from "./liteapi/rates";
import type { HotelLotEntry, ReslabAccount } from "./hotel-lots";
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
  reportThrottled,
  warmReslab,
  type LotDisplay,
  type LotLookup,
  type ParkingQuoteOutcome,
  type ReslabLot,
} from "./hotel-lot-resolve";
import { lotWindowVerdict, type ParkStayWindow } from "./parking-window";
import { packagePrice, parkingCommission, priceRoom, type PackagePrice, type PriceBasis } from "./pricing";
import type { ParkingQuote } from "./parking-quote";
import { roomRefundabilitySummary, type RoomRefundability } from "./refundability";
import {
  PARK_STAY_AUTH_REPORT_INTERVAL_MS,
  PARK_STAY_MIN_LITEAPI_LEG_MS,
  PARK_STAY_MIN_RESLAB_LEG_MS,
  PARK_STAY_SNAPSHOT_LEG_MS,
  PARK_STAY_TRANSIENT_REPORT_INTERVAL_MS,
} from "./plans";

// ───────────────────────────── types ─────────────────────────────

export type HiddenReason =
  | "no_account_id"
  | "lot_missing"
  | "lot_transient"
  | "lot_auth"
  | "lot_unexpected"
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
  /** due_at_location > 0 or discount ≠ 0 on the quote — deterministic policy. */
  | "parking_quote_policy"
  /** identity mismatch, missing / non-numeric fields, unpriced — a DATA failure. */
  | "parking_quote_invalid"
  | "parking_transient"
  | "parking_auth"
  | "parking_unexpected"
  /** The hotel was in a READABLE answer with no rooms (or LiteAPI said "no availability", 2001). */
  | "no_room"
  /** The hotel was simply absent from a readable answer — not evidence of a sell-out. */
  | "no_rates_returned"
  | "non_usd_collected_fee"
  | "rates_malformed"
  | "liteapi_mismatch";

/** Hidden because we could not get a reliable answer — the result is partial. */
export const DEGRADED_REASONS: ReadonlySet<HiddenReason> = new Set<HiddenReason>([
  "lot_transient",
  "lot_auth",
  "lot_unexpected",
  "parking_transient",
  "parking_auth",
  "parking_unexpected",
  "parking_quote_invalid",
  // An unrecognised ResLab refusal (a new wording of a known rule included):
  // we don't know it means "no parking" — never a confident exclusion.
  "parking_unknown_4xx",
  "rates_malformed",
]);

/** An honest-empty reason the page can name (§11: "the empty state names the reason"). */
export type EmptyReason = "min_stay" | "booking_window" | "sold_out" | "notice_period" | "none_available";

/** 503-class conditions: the route answers "temporarily unavailable". */
export class ParkStayUnavailableError extends Error {
  constructor(
    public reason: "unknown_reslab_account" | "no_ids_for_account" | "no_reliable_result" | "reslab_auth" | "deadline",
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

/** The account and ids, resolved before the budget ticket (H6). */
export interface PreparedParkStay {
  account: ReslabAccount;
  items: { entry: HotelLotEntry; lotId: number }[];
  /** Entries without an id under this account (fail closed for that hotel). */
  noAccountId: number;
}

export interface ParkStayRunInput {
  /**
   * Epoch ms by which the work must be done (request start + PARK_STAY_REQUEST_BUDGET_MS).
   * Every leg is bounded by what is left of it (review pass 2, H1).
   */
  deadlineMs: number;
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
      /** Some hotels could not be checked reliably right now — never cached. */
      partial: boolean;
      /** False when LiteAPI's answer left out a requested hotel: shown, but never micro-cached. */
      cacheable: boolean;
      /** Null when there are cards, or when the empty answer is only partial (we don't know). */
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
 * most `max` — always including the leading rate itself (D5: "hotel page
 * lists both"). The leading rate can share its key with a cheaper rate that
 * SHOWS non-refundable (an RFN tag whose deadline passed or couldn't be read),
 * so the leading rate takes its key's slot.
 */
export function hotelPageRates<T extends PricedRate>(priced: readonly T[], max: number): T[] {
  const sorted = [...priced].sort(byHeadlineThenId);
  const leading = chooseLeadingRate(sorted);
  const perKey = new Map<string, T>();
  for (const p of sorted) if (!perKey.has(p.offer.roomKey)) perKey.set(p.offer.roomKey, p);
  if (leading) perKey.set(leading.offer.roomKey, leading);
  const all = [...perKey.values()].sort(byHeadlineThenId);
  const list = all.slice(0, Math.max(1, max));
  if (leading && !list.includes(leading)) {
    list[list.length - 1] = leading;
    list.sort(byHeadlineThenId);
  }
  return list;
}

function emptyReasonFrom(hidden: HiddenCounts): EmptyReason {
  const reasons = (Object.keys(hidden) as HiddenReason[]).filter((r) => (hidden[r] ?? 0) > 0);
  const all = (ok: (r: HiddenReason) => boolean) => reasons.length > 0 && reasons.every(ok);
  if (all((r) => r === "notice_period")) return "notice_period";
  if (all((r) => r === "min_stay")) return "min_stay";
  if (all((r) => r === "booking_window")) return "booking_window";
  if (all((r) => r === "parking_sold_out" || r === "no_room")) return "sold_out";
  return "none_available";
}

function degradedCount(hidden: HiddenCounts): number {
  let n = 0;
  for (const r of DEGRADED_REASONS) n += hidden[r] ?? 0;
  return n;
}

// ───────────────────────────── step 0: account and ids (before the ticket) ─────────────────────────────

/**
 * Resolve the ResLab account and the entries' ids under it. Pure apart from
 * the fingerprint; throws ParkStayUnavailableError (→ 503) when the account is
 * unknown or no entry has an id under it — BEFORE any budget is spent.
 */
export function prepareParkStay(entries: readonly HotelLotEntry[], airportCode: string, caller: string): PreparedParkStay {
  const account = currentReslabAccount();
  if (!account) {
    reportOnce("park_stay_unknown_reslab_account", "Park & Stay: unknown ResLab account fingerprint — failing closed", {
      caller,
      stage: "reslab_account",
    });
    throw new ParkStayUnavailableError("unknown_reslab_account", "ResLab account not recognised");
  }
  const items: PreparedParkStay["items"] = [];
  let noAccountId = 0;
  for (const entry of entries) {
    const lotId = reslabIdFor(entry, account);
    if (lotId === null) noAccountId++;
    else items.push({ entry, lotId });
  }
  if (items.length === 0) {
    reportOnce(`park_stay_no_ids:${account}:${airportCode}`, `Park & Stay: no ${account} ResLab ids for ${airportCode}`, {
      caller,
      stage: "reslab_account",
      extra: { account, airport: airportCode },
    });
    throw new ParkStayUnavailableError("no_ids_for_account", `no ${account} ids for ${airportCode}`);
  }
  return { account, items, noAccountId };
}

// ───────────────────────────── the run ─────────────────────────────

interface Candidate {
  entry: HotelLotEntry;
  lotId: number;
  location: ReslabLot;
  display: LotDisplay;
}

interface HotelResult {
  summary: ParkStayHotelSummary;
  priced: PricedRate[];
}

interface RunResult {
  results: HotelResult[];
  hidden: HiddenCounts;
  /** Hotels with an id under this account. */
  considered: number;
  sandbox: boolean | null;
}

function hide(hidden: HiddenCounts, reason: HiddenReason): void {
  hidden[reason] = (hidden[reason] ?? 0) + 1;
}

/**
 * Report a degraded per-lot outcome (H2): transient throttled per lot (10 min);
 * auth throttled per process (≈ once a minute — every lot fails together);
 * unexpected throttled per lot per minute.
 */
function reportDegraded(
  stage: "lot" | "parking",
  kind: "transient" | "auth" | "unexpected",
  detail: string,
  c: { entry: HotelLotEntry; lotId: number },
  input: ParkStayRunInput
): void {
  const extra = { hotelKey: c.entry.key, lotId: c.lotId, detail };
  const message = `Park & Stay ${stage} ${kind} on ${c.entry.key} (lot ${c.lotId}): ${detail}`;
  if (kind === "transient") {
    reportThrottled(`park_stay_${stage}_transient:${c.lotId}`, PARK_STAY_TRANSIENT_REPORT_INTERVAL_MS, `Park & Stay ${stage} transient on lot ${c.lotId}`, {
      caller: input.caller,
      stage: `${stage}_transient`,
      extra,
    });
  } else if (kind === "auth") {
    reportThrottled("park_stay_reslab_auth", PARK_STAY_AUTH_REPORT_INTERVAL_MS, message, { caller: input.caller, stage: `${stage}_auth`, extra });
  } else {
    reportThrottled(`park_stay_${stage}_unexpected:${c.lotId}`, PARK_STAY_AUTH_REPORT_INTERVAL_MS, message, { caller: input.caller, stage: `${stage}_unexpected`, extra });
  }
}

function hideForLookup(lookup: Exclude<LotLookup, { kind: "found" }>, item: { entry: HotelLotEntry; lotId: number }, account: ReslabAccount, input: ParkStayRunInput, hidden: HiddenCounts): void {
  switch (lookup.kind) {
    case "missing":
      hide(hidden, "lot_missing");
      reportOnce(`park_stay_map_drift:${item.entry.key}:missing`, `Park & Stay map drift: ResLab lot ${item.lotId} (${item.entry.key}) not found`, {
        caller: input.caller,
        stage: "park_stay_map_drift",
        extra: { hotelKey: item.entry.key, lotId: item.lotId, account },
      });
      return;
    case "transient":
    case "auth":
    case "unexpected":
      hide(hidden, `lot_${lookup.kind}`);
      reportDegraded("lot", lookup.kind, lookup.detail, item, input);
      return;
  }
}

/** Milliseconds left until the request deadline (never negative). */
function timeLeft(input: ParkStayRunInput): number {
  return Math.max(0, input.deadlineMs - Date.now());
}

function requireTime(input: ParkStayRunInput, minMs: number, leg: string): void {
  if (timeLeft(input) < minMs) {
    throw new ParkStayUnavailableError("deadline", `only ${timeLeft(input)} ms left before ${leg}`);
  }
}

/**
 * Authenticate at most ONCE per request, before the first ResLab fan-out
 * (M1). A ResLab auth refusal stops the request here (503) instead of costing
 * N calls with N 401 retries; any other warm-up failure lets the per-lot
 * calls run and classify themselves.
 */
async function warmOnce(state: { warmed: boolean }, input: ParkStayRunInput): Promise<void> {
  if (state.warmed) return;
  state.warmed = true;
  const w = await warmReslab(timeLeft(input));
  if (!w.ok && w.failure.kind === "auth") {
    reportThrottled("park_stay_reslab_auth", PARK_STAY_AUTH_REPORT_INTERVAL_MS, `Park & Stay: ResLab refused our credentials: ${w.failure.detail}`, {
      caller: input.caller,
      stage: "reslab_auth",
    });
    throw new ParkStayUnavailableError("reslab_auth", "ResLab refused our credentials");
  }
}

async function resolveCandidates(prepared: PreparedParkStay, input: ParkStayRunInput, hidden: HiddenCounts, warm: { warmed: boolean }): Promise<Candidate[]> {
  // A snapshot read that doesn't answer in time is treated as "no list" (the Preview path).
  const list = await channelListNoSweep(Math.min(PARK_STAY_SNAPSHOT_LEG_MS, timeLeft(input)), input.caller);
  if (!list) {
    // Preview / cold instance: authenticate once before N parallel getLocation calls (M1).
    await warmOnce(warm, input);
    requireTime(input, PARK_STAY_MIN_RESLAB_LEG_MS, "the lot lookups");
  }
  const lotMs = timeLeft(input);
  const lookups = await Promise.all(prepared.items.map(async (item) => ({ item, lookup: await lookupLot(item.lotId, list, Date.now(), lotMs) })));
  const candidates: Candidate[] = [];
  for (const { item, lookup } of lookups) {
    const { entry, lotId } = item;
    if (lookup.kind !== "found") {
      hideForLookup(lookup, item, prepared.account, input, hidden);
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
  return candidates;
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
    case "check_failed": {
      // due-at-lot / discount are the lot's policy (deterministic); anything
      // else means the quote itself can't be trusted (H5).
      const policy = o.reason === "due_at_location" || o.reason === "discount";
      hide(hidden, policy ? "parking_quote_policy" : "parking_quote_invalid");
      reportOnce(`park_stay_quote_check:${c.entry.key}:${o.reason}`, `Park & Stay quote check failed (${o.reason}) on ${c.entry.key}: ${o.detail}`, {
        caller: input.caller,
        stage: policy ? "parking_quote_policy" : "parking_quote_invalid",
        extra: { hotelKey: c.entry.key, lotId: c.lotId, reason: o.reason },
      });
      return null;
    }
    case "transient":
    case "auth":
    case "unexpected":
      hide(hidden, `parking_${o.kind}`);
      reportDegraded("parking", o.kind, o.detail, c, input);
      return null;
  }
}

function serviceFeeCentsFor(quote: ParkingQuote): number {
  return Math.round(calculateServiceFee(quote.serviceFeeBaseCents / 100) * 100);
}

function priceHotelRates(c: Candidate, quote: ParkingQuote, serviceFeeCents: number, mapped: HotelRatesMapped, input: ParkStayRunInput): PricedRate[] {
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
      reportOnce(`park_stay_no_ssp:${c.entry.liteapi.hotelId}`, `Park & Stay: LiteAPI sent no SSP for hotel ${c.entry.liteapi.hotelId} — sold at max(order floor, net)`, {
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

async function run(prepared: PreparedParkStay, input: ParkStayRunInput, onAnomalies: (a: string[]) => void): Promise<RunResult> {
  const hidden: HiddenCounts = {};
  if (prepared.noAccountId > 0) hidden.no_account_id = prepared.noAccountId;
  const considered = prepared.items.length;
  const warm = { warmed: false };
  const candidates = await resolveCandidates(prepared, input, hidden, warm);
  if (candidates.length === 0) return { results: [], hidden, considered, sandbox: null };

  // Step 5: both suppliers in parallel. A LiteAPI failure propagates (503);
  // a ResLab failure is per lot. Warm-up only if the lookups didn't already
  // (the list came from the snapshot) — at most once per request.
  await warmOnce(warm, input);
  // Not enough time left for a useful LiteAPI call: 503 without calling it.
  // "Unspent" means no LiteAPI request is sent — the budget RPC already
  // debited the day's count when the ticket was taken, so this 503 still
  // counts against the daily budget.
  requireTime(input, PARK_STAY_MIN_LITEAPI_LEG_MS, "LiteAPI");
  const legMs = timeLeft(input);
  const [rates, quotes] = await Promise.all([
    fetchParkStayRates({
      hotelIds: candidates.map((c) => c.entry.liteapi.hotelId),
      checkin: input.window.night,
      checkout: input.window.departureDate,
      adults: input.adults,
      hotelTimeZone: input.airport.timezone,
      now: input.now,
      ticket: input.ticket,
      timeoutMs: legMs,
    }),
    Promise.all(candidates.map((c) => quoteLotParking(c.lotId, input.window.fromDate, input.window.toDate, Date.now(), legMs))),
  ]);
  onAnomalies(rates.anomalies);

  const results: HotelResult[] = [];
  candidates.forEach((c, i) => {
    const quote = hideForQuote(quotes[i], c, input, hidden);
    if (!quote) return;
    const mapped = rates.rates.get(c.entry.liteapi.hotelId);
    if (mapped?.hiddenReason) {
      hide(hidden, mapped.hiddenReason);
      if (mapped.hiddenReason === "rates_malformed") {
        reportOnce(`park_stay_rates_malformed:${c.entry.key}`, `Park & Stay: LiteAPI rates for ${c.entry.key} could not be read (${mapped.malformed} malformed)`, {
          caller: input.caller,
          stage: "liteapi_rates_malformed",
          extra: { hotelKey: c.entry.key, liteapiHotelId: c.entry.liteapi.hotelId },
        });
      }
      return;
    }
    if (!mapped) {
      // Absent from a readable answer: LiteAPI didn't say "no rooms", it said nothing.
      hide(hidden, "no_rates_returned");
      return;
    }
    if (mapped.rates.length === 0) {
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
    results.push({
      summary: summaryFor(c, content, verdict.kind === "absent", quote, serviceFeeCents, input.window),
      priced: priceHotelRates(c, quote, serviceFeeCents, mapped, input),
    });
  });
  return { results, hidden, considered, sandbox: rates.sandbox };
}

/** No results, and every considered hotel missed the notice period (pre-filter or ResLab's own 4xx) — M3. */
function isNoticeOnly(r: RunResult): boolean {
  return r.results.length === 0 && r.considered > 0 && (r.hidden.notice_period ?? 0) === r.considered;
}

function assertSomethingReliable(r: RunResult): void {
  if (r.considered > 0 && degradedCount(r.hidden) === r.considered) {
    throw new ParkStayUnavailableError("no_reliable_result", `all ${r.considered} hotels failed to check (${JSON.stringify(r.hidden)})`);
  }
}

/** Results for one airport: every enabled hotel with its own lot. */
export async function searchParkStay(prepared: PreparedParkStay, input: ParkStayRunInput, onAnomalies: (a: string[]) => void): Promise<ParkStaySearchOutcome> {
  const r = await run(prepared, input, onAnomalies);
  if (isNoticeOnly(r)) return { kind: "notice_period" };
  assertSomethingReliable(r);
  const cards: ParkStayCard[] = [];
  for (const h of r.results) {
    const leading = chooseLeadingRate(h.priced);
    if (leading) cards.push({ ...h.summary, room: leading.offer });
  }
  cards.sort((a, b) => a.room.price.headlineTotalCents - b.room.price.headlineTotalCents || (a.hotelKey < b.hotelKey ? -1 : 1));
  const partial = degradedCount(r.hidden) > 0;
  return {
    kind: "results",
    cards,
    partial,
    cacheable: (r.hidden.no_rates_returned ?? 0) === 0,
    // An empty answer that is only partial is "we couldn't check", not "none available" (M2).
    emptyReason: cards.length === 0 && !partial ? emptyReasonFrom(r.hidden) : null,
    sandbox: r.sandbox,
    hidden: r.hidden,
  };
}

/** One hotel, priced fresh (the hotel page never reuses the search's price, §8.4). */
export async function quoteParkStayHotel(
  prepared: PreparedParkStay,
  input: ParkStayRunInput,
  maxRates: number,
  onAnomalies: (a: string[]) => void
): Promise<ParkStayHotelOutcome> {
  const r = await run(prepared, input, onAnomalies);
  if (isNoticeOnly(r)) return { kind: "notice_period" };
  assertSomethingReliable(r);
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
