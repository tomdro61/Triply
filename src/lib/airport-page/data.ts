import { cache } from "react";
import { Airport } from "@/config/airports";
import { searchParking, isLocationBackoffError } from "@/lib/reslab/search";
import { ReslabError } from "@/lib/reslab/client";
import { UnifiedLot } from "@/types/lot";
import { captureAPIError } from "@/lib/sentry";

// Throttles the failure report below to one event per window per instance.
const AIRPORT_PAGE_REPORT_INTERVAL_MS = 10 * 60 * 1000;
let lastAirportPageReportAt: number | null = null;

// After an airport's render fails at runtime, later requests for it within
// this window rethrow the same error without calling ResLab again. Airport
// pages are no longer prerendered, so right after a deploy (or while ResLab is
// refusing us) a failed first render is not cached and every visit — bots
// included — would otherwise retry ~1–15 min-price calls. Per instance and per
// airport; only failures are recorded, a success neither records nor clears an
// entry (entries expire), and it is not consulted during `next build`.
// `suppressed` counts the requests answered from an entry: Sentry drops an
// error object it has already captured, so those rethrows add no events, and
// the count rides on the next capture for that airport instead (carried across
// throttled failures; lost only if the airport recovers first). Exported for
// tests.
export const AIRPORT_PAGE_FAILURE_MEMO_MS = 5 * 60 * 1000;
const recentFailures = new Map<string, { at: number; err: unknown; suppressed: number }>();
export function __resetAirportPageFailureMemoForTests(): void {
  recentFailures.clear();
  lastAirportPageReportAt = null;
}

export interface AirportPageData {
  lots: UnifiedLot[];
  topLots: UnifiedLot[];
  cheapestLot: UnifiedLot | null;
  cheapestPrice: number | null;
  closestLot: UnifiedLot | null;
  totalLots: number;
  priceRange: { min: number; max: number } | null;
  hasShuttle: boolean;
  commonAmenities: string[];
  distanceRange: { min: number; max: number } | null;
  /**
   * Lots we list near this airport, priced or not (searchParking's
   * `locationsConsidered`). 0 = we list nothing here ("coming soon"); > 0 with
   * totalLots 0 = none available for the window. null = unknown (the search
   * failed during `next build`), shown with neutral copy.
   */
  locationsConsidered: number | null;
}

/**
 * Fetch and compute all data needed for an airport landing page.
 * Uses default dates (tomorrow + 7 days) matching FeaturedParking pattern.
 */
// Wrapped in React.cache so generateMetadata and the page component share a
// single fetch per request (dedupes the ResLab call AND the Sentry capture on
// failure — they're invoked twice per request otherwise).
export const fetchAirportPageData = cache(async function fetchAirportPageData(
  airport: Airport
): Promise<AirportPageData> {
  const checkin = new Date();
  checkin.setDate(checkin.getDate() + 1);
  const checkout = new Date();
  checkout.setDate(checkout.getDate() + 8);

  const checkinStr = checkin.toISOString().split("T")[0];
  const checkoutStr = checkout.toISOString().split("T")[0];

  let lots: UnifiedLot[] = [];
  let locationsConsidered: number | null = null;
  const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

  if (!isBuildPhase) {
    const recent = recentFailures.get(airport.code);
    if (recent && Date.now() - recent.at < AIRPORT_PAGE_FAILURE_MEMO_MS) {
      // Reported (or deliberately throttled) when it was recorded. Next's
      // onRequestError sees this rethrow but Sentry drops the already-captured
      // object, so count it instead (reported with the next capture).
      recent.suppressed += 1;
      throw recent.err;
    }
  }

  try {
    const result = await searchParking({
      airport: airport.code,
      checkin: checkinStr,
      checkout: checkoutStr,
      sort: "price_asc",
      source: "airport-page",
    });
    // ⚠️ Assign BEFORE the throws below. If these pages are ever prerendered
    // again, the catch swallows during `next build`, so throwing first would
    // leave `lots` empty and bake the zero-lot render — empty, indexable
    // airport pages, strictly worse than the thin page we actually have.
    lots = result.results;
    locationsConsidered = result.locationsConsidered;

    // A THIN location list does not throw — searchParking returns successfully
    // with fewer lots than really exist. /api/search protects itself by serving
    // those no-store; this page has no such guard, so without this check Next
    // would commit a 2-lot render into the ISR cache and serve it — to users and
    // to Googlebot, with a truncated JSON-LD ItemList and a wrong lot count in
    // the metadata — for the full hour. Treat it like a throw so the last-good
    // page stands (at runtime; the build phase keeps the thin lots above).
    //
    // Gated on listIncomplete, NOT the broader `degraded`: `degraded` is also
    // set by a single failed min-price call, and ResLab has a documented
    // "pricing unavailable" degradation. Refusing a whole page because one lot
    // of fifteen failed to price would bake empty pages on healthy deploys.
    if (result.listIncomplete) {
      throw new ReslabError(
        502,
        `Thin ResLab location list for ${airport.code} ` +
          `(${result.results.length} lots) — refusing to bake it into ISR`
      );
    }
    // Same rule for a ResLab outage answered with direct lots only
    // (ENABLE_DIRECT_LOTS, plan A-23): /api/search serves that no-store, but
    // baking it here would publish a one-lot airport page for an hour.
    if (result.reslabUnavailable) {
      throw new ReslabError(
        502,
        `ResLab unavailable for ${airport.code}; ${result.results.length} direct ` +
          `lot(s) only — refusing to bake it into ISR`,
        // searchParking already captured the ROOT error when it chose to serve
        // direct lots; this marker lets the catch below skip a second,
        // root-less capture on every revalidation (review).
        { reslabUnavailableDirectServed: true }
      );
    }
    // The direct-lot read failed (ENABLE_DIRECT_LOTS): direct lots are missing
    // for a non-data reason, and locationsConsidered doesn't count them. With
    // no lots to show, baking it would publish "coming soon" at a direct-only
    // airport, or "no availability" while a bookable direct lot exists. With
    // ResLab lots present the page is right apart from the direct lot, so it
    // renders and caches — the same call /api/search makes (review C11): a DB
    // outage must not 500 every cold airport page. The store already reported
    // the read failure (throttled), so the catch skips a capture.
    if (result.directUnavailable && result.results.length === 0) {
      throw new ReslabError(
        502,
        `Direct lots unavailable for ${airport.code} — refusing to bake it into ISR`,
        { directLotsReadFailed: true }
      );
    }
  } catch (err) {
    // searchParking throws on a real ResLab failure, and also when our own
    // location-list circuit breaker is open (a cold instance backing off after
    // a failed build — see getChannelLocationsCached). A genuine "no lots"
    // still returns an empty result without throwing. Both throw cases mean
    // "we don't know the inventory", so always surface it — this page is
    // ISR-cached for 1h, so a swallowed failure is otherwise invisible.
    // Rate-limited: this fires per page per revalidation, and across ~85
    // airport pages during a degradation that's ~170 events/hour — which would
    // drown the single diagnostic event the circuit breaker deliberately emits
    // once per window. Under-reporting is how this incident hid for 4 weeks;
    // over-reporting is how the signal gets lost. One per window, either way.
    // (Next's onRequestError also sees the runtime rethrow, so a throttled
    // error still reaches Sentry the first time its object is thrown; repeats
    // of the SAME object are dropped by Sentry — see the failure memo.)
    // Throttle ONLY the high-volume, self-reporting circuit-breaker error.
    // Anything else — a TypeError in searchParking, an unexpected ResLab shape —
    // is reported every time. During `next build` the error is swallowed below
    // and never rethrown, so Next's onRequestError never sees it and this is the
    // only capture: a blanket time-based throttle would discard a novel failure
    // with no trace while the build reported success.
    const nowMs = Date.now();
    // Requests the previous (expired) memo entry answered without reaching
    // ResLab — invisible in Sentry otherwise.
    const memoSuppressed = recentFailures.get(airport.code)?.suppressed ?? 0;
    const isSelfReporting =
      isLocationBackoffError(err) ||
      (err instanceof ReslabError &&
        typeof err.details === "object" &&
        err.details !== null &&
        ("reslabUnavailableDirectServed" in err.details ||
          "directLotsReadFailed" in err.details));
    const capture =
      !isSelfReporting ||
      lastAirportPageReportAt === null ||
      nowMs - lastAirportPageReportAt >= AIRPORT_PAGE_REPORT_INTERVAL_MS;
    if (capture) {
      lastAirportPageReportAt = nowMs;
      captureAPIError(err instanceof Error ? err : new Error(String(err)), {
        endpoint: "/[slug]/airport-parking",
        method: "GET",
        ...(memoSuppressed > 0 ? { extra: { memoSuppressedRequests: memoSuppressed } } : {}),
      });
    }

    // At runtime, rethrow: on an ISR revalidation Next keeps serving the
    // last-good cached page instead of overwriting it with an empty render;
    // on a first render (nothing cached yet — these pages are generated on
    // first request since 2026-10-07) the request gets an uncached error and a
    // later visit retries, after the failure memo above expires.
    //
    // The build-phase branch is unreachable for the airport route now that it
    // prerenders no paths (generateStaticParams returns []). It stays as a
    // guard: if something prerenders these pages again, a ResLab blip must not
    // fail the whole deploy. That is the path that baked empty pages on every
    // deploy. Any count assigned before the throw is untrustworthy here (a thin
    // list can report 0 for an airport we serve), so it becomes null: neutral
    // copy, never "coming soon".
    if (!isBuildPhase) {
      // A throttled failure carries the uncounted requests forward, so they
      // reach Sentry with the next capture that actually happens.
      recentFailures.set(airport.code, {
        at: Date.now(),
        err,
        suppressed: capture ? 0 : memoSuppressed,
      });
      throw err;
    }
    locationsConsidered = null;
  }

  if (lots.length === 0) {
    return {
      lots: [],
      topLots: [],
      cheapestLot: null,
      cheapestPrice: null,
      closestLot: null,
      totalLots: 0,
      priceRange: null,
      hasShuttle: false,
      commonAmenities: [],
      distanceRange: null,
      locationsConsidered,
    };
  }

  const prices = lots
    .map((l) => l.pricing?.minPrice)
    .filter((p): p is number => p !== undefined && p > 0);

  const distances = lots
    .map((l) => l.distanceFromAirport)
    .filter((d): d is number => d !== undefined);

  const cheapestLot = lots.reduce<UnifiedLot | null>((best, lot) => {
    if (!lot.pricing?.minPrice) return best;
    if (!best || lot.pricing.minPrice < (best.pricing?.minPrice ?? Infinity)) {
      return lot;
    }
    return best;
  }, null);

  const closestLot = lots.reduce<UnifiedLot | null>((best, lot) => {
    if (lot.distanceFromAirport === undefined) return best;
    if (
      !best ||
      lot.distanceFromAirport < (best.distanceFromAirport ?? Infinity)
    ) {
      return lot;
    }
    return best;
  }, null);

  const hasShuttle = lots.some((l) => l.shuttleInfo?.summary);

  // Count amenity frequency across all lots
  const amenityCounts = new Map<string, number>();
  for (const lot of lots) {
    for (const amenity of lot.amenities) {
      amenityCounts.set(
        amenity.displayName,
        (amenityCounts.get(amenity.displayName) || 0) + 1
      );
    }
  }
  const commonAmenities = [...amenityCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name]) => name);

  return {
    lots,
    topLots: lots.slice(0, 6),
    cheapestLot,
    cheapestPrice: prices.length > 0 ? Math.min(...prices) : null,
    closestLot,
    totalLots: lots.length,
    priceRange:
      prices.length > 0
        ? { min: Math.min(...prices), max: Math.max(...prices) }
        : null,
    hasShuttle,
    commonAmenities,
    distanceRange:
      distances.length > 0
        ? {
            min: Math.min(...distances),
            max: Math.max(...distances),
          }
        : null,
    locationsConsidered,
  };
});
