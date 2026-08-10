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
import { UnifiedLot, SortOption } from "@/types/lot";
import { calculateDistance } from "@/lib/utils/geo";
import { convertTo24Hour } from "@/lib/utils/time";
import { generateSlug } from "@/lib/utils/slug";
import { captureAPIError } from "@/lib/sentry";

export { generateSlug };

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

  // Determine availability
  let availability: "available" | "limited" | "unavailable" = "available";
  if (minPriceData?.reservation.sold_out) {
    availability = "unavailable";
  } else if (
    minPriceData?.reservation.available_spots !== undefined &&
    minPriceData.reservation.available_spots < 10
  ) {
    availability = "limited";
  }

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
 * Sort lots by the specified option
 */
export function sortLots(lots: UnifiedLot[], sortBy: SortOption): UnifiedLot[] {
  const sorted = [...lots];

  switch (sortBy) {
    case "price_asc":
      sorted.sort(
        (a, b) => (a.pricing?.minPrice ?? 999) - (b.pricing?.minPrice ?? 999)
      );
      break;
    case "price_desc":
      sorted.sort(
        (a, b) => (b.pricing?.minPrice ?? 0) - (a.pricing?.minPrice ?? 0)
      );
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

export interface SearchParkingParams {
  airport: string;
  checkin: string; // YYYY-MM-DD
  checkout: string; // YYYY-MM-DD
  checkinTime?: string; // "10:00 AM" format
  checkoutTime?: string; // "2:00 PM" format
  sort?: SortOption;
}

export interface SearchParkingResult {
  airport: Airport;
  checkin: string;
  checkout: string;
  checkinTime: string;
  checkoutTime: string;
  results: UnifiedLot[];
  total: number;
  message?: string;
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
} | null = null;
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
  lastBackoffReportAt = null;
  buildPhaseSweeps = 0;
  inFlightLocationBuild = null;
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

export async function getChannelLocationsCached(): Promise<LocationListResult> {
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

  // `next build` prerenders ~85 airport landing pages, and airport-page/data.ts
  // deliberately swallows build-phase failures so a blip can't fail the deploy.
  // Honouring the backoff there would fast-fail every remaining page and ship
  // ~85 empty, indexable SEO pages that then serve from ISR for up to an hour.
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
  // Count every build-phase sweep, not just the ones that bypassed a backoff.
  // Once the bypasses are spent, pages fall back to the thin list and still fan
  // out ~15 min-price calls each, so ~85 pages take minutes of wall-clock — and
  // every expiry of the (short) backoff window would otherwise buy another
  // uncounted full sweep. Bounding bypasses instead of sweeps gives a real
  // ceiling of 3 + buildDuration/backoffWindow, not 3.
  const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
  const buildSweepsExhausted =
    isBuildPhase && buildPhaseSweeps >= BUILD_PHASE_MAX_SWEEPS;
  const buildBypassAllowed = isBuildPhase && !buildSweepsExhausted;

  if (backingOff && !buildBypassAllowed) {
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
      const failedPages = refusedPages + skippedPages;

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
        (fallback !== null &&
          fallback.complete &&
          unique.length < fallback.data.length * 0.5);

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
              `assembled ${unique.length} unique from ${all.length} rows ` +
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
      cachedLocationList = { data: unique, builtAt: Date.now(), complete: true };
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

// Replacement for ResLab's broken lat/lng geo-search: locations within
// `radiusKm` of the airport. 15km matches ResLab's documented search radius.
async function findLocationsNearAirport(
  lat: number,
  lng: number,
  radiusKm = 15
): Promise<{
  locations: ReslabLocation[];
  incomplete: boolean;
  stale: boolean;
}> {
  // calculateDistance() returns MILES (geo.ts uses R=3959), so convert the km
  // radius before comparing — otherwise the filter is ~2.6x too wide.
  const radiusMi = radiusKm * 0.621371;
  const { data, incomplete, stale } = await getChannelLocationsCached();
  const locations = data.filter((loc) => {
    const llat = parseFloat(loc.latitude);
    const llng = parseFloat(loc.longitude);
    if (Number.isNaN(llat) || Number.isNaN(llng)) return false;
    return calculateDistance(lat, lng, llat, llng) <= radiusMi;
  });
  return { locations, incomplete, stale };
}

export async function searchParking(
  params: SearchParkingParams
): Promise<SearchParkingResult> {
  const {
    airport: airportCode,
    checkin,
    checkout,
    // Search results show "from $X" estimates only — the customer must pick
    // their actual times on the lot detail page before booking.
    checkinTime = "10:00 AM",
    checkoutTime = "2:00 PM",
    sort = "popularity",
  } = params;

  // Validate airport
  const airportInfo = getAirportByCode(airportCode);
  if (!airportInfo) {
    throw new Error(`Invalid airport code: ${airportCode}`);
  }

  // Convert times to 24-hour format
  const checkinTime24 = convertTo24Hour(checkinTime);
  const checkoutTime24 = convertTo24Hour(checkoutTime);

  // Format dates for ResLab API (YYYY-MM-DD HH:mm:ss)
  const fromDate = `${checkin} ${checkinTime24}:00`;
  const toDate = `${checkout} ${checkoutTime24}:00`;

  // Search for locations near the airport.
  //
  // safety-removed: the previous `catch { locations = [] }` swallowed ResLab
  // outages into a "0 lots" success. /api/search caches 200s at the CDN, so a
  // transient ResLab 502 got cached as "No parking found" and stuck for the
  // full TTL — the live incident on 2026-06-29. Let ResLab errors propagate so
  // the route returns an uncacheable 5xx instead of poisoning the cache.
  let locations: ReslabLocation[];
  // True when the workaround served a THIN location list (pages failed, or the
  // sweep looked implausible) — folded into `degraded` so the route won't
  // CDN-cache a list that under-reports the lots near this airport.
  let listBuildIncomplete = false;
  // True when the list was COMPLETE but past its TTL. Not degraded — the result
  // is a full one — but the route shortens its CDN TTL so we pick up a repaired
  // list quickly once ResLab recovers.
  let listBuildStale = false;
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

  // Genuine "no lots near this airport" — distinct from a ResLab failure, which
  // now throws above. Returned as a 200, but the route serves every empty
  // result no-store (we never cache an empty search).
  if (locations.length === 0) {
    return {
      airport: airportInfo,
      checkin,
      checkout,
      checkinTime,
      checkoutTime,
      results: [],
      total: 0,
      message: "No parking locations found near this airport",
      // An outage-induced empty (a thin build dropped this airport's lots) is
      // already no-store via total:0; flag it so it's distinguishable.
      degraded: listBuildIncomplete,
      stale: listBuildStale,
      listIncomplete: listBuildIncomplete,
    };
  }

  // Get minimum price for each location. A per-location pricing failure is
  // non-fatal — we still show the others — but count them so we can tell a
  // genuine "everything is sold out" empty from a ResLab degradation (below).
  let pricingErrors = 0;
  const lotsWithPricing = await Promise.all(
    locations.map(async (location) => {
      let minPriceData: ReslabMinPriceResponse | null = null;

      try {
        minPriceData = await reslab.getMinPrice(location.id, {
          type: "parking",
          reservation_type: "parking",
          from_date: fromDate,
          to_date: toDate,
          number_of_spots: 1,
        });
      } catch {
        // Price unavailable for this location (transient ResLab error or
        // genuinely no price). Counted so an all-error result doesn't get
        // served as a cacheable empty success.
        pricingErrors++;
      }

      return transformLocation(
        location,
        minPriceData,
        airportInfo.latitude,
        airportInfo.longitude
      );
    })
  );

  // Filter out unavailable lots and lots with no valid pricing
  const availableLots = lotsWithPricing.filter(
    (lot) =>
      lot.availability !== "unavailable" &&
      lot.pricing?.grandTotal !== undefined &&
      lot.pricing.grandTotal > 0
  );

  // Found locations but priced none of them while pricing calls were erroring:
  // ResLab is degraded, not genuinely empty. Throw so the route returns an
  // uncacheable 5xx rather than caching a misleading "no parking" result.
  if (availableLots.length === 0 && pricingErrors > 0) {
    throw new ReslabError(
      502,
      `ResLab pricing unavailable for all ${locations.length} ${airportCode} location(s)`
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
        `ResLab pricing degraded: ${pricingErrors}/${locations.length} ${airportCode} location(s) failed to price`
      ),
      { endpoint: "/api/search", method: "GET", statusCode: 502 }
    );
  }

  // Sort lots
  const sortedLots = sortLots(availableLots, sort);

  return {
    airport: airportInfo,
    checkin,
    checkout,
    checkinTime,
    checkoutTime,
    results: sortedLots,
    total: sortedLots.length,
    // Degraded if pricing was partial OR the location list was THIN — either
    // way the result under-reports and must not be CDN-cached. A merely stale
    // (complete, past-TTL) list is NOT degraded: the result is full, so it's
    // cacheable, just on a shorter TTL. See `stale` below.
    degraded: pricingErrors > 0 || listBuildIncomplete,
    stale: listBuildStale,
    listIncomplete: listBuildIncomplete,
  };
}
