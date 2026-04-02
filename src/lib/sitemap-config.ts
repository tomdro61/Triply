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
  } catch {
    ids.push(BLOG_ID_START);
  }

  return ids;
}
