import { unstable_cache } from "next/cache";
import { after } from "next/server";
import { getAirportByCode, getSellableAirportCode } from "@/config/airports";
import { fetchAirportPageData, type AirportPageData } from "@/lib/airport-page/data";
import { isUsdLabelled } from "@/lib/fx/usd-label";
import { captureAPIError } from "@/lib/sentry";
import type { UnifiedLot } from "@/types/lot";

/**
 * Live "from $X/day" prices for a blog article's airport: the same figures the
 * airport landing page shows (fetchAirportPageData: check-in tomorrow, 7
 * nights, cheapest first). Pricing-only: these numbers are a "from" price at a
 * default window and never reach a booking. The reader picks real dates on
 * /search or the lot page, which re-prices from scratch.
 *
 * Cached per airport, not per post: roughly one ResLab search per airport per
 * hour from the blog (more only when several server instances miss the same
 * window at once). The post page's own ISR hour stacks on the cache hour, so a
 * shown "from" price can be up to about 2 hours old.
 *
 * Accepts what the airport page accepts: a result where one lot of many
 * failed to price (`degraded`) is shown, a thin location list or a ResLab
 * outage is not (fetchAirportPageData throws for those). See data.ts.
 */

export interface BlogPriceLot {
  name: string;
  slug: string;
  /** Daily rate as the airport page's lot cards show it: ResLab fees in, taxes and the service fee out. */
  price: number;
  usdLabel: boolean;
  shuttle: boolean;
  distance: number | null;
}

export interface BlogPriceSnapshot {
  airportCode: string;
  airportSlug: string;
  /** The cheapest lot's daily rate (lots[0].price). */
  fromPrice: number;
  /** US$ label for fromPrice: whether the cheapest lot is a converted (Canadian) one. */
  fromUsdLabel: boolean;
  totalLots: number;
  /** 1 to 3 cheapest priced lots, cheapest first. Never empty (no snapshot then). */
  lots: [BlogPriceLot, ...BlogPriceLot[]];
  /** When ResLab was asked (epoch ms), not when the cache was read: the age the fallback is bounded by. */
  fetchedAt: number;
}

const CACHE_S = 3600;
/**
 * A cold post must not wait on a slow ResLab sweep (up to ~40s); past this it
 * renders without prices. Generous on purpose: only the first render of a post
 * waits (ISR then serves the cached page while it rebuilds in the background),
 * and every timeout bakes a price-less page for an hour, so a tight limit would
 * quietly turn slow airports into the control arm. Timeouts go to Sentry.
 */
export const SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * Cache key part: the hour window, offset per airport so ~85 entries don't all
 * expire at :00 together. With the window in the key an entry is only read
 * inside the hour it was written in; without it, unstable_cache serves a stale
 * entry and refreshes in the background, where a failure only keeps the stale
 * entry (prices could then stay old for days). Same idea as netCacheWindow in
 * api/admin/blog-bookings.
 */
export function priceCacheWindow(now: number, airportCode: string): string {
  let offset = 0;
  for (const ch of airportCode) offset = (offset * 31 + ch.charCodeAt(0)) % CACHE_S;
  return String(Math.floor((now / 1000 + offset) / CACHE_S));
}

function pricedLot(l: UnifiedLot): { lot: UnifiedLot; price: number } | null {
  const p = l.pricing?.minPrice;
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? { lot: l, price: p } : null;
}

/** Pure: turn the airport page's data into what the blog shows. Exported for tests. */
export function buildSnapshot(
  airportCode: string,
  airportSlug: string,
  data: AirportPageData,
  fetchedAt: number
): BlogPriceSnapshot | null {
  const priced = data.lots
    .map(pricedLot)
    .filter((x): x is { lot: UnifiedLot; price: number } => x !== null)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3)
    .map(({ lot, price }) => ({
      name: lot.name,
      slug: lot.slug,
      price,
      usdLabel: isUsdLabelled(lot),
      // Same test as the airport page's hasShuttle (data.ts): a summary, not just the object.
      shuttle: Boolean(lot.shuttleInfo?.summary),
      distance: typeof lot.distanceFromAirport === "number" ? lot.distanceFromAirport : null,
    }));
  const [first, ...rest] = priced;
  if (!first) return null;

  return {
    airportCode,
    airportSlug,
    fromPrice: first.price,
    fromUsdLabel: first.usdLabel,
    totalLots: data.totalLots,
    lots: [first, ...rest],
    fetchedAt,
  };
}

/**
 * One in-flight load per cache key on this instance. unstable_cache does not
 * merge simultaneous misses, so without this every post at a busy airport
 * rebuilt in the first seconds of a new window would run its own search.
 */
const inFlight = new Map<string, Promise<BlogPriceSnapshot | null>>();

/**
 * This instance's last good snapshot per airport, used when a load times out.
 * unstable_cache saves a value only after the render that asked for it, so a
 * load that finishes late may never reach the shared cache; this keeps a warm
 * instance from showing a slow airport without prices hour after hour. At most
 * 2 hours old, the same bound as a cache entry under a stale ISR page.
 */
const lastGood = new Map<string, BlogPriceSnapshot>();
const LAST_GOOD_MAX_MS = 2 * CACHE_S * 1000;

/** Timeout reports sent, one per in-flight load, so a slow search is one Sentry event, not one per post waiting on it. */
const timeoutReported = new Set<string>();

export function __resetBlogPriceInFlightForTests(): void {
  inFlight.clear();
  lastGood.clear();
  timeoutReported.clear();
}

/**
 * Keeps a slow load running past the response (Vercel may otherwise freeze it)
 * so it can fill this instance's lastGood. Whether it also reaches the shared
 * unstable_cache is not guaranteed (that save is collected at render end).
 */
function finishAfterResponse(load: Promise<unknown>): void {
  try {
    after(() => load);
  } catch {
    // Outside a request (tests, scripts): nothing to extend; the promise runs on its own.
  }
}

/**
 * The snapshot for a post's airport, or null when we don't sell that airport,
 * nothing is priced, the search failed, or it took longer than
 * SNAPSHOT_TIMEOUT_MS. A failure is not cached (it throws inside
 * unstable_cache). On a timeout it falls back to this instance's last good
 * snapshot for the airport (at most 2 hours old), else null, and keeps the
 * slow load alive with after(). Without prices the article renders exactly as
 * before this feature.
 */
export async function getBlogPriceSnapshot(code?: string | null): Promise<BlogPriceSnapshot | null> {
  const sellable = getSellableAirportCode(code);
  if (!sellable) return null;
  const airport = getAirportByCode(sellable);
  if (!airport) return null;
  // `next build` has no live inventory; never bake an empty or partial price.
  if (process.env.NEXT_PHASE === "phase-production-build") return null;

  const window = priceCacheWindow(Date.now(), airport.code);
  const key = `${airport.code}:${window}`;
  let load = inFlight.get(key);
  if (!load) {
    load = unstable_cache(
      async () => {
        const fetchedAt = Date.now();
        return buildSnapshot(airport.code, airport.slug, await fetchAirportPageData(airport), fetchedAt);
      },
      ["blog-price-snapshot", airport.code, window],
      { revalidate: 2 * CACHE_S }
    )()
      .then((snapshot) => {
        if (!snapshot) {
          // The latest answer is "nothing priced": never fall back to an older price.
          lastGood.delete(airport.code);
        } else if ((lastGood.get(airport.code)?.fetchedAt ?? 0) < snapshot.fetchedAt) {
          // Only newer data replaces older (a late load from an earlier window must not).
          lastGood.set(airport.code, snapshot);
        }
        return snapshot;
      })
      .catch((err: unknown) => {
        // fetchAirportPageData already reported its own failures; Sentry drops an
        // error object it has seen, so this only adds the ones it didn't (the
        // cache layer, buildSnapshot). Prices are optional on a blog post.
        captureAPIError(err instanceof Error ? err : new Error(String(err)), {
          endpoint: "/blog/[slug]",
          method: "GET",
          stage: "blog-price-snapshot",
          extra: { airport: airport.code },
        });
        return null;
      })
      .finally(() => {
        inFlight.delete(key);
        timeoutReported.delete(key); // bounded: an entry lives only while its load is in flight
      });
    inFlight.set(key, load);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), SNAPSHOT_TIMEOUT_MS);
  });
  const result = await Promise.race([load, timedOut]).finally(() => clearTimeout(timer));
  if (result !== "timeout") return result;

  finishAfterResponse(load);
  if (!timeoutReported.has(key)) {
    timeoutReported.add(key);
    captureAPIError(new Error(`Blog price snapshot timed out after ${SNAPSHOT_TIMEOUT_MS}ms`), {
      endpoint: "/blog/[slug]",
      method: "GET",
      stage: "blog-price-snapshot-timeout",
      level: "warning",
      extra: { airport: airport.code },
    });
  }
  const prev = lastGood.get(airport.code);
  return prev && Date.now() - prev.fetchedAt <= LAST_GOOD_MAX_MS ? prev : null;
}
