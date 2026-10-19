/**
 * Each mapped hotel's OWN ResLab lot: resolve it, guard it, and quote it
 * (plan v3 §3.4, §6 steps 4–6). Replaces pairing.ts, which paired every
 * hotel with the airport's cheapest lot (B1).
 *
 * The ONLY hotels module allowed to import @/lib/reslab/* (the import guard
 * enforces it). It never calls `searchParking` or `getChannelLocationsCached`:
 *   - lots come from `getChannelLocationsNoSweep()` (never calls ResLab;
 *     warmed from the shared snapshot in Production), else from
 *     `reslab.getLocation(id)` — cached 4 h per process, single-flight,
 *     bounded at 4 s, 10-minute backoff after a transient failure;
 *   - prices come from one `reslab.getMinPrice` per lot — bounded at 8 s,
 *     cached 5 minutes on (lot, from, to).
 * So a Park & Stay request makes zero `/locations?page=N` calls and writes no
 * parking telemetry (`availability_log`, `search_events` — those live inside
 * searchParking, which this module does not touch).
 *
 * `request()` in reslab/client.ts can take getToken (10 s) + the call (10 s)
 * + a 401 retry, and `getLocation` has no per-call timeout, so every call
 * here goes through `bounded()`.
 */

import { reslab, ReslabError, stripHtml, warmReslabToken, type ReslabLocation } from "@/lib/reslab/client";
import { BLOCKED_RESLAB_LOCATION_IDS, getChannelLocationsNoSweep } from "@/lib/reslab/search";
import { keyFingerprint } from "@/lib/reslab/location-snapshot";
import { captureAPIError } from "@/lib/sentry";
import { bounded, BoundedTimeoutError } from "@/lib/utils/bounded";
import { convertTo12Hour } from "@/lib/utils/time";
import type { HotelLotEntry, ReslabAccount } from "./hotel-lots";
import { reslabAccountForFingerprint } from "./reslab-account";
import { distanceMeters, sameNameTokens } from "./geo";
import { checkParkingQuote, type ParkingQuote, type QuoteCheckFailure } from "./parking-quote";
import type { LotWindowFacts } from "./parking-window";
import type { HotelContent } from "./liteapi/rates";
import {
  PARK_STAY_MAX_DRIFT_M,
  RESLAB_GET_LOCATION_TIMEOUT_MS,
  RESLAB_LOCATION_BACKOFF_MS,
  RESLAB_LOCATION_CACHE_TTL_MS,
  RESLAB_LOCATION_FAILURE_BACKOFF_MS,
  RESLAB_LOCATION_TIMEOUT_BACKOFF_MS,
  RESLAB_MIN_PRICE_TIMEOUT_MS,
  RESLAB_TOKEN_WARM_TIMEOUT_MS,
  RESLAB_QUOTE_CACHE_TTL_MS,
} from "./plans";

/** The ResLab location record, re-exported so other hotels modules never import @/lib/reslab/* themselves. */
export type ReslabLot = ReslabLocation;

// ───────────────────────────── account ─────────────────────────────

/** The ResLab account this process talks to, or null (fail closed). */
export function currentReslabAccount(): ReslabAccount | null {
  return reslabAccountForFingerprint(keyFingerprint());
}

// ───────────────────────────── once-per-process reports ─────────────────────────────

const reported = new Set<string>();

/**
 * One Sentry event per (key) per process. `stage` groups them; drift alerts
 * use `park_stay_map_drift` (the signal the runbook keys off, §3.5).
 */
export function reportOnce(
  key: string,
  message: string,
  context: { caller: string; stage: string; extra?: Record<string, unknown> }
): void {
  if (reported.has(key)) return;
  reported.add(key);
  captureAPIError(new Error(message), {
    endpoint: context.caller,
    method: "GET",
    stage: context.stage,
    extra: context.extra,
  });
}

const lastReportAt = new Map<string, number>();
const LAST_REPORT_MAX_KEYS = 1_000;

/**
 * At most one Sentry event per (key) per `intervalMs` — for recurring
 * per-lot failures (transient ResLab trouble), so an outage is visible
 * without one event per request.
 */
export function reportThrottled(
  key: string,
  intervalMs: number,
  message: string,
  context: { caller: string; stage: string; extra?: Record<string, unknown> },
  now: number = Date.now()
): void {
  const last = lastReportAt.get(key);
  if (last !== undefined && now - last < intervalMs) return;
  lastReportAt.delete(key);
  lastReportAt.set(key, now);
  while (lastReportAt.size > LAST_REPORT_MAX_KEYS) {
    const oldest = lastReportAt.keys().next().value;
    if (oldest === undefined) break;
    lastReportAt.delete(oldest);
  }
  captureAPIError(new Error(message), { endpoint: context.caller, method: "GET", stage: context.stage, extra: context.extra });
}

/** Every time (auth failures, our own defects): Sentry groups them into one issue. */
export function reportAlways(error: Error, context: { caller: string; stage: string; extra?: Record<string, unknown> }): void {
  captureAPIError(error, { endpoint: context.caller, method: "GET", stage: context.stage, extra: context.extra });
}

// ───────────────────────────── error classification ─────────────────────────────

/**
 * What a failed ResLab CALL means. Only genuinely unknown outcomes are
 * "transient"; a 401/403 (after the client's own token retry) is `auth`, and
 * anything we can't explain is `unexpected` — neither is a blip to retry
 * quietly.
 */
export type CallFailure =
  | { kind: "transient"; detail: string; timeout: boolean }
  | { kind: "auth"; detail: string }
  | { kind: "not_found"; detail: string }
  | { kind: "client_4xx"; status: number; detail: string }
  | { kind: "unexpected"; detail: string };

function errorDetail(err: unknown): string {
  if (err instanceof ReslabError) return `ResLab ${err.statusCode}: ${err.message.slice(0, 200)}`;
  return err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : String(err).slice(0, 200);
}

export function classifyCallError(err: unknown): CallFailure {
  const detail = errorDetail(err);
  if (err instanceof BoundedTimeoutError) return { kind: "transient", detail, timeout: true };
  if (err instanceof ReslabError) {
    const s = err.statusCode;
    if (s === 401 || s === 403) return { kind: "auth", detail };
    if (s === 404) return { kind: "not_found", detail };
    if (s === 0 || s === 408 || s === 429 || s >= 500) return { kind: "transient", detail, timeout: false };
    if (s >= 400 && s < 500) return { kind: "client_4xx", status: s, detail };
    return { kind: "unexpected", detail };
  }
  // reslabFetch's own abort, and undici's network failure ("fetch failed").
  if (err instanceof Error && (err.name === "AbortError" || (err.name === "TypeError" && /fetch failed/i.test(err.message)))) {
    return { kind: "transient", detail, timeout: err.name === "AbortError" };
  }
  return { kind: "unexpected", detail };
}

// ───────────────────────────── token warm-up (M1) ─────────────────────────────

export type WarmResult = { ok: true } | { ok: false; failure: CallFailure };

/**
 * Authenticate once before a fan-out, so N parallel ResLab calls on a cold
 * instance don't each POST /authenticate (the client's token cache has no
 * single-flight). Bounded by `timeoutMs` (≤ RESLAB_TOKEN_WARM_TIMEOUT_MS).
 * Returns the classified failure: the caller refuses the whole request on
 * `auth` BEFORE fanning out (a revoked key must not cost N calls + N 401
 * retries per request); any other failure lets the per-lot calls proceed and
 * classify themselves.
 */
export async function warmReslab(timeoutMs: number = RESLAB_TOKEN_WARM_TIMEOUT_MS): Promise<WarmResult> {
  try {
    await bounded(warmReslabToken(), Math.min(timeoutMs, RESLAB_TOKEN_WARM_TIMEOUT_MS), "reslab token warm-up");
    return { ok: true };
  } catch (err) {
    return { ok: false, failure: classifyCallError(err) };
  }
}

// ───────────────────────────── lot lookup ─────────────────────────────

export type LotLookup =
  | { kind: "found"; location: ReslabLocation }
  /** A definite miss: absent from a complete list, or a ResLab 404 on the id. */
  | { kind: "missing" }
  /** Unknown — timeout, 5xx, 429, network, or inside the backoff window. */
  | { kind: "transient"; detail: string }
  /** ResLab refused our credentials (after the client's token retry). */
  | { kind: "auth"; detail: string }
  /** A failure we can't explain (an odd 4xx, a body that isn't this lot, our own throw). */
  | { kind: "unexpected"; detail: string };

interface CachedLocation {
  at: number;
  location: ReslabLocation;
}
const locationCache = new Map<number, CachedLocation>();
/** Per-lot backoff, remembering WHY so a lookup inside it answers with the same kind. */
interface LocationBackoff {
  until: number;
  kind: "transient" | "auth" | "unexpected";
  detail: string;
}
const locationBackoff = new Map<number, LocationBackoff>();
const locationInflight = new Map<number, Promise<LotLookup>>();

const isThisLot = (location: ReslabLocation | null | undefined, id: number): location is ReslabLocation =>
  !!location && typeof location === "object" && location.id === id;

function backOff(id: number, now: number, ms: number, kind: LocationBackoff["kind"], detail: string): void {
  locationBackoff.set(id, { until: now + ms, kind, detail });
}

async function fetchLocation(id: number, now: number, timeoutMs: number): Promise<LotLookup> {
  const call = reslab.getLocation(id);
  // A late answer (after our 4 s bound) still fills the cache, so a cold
  // instance's slow first request doesn't cost the next one too (M1).
  void call.then(
    (late) => {
      if (isThisLot(late, id)) {
        locationCache.set(id, { at: Date.now(), location: late });
        locationBackoff.delete(id);
      }
    },
    () => {}
  );
  try {
    const location = await bounded(call, Math.min(timeoutMs, RESLAB_GET_LOCATION_TIMEOUT_MS), `reslab.getLocation(${id})`);
    if (!isThisLot(location, id)) {
      const detail = "getLocation returned a body that is not this lot";
      backOff(id, now, RESLAB_LOCATION_FAILURE_BACKOFF_MS, "unexpected", detail);
      return { kind: "unexpected", detail };
    }
    locationCache.set(id, { at: now, location });
    return { kind: "found", location };
  } catch (err) {
    const f = classifyCallError(err);
    switch (f.kind) {
      case "not_found":
        // Definite: no backoff; the caller hides the hotel and alerts.
        return { kind: "missing" };
      case "transient":
        // Our own 4 s bound is not ResLab refusing: retry within a minute
        // (the late answer may fill the cache first). Real 5xx / 429: 10 min.
        backOff(id, now, f.timeout ? RESLAB_LOCATION_TIMEOUT_BACKOFF_MS : RESLAB_LOCATION_BACKOFF_MS, "transient", f.detail);
        return { kind: "transient", detail: f.detail };
      // A revoked key or an inexplicable failure repeats on every request:
      // back off (≥ 60 s) so it costs one call per lot per minute, not N per request.
      case "auth":
        backOff(id, now, RESLAB_LOCATION_FAILURE_BACKOFF_MS, "auth", f.detail);
        return { kind: "auth", detail: f.detail };
      case "client_4xx":
      case "unexpected":
        backOff(id, now, RESLAB_LOCATION_FAILURE_BACKOFF_MS, "unexpected", f.detail);
        return { kind: "unexpected", detail: f.detail };
    }
  }
}

/**
 * Look up one lot by id. `list` is `getChannelLocationsNoSweep()`'s answer
 * (complete when non-null) — when present it is authoritative and no ResLab
 * call is made.
 */
export async function lookupLot(
  id: number,
  list: readonly ReslabLocation[] | null,
  now: number = Date.now(),
  timeoutMs: number = RESLAB_GET_LOCATION_TIMEOUT_MS
): Promise<LotLookup> {
  if (list) {
    const location = list.find((l) => l.id === id);
    return location ? { kind: "found", location } : { kind: "missing" };
  }
  const cached = locationCache.get(id);
  if (cached && now - cached.at < RESLAB_LOCATION_CACHE_TTL_MS) return { kind: "found", location: cached.location };
  const backoff = locationBackoff.get(id);
  if (backoff && now < backoff.until) return { kind: backoff.kind, detail: `in backoff after: ${backoff.detail}` };
  const inflight = locationInflight.get(id);
  if (inflight) return inflight;
  const p = fetchLocation(id, now, timeoutMs).finally(() => locationInflight.delete(id));
  locationInflight.set(id, p);
  return p;
}

/**
 * The no-sweep list, or null (Preview / a cold instance / the snapshot read
 * did not answer within `timeoutMs`). Never calls ResLab; never throws.
 */
export async function channelListNoSweep(timeoutMs: number): Promise<readonly ReslabLocation[] | null> {
  if (timeoutMs <= 0) return null;
  try {
    return await bounded(getChannelLocationsNoSweep(), timeoutMs, "getChannelLocationsNoSweep");
  } catch {
    return null;
  }
}

// ───────────────────────────── the guard (§3.4) ─────────────────────────────

export type LotGuardFailure = "blocked" | "wrong_id" | "renamed" | "moved" | "wrong_type" | "due_at_location" | "refund";

export function normaliseLotName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const truthy = (v: boolean | number | undefined | null) => v === true || v === 1;

/**
 * Checks 1–3: the lot is not blocked, is the same lot (normalised name equal,
 * within 300 m), and is still suitable (parking_room, nothing due at the
 * lot, every parking policy refunds 100 %). Pure.
 */
export function guardLot(entry: HotelLotEntry, expectedId: number, location: ReslabLocation): { ok: true } | { ok: false; reason: LotGuardFailure; detail: string } {
  if (BLOCKED_RESLAB_LOCATION_IDS.has(location.id)) return { ok: false, reason: "blocked", detail: `lot ${location.id} is in BLOCKED_RESLAB_LOCATION_IDS` };
  if (location.id !== expectedId) return { ok: false, reason: "wrong_id", detail: `asked for ${expectedId}, got ${location.id}` };
  if (normaliseLotName(location.name ?? "") !== normaliseLotName(entry.reslab.name)) {
    return { ok: false, reason: "renamed", detail: `ResLab name ${JSON.stringify(location.name)} ≠ map ${JSON.stringify(entry.reslab.name)}` };
  }
  const lat = Number.parseFloat(location.latitude);
  const lng = Number.parseFloat(location.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, reason: "moved", detail: "lot has no usable coordinates" };
  const d = distanceMeters(lat, lng, entry.reslab.latitude, entry.reslab.longitude);
  if (d > PARK_STAY_MAX_DRIFT_M) return { ok: false, reason: "moved", detail: `lot is ${d} m from the recorded point` };
  if (location.type !== "parking_room") return { ok: false, reason: "wrong_type", detail: `type ${JSON.stringify(location.type ?? null)}` };
  if (truthy(location.parking_due_at_location)) return { ok: false, reason: "due_at_location", detail: "parking_due_at_location is set" };
  const parkingPolicies = (location.cancellation_policies ?? []).filter((p) => p && p.type === "parking");
  if (parkingPolicies.length === 0 || !parkingPolicies.every((p) => p.percentage === 100)) {
    return { ok: false, reason: "refund", detail: `parking policies ${JSON.stringify(parkingPolicies.map((p) => p.percentage))}` };
  }
  return { ok: true };
}

export type ContentVerdict =
  | { kind: "ok" }
  /** Name matches but LiteAPI sent no coordinates: shown (the id is authoritative), reported once. */
  | { kind: "ok_no_coordinates" }
  | { kind: "absent" }
  | { kind: "mismatch"; detail: string };

/**
 * Check 4: the LiteAPI hotel id is authoritative (hand-checked, stable). When
 * `hotels[]` carries the entry it must match the map's name by tokens and lie
 * within 300 m — a mismatch is positive evidence of the worst failure (a room
 * where the car isn't) and hides the hotel. Absence is NOT evidence: the
 * hotel shows under the map's name with a placeholder photo.
 */
export function guardHotelContent(entry: HotelLotEntry, content: HotelContent | undefined): ContentVerdict {
  if (!content) return { kind: "absent" };
  if (!sameNameTokens(content.name, entry.liteapi.name)) {
    return { kind: "mismatch", detail: `LiteAPI name ${JSON.stringify(content.name)} ≠ map ${JSON.stringify(entry.liteapi.name)}` };
  }
  if (content.latitude === null || content.longitude === null) return { kind: "ok_no_coordinates" };
  const d = distanceMeters(content.latitude, content.longitude, entry.liteapi.latitude, entry.liteapi.longitude);
  if (d > PARK_STAY_MAX_DRIFT_M) return { kind: "mismatch", detail: `LiteAPI hotel is ${d} m from the recorded point` };
  return { kind: "ok" };
}

// ───────────────────────────── lot facts for display and the window rules ─────────────────────────────

export interface LotDisplay {
  reslabLotId: number;
  name: string;
  address: string;
  shuttleAvailable: boolean;
  /** Plain text (ResLab fields are HTML). Empty when ResLab has none. */
  shuttleSummary: string;
  shuttleDetails: string;
  /** "4:00 PM", or null when ResLab has none (omit the field). */
  roomCheckinTime: string | null;
  roomCheckoutTime: string | null;
  frontDeskHours: string | null;
  specialConditions: string;
}

function hhmmTo12(v: string | null | undefined): string | null {
  if (typeof v !== "string" || !/^\d{1,2}:\d{2}(:\d{2})?$/.test(v.trim())) return null;
  const out = convertTo12Hour(v.trim());
  return out.length > 0 ? out : null;
}

export function lotDisplay(location: ReslabLocation): LotDisplay {
  const fd = stripHtml(location.front_desk_hours ?? null);
  return {
    reslabLotId: location.id,
    name: location.name,
    address: location.address ?? "",
    shuttleAvailable: truthy(location.shuttle_available),
    shuttleSummary: stripHtml(location.shuttle_info_summary ?? null),
    shuttleDetails: stripHtml(location.shuttle_info_details ?? null),
    roomCheckinTime: hhmmTo12(location.checkin_time),
    roomCheckoutTime: hhmmTo12(location.checkout_time),
    frontDeskHours: fd.length > 0 ? fd : null,
    specialConditions: stripHtml(location.special_conditions ?? null),
  };
}

export function lotWindowFacts(location: ReslabLocation): LotWindowFacts {
  return {
    hoursBeforeReservation: Number(location.hours_before_reservation) || 0,
    minimumBookingDays: Number(location.minimum_booking_days) || 0,
    dailyOrHourly: location.daily_or_hourly === "daily" ? "daily" : "hourly",
    timeZone: location.timezone?.code ?? null,
  };
}

/** The commission inputs the lot carries (the lot's share; §5.1). */
export function lotCommissionTerms(location: ReslabLocation): { commissionType: string | null; lotSharePercent: number | null } {
  const pc = typeof location.parking_commission === "number" ? location.parking_commission : Number.NaN;
  return {
    commissionType: typeof location.parking_commission_type === "string" ? location.parking_commission_type : null,
    lotSharePercent: Number.isFinite(pc) ? pc : null,
  };
}

// ───────────────────────────── the parking quote (§6 step 6) ─────────────────────────────

export type KnownParkingRefusal = "min_stay" | "notice_period" | "booking_window";

export type ParkingQuoteOutcome =
  | { kind: "priced"; quote: ParkingQuote }
  | { kind: "sold_out" }
  | { kind: "known_4xx"; reason: KnownParkingRefusal; message: string }
  | { kind: "unknown_4xx"; status: number; message: string }
  | { kind: "check_failed"; reason: QuoteCheckFailure; detail: string }
  | { kind: "transient"; detail: string }
  | { kind: "auth"; detail: string }
  /** Our own throw (e.g. while checking the quote) or an inexplicable failure — reported, NOT transient. */
  | { kind: "unexpected"; detail: string };

/**
 * ResLab's min-price refusals we recognise. Patterns from messages already
 * seen in production ("Minimum number of hours before parking reservation is
 * N", "Please choose a date in the future", "Bookings only accepted within N
 * days"); the minimum-stay wording is a best guess until V3 reads it live on
 * lots 304 and 323. An unrecognised 4xx is hidden and reported once per
 * message — never treated as success.
 */
export function classifyParkingRefusal(message: string): KnownParkingRefusal | null {
  if (/minimum number of hours/i.test(message) || /date in the future/i.test(message)) return "notice_period";
  if (/only accepted within/i.test(message)) return "booking_window";
  if (/minimum (number of )?(booking )?days|minimum (stay|booking)|at least \d+ days?/i.test(message)) return "min_stay";
  return null;
}

/** Strip ResLab's "API request failed: " prefix and any JSON wrapper down to the human message. */
function reslabMessage(err: ReslabError): string {
  const raw = err.message.replace(/^API request failed:\s*/, "");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") {
      return parsed.message.slice(0, 300);
    }
  } catch {
    // not JSON — use the text as is
  }
  return raw.slice(0, 300);
}

interface CachedQuote {
  at: number;
  ttlMs: number;
  outcome: ParkingQuoteOutcome;
}
const quoteCache = new Map<string, CachedQuote>();
const quoteInflight = new Map<string, Promise<ParkingQuoteOutcome>>();
const QUOTE_CACHE_MAX_KEYS = 2_000;

async function fetchQuote(lotId: number, fromDate: string, toDate: string, timeoutMs: number): Promise<ParkingQuoteOutcome> {
  let raw: unknown;
  try {
    raw = await bounded(
      reslab.getMinPrice(lotId, {
        type: "parking",
        reservation_type: "parking",
        from_date: fromDate,
        to_date: toDate,
        number_of_spots: 1,
      }),
      Math.min(timeoutMs, RESLAB_MIN_PRICE_TIMEOUT_MS),
      `reslab.getMinPrice(${lotId})`
    );
  } catch (err) {
    const f = classifyCallError(err);
    switch (f.kind) {
      case "transient":
        return { kind: "transient", detail: f.detail };
      case "auth":
        return { kind: "auth", detail: f.detail };
      case "not_found":
        // The lot resolved a moment ago, so a min-price 404 is not "no parking":
        // we don't know what it means — degraded, never a confident exclusion.
        return { kind: "unexpected", detail: f.detail };
      case "client_4xx": {
        if (!(err instanceof ReslabError)) return { kind: "unexpected", detail: f.detail };
        const message = reslabMessage(err);
        const known = classifyParkingRefusal(message);
        return known ? { kind: "known_4xx", reason: known, message } : { kind: "unknown_4xx", status: err.statusCode, message };
      }
      case "unexpected":
        return { kind: "unexpected", detail: f.detail };
    }
  }
  // Our own code from here on: a throw is a defect, never a "transient".
  try {
    const checked = checkParkingQuote(raw);
    if (checked.kind === "priced") return { kind: "priced", quote: checked.quote };
    if (checked.kind === "sold_out") return { kind: "sold_out" };
    return { kind: "check_failed", reason: checked.reason, detail: checked.detail };
  } catch (err) {
    return { kind: "unexpected", detail: `checking the quote threw: ${errorDetail(err)}` };
  }
}

/**
 * How long an outcome is reused: definitive answers for the quote TTL; auth
 * and unexpected failures briefly (a negative cache, so a revoked key costs
 * one call per lot per minute, not one per request); transient, unknown 4xx
 * and failed checks never.
 */
function cacheTtl(o: ParkingQuoteOutcome): number {
  if (o.kind === "priced" || o.kind === "sold_out" || o.kind === "known_4xx") return RESLAB_QUOTE_CACHE_TTL_MS;
  if (o.kind === "auth" || o.kind === "unexpected") return RESLAB_LOCATION_FAILURE_BACKOFF_MS;
  return 0;
}

export async function quoteLotParking(
  lotId: number,
  fromDate: string,
  toDate: string,
  now: number = Date.now(),
  timeoutMs: number = RESLAB_MIN_PRICE_TIMEOUT_MS
): Promise<ParkingQuoteOutcome> {
  const key = `${lotId}|${fromDate}|${toDate}`;
  const hit = quoteCache.get(key);
  if (hit && now - hit.at < hit.ttlMs) return hit.outcome;
  const inflight = quoteInflight.get(key);
  if (inflight) return inflight;
  const p = fetchQuote(lotId, fromDate, toDate, timeoutMs)
    .then((outcome) => {
      const ttlMs = cacheTtl(outcome);
      if (ttlMs > 0) {
        quoteCache.set(key, { at: now, ttlMs, outcome });
        while (quoteCache.size > QUOTE_CACHE_MAX_KEYS) {
          const oldest = quoteCache.keys().next().value;
          if (oldest === undefined) break;
          quoteCache.delete(oldest);
        }
      }
      return outcome;
    })
    .finally(() => quoteInflight.delete(key));
  quoteInflight.set(key, p);
  return p;
}

/** Test seam. */
export function __resetHotelLotResolveForTests(): void {
  reported.clear();
  lastReportAt.clear();
  locationCache.clear();
  locationBackoff.clear();
  locationInflight.clear();
  quoteCache.clear();
  quoteInflight.clear();
}
