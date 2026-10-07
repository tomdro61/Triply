import type { MetadataRoute } from "next";
import { productionAirports } from "@/config/airports";
import {
  AIRPORT_SEARCH_RADIUS_KM,
  BLOCKED_RESLAB_LOCATION_IDS,
  getChannelLocationsNoSweep,
  locationsNearPoint,
} from "@/lib/reslab/search";
import { isSnapshotEnabled } from "@/lib/reslab/location-snapshot";
import { resolveEnv } from "@/lib/env";
import { captureAPIError } from "@/lib/sentry";
import { generateSlug } from "@/lib/utils/slug";
import { isDirectLotsEnabled } from "@/lib/direct/flag";
import { fetchDirectLots, isListable, type DirectLot } from "@/lib/direct/store";
import {
  getPublishedPosts,
  CmsAuthError,
  getDistinctAirportCodes,
  getCategories,
  getContentUpdatedAt,
} from "@/lib/cms";
import {
  STATIC_ID,
  AIRPORTS_ID,
  BLOG_AIRPORT_HUBS_ID,
  BLOG_CATEGORIES_ID,
  LOTS_ID_START,
  BLOG_ID_START,
  AIRPORTS_PER_LOT_SEGMENT,
  BLOG_POSTS_PER_SEGMENT,
  getSitemapSegmentIds,
} from "@/lib/sitemap-config";

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://triplypro.com";

/**
 * Generate all sitemap segment IDs.
 * Next.js uses this to determine which /sitemap/[id].xml routes to build.
 */
export async function generateSitemaps() {
  const ids = await getSitemapSegmentIds();
  return ids.map((id) => ({ id }));
}

/**
 * Generate URLs for a single sitemap segment.
 * Next.js calls this for each ID returned by generateSitemaps().
 */
export default async function sitemap(props: {
  id: Promise<number>;
}): Promise<MetadataRoute.Sitemap> {
  const id = Number(await props.id);

  if (id === STATIC_ID) return staticPages();
  if (id === AIRPORTS_ID) return airportPages();
  if (id === BLOG_AIRPORT_HUBS_ID) return blogAirportHubPages();
  if (id === BLOG_CATEGORIES_ID) return blogCategoryPages();
  if (id >= LOTS_ID_START && id < BLOG_ID_START) return lotPages(id);
  if (id >= BLOG_ID_START) return blogPostPages(id);

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Segment generators
// ─────────────────────────────────────────────────────────────────────────────

function staticPages(): MetadataRoute.Sitemap {
  return [
    { url: baseUrl, changeFrequency: "weekly", priority: 1.0 },
    { url: `${baseUrl}/about`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${baseUrl}/help`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${baseUrl}/contact`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${baseUrl}/blog`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${baseUrl}/terms`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${baseUrl}/privacy`, changeFrequency: "yearly", priority: 0.3 },
  ];
}

function airportPages(): MetadataRoute.Sitemap {
  return [
    {
      url: `${baseUrl}/airport-parking`,
      changeFrequency: "weekly",
      priority: 0.85,
    },
    ...productionAirports.map((airport) => ({
      url: `${baseUrl}/${airport.slug}/airport-parking`,
      changeFrequency: "daily" as const,
      priority: 0.9,
    })),
  ];
}

async function blogAirportHubPages(): Promise<MetadataRoute.Sitemap> {
  try {
    const codes = await getDistinctAirportCodes();
    return codes.map((code) => ({
      url: `${baseUrl}/blog/airport/${code.toLowerCase()}`,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    }));
  } catch (error) {
    // A refused API key must not become an empty sitemap: rethrow so the
    // route 500s (search engines retry) and Sentry has the cms:auth event.
    if (error instanceof CmsAuthError) throw error;
    return [];
  }
}

async function blogCategoryPages(): Promise<MetadataRoute.Sitemap> {
  try {
    const { docs: categories } = await getCategories();
    return categories.map((cat: { slug: string }) => ({
      url: `${baseUrl}/blog/category/${cat.slug}`,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }));
  } catch (error) {
    // A refused API key must not become an empty sitemap: rethrow so the
    // route 500s (search engines retry) and Sentry has the cms:auth event.
    if (error instanceof CmsAuthError) throw error;
    return [];
  }
}

async function lotPages(id: number): Promise<MetadataRoute.Sitemap> {
  const chunkIndex = id - LOTS_ID_START;
  const start = chunkIndex * AIRPORTS_PER_LOT_SEGMENT;
  const airportChunk = productionAirports.slice(
    start,
    start + AIRPORTS_PER_LOT_SEGMENT
  );

  // ResLab lots come from the channel location list this instance holds or the
  // shared snapshot (028) — never from ResLab directly. This segment is built
  // during `next build` and regenerated hourly; it used to call ResLab's
  // lat/lng geo-search once per airport, which has been broken since June
  // (RESLAB_GEO_SEARCH_BROKEN), so every lot segment was empty in production.
  // A sweep here would spend the rate-limited /locations budget on a sitemap.
  const channel = await getChannelLocationsNoSweep();
  if (channel === null) {
    const why = isSnapshotEnabled()
      ? "no usable location list (snapshot unavailable)"
      : "no location list in memory (ENABLE_RESLAB_LOCATION_SNAPSHOT is off)";
    // In production at runtime, fail the regeneration so Next keeps serving
    // the last good segment instead of replacing it with one that has no
    // ResLab lots for an hour (Sentry gets it via onRequestError). Keyed on
    // the environment, not the flag: with the flag off (the PR #40 rollback)
    // only an instance that happened to sweep for a search holds a list, so
    // lot URLs would come and go. In that mode the segments stay at their
    // build-time version (direct lots only) and every hourly regeneration
    // reports this error — expected during a rollback, not a new incident.
    // At build, or outside production, list direct lots only.
    if (resolveEnv() === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
      throw new Error(`Sitemap lot segment ${id}: ${why}; keeping the previous segment`);
    }
    console.warn(`Sitemap lot segment ${id}: ${why}; listing no ResLab lots`);
  }

  // Direct lots (ENABLE_DIRECT_LOTS): one bounded read per segment. A failed
  // read is reported by the store and leaves the segment ResLab-only — the
  // ResLab URLs are the bulk of the sitemap and must not disappear with it.
  // isSellable applies the environment rule, so a staging_only lot is never
  // listed from a production build.
  let directLots: DirectLot[] = [];
  if (isDirectLotsEnabled()) {
    try {
      const direct = await fetchDirectLots({}, "sitemap");
      if (direct.ok) directLots = direct.lots.filter((l) => isListable(l));
      else console.warn(`Sitemap lot segment ${id}: direct lots unavailable (${direct.kind}), listing ResLab only`);
    } catch (error) {
      // fetchDirectLots reports its own failures and doesn't throw, so this is
      // a code bug (e.g. in isListable): report it, keep the ResLab URLs.
      console.warn(`Sitemap lot segment ${id}: direct lots read threw, listing ResLab only:`, error);
      captureAPIError(error instanceof Error ? error : new Error(String(error)), {
        endpoint: "sitemap",
        method: "GET",
        stage: "direct_lots",
      });
    }
  }
  // A ResLab twin of a direct lot is sold direct only once direct booking is
  // open (review B17 / M3; until then isListable hides the direct lot): its
  // URL then renders the direct lot, so list the direct slug and not the twin.
  const suppressedReslabIds = new Set<number>(
    directLots.map((l) => l.reslabLocationId).filter((v): v is number => v !== null)
  );

  const urls: MetadataRoute.Sitemap = [];
  const seen = new Set<string>();
  for (const airport of airportChunk) {
    // Same selection searchParking makes: the mapped location for an airport
    // with a reslabLocationId, otherwise every lot within its 15 km radius.
    const near = channel === null
      ? []
      : airport.reslabLocationId !== undefined
        ? channel.filter((loc) => loc.id === airport.reslabLocationId)
        : locationsNearPoint(channel, airport.latitude, airport.longitude, AIRPORT_SEARCH_RADIUS_KM);
    for (const loc of near) {
      if (BLOCKED_RESLAB_LOCATION_IDS.has(loc.id) || suppressedReslabIds.has(loc.id)) continue;
      const url = `${baseUrl}/${airport.slug}/airport-parking/${generateSlug(loc.name)}`;
      if (seen.has(url)) continue; // two lots with one name resolve to one page
      seen.add(url);
      urls.push({ url, changeFrequency: "daily" as const, priority: 0.8 });
    }
    // lastModified goes through the same Invalid-Date guard as the blog
    // segment (review L3).
    for (const l of directLots) {
      if (l.airportCode !== airport.code) continue;
      const url = `${baseUrl}/${airport.slug}/airport-parking/${l.slug}`;
      if (seen.has(url)) continue; // a same-slug ResLab entry already lists it
      seen.add(url);
      urls.push({
        url,
        lastModified: toValidDate(l.updatedAt),
        changeFrequency: "weekly" as const,
        priority: 0.8,
      });
    }
  }
  if (channel !== null) {
    // One line per segment, so a build log shows the list was used.
    console.log(
      `Sitemap lot segment ${id}: ${urls.length} URLs from a ${channel.length}-lot channel list`
    );
  }
  return urls;
}

// Returns the first candidate that parses to a valid Date. Next serializes
// lastModified via toISOString() AFTER blogPostPages returns, so an Invalid
// Date would throw outside our try/catch and take down the whole sitemap
// segment — a bad date string must degrade to the next candidate instead.
function toValidDate(...candidates: (string | null | undefined)[]): Date {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(); // last resort — never Invalid
}

async function blogPostPages(id: number): Promise<MetadataRoute.Sitemap> {
  const cmsPage = id - BLOG_ID_START + 1;

  try {
    // Sort ascending so oldest posts are in segment 200, newest in the last segment.
    // This keeps segments stable — new posts only affect the last segment.
    const { docs: posts } = await getPublishedPosts(
      { sort: "publishedAt" },
      cmsPage,
      BLOG_POSTS_PER_SEGMENT
    );

    const priorityMap: Record<string, number> = {
      hub: 0.9,
      "sub-pillar": 0.7,
      spoke: 0.6,
    };

    return posts.map(
      (post: {
        slug: string;
        updatedAt: string;
        publishedAt?: string | null;
        contentUpdatedAt?: string | null;
        articleType?: string;
      }) => ({
        url: `${baseUrl}/blog/${post.slug}`,
        // Match JSON-LD dateModified and the visible "Updated" badge: only a
        // genuine content refresh (contentUpdatedAt) counts as a
        // modification. Payload's updatedAt bumps on every save (SEO
        // scoring/link passes), which would mark the whole catalog
        // "modified today" after each bulk pass and teach crawlers to
        // distrust our lastmod entirely.
        lastModified: toValidDate(
          getContentUpdatedAt(post),
          post.publishedAt,
          post.updatedAt
        ),
        changeFrequency: "monthly" as const,
        priority: priorityMap[post.articleType || ""] || 0.6,
      })
    );
  } catch (error) {
    // A refused API key must not become an empty sitemap: rethrow so the
    // route 500s (search engines retry) and Sentry has the cms:auth event.
    if (error instanceof CmsAuthError) throw error;
    return [];
  }
}
