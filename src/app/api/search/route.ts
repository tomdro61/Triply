import { NextRequest, NextResponse } from "next/server";
import { searchParking, isLocationBackoffError } from "@/lib/reslab/search";
import type { SearchEventAttribution } from "@/lib/reslab/search";
import { SortOption } from "@/types/lot";
import { captureAPIError } from "@/lib/sentry";
import { z } from "zod";
import { readAttributionFromRequest } from "@/lib/attribution/read-request";
import type { Attribution } from "@/lib/attribution/schema";

/** First-touch utm_source/medium/campaign + GA client id off the same
 *  `triply_attr` cookie bookings already read (migration 023), so a
 *  search_events row can later be joined to a booking. Absent/invalid
 *  attribution logs as all-null, same as bookings.attribution NULL.
 *
 *  Parsed with surface="search": /api/search is public and bot-reachable,
 *  and a junk triply_attr cookie here must never inject a
 *  booking.step=checkout-tagged event into the money-path error stream (see
 *  readAttributionFromRequest). */
function attributionFields(attribution: Attribution | null): SearchEventAttribution {
  if (!attribution || attribution.v === null) {
    return { utmSource: null, utmMedium: null, utmCampaign: null, gaClientId: null };
  }
  return {
    utmSource: attribution.first.src ?? null,
    utmMedium: attribution.first.med ?? null,
    utmCampaign: attribution.first.cmp ?? null,
    gaClientId: attribution.ga_client_id ?? null,
  };
}

// A cold location-list build sweeps ~54 pages and is budgeted at 40s
// (LOCATION_BUILD_BUDGET_MS). Pin the invocation ceiling above it so the build
// always settles — and therefore always arms its circuit breaker — instead of
// being killed mid-sweep, which would leave the breaker un-armed and re-open
// the per-request sweep loop that caused the 2026-08-10 outage.
export const maxDuration = 60;

const searchQuerySchema = z.object({
  airport: z.string().min(2).max(10),
  checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format").optional(),
  checkinTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Invalid time format").optional(),
  checkoutTime: z.string().regex(/^\d{1,2}:\d{2}\s[AP]M$/, "Invalid time format").optional(),
  sort: z.enum(["popularity", "price_asc", "price_desc", "rating", "distance"]).optional(),
  // Set by the homepage's FeaturedParking widget only (src/components/shared/
  // featured-parking.tsx), which polls this endpoint with fixed tomorrow/+7
  // dates on every homepage view and airport-tab click. Tags the
  // search_events row 'homepage-featured' instead of 'search' so that
  // automated background traffic can be told apart from a real customer
  // search — see migration 027 for the full reasoning. Never trusted for
  // anything else; an arbitrary/missing value just falls back to 'search'.
  surface: z.enum(["featured"]).optional(),
});

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  // Validate query parameters
  const validation = searchQuerySchema.safeParse({
    airport: searchParams.get("airport") || "JFK",
    checkin: searchParams.get("checkin") || undefined,
    checkout: searchParams.get("checkout") || undefined,
    checkinTime: searchParams.get("checkinTime") || undefined,
    checkoutTime: searchParams.get("checkoutTime") || undefined,
    sort: searchParams.get("sort") || undefined,
    surface: searchParams.get("surface") || undefined,
  });

  if (!validation.success) {
    return NextResponse.json(
      { error: "Invalid search parameters", fields: validation.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const airport = validation.data.airport;
  // Pricing-only fallbacks: search results show "from $X" estimates. The actual
  // booking time is captured on the lot detail page and validated server-side.
  // Recorded as `datesDefaulted` on the search_events row (migration 027) so
  // this fallback is never counted as if a person had typed those dates.
  const datesDefaulted = !validation.data.checkin || !validation.data.checkout;
  const checkin = validation.data.checkin || tomorrow.toISOString().split("T")[0];
  const checkout =
    validation.data.checkout ||
    new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const pricingCheckinTime = validation.data.checkinTime || "10:00 AM";
  const pricingCheckoutTime = validation.data.checkoutTime || "2:00 PM";
  const sort = validation.data.sort || "popularity";
  const searchEventSource = validation.data.surface === "featured" ? "homepage-featured" : undefined;

  try {
    const result = await searchParking({
      airport,
      checkin,
      checkout,
      checkinTime: pricingCheckinTime,
      checkoutTime: pricingCheckoutTime,
      sort,
      datesDefaulted,
      searchEventSource,
      // "search" is checked against Attribution's discriminated union by
      // readAttributionFromRequest, never the checkout money path — see
      // attributionFields above.
      attribution: attributionFields(readAttributionFromRequest(request, {}, "search")),
    });

    // Cache only a clean, non-empty result. An empty result OR a degraded one
    // (thin location list, or some/all ResLab pricing calls failed) is served
    // no-store, so a transient upstream blip can never be cached — as "No
    // parking found" or as a thin partial list — and stick for the TTL (the
    // 2026-06-29 incident).
    //
    // A `stale` result is a different animal and must NOT be lumped in with
    // degraded: the lot list is COMPLETE, just past its TTL because ResLab is
    // failing. Refusing to cache it would push 100% of search traffic to origin
    // for as long as the outage lasts, and every origin request fans out into
    // one min-price call per nearby lot — i.e. it would move the amplification
    // loop onto a different ResLab endpoint at the worst possible moment. Cache
    // it, but briefly, so a repaired list is picked up within a minute.
    const cacheControl =
      result.total > 0 && !result.degraded
        ? result.stale
          ? "public, s-maxage=60, stale-while-revalidate=300"
          : "public, s-maxage=300, stale-while-revalidate=600"
        : "no-store";

    // search_events (the per-search demand header row) is now written from
    // inside searchParking itself, alongside availability_log, sharing its
    // search_id/env/lead_days — see src/lib/search-events/log.ts and
    // migration 027. There is nothing left to do here: no route-level insert
    // to await, and therefore nothing here that could turn a telemetry defect
    // into a customer-facing 503 (the earlier design's block was inline in
    // this success path, unwrapped).

    return NextResponse.json(result, {
      headers: { "Cache-Control": cacheControl },
    });
  } catch (error) {
    console.error("Search API error:", error);
    // The location-list circuit breaker fires on every search while it's open
    // and already reports itself once per backoff window with a more useful
    // message (see isLocationBackoffError). Capturing it here too would bury
    // the root-cause ResLab error under hundreds of derived events — the
    // opposite of what we need during an incident. Every other error is still
    // captured unconditionally.
    if (!isLocationBackoffError(error)) {
      captureAPIError(
        error instanceof Error ? error : new Error(String(error)),
        {
          endpoint: "/api/search",
          method: "GET",
        }
      );
    }

    if (error instanceof Error && error.message.startsWith("Invalid airport code")) {
      return NextResponse.json(
        { error: "Invalid airport code" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Upstream (ResLab) failure — never cache an error so it can't poison the
    // CDN. 503 signals "transient, retry" to the client.
    return NextResponse.json(
      { error: "Failed to search for parking" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
