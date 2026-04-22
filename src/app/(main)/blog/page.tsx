import { Metadata } from "next";
import { Navbar, Footer } from "@/components/shared";
import { getPublishedPosts, getCategories } from "@/lib/cms";
import { enabledAirports } from "@/config/airports";
import { BlogPostCard } from "@/components/blog/BlogPostCard";
import { BlogPagination } from "@/components/blog/BlogPagination";
import { BlogFilterBar } from "@/components/blog/BlogFilterBar";
import { BlogFeaturedPost } from "@/components/blog/BlogFeaturedPost";
import { BlogAirportGrid } from "@/components/blog/BlogAirportGrid";
import { BlogSearchInput } from "@/components/blog/BlogSearchInput";
import { BlogSortSelect } from "@/components/blog/BlogSortSelect";

export const metadata: Metadata = {
  title: "Blog | Triply - Airport Parking Tips & Travel Guides",
  description:
    "Expert tips on airport parking, travel hacks, and guides to make your trip easier. Your Trip Simplified.",
  alternates: { canonical: "/blog" },
};

type SearchParams = Promise<{
  page?: string;
  airport?: string;
  q?: string;
  sort?: string;
}>;

export default async function BlogPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const page = parseInt(params.page || "1", 10);
  const airportFilter = params.airport?.toUpperCase();
  const searchQuery = params.q?.trim();
  const sort = params.sort === "oldest" ? "oldest" : "newest";
  const isFirstPage = page === 1 && !airportFilter && !searchQuery;

  // Build CMS filters
  const extraFilters: Record<string, string> = {};
  if (airportFilter) {
    extraFilters["where[airportCode][equals]"] = airportFilter;
  }
  if (searchQuery) {
    extraFilters["where[title][like]"] = searchQuery;
  }
  if (sort === "oldest") {
    extraFilters["sort"] = "publishedAt";
  }

  // Fetch data in parallel
  const [postsResult, categoriesResult] = await Promise.all([
    getPublishedPosts(extraFilters, page, 12),
    getCategories(),
  ]);

  const { docs: posts, totalPages } = postsResult;
  const categories = categoriesResult.docs;

  // Show all enabled airports as filter chips (so every supported airport is
  // browsable even before any posts exist for it).
  const airportGridData = enabledAirports
    .map((a) => ({ code: a.code, name: a.name, city: a.city }))
    .sort((a, b) => a.code.localeCompare(b.code));

  // Find featured post (latest hub article) for page 1
  const featuredPost = isFirstPage
    ? posts.find((p: any) => p.articleType === "hub")
    : null;
  const gridPosts = featuredPost
    ? posts.filter((p: any) => p.id !== featuredPost.id)
    : posts;

  // Build extra params for pagination links
  const paginationParams: Record<string, string> = {};
  if (airportFilter) paginationParams.airport = airportFilter;
  if (searchQuery) paginationParams.q = searchQuery;
  if (sort === "oldest") paginationParams.sort = "oldest";

  return (
    <>
      <Navbar forceSolid />
      <main className="min-h-screen bg-gray-50 pt-20">
        {/* Hero Section */}
        <section className="bg-navy text-white py-16">
          <div className="container mx-auto px-4">
            <h1 className="text-4xl md:text-5xl font-heading font-bold text-center mb-4">
              Triply Blog
            </h1>
            <p className="text-lg text-gray-300 text-center max-w-2xl mx-auto">
              Travel tips, parking guides, and more
            </p>
            <BlogSearchInput defaultValue={searchQuery} />
          </div>
        </section>

        {/* Filter Bar + Airport Grid + Sort */}
        <section className="py-6 border-b border-gray-200 bg-white">
          <div className="container mx-auto px-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <BlogFilterBar categories={categories} />
              <BlogSortSelect currentSort={sort} baseHref="/blog" />
            </div>
            <BlogAirportGrid airports={airportGridData} />
          </div>
        </section>

        {/* Content */}
        <section className="py-12">
          <div className="container mx-auto px-4">
            {/* Featured Post */}
            {featuredPost && <BlogFeaturedPost post={featuredPost} />}

            {/* Post Grid */}
            {gridPosts.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-gray-500 text-lg">
                  {searchQuery
                    ? `No results for "${searchQuery}"`
                    : "No blog posts yet. Check back soon!"}
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
              baseHref="/blog"
              extraParams={
                Object.keys(paginationParams).length > 0
                  ? paginationParams
                  : undefined
              }
            />

          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
