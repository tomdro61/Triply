import { productionAirports } from "@/config/airports";
import { getPublishedPostCount } from "@/lib/cms";

export const STATIC_ID = 0;
export const AIRPORTS_ID = 1;
export const BLOG_AIRPORT_HUBS_ID = 2;
export const BLOG_CATEGORIES_ID = 3;
export const LOTS_ID_START = 100;
export const BLOG_ID_START = 200;
export const AIRPORTS_PER_LOT_SEGMENT = 20;
export const BLOG_POSTS_PER_SEGMENT = 100;

/**
 * Calculate all sitemap segment IDs.
 * Shared between generateSitemaps() and the sitemap index route.
 */
export async function getSitemapSegmentIds(): Promise<number[]> {
  const ids: number[] = [STATIC_ID, AIRPORTS_ID, BLOG_AIRPORT_HUBS_ID, BLOG_CATEGORIES_ID];

  const lotSegmentCount = Math.ceil(
    productionAirports.length / AIRPORTS_PER_LOT_SEGMENT
  );
  for (let i = 0; i < lotSegmentCount; i++) {
    ids.push(LOTS_ID_START + i);
  }

  try {
    const totalPosts = await getPublishedPostCount();
    const blogSegmentCount = Math.max(
      1,
      Math.ceil(totalPosts / BLOG_POSTS_PER_SEGMENT)
    );
    for (let i = 0; i < blogSegmentCount; i++) {
      ids.push(BLOG_ID_START + i);
    }
  } catch (error) {
    // Deliberately NOT rethrowing CmsAuthError here. This runs at build time
    // (generateSitemaps) and for /api/sitemap-index: swallowing keeps the
    // index and the static/airport/lot segments listed. Note that a refused
    // key still FAILS THE BUILD through the prerendered blog segments in
    // sitemap.ts (their rethrow is deliberate — red builds are the loud
    // signal; PAYLOAD_API_KEY must be set in Production, Preview and local
    // env before CMS reads lock). fetchFromCms already reported the
    // cms:auth event; log the rest so a 5xx/timeout here isn't invisible.
    console.warn("sitemap: blog post count unavailable, listing one blog segment:", error);
    ids.push(BLOG_ID_START);
  }

  return ids;
}
