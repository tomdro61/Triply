import { NextRequest, NextResponse } from "next/server";
import { searchParking, isLocationBackoffError } from "@/lib/reslab/search";
import { SortOption } from "@/types/lot";
import { captureAPIError } from "@/lib/sentry";
import { z } from "zod";
import { readAttributionFromRequest } from "@/lib/attribution/read-request";
import type { Attribution } from "@/lib/attribution/schema";
import { deriveSearchEventDates } from "@/lib/search-events/derive";
import { logSearchEvent } from "@/lib/search-events/log";

/** First-touch source/medium/campaign + GA client id off the same
 *  `triply_attr` cookie bookings already read (migration 023), so a
 *  search_events row can later be joined to a booking. Absent/invalid
 *  attribution logs as all-null, same as bookings.attribution NULL. */
function attributionFields(attribution: Attribution | null): {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  gaClientId: string | null;
} {
  if (!attribution || attribution.v === null) {
    return { source: null, medium: null, campaign: null, gaClientId: null };
  }
  return {
    source: attribution.first.src ?? null,
    medium: attribution.first.med ?? null,
    campaign: attribution.first.cmp ?? null,
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
  });

  if (!validation.success) {
    return NextResponse.json(
      { error: "Invalid search parameters", fields: validation.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const airport = validation.data.airport;
  const checkin = validation.data.checkin || tomorrow.toISOString().split("T")[0];
  const checkout =
    validation.data.checkout ||
    new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  // Pricing-only fallbacks: search results show "from $X" estimates. The actual
  // booking time is captured on the lot detail page and validated server-side.
  const pricingCheckinTime = validation.data.checkinTime || "10:00 AM";
  const pricingCheckoutTime = validation.data.checkoutTime || "2:00 PM";
  const sort = validation.data.sort || "popularity";

  try {
    const result = await searchParking({
      airport,
      checkin,
      checkout,
      checkinTime: pricingCheckinTime,
      checkoutTime: pricingCheckoutTime,
      sort,
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

    // Fire-and-forget demand logging — never awaited, never allowed to delay
    // or fail this response (see src/lib/search-events/log.ts). Skipped
    // entirely for a date range deriveSearchEventDates rejects (unparseable,
    // or checkout before checkin) rather than writing a row the table's
    // CHECK/NOT NULL constraints would bounce anyway.
    const dates = deriveSearchEventDates(checkin, checkout);
    if (dates) {
      const pricedTotals = result.results
        .map((lot) => lot.pricing?.grandTotal)
        .filter((v): v is number => typeof v === "number" && v > 0);
      const { source, medium, campaign, gaClientId } = attributionFields(
        readAttributionFromRequest(request, {})
      );
      logSearchEvent({
        airport_code: airport,
        check_in: checkin,
        check_out: checkout,
        stay_days: dates.stayDays,
        lead_days: dates.leadDays,
        results_count: result.total,
        cheapest_price_cents:
          pricedTotals.length > 0 ? Math.round(Math.min(...pricedTotals) * 100) : null,
        sold_out_count: null,
        source,
        medium,
        campaign,
        ga_client_id: gaClientId,
      });
    }

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
