import type { MetadataRoute } from "next";
import { productionAirports } from "@/config/airports";
import { reslab } from "@/lib/reslab/client";
import { generateSlug } from "@/lib/utils/slug";
import {
  getPublishedPosts,
  getDistinctAirportCodes,
  getCategories,
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
  } catch {
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
  } catch {
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

  try {
    const results = await Promise.allSettled(
      airportChunk.map(async (airport) => {
        const locations = await reslab.searchLocations({
          lat: String(airport.latitude),
          lng: String(airport.longitude),
        });

        return locations.map((loc) => ({
          url: `${baseUrl}/${airport.slug}/airport-parking/${generateSlug(loc.name)}`,
          changeFrequency: "daily" as const,
          priority: 0.8,
        }));
      })
    );

    const urls: MetadataRoute.Sitemap = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        urls.push(...result.value);
      }
    }
    return urls;
  } catch (error) {
    console.warn(`Sitemap lot segment ${id} failed:`, error);
    return [];
  }
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
      (post: { slug: string; updatedAt: string; articleType?: string }) => ({
        url: `${baseUrl}/blog/${post.slug}`,
        lastModified: new Date(post.updatedAt),
        changeFrequency: "monthly" as const,
        priority: priorityMap[post.articleType || ""] || 0.6,
      })
    );
  } catch {
    return [];
  }
}
