/**
 * Shared parking search logic
 *
 * Extracted from the search API route so it can be reused
 * by both /api/search and /api/chat (AI tool calling).
 */

import { getAirportByCode, Airport } from "@/config/airports";
import {
  reslab,
  ReslabError,
  ReslabLocation,
  ReslabMinPriceResponse,
  stripHtml,
  getFeaturedPhoto,
} from "@/lib/reslab/client";
import { UnifiedLot, SortOption, type LotBadge } from "@/types/lot";
import { calculateDistance } from "@/lib/utils/geo";
import { convertTo24Hour } from "@/lib/utils/time";
import {
  airportPricingTimes,
  reslabLotPricingWindow,
  type PricingWindowInput,
} from "@/lib/reslab/pricing-window";
import { generateSlug } from "@/lib/utils/slug";
import { captureAPIError } from "@/lib/sentry";
import {
  isSnapshotEnabled,
  readSnapshot,
  SNAPSHOT_FRESH_MS,
  SNAPSHOT_MAX_AGE_MS,
} from "@/lib/reslab/location-snapshot";
import {
  logAvailability,
  dayDiff,
  localToday,
  resolveEnv,
  type AvailabilityRow,
  type AvailabilitySource,
} from "@/lib/availability/log";
import { logSearchEvent, type SearchEventSource } from "@/lib/search-events/log";
import { deriveAvailability } from "@/lib/reslab/availability";
import { DIRECT_BOOKING_OPEN, isDirectLotsEnabled } from "@/lib/direct/flag";
import { fetchListableDirectLots, type DirectLot, type DirectLotsResult } from "@/lib/direct/store";
import { directLotToUnified } from "@/lib/direct/adapter";
import {
  isExemptFromOwnership,
  isOwnAirportFilterEnabled,
  locationBelongsToAirport,
  lotBelongsToAirport,
} from "@/lib/search/airport-ownership";
import {
  getLotBookingCounts,
  isRecommendedRankingEnabled,
  type LotBookingCounts,
} from "@/lib/search/booking-popularity";
import {
  compareByTotal,
  compareByTotalDesc,
  lowestTotalLot,
  pickMostBookedLot,
  rankRecommended,
} from "@/lib/search/ranking";

export { generateSlug };

// ResLab location IDs deliberately hidden from the site. Search filters them
// out and the lot detail page 404s them. Remove the ID to restore the lot.
//   416 — Parking 4 Airport (JFK): repeatedly refused Triply customers on
//         arrival (2026-09-15). Ask ResLab to unlink it from our channel too.
export const BLOCKED_RESLAB_LOCATION_IDS: ReadonlySet<number> = new Set([416]);

/**
 * Transform ResLab location to UnifiedLot format
 */
export function transformLocation(
  location: ReslabLocation,
  minPriceData: ReslabMinPriceResponse | null,
  airportLat: number,
  airportLng: number
): UnifiedLot {
  const lat = parseFloat(location.latitude);
  const lng = parseFloat(location.longitude);

  const distance = calculateDistance(airportLat, airportLng, lat, lng);

  // Get featured photo or first photo
  const featuredPhotoUrl = getFeaturedPhoto(location);

  // Transform photos
  const photos = (location.photos || []).map((p) => ({
    id: String(p.id),
    url: p.filename,
    alt: location.name,
  }));

  // Transform amenities
  const amenities = (location.amenities || []).map((a) => ({
    id: a.id,
    name: a.name,
    displayName: a.display_name,
    icon: a.icon,
  }));

  // Shared with the lot detail page (get-lot.ts) so the two can't drift.
  const availability = deriveAvailability(minPriceData?.reservation);

  // Get currency code
  const currencyCode = location.currency?.code || "USD";

  return {
    id: `reslab-${location.id}`,
    source: "reslab",
    sourceId: String(location.id),
    reslabLocationId: location.id,

    name: location.name,
    slug: generateSlug(location.name),
    address: location.address,
    city: location.city,
    state: location.state?.code || "",
    zipCode: location.zip_code,
    country: location.country?.name,
    latitude: lat,
    longitude: lng,

    description: stripHtml(location.description),
    directions: stripHtml(location.directions),
    specialConditions: stripHtml(location.special_conditions),
    phone: location.phone,

    shuttleInfo: location.shuttle_info_summary
      ? {
          summary: stripHtml(location.shuttle_info_summary),
          details: stripHtml(location.shuttle_info_details),
        }
      : undefined,

    amenities,
    photos:
      photos.length > 0
        ? photos
        : [
            {
              id: "placeholder",
              url: "/placeholder-parking.jpg",
              alt: location.name,
            },
          ],

    rating: undefined,
    reviewCount: undefined,

    distanceFromAirport: distance,

    pricing: minPriceData
      ? {
          // Daily rate includes ResLab fees but excludes taxes.
          // Fees are hidden as a separate line — rolled into the per-day rate
          // so pricing is consistent across search, lot detail, and checkout.
          minPrice:
            (minPriceData.reservation.sub_total + minPriceData.reservation.fees_total) /
            (minPriceData.reservation.totals?.parking?.number_of_days || 1),
          currency: currencyCode === "USD" ? "$" : currencyCode,
          currencyCode,
          parkingTypes: [],
          grandTotal: minPriceData.reservation.grand_total,
          subtotal: minPriceData.reservation.sub_total,
          feesTotal: minPriceData.reservation.fees_total,
          taxTotal: minPriceData.reservation.tax_total,
          taxValue: location.tax_value,
          taxType: location.tax_type,
          numberOfDays: minPriceData.reservation.totals?.parking?.number_of_days,
        }
      : undefined,

    availability,

    minimumBookingDays: location.minimum_booking_days || undefined,
    hoursBeforeReservation: location.hours_before_reservation || undefined,
    dailyOrHourly: location.daily_or_hourly,

    dueAtLocation: Boolean(location.parking_due_at_location),
    dueAtLocationAmount: minPriceData?.reservation.due_at_location,

    extraFields: (location.extra_fields || []).map((f) => ({
      id: f.id,
      name: f.name,
      label: f.label,
      type: f.type,
      inputType: f.input_type,
      perCar: Boolean(f.per_car),
    })),

    cancellationPolicies: (location.cancellation_policies || [])
      .filter((p) => p.type === "parking")
      .map((p) => ({
        numberOfDays: p.number_of_days,
        percentage: p.percentage,
      })),
  };
}

/**
 * Sort lots by the specified option.
 *
 * Price sorts compare the total the card shows (customerTotalFromPricing via
 * compareByTotal), not the per-day `minPrice`, so "Lowest Price" and the
 * "Lowest total" badge always agree. Unpriced lots sort last either way.
 *
 * `popularity` is the "Recommended" option: with `recommended: true`, the pinned
 * booking leader (pickMostBookedLot, chosen by the caller) then cheapest-first;
 * with `recommended: false` (SEARCH_RECOMMENDED_RANKING=off), the old distance
 * order. Explicit on purpose — a sorter must not read the environment.
 */
export function sortLots(
  lots: UnifiedLot[],
  sortBy: SortOption,
  ranking: { recommended: false } | { recommended: true; pinnedId: string | null }
): UnifiedLot[] {
  const sorted = [...lots];

  switch (sortBy) {
    case "price_asc":
      sorted.sort(compareByTotal);
      break;
    case "price_desc":
      sorted.sort(compareByTotalDesc);
      break;
    case "rating":
      sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
      break;
    case "distance":
      sorted.sort(
        (a, b) =>
          (a.distanceFromAirport ?? 999) - (b.distanceFromAirport ?? 999)
      );
      break;
    case "popularity":
    default:
      if (ranking.recommended) {
        return rankRecommended(sorted, ranking.pinnedId);
      }
      sorted.sort(
        (a, b) =>
          (a.distanceFromAirport ?? 999) - (b.distanceFromAirport ?? 999)
      );
      break;
  }

  return sorted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main search function (used by both /api/search and /api/chat tool)
// ─────────────────────────────────────────────────────────────────────────────

/** First-touch attribution + GA client id to record on the search_events
 *  header row, read by the caller off the `triply_attr` cookie (see
 *  readAttributionFromRequest) — passed in rather than parsed here because
 *  searchParking has no Request object and must not couple to route-only
 *  cookie parsing (chat and airport-page callers have none to give). */
export interface SearchEventAttribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  gaClientId: string | null;
}

/**
 * The searched dates can't be priced for a reason that is the CALLER's, not
 * ResLab's: the check-in is already past at the airport, or it is today and no
 * check-in slot is left. Callers answer 400 with `code` — never a 5xx, never a
 * Sentry event (it isn't an outage, and retrying can't succeed).
 */
export class SearchDateError extends Error {
  constructor(public readonly code: "checkin_in_past" | "same_day_too_late") {
    super(
      code === "checkin_in_past"
        ? "Check-in date has already passed at this airport"
        : "It's too late to book parking for today at this airport"
    );
    this.name = "SearchDateError";
  }
}

export interface SearchParkingParams {
  airport: string;
  checkin: string; // YYYY-MM-DD
  checkout: string; // YYYY-MM-DD
  // "10:00 AM" format. Omit unless the customer chose a time: searchParking
  // then prices from a timezone-aware default (see resolvePricingTimes).
  checkinTime?: string;
  checkoutTime?: string; // "2:00 PM" format; same rule
  sort?: SortOption;
  /**
   * Which surface asked. Recorded with the sold-out signal so an airport-page
   * render (a fixed +1d/+8d window, hit on every ISR revalidation) can be told
   * apart from a real customer search. Defaults to "search". Also the
   * search_events call-site tag unless `searchEventSource` overrides it.
   */
  source?: AvailabilitySource;
  /**
   * Overrides `source` on the search_events row only, for a call site that
   * shares availability_log's "search" tag but must be distinguishable in
   * the demand table — today just the homepage's featured-parking widget,
   * which polls /api/search on every homepage view with fixed dates nobody
   * typed. Leaving availability_log's own enum untouched avoids a migration
   * to widen its CHECK for a distinction only search_events needs.
   */
  searchEventSource?: SearchEventSource;
  /**
   * True when checkin/checkout were NOT supplied by the caller and the route
   * substituted its tomorrow/+7 pricing-estimate fallback (see route.ts).
   * Recorded on the search_events row; omitted (false) by callers that always
   * pass explicit dates (chat, airport pages).
   */
  datesDefaulted?: boolean;
  /** See SearchEventAttribution. Omitted (all-null) when the caller has no
   *  request to read a cookie from. */
  attribution?: SearchEventAttribution;
}

export interface SearchParkingResult {
  airport: Airport;
  checkin: string;
  checkout: string;
  checkinTime: string;
  checkoutTime: string;
  results: UnifiedLot[];
  total: number;
  /**
   * How many lots we list near this airport for this search, before pricing:
   * ResLab locations after the blocked-id and direct-twin filters, plus listable
   * direct lots. Counts lots that turned out sold out, closed for today or
   * failed to price, so 0 means "we list nothing here" while
   * `total === 0 && locationsConsidered > 0` means "we list lots, none bookable
   * for these dates". Only meaningful when neither `listIncomplete`,
   * `reslabUnavailable` nor `directUnavailable` is set (a source is missing,
   * so the count under-reports); the airport pages refuse to cache those and
   * key their empty-state copy on it otherwise.
   */
  locationsConsidered: number;
  message?: string;
  // Every lot found is closed to bookings for the rest of today (notice
  // period): a real answer, not an outage — the search page shows it as a
  // date message and chat relays it.
  closedForToday?: boolean;
  // True when some/all ResLab pricing calls failed, so the list is incomplete.
  // The route refuses to CDN-cache a degraded result — the lot list under-
  // reports (thin location build, or some lots failed to price).
  degraded?: boolean;
  // The location list was COMPLETE but past its TTL (ResLab is failing and we're
  // serving the last good list). The result itself is full, so it stays
  // cacheable — the route just shortens the CDN TTL so a repaired list is picked
  // up quickly. Distinct from `degraded`, which means "this result is thin".
  stale?: boolean;
  // Specifically "the LOCATION LIST was thin" — a subset of `degraded`, which is
  // also set by per-lot pricing failures. Consumers that must distinguish
  // "we're missing whole lots" from "one lot failed to price" read this; the
  // airport ISR pages use it to decide whether a render is safe to bake.
  listIncomplete?: boolean;
  // ResLab threw (list fetch failed / circuit breaker open) but the result
  // still carries this airport's DIRECT lots — a 200 instead of the 503 the
  // caller would otherwise have returned. Always paired with degraded:true
  // (never CDN-cached); the airport ISR pages treat it like listIncomplete.
  // Only ever set with ENABLE_DIRECT_LOTS on.
  reslabUnavailable?: boolean;
  // The direct-lot read failed or timed out, so direct lots are absent for a
  // non-data reason. NOT folded into `degraded` (review C11): a no-store
  // response here would push every search to origin and re-create the
  // ResLab min-price amplification loop during a database blip. The route
  // caches it briefly (60 s) instead.
  directUnavailable?: boolean;
  // How many direct lots were merged in; null when the flag is off.
  directCount?: number | null;
  // The Recommended order fell back to cheapest-first because the booking
  // counts could not be read (src/lib/search/booking-popularity.ts). The list
  // is complete and correctly priced, so it stays cacheable — the route just
  // shortens the CDN TTL (never no-store: that would push every search to
  // origin and re-create the min-price amplification loop). Set on any sort:
  // the "Most booked" badge is missing too.
  rankingDegraded?: boolean;
  // This airport's own lots left nothing bookable (sold out, closed for today
  // or failed to price), so the full radius list — other airports' lots
  // included — was shown instead (src/lib/search/airport-ownership.ts).
  ownAirportFallback?: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// ResLab geo-search workaround (2026-06-29)
//
// ResLab's lat/lng location search (`/locations/search?lat&lng`) is down — it
// hangs and 504s — while every other endpoint (list, single, by-ID, pricing)
// works. Until they fix it, find lots near an airport by fetching the full
// channel location list (which works) and filtering by distance ourselves. The
// list objects are complete (photos/amenities/etc.), so search cards render
// identically.
//
// To revert once ResLab's geo-search recovers: flip this to false. The original
// lat/lng path is preserved untouched in searchParking's `else` branch below.
// ───────────────────────────────────────────────────────────────────────────
const RESLAB_GEO_SEARCH_BROKEN = true;

// Cache the full channel location list so the workaround doesn't re-page on
// every search (the channel has ~533 locations across ~54 pages).
//
// ─── 2026-08-10 incident ────────────────────────────────────────────────────
// ResLab rate-limited this endpoint and search went to 503 site-wide (no
// inventory shown to customers). They had warned us: on 2026-07-28 we called
// /locations?page=N **18,044 times** (page 1 alone, 597 times) against their
// guidance of "a handful of times per day" — roughly 334 full sweeps a day.
//
// Three things drove that volume:
//   1. a 1-hour TTL on a list that changes rarely;
//   2. this cache being MODULE-SCOPED, i.e. per serverless instance — every
//      cold start does its own 54-page sweep (still true; see PHASE 2 below);
//   3. failed builds never caching anything, so while ResLab was failing every
//      incoming search kicked off another full sweep, which kept the rate limit
//      engaged. That feedback loop is what turned a blip into an outage.
//
// (1) and (3) are fixed here. (2) needs a cache shared across instances
// (PHASE 2 — persistent store + scheduled refresh, targeting ResLab's ~54
// calls/day). Until then this is per-instance-per-day, not per-day.
//
// Rule of thumb for anyone editing this: a stale-but-complete lot list is
// enormously better for customers than no lots at all, and re-sweeping a
// rate-limited endpoint is worse than not sweeping at all.

// ResLab's own guidance: this data "only needs to be pulled about once per day".
const LOCATION_LIST_TTL_MS = 24 * 60 * 60 * 1000;

// After a failed or partial build, don't attempt another sweep for this long.
// Serve the last good list instead. This is the circuit breaker that stops a
// rate-limited window from being self-sustaining.
const LOCATION_BUILD_BACKOFF_MS = 10 * 60 * 1000;

// Hard ceiling on how old a served list may be. Past this we stop serving
// stale data and surface the failure — better to show a retry state than to
// sell parking off a list that may no longer reflect the channel.
const LOCATION_LIST_MAX_AGE_MS = 72 * 60 * 60 * 1000;

// Wall-clock budget for one sweep. Two jobs: (a) a fully-refused sweep gives up
// instead of spending all ~54 requests proving it, and (b) the build always
// settles — and therefore always arms the backoff — before the serverless
// invocation can be killed underneath it. A killed invocation leaves
// lastBuildFailureAt unset, which resurrects the per-request sweep loop this
// whole fix exists to kill. Must stay comfortably under the route's maxDuration.
const LOCATION_BUILD_BUDGET_MS = 40 * 1000;

// A sweep that ran out of wall-clock WITHOUT any page being refused means
// ResLab is slow, not refusing. Measured: at ~3.6s per batch of 8 a perfectly
// healthy 54-page sweep trips the budget, and the full backoff would then keep
// search degraded indefinitely because every retry is equally slow. Back off
// briefly instead so we recover as soon as latency does.
const LOCATION_SLOW_BACKOFF_MS = 60 * 1000;

// How many times a single `next build` worker may bypass the backoff. See the
// bypass rationale in getChannelLocationsCached.
const BUILD_PHASE_MAX_SWEEPS = 3;

/**
 * `incomplete` — the list is known-thin (pages failed, or the sweep looked
 * implausible). A search built on it may show fewer lots than really exist, so
 * it must never be CDN-cached.
 *
 * `stale` — the list is COMPLETE but past its TTL. Safe to serve and safe to
 * cache briefly; pricing is fetched live per request, so a lot that has left
 * the channel drops out on its own (see the grandTotal filter in searchParking).
 *
 * Keeping these separate matters: collapsing both into one "degraded" boolean
 * would make every response uncacheable for the whole 24h→72h stale window,
 * pushing 100% of search traffic to origin and multiplying our min-price calls
 * against ResLab at precisely the moment they're throttling us.
 */
export type LocationListResult = {
  data: ReslabLocation[];
  incomplete: boolean;
  stale: boolean;
};

// `complete: false` marks a list assembled from a sweep that didn't fully
// succeed. We keep it — serving slightly-thin inventory beats serving a 503 —
// but it can never satisfy the fresh path, so we keep retrying for a good one.
let cachedLocationList: {
  data: ReslabLocation[];
  builtAt: number;
  complete: boolean;
  /** Where the list came from. A snapshot-sourced list is served on its own
   *  (shorter) freshness rules and can never be laundered into a swept one. */
  source?: "sweep" | "snapshot";
} | null = null;
// Shared-snapshot reader state (plan v3 §3). At most one snapshot read per
// instance per SNAPSHOT_READ_MIN_INTERVAL_MS, regardless of outcome, so a
// missing/stale row can never turn into a per-request Supabase read (the
// egress-incident class). Single-flight so concurrent cold starts share one.
let lastSnapshotReadAt: number | null = null;
let inFlightSnapshotRead: Promise<void> | null = null;
let lastSnapshotReportAt: number | null = null;
const SNAPSHOT_READ_MIN_INTERVAL_MS = 15 * 60 * 1000;
const SNAPSHOT_REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;
// The ">24 h snapshot falls through to the sweep path" rule below is only
// correct while the snapshot serving ceiling does not exceed the sweep TTL:
// past the ceiling the generic "fresh AND complete" check must ALSO be false,
// or a 30 h snapshot would be served site-wide as stale:false. Pinned here so
// a future change to either constant fails at module load, not in production.
if (SNAPSHOT_MAX_AGE_MS > LOCATION_LIST_TTL_MS) {
  throw new Error("SNAPSHOT_MAX_AGE_MS must not exceed LOCATION_LIST_TTL_MS");
}
// When the last build attempt failed (partial, implausible, or thrown). Drives
// the backoff. Cleared on any successful complete build.
let lastBuildFailureAt: number | null = null;
// True when the last failure was purely a wall-clock timeout with zero refused
// pages (slow ResLab, not refusing). Selects the shorter backoff window.
let lastFailureWasTimeoutOnly = false;
// Consecutive slow-only failures. The short window is for a BLIP, not a REGIME:
// a slow-only abort is never `complete`, so it can never satisfy the fresh path
// — meaning at 60s the retry loop is permanent. Measured, a sustained ~6s/batch
// regime cycles every ~102s ≈ 41k calls/day/instance, six times the call volume
// that got us rate-limited in the first place. Two fast retries absorb a blip;
// after that we fall back to the full window.
let consecutiveTimeoutOnlyFailures = 0;
const MAX_FAST_TIMEOUT_RETRIES = 2;
// When we last reported an open-breaker 503 to Sentry. Rate-limits that report
// to one per backoff window so an outage stays visible without flooding.
let lastBackoffReportAt: number | null = null;
// When we last reported an availability-row-builder throw (see the
// logAvailability block in searchParking). Same reasoning as above.
let lastAvailabilityReportAt: number | null = null;
// Separate clock for the expected "unparseable dates" skip (chat path), so it
// cannot starve the report of a genuine row-builder defect above.
let lastAvailabilityDateSkipReportAt: number | null = null;
// search_events header-row builder defect — its own clock, same reasoning:
// distinct from availability_log's own row-builder throttle above so one
// table's outage report can't mask the other's.
let lastSearchEventReportAt: number | null = null;
const AVAILABILITY_REPORT_INTERVAL_MS = 10 * 60 * 1000;

// Per-airport throttle for the own-airport fallback log line (below).
const lastOwnFallbackLogAt = new Map<string, number>();

/**
 * The own-airport filter fell back to the full radius list (src/lib/search/
 * airport-ownership.ts). Usually a sell-out night — not an error, so no Sentry
 * event — but a filter regression (bad airport coordinates, a new airport, a
 * botched override) would look the same to customers: every search silently
 * back on the old list. One structured log line per airport per ten minutes
 * lets the two be told apart in the runtime logs (search "own_airport_fallback").
 */
function reportOwnAirportFallback(
  airportCode: string,
  ownPriced: readonly { minPriceData: ReslabMinPriceResponse | null }[],
  ownPricingErrors: number
): void {
  const now = Date.now();
  const last = lastOwnFallbackLogAt.get(airportCode);
  if (last !== undefined && now - last < AVAILABILITY_REPORT_INTERVAL_MS) return;
  lastOwnFallbackLogAt.set(airportCode, now);
  console.warn(
    JSON.stringify({
      event: "own_airport_fallback",
      airport: airportCode,
      ownLots: ownPriced.length,
      ownSoldOut: ownPriced.filter((p) => p.minPriceData?.reservation?.sold_out === true).length,
      ownPricingErrors,
    })
  );
}
// Bypasses consumed by the current `next build` worker (see BUILD_PHASE_MAX_SWEEPS).
let buildPhaseSweeps = 0;
// Single-flight: coalesce concurrent cold-cache builds so we don't fire N
// simultaneous 54-page sweeps at the one ResLab endpoint that still works.
let inFlightLocationBuild: Promise<LocationListResult> | null = null;

/** Test seam — reset module cache state between cases. */
export function __resetLocationListCacheForTests(): void {
  cachedLocationList = null;
  lastBuildFailureAt = null;
  lastFailureWasTimeoutOnly = false;
  consecutiveTimeoutOnlyFailures = 0;
  lastBackoffReportAt = null;
  lastAvailabilityReportAt = null;
  lastOwnFallbackLogAt.clear();
  lastAvailabilityDateSkipReportAt = null;
  lastSearchEventReportAt = null;
  buildPhaseSweeps = 0;
  inFlightLocationBuild = null;
  lastSnapshotReadAt = null;
  inFlightSnapshotRead = null;
  lastSnapshotReportAt = null;
}

/**
 * True for the open-circuit-breaker error thrown above. /api/search uses this
 * to skip its generic per-request Sentry capture: this condition is already
 * reported once per backoff window with a far more diagnostic message, and the
 * root-cause ResLab error was reported when the build actually failed.
 */
export function isLocationBackoffError(error: unknown): boolean {
  return (
    error instanceof ReslabError &&
    typeof error.details === "object" &&
    error.details !== null &&
    "locationListBackoff" in error.details
  );
}

/** What one full sweep of ResLab's paginated location list produced. */
export interface ChannelLocationSweep {
  /** Deduped by id (ResLab repeats ids across pages). */
  unique: ReslabLocation[];
  /** Rows fetched PRE-dedupe — the only number the 0.9 plausibility check may use. */
  rowsFetched: number;
  paginatorTotal: number;
  lastPage: number;
  refusedPages: number;
  skippedPages: number;
  implausible: boolean;
  /** When page 1 was requested — the snapshot's `built_at`, never Date.now() at write time. */
  sweepStartedAt: number;
}

/**
 * ONE sweep of the channel list, state-free: no cache consult, no backoff, no
 * Sentry, no module writes. `getChannelLocationsCached` wraps it with all of
 * that; the refresh cron (src/app/api/cron/refresh-reslab-locations) calls it
 * directly so a cron run can never read its own snapshot back and re-write it,
 * and never has to touch NEXT_PHASE (which also silences availability_log,
 * search_events and the airport-page error path in the same process).
 *
 * `trustedCompleteSize` is the size of the list the caller already trusts
 * (the in-memory complete list, or the current snapshot row) for the ≥ 50 %
 * anti-ratchet clause; null when there is none.
 *
 * Throws on an unusable paginator (a definitive "nothing usable came back").
 */
export async function sweepChannelLocations(
  trustedCompleteSize: number | null
): Promise<ChannelLocationSweep> {
  const buildStart = Date.now();
  // Page 1 gives last_page + the first slice. A throw here lands in the
  // catch below, which prefers stale data over a 503.
  const first = await reslab.getAllLocations(1);

  // Trust nothing about the paginator. `request()` asserts the response
  // shape rather than validating it, so a degraded body, an error object
  // returned with HTTP 200, or a proxy interstitial all land here.
  //
  // BOTH fields must be validated, not just last_page. A missing last_page
  // makes `2 <= undefined` false so we'd sweep exactly one page; a missing
  // `total` disables the plausibility check below (which is guarded on
  // `expectedRows > 0`). Either one alone lets ~10 of ~533 locations be
  // cached as authoritative for 24h and CDN-cached — indistinguishable from
  // success, with no Sentry event. Also cross-check that last_page can
  // actually cover total/per_page, which catches a truncated paginator that
  // is individually well-formed but internally inconsistent.
  // Coerce before validating. This API demonstrably serializes numbers as
  // strings elsewhere (ReslabLocation.latitude/longitude are typed string;
  // `featured` is boolean | number), so if `total` ever arrives as "533" a
  // bare Number.isInteger would reject EVERY build — a permanent, site-wide
  // search outage of our own making, unfixable without a deploy. Coercing
  // costs nothing: Number("abc"), Number(null), Number(undefined) all still
  // fail the checks below.
  const lastPage = Number(first.last_page);
  const totalRows = Number(first.total);
  const perPage = Number(first.per_page);

  const pagerUnusable =
    !Number.isInteger(lastPage) ||
    lastPage < 1 ||
    !Number.isInteger(totalRows) ||
    totalRows < 1;
  const pagerInconsistent =
    !pagerUnusable &&
    Number.isInteger(perPage) &&
    perPage > 0 &&
    lastPage < Math.ceil(totalRows / perPage);

  if (pagerUnusable || pagerInconsistent) {
    throw new ReslabError(
      502,
      `ResLab location list returned an unusable paginator ` +
        `(last_page=${JSON.stringify(first.last_page)}, ` +
        `total=${JSON.stringify(first.total)}, ` +
        `per_page=${JSON.stringify(first.per_page)})`
    );
  }

  const all: ReslabLocation[] = [...first.data];
  const remaining: number[] = [];
  for (let p = 2; p <= lastPage; p++) remaining.push(p);

  // Fetch remaining pages in small concurrent batches to keep load civil.
  // Tolerate an individual page failing rather than zeroing out all search.
  // Tracked separately because they mean different things: `refusedPages`
  // is ResLab saying no (back off hard), `skippedPages` is us running out
  // of wall-clock (ResLab is just slow — back off briefly). Both make the
  // build incomplete; only the mix decides how long we wait.
  let refusedPages = 0;
  let skippedPages = 0;
  let consecutiveDeadBatches = 0;
  const BATCH = 8;
  for (let i = 0; i < remaining.length; i += BATCH) {
    // Give up early rather than spending the remaining ~45 requests proving
    // we're being refused. Counting the abandoned pages is what arms the
    // backoff below — abandoning the sweep silently would leave the breaker
    // un-armed and re-open the per-request sweep loop.
    const outOfTime = Date.now() - buildStart > LOCATION_BUILD_BUDGET_MS;
    if (outOfTime || consecutiveDeadBatches >= 1) {
      skippedPages += remaining.length - i;
      break;
    }

    const results = await Promise.allSettled(
      remaining.slice(i, i + BATCH).map((p) => reslab.getAllLocations(p))
    );
    const rejected = results.filter((r) => r.status === "rejected").length;
    consecutiveDeadBatches =
      rejected === results.length ? consecutiveDeadBatches + 1 : 0;
    for (const r of results) {
      if (r.status === "fulfilled") all.push(...r.value.data);
      else refusedPages++;
    }
  }

  // ResLab's paginated list returns the same location id on multiple pages —
  // dedupe by id so search doesn't render duplicate lot cards.
  const unique = Array.from(new Map(all.map((l) => [l.id, l])).values());

  // ⚠️ Compare `all.length` (rows fetched, PRE-dedupe) against `total`.
  // Comparing `unique.length` would reject every healthy build and take
  // search down permanently. Measured against live ResLab on 2026-08-10:
  //   last_page 54 · total 533 · rows fetched 533 · UNIQUE 381
  // 381 is only 71% of 533 — well under the 0.9 threshold — because ResLab
  // repeats ~152 rows across pages. Rows match `total` exactly; unique does
  // not and never will. Do not "simplify" this to unique.length.
  //
  // A build is only "good" if no page failed AND the result looks plausible.
  // Counting rejections alone cannot distinguish a healthy sweep from ResLab
  // answering HTTP 200 with an empty or truncated paginator — and that
  // mistake would then be cached as authoritative. At a 24h TTL the blast
  // radius is a full day: an empty list makes this instance answer "no
  // parking" for every airport until the TTL expires, and a truncated one is
  // complete-looking enough to be CDN-cached and to bake thin ISR airport
  // pages. Compare against the paginator's own `total` (rows, pre-dedupe —
  // ResLab repeats ids across pages, so `unique.length` is legitimately
  // lower and must NOT be compared to `total` directly) and against the
  // size of the list we already trust.
  const expectedRows = totalRows;
  const implausible =
    unique.length === 0 ||
    (expectedRows > 0 && all.length < expectedRows * 0.9) ||
    (trustedCompleteSize !== null &&
      unique.length < trustedCompleteSize * 0.5);


  return {
    unique,
    rowsFetched: all.length,
    paginatorTotal: totalRows,
    lastPage,
    refusedPages,
    skippedPages,
    implausible,
    sweepStartedAt: buildStart,
  };
}

/**
 * Load the shared snapshot into `cachedLocationList` — the FIRST thing
 * `getChannelLocationsCached` does, before `now` and `fallback` are captured,
 * so every existing guard (anti-ratchet, "prefer complete", the 72 h ceiling,
 * single-flight, the build-phase cap) sees a snapshot exactly as it would see
 * a swept list. It may ONLY assign `cachedLocationList`; it never returns data.
 *
 * No-op when the flag is off (zero Supabase calls), when memory is fresh
 * enough that a read could not change the outcome, or inside the debounce.
 */
async function maybeWarmFromSnapshot(): Promise<void> {
  if (!isSnapshotEnabled()) return;
  const now = Date.now();
  const mem = cachedLocationList;
  if (mem && mem.complete) {
    // A swept list is trusted for the full TTL; a snapshot-sourced one is
    // re-read after SNAPSHOT_FRESH_MS so a cron refresh is picked up.
    const limit = mem.source === "snapshot" ? SNAPSHOT_FRESH_MS : LOCATION_LIST_TTL_MS;
    if (now - mem.builtAt < limit) return;
  }
  // Join an in-flight read BEFORE consulting the debounce: a concurrent cold
  // start must wait for the one read in progress, not skip it and sweep.
  if (inFlightSnapshotRead) return inFlightSnapshotRead;
  if (lastSnapshotReadAt !== null && now - lastSnapshotReadAt < SNAPSHOT_READ_MIN_INTERVAL_MS) return;
  lastSnapshotReadAt = now;
  inFlightSnapshotRead = (async () => {
    try {
      // Ask only for a row NEWER than what we hold: "nothing newer" is a few
      // bytes, not a 400 KB payload we would then discard.
      const r = await readSnapshot(now, mem && mem.complete ? mem.builtAt : null);
      if (r.kind === "miss") {
        if (r.reportable) reportSnapshot(`ResLab snapshot not usable: ${r.reason}`, now);
        return;
      }
      const current = cachedLocationList;
      // NEVER downgrade what customers can see: a smaller snapshot does not
      // replace a bigger complete list, and an older one does not replace a
      // newer swept one.
      if (current && current.complete) {
        if (r.locations.length < current.data.length) {
          reportSnapshot(
            `ResLab snapshot (${r.locations.length} lots) is smaller than the in-memory complete list (${current.data.length}); not adopted`,
            now
          );
          return;
        }
        if (current.builtAt >= r.builtAtMs) return;
      }
      cachedLocationList = {
        data: r.locations,
        builtAt: r.builtAtMs,
        complete: true,
        source: "snapshot",
      };
    } catch (err) {
      reportSnapshot(
        `ResLab snapshot read threw: ${err instanceof Error ? err.message : String(err)}`,
        Date.now()
      );
    } finally {
      inFlightSnapshotRead = null;
    }
  })();
  return inFlightSnapshotRead;
}

/**
 * One Sentry event per instance per SNAPSHOT_REPORT_INTERVAL_MS; the cron's own
 * failures are the loud signal. Never throws: a telemetry fault must not become
 * a search 503 (the warm-up's contract is "assign memory or do nothing").
 */
function reportSnapshot(message: string, now: number): void {
  if (lastSnapshotReportAt !== null && now - lastSnapshotReportAt < SNAPSHOT_REPORT_INTERVAL_MS) return;
  lastSnapshotReportAt = now;
  try {
    captureAPIError(new Error(message), {
      // Not "/api/search": the list is read from lot pages, airport pages and chat too.
      endpoint: "reslab.location_snapshot",
      method: "READ",
      stage: "location_snapshot",
    });
  } catch {
    // Sentry itself failing is not our problem here.
  }
}

export async function getChannelLocationsCached(): Promise<LocationListResult> {
  // Shared snapshot first (no-op unless ENABLE_RESLAB_LOCATION_SNAPSHOT): it
  // can only populate `cachedLocationList`, which everything below then reads.
  // `.catch` is belt-and-braces on top of the function's own guards.
  await maybeWarmFromSnapshot().catch(() => {});
  const now = Date.now();
  // Capture the VALUE, not a predicate about it. The build below reads this
  // across awaits; holding the object (a) lets TypeScript narrow without
  // non-null assertions, and (b) lets us re-check the age at the moment of use
  // — a slow build can push a list past the 72h ceiling mid-flight, and an
  // entry-time snapshot would serve it anyway.
  const fallback = cachedLocationList;
  const usableFallback = () =>
    fallback !== null &&
    Date.now() - fallback.builtAt < LOCATION_LIST_MAX_AGE_MS
      ? fallback
      : null;

  // A snapshot-sourced list has its own, shorter freshness rules: fresh under
  // SNAPSHOT_FRESH_MS, complete-but-stale (60 s CDN TTL, the window in which a
  // cron refresh is expected) up to SNAPSHOT_MAX_AGE_MS. Older than that it is
  // just a complete list past its TTL for the code below — a "never downgrade"
  // fallback while this instance sweeps for itself, staggered by the existing
  // breaker, so a dead cron degrades to today's behaviour with no cliff.
  if (fallback && fallback.complete && fallback.source === "snapshot") {
    const age = now - fallback.builtAt;
    if (age < SNAPSHOT_MAX_AGE_MS) {
      return { data: fallback.data, incomplete: false, stale: age >= SNAPSHOT_FRESH_MS };
    }
  }

  // Fresh AND complete — the overwhelmingly common path.
  if (
    fallback &&
    fallback.complete &&
    now - fallback.builtAt < LOCATION_LIST_TTL_MS
  ) {
    return { data: fallback.data, incomplete: false, stale: false };
  }

  const backoffWindow = lastFailureWasTimeoutOnly
    ? LOCATION_SLOW_BACKOFF_MS
    : LOCATION_BUILD_BACKOFF_MS;
  const backingOff =
    lastBuildFailureAt !== null && now - lastBuildFailureAt < backoffWindow;

  // Until 2026-10-07 `next build` prerendered ~85 airport landing pages, and
  // airport-page/data.ts swallows build-phase failures so a blip can't fail the
  // deploy. Honouring the backoff there would fast-fail every remaining page
  // and ship empty, indexable SEO pages. Airport pages are now rendered on
  // first request and the sitemap never sweeps (getChannelLocationsNoSweep),
  // so no current build path should reach this; the bounded bypass stays for
  // any page that prerenders a search in future.
  //
  // But the bypass must be BOUNDED. A rejected build caches `complete: false`,
  // which by design never satisfies the fresh path — so an unbounded bypass
  // means each of the 85 pages runs its own full sweep. Measured worst cases:
  // ~3,000 calls per deploy at a 2%/page failure rate, ~4,590 if every sweep is
  // rejected, against ResLab's ~54/day guidance. That trades a runtime
  // amplification for a deploy-time one — and the likeliest moment to deploy is
  // during an incident. A few retries get us past a blip; unlimited retries are
  // the bug we're fixing, wearing a different hat.
  //
  // NB static generation runs in multiple worker processes, so this counter
  // (like the cache itself) is per-worker — the real bound is
  // BUILD_PHASE_MAX_SWEEPS × workers, not × 1.
  // Count every build-phase sweep, and enforce the cap INDEPENDENTLY of whether
  // a backoff happens to be active. A build that prerendered the airport pages
  // ran for minutes (~85 pages, each
  // fanning out ~15 min-price calls), long enough for backoff windows to expire
  // during it — and
  // a check that only fires while `backingOff` is true lets every expiry buy
  // another uncapped sweep. Measured that way: 8 sweeps across a 60-minute
  // build phase, not 3. Consulting the cap unconditionally makes
  // BUILD_PHASE_MAX_SWEEPS the actual ceiling it claims to be.
  const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
  const buildSweepsExhausted =
    isBuildPhase && buildPhaseSweeps >= BUILD_PHASE_MAX_SWEEPS;
  const buildBypassAllowed = isBuildPhase && !buildSweepsExhausted;

  if (buildSweepsExhausted || (backingOff && !buildBypassAllowed)) {
    // Serve whatever we still hold rather than sweeping into a rate limit —
    // even a thin list beats a 503. This is the difference between "customers
    // see lots" and "customers see nothing" while ResLab is refusing us.
    const usable = usableFallback();
    if (usable) {
      return {
        data: usable.data,
        incomplete: !usable.complete,
        stale: usable.complete,
      };
    }

    // Nothing to serve. Fail fast WITHOUT touching ResLab — sweeping here is
    // exactly what keeps the rate-limit window from ever expiring.
    //
    // Reporting: this fires on EVERY search while the breaker is open, and
    // /api/search's catch calls captureAPIError unconditionally, so left alone
    // it buries the root-cause 429 under a flood of derived breaker errors.
    // Instead we emit one diagnostic event per backoff window and mark the
    // error so the route skips its generic capture (isLocationBackoffError).
    // That keeps "customers are seeing 503s" visible — 1,311 Sentry events went
    // unnoticed for ~4 weeks here — without the per-request noise.
    if (
      lastBackoffReportAt === null ||
      now - lastBackoffReportAt >= LOCATION_BUILD_BACKOFF_MS
    ) {
      lastBackoffReportAt = now;
      captureAPIError(
        new Error(
          `ResLab location list unavailable — no usable cached list, backing ` +
            `off ${Math.round((now - (lastBuildFailureAt ?? now)) / 1000)}s ` +
            `after a failed build. Search is returning 503 to customers.`
        ),
        { endpoint: "/api/search", method: "GET", statusCode: 503 }
      );
    }
    throw new ReslabError(
      503,
      "ResLab location list unavailable (backing off after a recent failed build)",
      { locationListBackoff: true }
    );
  }

  if (inFlightLocationBuild) return inFlightLocationBuild;

  // Every build-phase sweep counts against the cap (see buildSweepsExhausted).
  if (isBuildPhase) buildPhaseSweeps++;

  inFlightLocationBuild = (async () => {
    try {
      const sweep = await sweepChannelLocations(
        fallback?.complete ? fallback.data.length : null
      );
      const {
        unique,
        rowsFetched,
        paginatorTotal: expectedRows,
        lastPage,
        refusedPages,
        skippedPages,
        implausible,
      } = sweep;
      const failedPages = refusedPages + skippedPages;

      if (failedPages > 0 || implausible) {
        // Rejected build. Arm the backoff so we stop hammering. Never clears
        // lastBuildFailureAt — a suspect build must not look like recovery.
        lastBuildFailureAt = Date.now();
        // Slow-only (nothing refused) gets the short window: ResLab is
        // answering, so recovery should track latency, not a fixed 10 minutes.
        // But only for the first couple of attempts — see
        // MAX_FAST_TIMEOUT_RETRIES. Sustained slowness is a regime, and fast
        // retries against a regime are re-amplification.
        const slowOnly = refusedPages === 0 && skippedPages > 0;
        consecutiveTimeoutOnlyFailures = slowOnly
          ? consecutiveTimeoutOnlyFailures + 1
          : 0;
        lastFailureWasTimeoutOnly =
          slowOnly && consecutiveTimeoutOnlyFailures <= MAX_FAST_TIMEOUT_RETRIES;
        captureAPIError(
          new Error(
            `ResLab location-list build rejected: ` +
              `${refusedPages} refused + ${skippedPages} skipped of ` +
              `${lastPage} pages, ` +
              `assembled ${unique.length} unique from ${rowsFetched} rows ` +
              `(paginator total ${expectedRows})` +
              (fallback
                ? `, cached list has ${fallback.data.length} (complete=${fallback.complete})`
                : ", no cached list to fall back on")
          ),
          { endpoint: "/api/search", method: "GET", statusCode: 502 }
        );

        // NEVER downgrade what customers can see. Prefer a COMPLETE list
        // outright; otherwise prefer whichever list has MORE lots. Two failures
        // this prevents, both reachable without exotic input:
        //   (a) fallback is thin (say 400 lots) and this rebuild assembled
        //       nothing — without the size comparison we'd return [] and tell
        //       the customer "No parking locations found near this airport"
        //       while holding 400 usable lots one branch away;
        //   (b) successive rejected rebuilds each assemble less than the last,
        //       ratcheting inventory down toward zero over an outage
        //       (400 → 90 → 0) with no path back until a fully clean sweep.
        // Note we do NOT re-stamp builtAt when preferring the fallback: a stale
        // list must not be laundered into a fresh one.
        const usable = usableFallback();
        if (usable && (usable.complete || usable.data.length >= unique.length)) {
          return {
            data: usable.data,
            incomplete: !usable.complete,
            stale: usable.complete,
          };
        }

        // This build is the best we have. Keep it so the backoff window serves
        // lots instead of 503s. `complete: false` means it can never satisfy
        // the fresh path, so we keep retrying for a good one.
        if (unique.length > 0) {
          // thin → thin must NOT reset the clock. Re-stamping on every rejected
          // rebuild makes LOCATION_LIST_MAX_AGE_MS unreachable for the least
          // trustworthy list we hold, so the 72h ceiling would never fire.
          //
          // But inheritance must itself be bounded, or the opposite failure
          // appears: past the ceiling, a brand-new build (rows fetched seconds
          // ago) keeps inheriting a dead timestamp, so it's returned once and
          // then every subsequent request 503s while we hold fresh inventory.
          // The ceiling should measure DATA age, not lineage age. Largely
          // unreachable while the cache is per-instance (lambdas recycle well
          // inside 72h) — but it becomes a site-wide 503 the moment the shared
          // cache in PHASE 2 lands, so bound it now.
          const inherited =
            fallback && !fallback.complete ? fallback.builtAt : null;
          const canInherit =
            inherited !== null &&
            Date.now() - inherited < LOCATION_LIST_MAX_AGE_MS;
          cachedLocationList = {
            data: unique,
            builtAt: canInherit ? inherited : Date.now(),
            complete: false,
          };
        }
        return { data: unique, incomplete: true, stale: false };
      }

      lastBuildFailureAt = null;
      lastFailureWasTimeoutOnly = false;
      consecutiveTimeoutOnlyFailures = 0;
      cachedLocationList = { data: unique, builtAt: Date.now(), complete: true, source: "sweep" };
      return { data: unique, incomplete: false, stale: false };
    } catch (err) {
      // Total build failure (page 1 threw / unusable paginator — typically a
      // 429 or timeout). Arm the backoff, then serve what we have rather than
      // blanking search.
      lastBuildFailureAt = Date.now();
      lastFailureWasTimeoutOnly = false;
      consecutiveTimeoutOnlyFailures = 0;
      const usable = usableFallback();
      if (usable) {
        captureAPIError(
          new Error(
            `ResLab location-list rebuild failed; serving cached list ` +
              `(age ${Math.round((Date.now() - usable.builtAt) / 60000)}m, ` +
              `complete=${usable.complete}): ` +
              `${err instanceof Error ? err.message : String(err)}`
          ),
          { endpoint: "/api/search", method: "GET", statusCode: 502 }
        );
        return {
          data: usable.data,
          incomplete: !usable.complete,
          stale: usable.complete,
        };
      }
      // Nothing to fall back on — propagate so the route returns an
      // uncacheable 503 + retry state, as before.
      throw err;
    }
  })().finally(() => {
    inFlightLocationBuild = null;
  });

  return inFlightLocationBuild;
}

// "Near an airport" for search and the sitemap. 15 km matches ResLab's
// documented search radius.
export const AIRPORT_SEARCH_RADIUS_KM = 15;

// Replacement for ResLab's broken lat/lng geo-search: locations within
// `radiusKm` of the airport.
async function findLocationsNearAirport(
  lat: number,
  lng: number,
  radiusKm = AIRPORT_SEARCH_RADIUS_KM
): Promise<{
  locations: ReslabLocation[];
  incomplete: boolean;
  stale: boolean;
}> {
  const { data, incomplete, stale } = await getChannelLocationsCached();
  return { locations: locationsNearPoint(data, lat, lng, radiusKm), incomplete, stale };
}

/** Pure distance filter shared by search and the sitemap. */
export function locationsNearPoint(
  data: readonly ReslabLocation[],
  lat: number,
  lng: number,
  radiusKm: number
): ReslabLocation[] {
  // calculateDistance() returns MILES (geo.ts uses R=3959), so convert the km
  // radius before comparing — otherwise the filter is ~2.6x too wide.
  const radiusMi = radiusKm * 0.621371;
  return data.filter((loc) => {
    const llat = parseFloat(loc.latitude);
    const llng = parseFloat(loc.longitude);
    if (Number.isNaN(llat) || Number.isNaN(llng)) return false;
    return calculateDistance(lat, lng, llat, llng) <= radiusMi;
  });
}

/**
 * The channel location list for callers that must NEVER trigger a ResLab
 * sweep — the sitemap, which is generated at build and regenerated hourly.
 * Warms from the shared snapshot (028) when ENABLE_RESLAB_LOCATION_SNAPSHOT is
 * on, then returns the COMPLETE list this instance holds if it is within the
 * same 72 h ceiling search applies (LOCATION_LIST_MAX_AGE_MS) — from the
 * snapshot or from an earlier search's sweep, so with the flag off a warm
 * instance can still answer. Otherwise null: never a thin list. Never calls
 * ResLab; never throws (the warm-up reports its own failures).
 */
export async function getChannelLocationsNoSweep(): Promise<readonly ReslabLocation[] | null> {
  // maybeWarmFromSnapshot catches internally; the .catch is belt-and-braces,
  // as in getChannelLocationsCached — a throw here would fail a build.
  await maybeWarmFromSnapshot().catch(() => {});
  const mem = cachedLocationList;
  if (!mem || !mem.complete) return null;
  if (Date.now() - mem.builtAt > LOCATION_LIST_MAX_AGE_MS) return null;
  return mem.data;
}

export async function searchParking(
  params: SearchParkingParams
): Promise<SearchParkingResult> {
  const {
    airport: airportCode,
    checkin,
    checkout,
    sort = "popularity",
    source = "search",
    searchEventSource,
    datesDefaulted = false,
    attribution,
  } = params;

  // A reversed range is a caller bug, never a ResLab question. Checked here
  // so /api/search, the chat tool and the airport pages all inherit it.
  // Lexicographic compare is exact ONLY for YYYY-MM-DD, so the format is an
  // enforced precondition, not an assumption.
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!ISO_DATE.test(checkin) || !ISO_DATE.test(checkout)) {
    throw new Error(`Invalid date range: dates must be YYYY-MM-DD (got ${checkin} / ${checkout})`);
  }
  if (checkout < checkin) {
    throw new Error(`Invalid date range: check-out ${checkout} is before check-in ${checkin}`);
  }

  // Validate airport
  const airportInfo = getAirportByCode(airportCode);
  if (!airportInfo) {
    throw new Error(`Invalid airport code: ${airportCode}`);
  }

  // Pricing-only times. Results show "from $X" estimates and the customer
  // picks real times on the lot page before booking; a time the caller
  // supplied is used as given unless it has already passed today. A same-day
  // check-in prices at the earliest slot still open at the airport instead of
  // a fixed 10:00 AM, which ResLab rejected as past for every same-day search
  // after 10 AM (see src/lib/reslab/pricing-window.ts).
  const pricingInput: PricingWindowInput = {
    checkin,
    checkout,
    airportTimeZone: airportInfo.timezone,
    checkinTime: params.checkinTime,
    checkoutTime: params.checkoutTime,
    now: new Date(),
  };
  const pricingTimes = airportPricingTimes(pricingInput);
  // A past check-in is not demand worth recording (027's lead_days CHECK
  // would refuse most of these rows anyway): answer it before any telemetry.
  if (!pricingTimes.ok && pricingTimes.reason === "checkin_in_past") {
    throw new SearchDateError("checkin_in_past");
  }

  // Identifiers shared by BOTH telemetry tables this search writes:
  // availability_log (per lot, below) and search_events (this search's
  // header row) — generated once here, not inside either logger, so a row in
  // one can be joined to the rows in the other by search_id, and so the two
  // can never disagree about lead_days/env/searched-on the way the old
  // separately-computed search_events (UTC "today", route-level insert) used
  // to. lead_days is measured against "today" in the airport's own timezone,
  // not UTC — a US evening search is already "tomorrow" in UTC and would
  // otherwise log a systematic -1 lead day (asserted against this real code
  // path in __tests__/search-events.test.ts, "timezone boundary").
  const searchedOn = localToday(airportInfo.timezone);
  const leadDays = dayDiff(searchedOn, checkin);
  const stayDays = dayDiff(checkin, checkout);
  const searchId = crypto.randomUUID();
  const searchEnv = resolveEnv();
  const eventSource: SearchEventSource = searchEventSource ?? source;

  // Fire-and-forget search_events header row for THIS search, called at every
  // return point below (including the zero-locations early return) once
  // lead/stay days are known to parse. Wrapped in its own try/catch, on its
  // own report clock, so a defect building this row can never take down a
  // real search result or starve availability_log's own error reporting.
  //
  // It takes the RAW arrays rather than pre-computed numbers on purpose:
  // every derived telemetry value (the cheapest price, the sold-out count,
  // and in particular the `Math.min(...)` SPREAD, which throws RangeError on
  // a large enough array) is computed INSIDE this try/catch. Nothing
  // telemetry-only is evaluated on the customer's path.
  const emitSearchEvent = (fields: {
    results_count: number;
    degraded: boolean;
    stale: boolean;
    /** The per-lot pricing pass: one entry per location except lots skipped
     *  as closed for today. Empty at the zero-location early return. */
    priced: readonly { minPriceData: ReslabMinPriceResponse | null }[];
    /** The lots that will actually be returned, for the cheapest-price floor.
     *  Empty at the zero-location early return. */
    available: readonly UnifiedLot[];
    /** How many of `priced` failed to price at all. */
    pricingErrors: number;
    /** Direct lots merged in (null = flag off). Kept OUT of results_count. */
    directCount: number | null;
    directSkipped: boolean;
  }): void => {
    try {
      // Unparseable dates: skip rather than write a row the table's NOT
      // NULL/CHECK constraints would bounce anyway — availability_log's own
      // skip (below) already reports this once per its own throttle window,
      // so no second Sentry event here. (A date that PARSES but Postgres
      // still refuses — "2026-02-30", a reversed range, a long-past check-in
      // — is caught and reported by logSearchEvent's own insertability gate,
      // on its own signature; see src/lib/search-events/log.ts.)
      if (leadDays === null || stayDays === null) return;

      // Cheapest priced total, in cents, across the lots that will actually
      // be returned — but NOT when the result is degraded: a "cheapest"
      // computed from a partial ResLab response isn't a real cheapest, it's
      // whatever survived, and would understate the true floor.
      const pricedTotals = fields.available
        .map((lot) => lot.pricing?.grandTotal)
        .filter((v): v is number => typeof v === "number" && v > 0);
      // Sold-out count from the same per-lot pricing pass availability_log's
      // rows are built from, BEFORE the sold-out lots are filtered out.
      // Null — not 0 — when NOTHING priced (no locations at all, or every
      // ResLab pricing call failed): there were no lots to have an opinion
      // about, and a 0 during a total outage reads as "nothing was sold out".
      const nothingPriced =
        fields.priced.length === 0 || fields.pricingErrors >= fields.priced.length;
      const soldOutCount = nothingPriced
        ? null
        : fields.priced.filter((p) => p.minPriceData?.reservation?.sold_out === true)
            .length;

      logSearchEvent({
        search_id: searchId,
        env: searchEnv,
        airport_code: airportInfo.code,
        check_in: checkin,
        check_out: checkout,
        stay_days: stayDays,
        lead_days: leadDays,
        dates_defaulted: datesDefaulted,
        source: eventSource,
        utm_source: attribution?.utmSource ?? null,
        utm_medium: attribution?.utmMedium ?? null,
        utm_campaign: attribution?.utmCampaign ?? null,
        ga_client_id: attribution?.gaClientId ?? null,
        results_count: fields.results_count,
        cheapest_price_cents:
          !fields.degraded && pricedTotals.length > 0
            ? Math.round(Math.min(...pricedTotals) * 100)
            : null,
        sold_out_count: soldOutCount,
        degraded: fields.degraded,
        stale: fields.stale,
        direct_results_count: fields.directCount,
        direct_skipped: fields.directSkipped,
      });
    } catch (err) {
      const now = Date.now();
      if (
        lastSearchEventReportAt === null ||
        now - lastSearchEventReportAt >= AVAILABILITY_REPORT_INTERVAL_MS
      ) {
        lastSearchEventReportAt = now;
        captureAPIError(err instanceof Error ? err : new Error(String(err)), {
          endpoint: "searchParking.logSearchEvent",
          method: "GET",
        });
      }
    }
  };

  // No check-in slot left today: still real "parking tonight" demand, so it
  // gets its search_events row before the caller answers 400.
  if (!pricingTimes.ok) {
    emitSearchEvent({
      results_count: 0,
      degraded: false,
      stale: false,
      priced: [],
      available: [],
      pricingErrors: 0,
      directCount: null,
      directSkipped: false,
    });
    throw new SearchDateError(pricingTimes.reason);
  }
  const { checkinTime, checkoutTime } = pricingTimes;

  // Convert times to 24-hour format
  const checkinTime24 = convertTo24Hour(checkinTime);
  const checkoutTime24 = convertTo24Hour(checkoutTime);

  // Format dates for ResLab API (YYYY-MM-DD HH:mm:ss)
  const fromDate = `${checkin} ${checkinTime24}:00`;
  const toDate = `${checkout} ${checkoutTime24}:00`;

  // A same-day check-in has to clear each lot's own notice period, judged in
  // the lot's own timezone — the same rule the lot page prices with. Null =
  // this lot can't take a booking for that check-in: skipped, NOT counted as
  // a pricing error, so it can't mark the search degraded or page Sentry.
  const pricingWindowFor = (location: ReslabLocation) =>
    reslabLotPricingWindow(location, pricingInput);

  // ── Direct (non-ResLab) lots — plan A-22 ──────────────────────────────────
  // Started BEFORE the ResLab list fetch so the two run in parallel; awaited
  // only where the merge needs it. fetchListableDirectLots never throws (a
  // typed failure instead), is bounded at 4 s, and already filters to lots
  // that are published + active + visible in THIS environment, so a
  // staging_only lot can never appear in a production result. With the flag
  // off this is null and every line below that reads it is a no-op — the
  // ResLab path is unchanged.
  const directEnabled = isDirectLotsEnabled();
  const directPromise: Promise<DirectLotsResult> | null = directEnabled
    ? fetchListableDirectLots(airportInfo.code, source === "chat" ? "/api/chat" : "/api/search")
    : null;

  // Booking counts for the Recommended order + "Most booked" badge, started
  // now and awaited only at the sort, so the read overlaps the ResLab pricing
  // calls instead of adding to them. getLotBookingCounts never rejects, so the
  // throw paths below can't leave a rejected promise floating. Not consulted
  // for the airport pages (they sort by price and render no badges) nor on a
  // Vercel preview, which prices against STAGING ResLab — its location ids are
  // not production's, so production counts would badge unrelated lots there.
  const rankingEnabled = isRecommendedRankingEnabled();
  const withBadges = rankingEnabled && source !== "airport-page";
  const countsPromise: Promise<LotBookingCounts> | null =
    withBadges && process.env.VERCEL_ENV !== "preview" ? getLotBookingCounts() : null;

  // Search for locations near the airport.
  //
  // safety-removed: the previous `catch { locations = [] }` swallowed ResLab
  // outages into a "0 lots" success. /api/search caches 200s at the CDN, so a
  // transient ResLab 502 got cached as "No parking found" and stuck for the
  // full TTL — the live incident on 2026-06-29. Let ResLab errors propagate so
  // the route returns an uncacheable 5xx instead of poisoning the cache.
  //
  // With direct lots enabled the error is HELD rather than thrown (see
  // `reslabFailure` below): if this airport has direct lots the search still
  // answers 200 with them (degraded, no-store, Sentry capture kept); if it has
  // none, the held error is rethrown and behaviour is identical to today.
  let locations: ReslabLocation[] = [];
  let reslabFailure: unknown = null;
  // True when the workaround served a THIN location list (pages failed, or the
  // sweep looked implausible) — folded into `degraded` so the route won't
  // CDN-cache a list that under-reports the lots near this airport.
  let listBuildIncomplete = false;
  // True when the list was COMPLETE but past its TTL. Not degraded — the result
  // is a full one — but the route shortens its CDN TTL so we pick up a repaired
  // list quickly once ResLab recovers.
  let listBuildStale = false;
  try {
    if (airportInfo.reslabLocationId) {
      // Single mapped location — search-by-ID works even during the geo outage.
      locations =
        (await reslab.searchLocations({
          locations: [airportInfo.reslabLocationId],
        })) || [];
    } else if (RESLAB_GEO_SEARCH_BROKEN) {
      // Workaround for ResLab's broken lat/lng geo-search (see flag above).
      const near = await findLocationsNearAirport(
        airportInfo.latitude,
        airportInfo.longitude
      );
      locations = near.locations;
      listBuildIncomplete = near.incomplete;
      listBuildStale = near.stale;
    } else {
      // Original path — restore by flipping RESLAB_GEO_SEARCH_BROKEN to false.
      locations =
        (await reslab.searchLocations({
          lat: String(airportInfo.latitude),
          lng: String(airportInfo.longitude),
        })) || [];
    }
  } catch (err) {
    // Flag off: exactly the pre-direct behaviour — propagate.
    if (!directPromise) throw err;
    reslabFailure = err;
    locations = [];
  }

  // Resolve the direct branch (already in flight). A failed read is a
  // "skipped" branch — the result still carries every ResLab lot — reported
  // by the store (throttled, tag direct_lots_read) and flagged on the result
  // and the search_events row so a quiet outage is still visible.
  let directLots: DirectLot[] = [];
  let directSkipped = false;
  if (directPromise) {
    const direct = await directPromise;
    if (direct.ok) directLots = direct.lots;
    else directSkipped = true;
  }

  // Direct lots priced for the searched window through the same quote
  // checkout will charge. The totals are absent when the window does not
  // price (a same-day search with reversed TIMES survives the date checks
  // above), and the grandTotal filter then drops the lot rather than showing
  // "$0" — so every decision below is taken on the PRICED list, never on the
  // raw sellable one (review L1).
  const directUnified: UnifiedLot[] = directLots.map((lot) =>
    directLotToUnified(lot, airportInfo, { fromDate, toDate })
  ).filter((lot) => lot.pricing?.grandTotal !== undefined && lot.pricing.grandTotal > 0);
  const directCount: number | null = directEnabled ? directUnified.length : null;

  if (reslabFailure !== null) {
    if (directUnified.length === 0) throw reslabFailure;
    // ResLab is down but this airport has direct inventory: answer with it.
    // Keep the Sentry capture the route would have made, minus the
    // circuit-breaker error, which self-reports once per window.
    if (!isLocationBackoffError(reslabFailure)) {
      captureAPIError(
        reslabFailure instanceof Error ? reslabFailure : new Error(String(reslabFailure)),
        {
          endpoint: "searchParking.reslab",
          method: "GET",
          stage: "reslab_unavailable_direct_served",
          extra: { airport: airportInfo.code, source, directLots: directUnified.length },
        }
      );
    }
  }

  // A direct lot that is ALSO on the ResLab channel (`reslabLocationId` set in
  // the CMS) is sold direct only: drop the ResLab twin here, before pricing,
  // so the pair never lists twice and no getMinPrice call is spent on the
  // suppressed id (review B17). Sits beside the blocked-id filter on purpose.
  // Until DIRECT_BOOKING_OPEN, a direct lot with a declared twin is not in
  // `directLots` at all (store.isListable), so this set is empty and the
  // ResLab listing sells exactly as today (review M3).
  // Scope note: this is THIS airport's direct lots (fetchListableDirectLots is
  // per airport), so a ResLab lot inside two airports' radii is suppressed only
  // where its twin is declared — the lot page applies the same airport scope.
  const suppressedReslabIds = new Set<number>(
    directLots.map((l) => l.reslabLocationId).filter((id): id is number => id !== null)
  );

  // Drop lots we've deliberately hidden (see BLOCKED_RESLAB_LOCATION_IDS).
  locations = locations.filter(
    (loc) => !BLOCKED_RESLAB_LOCATION_IDS.has(loc.id) && !suppressedReslabIds.has(loc.id)
  );
  const locationsConsidered = locations.length + directLots.length;

  // Genuine "no lots near this airport" — distinct from a ResLab failure, which
  // now throws above. Returned as a 200, but the route serves every empty
  // result no-store (we never cache an empty search). Only when BOTH sources
  // are empty: a direct-only airport must not fall into this branch.
  if (locations.length === 0 && directUnified.length === 0) {
    // A real search that found nothing is still demand — record the header
    // row before returning. Nothing priced, so cheapest/sold_out resolve to
    // null from the empty arrays.
    emitSearchEvent({
      results_count: 0,
      degraded: listBuildIncomplete,
      stale: listBuildStale,
      priced: [],
      available: [],
      pricingErrors: 0,
      directCount,
      directSkipped,
    });
    return {
      airport: airportInfo,
      checkin,
      checkout,
      checkinTime,
      checkoutTime,
      results: [],
      total: 0,
      // directLots may be non-empty here when none of them priced.
      locationsConsidered,
      message: "No parking locations found near this airport",
      // An outage-induced empty (a thin build dropped this airport's lots) is
      // already no-store via total:0; flag it so it's distinguishable.
      degraded: listBuildIncomplete,
      stale: listBuildStale,
      listIncomplete: listBuildIncomplete,
      ...(directEnabled ? { directUnavailable: directSkipped, directCount } : {}),
    };
  }

  // Get minimum price for each location. A per-location pricing failure is
  // non-fatal — we still show the others — but count them so we can tell a
  // genuine "everything is sold out" empty from a ResLab degradation (below).
  let pricingErrors = 0;
  // Keep the raw minPriceData alongside each transformed lot: transformLocation
  // collapses sold_out/available_spots into one `availability` string and the
  // filter below then drops the sold-out lots entirely, so this is the only
  // point where the signal still exists in full.
  const allPricedLots = await Promise.all(
    locations.map(async (location) => {
      let minPriceData: ReslabMinPriceResponse | null = null;
      const window = pricingWindowFor(location);
      if (window === null) {
        // Can't take a booking today in the lot's own zone (notice period, or
        // the date has already passed there). No ResLab call and no pricing
        // error; removed before the results and the telemetry below.
        return {
          lot: transformLocation(location, null, airportInfo.latitude, airportInfo.longitude),
          location,
          minPriceData,
          closedToday: true,
        };
      }

      try {
        minPriceData = await reslab.getMinPrice(location.id, {
          type: "parking",
          reservation_type: "parking",
          from_date: window.fromDate,
          to_date: window.toDate,
          number_of_spots: 1,
        });
      } catch {
        // Price unavailable for this location (transient ResLab error or
        // genuinely no price). Counted so an all-error result doesn't get
        // served as a cacheable empty success.
        pricingErrors++;
      }

      return {
        lot: transformLocation(
          location,
          minPriceData,
          airportInfo.latitude,
          airportInfo.longitude
        ),
        location,
        minPriceData,
        closedToday: false,
      };
    })
  );
  // Telemetry (availability_log, search_events) records only lots we asked
  // ResLab about; a lot closed for today was never an observation.
  const pricedLots = allPricedLots.filter((p) => !p.closedToday);
  const closedTodayCount = allPricedLots.length - pricedLots.length;

  const lotsWithPricing = pricedLots.map((p) => p.lot);

  // Record which lots were sold out, BEFORE the filter below throws that away.
  // ResLab has no history endpoint, so an unrecorded day is unrecoverable.
  // Fire-and-forget and error-swallowing by contract — see
  // src/lib/availability/log.ts and supabase/migrations/025_availability_log.sql.
  //
  // Wrapped in its own try/catch so that no defect in the row builder can
  // ever take down a real search result just to log telemetry about it.
  try {
    // leadDays/stayDays/searchedOn computed once above, shared with
    // search_events — see the comment there.
    if (leadDays === null || stayDays === null) {
      // Unparseable dates: skip the whole search rather than store a
      // fabricated lead_days — but say so, throttled on its own clock (this
      // is an expected, recurring signal on the chat path, whose dates are
      // model-supplied; it must not re-arm the clock that reports genuine
      // row-builder defects below). A silent skip here could erase 100% of
      // chat observations. Values are truncated: they are raw caller input.
      // (A past check-in beyond the -1 CHECK is dropped per row, and
      // reported, by rowIsInsertable inside logAvailability.)
      const now = Date.now();
      if (
        lastAvailabilityDateSkipReportAt === null ||
        now - lastAvailabilityDateSkipReportAt >= AVAILABILITY_REPORT_INTERVAL_MS
      ) {
        lastAvailabilityDateSkipReportAt = now;
        captureAPIError(
          new Error(`availability: search skipped, unparseable dates (source=${source})`),
          {
            endpoint: "searchParking.logAvailability",
            method: "GET",
            extra: {
              checkin: String(checkin).slice(0, 32),
              checkout: String(checkout).slice(0, 32),
              searchedOn,
            },
          }
        );
      }
    } else {
      const availabilityRows: AvailabilityRow[] = pricedLots.map(
        ({ location, minPriceData }) => {
          // A lot whose pricing call failed is still an observation — "we
          // looked and don't know". Logged with sold_out NULL so the rollup can
          // tell a 1-of-12 sample from a census; never a fabricated `false`.
          // safety-removed: the `if (!minPriceData) return []` skip is replaced
          // by optional chaining — a null minPriceData now yields a null-valued
          // row instead of being dropped, and nothing here can throw on it.
          const reservation = minPriceData?.reservation;
          const sold_out = reservation?.sold_out;
          const available_spots = reservation?.available_spots;
          const grand_total = reservation?.grand_total;
          return {
            airport_code: airportInfo.code,
            check_in: checkin,
            check_out: checkout,
            lead_days: leadDays,
            stay_days: stayDays,
            reslab_location_id: location.id,
            sold_out: typeof sold_out === "boolean" ? sold_out : null,
            available_spots:
              typeof available_spots === "number" ? available_spots : null,
            grand_total_cents:
              typeof grand_total === "number" && grand_total > 0
                ? Math.round(grand_total * 100)
                : null,
            source,
          };
        }
      );
      logAvailability(availabilityRows, searchId);
    }
  } catch (err) {
    // Throttled like every other capture in this file: this sits on the
    // highest-volume path and one bad response shape would otherwise emit one
    // Sentry event per search.
    const now = Date.now();
    if (
      lastAvailabilityReportAt === null ||
      now - lastAvailabilityReportAt >= AVAILABILITY_REPORT_INTERVAL_MS
    ) {
      lastAvailabilityReportAt = now;
      captureAPIError(err instanceof Error ? err : new Error(String(err)), {
        endpoint: "searchParking.logAvailability",
        method: "GET",
      });
    }
  }

  // Filter out unavailable lots and lots with no valid pricing
  const availableLots = lotsWithPricing.filter(
    (lot) =>
      lot.availability !== "unavailable" &&
      lot.pricing?.grandTotal !== undefined &&
      lot.pricing.grandTotal > 0
  ).map((lot) => ({ ...lot, airportCode: airportInfo.code }));

  // Each airport lists its OWN lots: drop a lot another airport is strictly
  // closer to (src/lib/search/airport-ownership.ts — JFK and LGA overlap).
  // Applied AFTER pricing on purpose: if this airport's own lots leave nothing
  // a customer can book (sold out, closed for today, or failed to price), the
  // full radius list is shown as before rather than turning a sale into "no
  // results" — flagged `ownAirportFallback` so a sell-out night can be told
  // from a regression. A direct lot counts only once it can be booked
  // (DIRECT_BOOKING_OPEN). A seaport or test airport is never filtered.
  const ownershipExempt = isExemptFromOwnership(airportInfo);
  const ownFilter = isOwnAirportFilterEnabled() && !ownershipExempt;
  const belongsHere = (loc: ReslabLocation) => locationBelongsToAirport(loc, airportInfo);
  const ownAvailable = ownFilter
    ? availableLots.filter((lot) => lotBelongsToAirport(lot, airportInfo))
    : availableLots;
  const ownPriced = ownFilter ? pricedLots.filter((p) => belongsHere(p.location)) : pricedLots;
  // In pricedLots, a null minPriceData means exactly "getMinPrice threw"
  // (closed-for-today lots were removed above).
  const ownPricingErrors = ownPriced.filter((p) => p.minPriceData === null).length;
  const bookableDirect = DIRECT_BOOKING_OPEN ? directUnified.length : 0;
  // A bookable direct lot stands in for sold-out own lots, but not for own
  // lots that FAILED to price — that is an outage, and the other airport's
  // ResLab lots keep the customer (and `reslabUnavailable`) honest.
  const ownAirportFallback =
    ownFilter &&
    ownAvailable.length === 0 &&
    availableLots.length > 0 &&
    (bookableDirect === 0 || ownPricingErrors > 0);
  const shownReslabLots = ownAirportFallback ? availableLots : ownAvailable;
  // The pricing pass for the lots shown, so search_events' results_count and
  // sold_out_count describe the same set (the digest divides one by the other).
  const shownPriced = ownAirportFallback ? pricedLots : ownPriced;
  const shownPricingErrors = shownPriced.filter((p) => p.minPriceData === null).length;
  if (ownAirportFallback) reportOwnAirportFallback(airportInfo.code, ownPriced, ownPricingErrors);
  // The "Most booked" leader is ALWAYS chosen from this airport's own lots —
  // with the filter switched off and on the fallback too — so another airport's
  // leader can never be pinned here. On the fallback the own leader is not
  // among the results, so nothing is pinned (pickMostBookedLot).
  const consideredIds = (ownershipExempt ? locations : locations.filter(belongsHere)).map((loc) => loc.id);

  // Degraded if pricing was partial OR the location list was THIN OR ResLab
  // was unreachable and only direct lots are being served — either way the
  // result under-reports and must not be CDN-cached. A merely stale
  // (complete, past-TTL) list is NOT degraded: the result is full, so it's
  // cacheable, just on a shorter TTL.
  //
  // `reslabUnavailable` = ResLab contributed NOTHING for a non-data reason:
  // the list fetch threw, OR every lot it listed failed to price (the
  // recurring TRIPLY-13 "pricing unavailable for all N" degradation). Both
  // used to be a throw; with direct lots to show they are a 200 — and the
  // airport ISR pages / chat key on this flag to treat that 200 as the outage
  // it is (review H1). Only ever set with the flag on, because without direct
  // lots both cases still throw.
  const reslabUnavailable =
    reslabFailure !== null ||
    (directUnified.length > 0 && locations.length > 0 && availableLots.length === 0 && pricingErrors > 0);
  const isDegraded = pricingErrors > 0 || listBuildIncomplete || reslabUnavailable;
  // The same judgement for the lots the customer is SHOWN: a hidden other-
  // airport lot failing to price does not make this airport's list partial.
  // Drives the "Lowest total" badge and the search_events row; caching still
  // follows `isDegraded` (conservative — the min-price amplification history).
  const shownDegraded = shownPricingErrors > 0 || listBuildIncomplete || reslabUnavailable;
  // Everything telemetry-only (cheapest price, sold-out count, the Math.min
  // spread) is derived INSIDE emitSearchEvent's try/catch — see its comment.
  // results_count / cheapest / sold_out stay ResLab-only (plan A-22) so the
  // demand history reads the same across the flag flip; direct lots have
  // their own column.
  emitSearchEvent({
    // What the customer is shown (own-airport lots), so results_count, the
    // sold-out count and the cheapest floor all describe the page they saw.
    // availability_log above still records every lot priced.
    results_count: shownReslabLots.length,
    degraded: shownDegraded,
    stale: listBuildStale,
    priced: shownPriced,
    available: shownReslabLots,
    pricingErrors: shownPricingErrors,
    directCount,
    directSkipped,
  });

  // Found locations but priced none of them while pricing calls were erroring:
  // ResLab is degraded, not genuinely empty. Throw so the route returns an
  // uncacheable 5xx rather than caching a misleading "no parking" result —
  // unless direct lots can still be shown, in which case the result goes out
  // degraded (no-store) with the partial-pricing capture below.
  if (availableLots.length === 0 && pricingErrors > 0 && directUnified.length === 0) {
    throw new ReslabError(
      502,
      `ResLab pricing unavailable for all ${pricedLots.length} ${airportCode} location(s)`
    );
  }

  // Partial degradation: at least one lot priced but some pricing calls failed,
  // so the list is incomplete. The per-location catch above is otherwise silent
  // — surface it to Sentry, and flag it so the route won't CDN-cache a thin
  // result that would stick for the TTL (the 2026-06-29 failure mode, at
  // partial scale).
  if (pricingErrors > 0) {
    captureAPIError(
      new Error(
        `ResLab pricing degraded: ${pricingErrors}/${pricedLots.length} ${airportCode} location(s) failed to price`
      ),
      { endpoint: "/api/search", method: "GET", statusCode: 502 }
    );
  }

  // Sort lots — both sources together, so a direct lot competes on the same
  // price/distance as its ResLab neighbours. The only lot ever pinned is the
  // airport's clear booking leader (pickMostBookedLot).
  const merged = [...shownReslabLots, ...directUnified];
  const counts = countsPromise ? await countsPromise : null;
  const pinned = counts?.ok ? pickMostBookedLot(merged, consideredIds, counts.counts) : null;
  const sortedLots = sortLots(
    merged,
    sort,
    rankingEnabled ? { recommended: true, pinnedId: pinned?.id ?? null } : { recommended: false }
  );
  // Counts unread → no "Most booked" on any sort, and the Recommended order fell
  // back to cheapest-first: cache briefly so the badge/pin return quickly.
  const rankingDegraded = counts !== null && !counts.ok;

  // Badges are independent of the chosen sort, and only where cards render them.
  // "Lowest total" is withheld unless the result is complete (no partial
  // pricing, thin list, ResLab outage or failed direct-lot read).
  const lowest = withBadges
    ? lowestTotalLot(sortedLots, { resultComplete: !shownDegraded && !directSkipped })
    : null;
  const results: UnifiedLot[] = withBadges
    ? sortedLots.map((lot) => {
        const badges: LotBadge[] = [];
        if (pinned && lot.id === pinned.id) badges.push("most_booked");
        if (lowest && lot.id === lowest.id) badges.push("lowest_total");
        return badges.length > 0 ? { ...lot, badges } : lot;
      })
    : sortedLots;

  return {
    airport: airportInfo,
    checkin,
    checkout,
    checkinTime,
    checkoutTime,
    results,
    total: results.length,
    locationsConsidered,
    // Not on a thin list: with lots missing, "closed for today" may be false.
    ...(sortedLots.length === 0 && closedTodayCount > 0 && !listBuildIncomplete
      ? {
          message: "No lots near this airport can take a booking for the rest of today",
          closedForToday: true,
        }
      : {}),
    degraded: isDegraded,
    stale: listBuildStale,
    listIncomplete: listBuildIncomplete,
    ...(rankingDegraded ? { rankingDegraded } : {}),
    ...(ownAirportFallback ? { ownAirportFallback } : {}),
    ...(directEnabled
      ? { reslabUnavailable, directUnavailable: directSkipped, directCount }
      : {}),
  };
}
