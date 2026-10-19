import Link from "next/link";
import { Airport } from "@/config/airports";
import { fetchFromCms } from "@/lib/cms";
import { captureAPIError } from "@/lib/sentry";
import { BookOpen } from "lucide-react";
import { isPromoPost } from "@/lib/blog/promo-post";
import { guideLabels } from "@/lib/blog/guide-label";

interface AirportGuidesProps {
  airport: Airport;
}

interface GuidePost {
  slug: string;
  title: string;
  articleType?: string;
}

const MAX_GUIDES = 10;

// The airport's blog hub + sub-pillar guides. Booking pages linked to no blog
// post at all, so Google had no crawl path to newly written airports (281 posts
// "URL is unknown to Google", 16 Oct 2026). Decorative: a CMS failure hides the
// section instead of failing the booking page.
async function getGuides(code: string): Promise<GuidePost[]> {
  try {
    const data = await fetchFromCms("/posts", {
      "where[status][equals]": "published",
      "where[airportCode][equals]": code,
      "where[articleType][in]": "hub,sub-pillar",
      // "hub" sorts before "sub-pillar", so the hub is never cut by the limit.
      "sort": "articleType",
      "depth": "0",
      "limit": String(MAX_GUIDES + 4),
      "select[slug]": "true",
      "select[title]": "true",
      "select[articleType]": "true",
    });
    const docs: GuidePost[] = data?.docs ?? [];
    // Coupon/promo guides stay off the booking page: a reader here is ready to
    // book, and those posts convert worst (blog audit, Oct 19). They are still
    // linked from the hub, so Google keeps its crawl path to them.
    return docs
      .filter((p) => !isPromoPost(p.slug))
      .sort((a, b) => Number(b.articleType === "hub") - Number(a.articleType === "hub"))
      .slice(0, MAX_GUIDES);
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), {
      endpoint: "/api/posts",
      method: "GET",
      stage: "airport-page:guides",
    });
    return [];
  }
}

export async function AirportGuides({ airport }: AirportGuidesProps) {
  const guides = await getGuides(airport.code);
  if (guides.length === 0) return null;
  // Topic-only link text: no lot prices or year under the live rates table.
  const labels = guideLabels(guides.map((g) => g.title));

  return (
    <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <h2 className="text-2xl font-bold text-gray-900 mb-6">
        {airport.code} Parking Guides
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {guides.map((post, i) => (
          <Link
            key={post.slug}
            href={`/blog/${post.slug}`}
            className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-brand-orange/30 hover:shadow-sm transition-all group"
          >
            <div className="w-8 h-8 rounded-full bg-gray-100 group-hover:bg-brand-orange/10 flex items-center justify-center shrink-0 transition-colors">
              <BookOpen className="w-4 h-4 text-gray-400 group-hover:text-brand-orange transition-colors" />
            </div>
            <span className="text-sm font-medium text-gray-900 line-clamp-2">
              {labels[i]}
            </span>
          </Link>
        ))}
      </div>
      <div className="text-center mt-6">
        <Link
          href={`/blog/airport/${airport.code.toLowerCase()}`}
          className="text-sm text-brand-orange font-medium hover:underline"
        >
          All {airport.code} guides &rarr;
        </Link>
      </div>
    </section>
  );
}
