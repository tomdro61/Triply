import { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Navbar, Footer } from "@/components/shared";
import {
  getPublishedPosts,
  getCategories,
  getDistinctAirportCodes,
} from "@/lib/cms";
import {
  getAirportByCode,
  productionAirports,
} from "@/config/airports";
import { BlogPostCard } from "@/components/blog/BlogPostCard";
import { BlogPagination } from "@/components/blog/BlogPagination";
import { BlogFilterBar } from "@/components/blog/BlogFilterBar";
import { BlogFeaturedPost } from "@/components/blog/BlogFeaturedPost";

type Props = {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ page?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const airport = getAirportByCode(code.toUpperCase());
  if (!airport) return {};

  return {
    title: `${airport.code} Airport Parking & Travel Guides | Triply Blog`,
    description: `Expert tips, parking guides, and travel advice for ${airport.name}. Your Trip Simplified.`,
    alternates: { canonical: `/blog/airport/${code.toLowerCase()}` },
  };
}

export default async function BlogAirportPage({ params, searchParams }: Props) {
  const { code } = await params;
  const { page: pageParam } = await searchParams;
  const airport = getAirportByCode(code.toUpperCase());

  if (!airport) {
    notFound();
  }

  const page = parseInt(pageParam || "1", 10);

  const [postsResult, categoriesResult] = await Promise.all([
    getPublishedPosts(
      { "where[airportCode][equals]": airport.code },
      page,
      12
    ),
    getCategories(),
  ]);

  const { docs: posts, totalPages } = postsResult;
  const categories = categoriesResult.docs;

  // Featured hub article for this airport
  const featuredPost =
    page === 1
      ? posts.find((p: any) => p.articleType === "hub")
      : null;
  const gridPosts = featuredPost
    ? posts.filter((p: any) => p.id !== featuredPost.id)
    : posts;

  // Other airports that have blog content
  const allCodes = await getDistinctAirportCodes();
  const otherAirports = allCodes
    .filter((c) => c !== airport.code)
    .slice(0, 10)
    .map((c) => {
      const a = getAirportByCode(c);
      return a ? { code: a.code, city: a.city } : null;
    })
    .filter(Boolean) as Array<{ code: string; city: string }>;

  return (
    <>
      <Navbar forceSolid />
      <main className="min-h-screen bg-gray-50 pt-20">
        {/* Header */}
        <section className="bg-navy text-white py-12">
          <div className="container mx-auto px-4">
            <nav className="text-sm text-gray-400 mb-4">
              <Link href="/blog" className="hover:text-white">
                Blog
              </Link>
              <span className="mx-2">/</span>
              <span className="text-white">{airport.code} Airport Guide</span>
            </nav>
            <h1 className="text-3xl md:text-4xl font-heading font-bold mb-3">
              {airport.name}
            </h1>
            <p className="text-gray-300 mb-4">
              Parking guides, travel tips, and everything you need to know about{" "}
              {airport.code}.
            </p>
            <Link
              href={`/search?airport=${airport.code}`}
              className="inline-block px-6 py-2 bg-coral text-white rounded-full font-medium hover:bg-coral/90 transition-colors"
            >
              Find Parking at {airport.code}
            </Link>
          </div>
        </section>

        {/* Filter Bar */}
        <section className="py-6 border-b border-gray-200 bg-white">
          <div className="container mx-auto px-4">
            <BlogFilterBar categories={categories} />
          </div>
        </section>

        {/* Content */}
        <section className="py-12">
          <div className="container mx-auto px-4">
            {featuredPost && <BlogFeaturedPost post={featuredPost} />}

            {gridPosts.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-gray-500 text-lg">
                  No articles for {airport.code} yet. Check back soon!
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                {gridPosts.map((post: any) => (
                  <BlogPostCard key={post.id} post={post} />
                ))}
              </div>
            )}

            <BlogPagination
              currentPage={page}
              totalPages={totalPages}
              baseHref={`/blog/airport/${code.toLowerCase()}`}
            />

            {/* Other Airports */}
            {otherAirports.length > 0 && (
              <section className="mt-16 pt-8 border-t border-gray-200">
                <h2 className="text-xl font-heading font-bold text-navy mb-4">
                  More Airport Guides
                </h2>
                <div className="flex flex-wrap gap-2">
                  {otherAirports.map((a) => (
                    <Link
                      key={a.code}
                      href={`/blog/airport/${a.code.toLowerCase()}`}
                      className="px-4 py-2 bg-white border border-gray-200 rounded-full text-sm text-gray-700 hover:border-coral hover:text-coral transition-colors"
                    >
                      {a.code} — {a.city}
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
