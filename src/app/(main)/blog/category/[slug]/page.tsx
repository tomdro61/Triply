import { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Navbar, Footer } from "@/components/shared";
import { getPublishedPosts, getCategories, getCategoryBySlug } from "@/lib/cms";
import { BlogPostCard } from "@/components/blog/BlogPostCard";
import { BlogPagination } from "@/components/blog/BlogPagination";
import { BlogFilterBar } from "@/components/blog/BlogFilterBar";
import { BlogSortSelect } from "@/components/blog/BlogSortSelect";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; sort?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const category = await getCategoryBySlug(slug);
  if (!category) return {};

  return {
    title: `${category.name} | Triply Blog`,
    description:
      category.description ||
      `Browse ${category.name} articles on the Triply blog.`,
    alternates: { canonical: `/blog/category/${slug}` },
  };
}

export default async function BlogCategoryPage({
  params,
  searchParams,
}: Props) {
  const { slug } = await params;
  const { page: pageParam, sort: sortParam } = await searchParams;

  const category = await getCategoryBySlug(slug);
  if (!category) {
    notFound();
  }

  const page = parseInt(pageParam || "1", 10);
  const sort = sortParam === "oldest" ? "oldest" : "newest";

  // Filter by category ID
  const extraFilters: Record<string, string> = {
    "where[category][equals]": category.id,
  };
  if (sort === "oldest") {
    extraFilters["sort"] = "publishedAt";
  }

  const [postsResult, categoriesResult] = await Promise.all([
    getPublishedPosts(extraFilters, page, 12),
    getCategories(),
  ]);

  const { docs: posts, totalPages } = postsResult;
  const categories = categoriesResult.docs;

  const paginationParams: Record<string, string> = {};
  if (sort === "oldest") paginationParams.sort = "oldest";

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
              <span className="text-white">{category.name}</span>
            </nav>
            <h1 className="text-3xl md:text-4xl font-heading font-bold">
              {category.name}
            </h1>
            {category.description && (
              <p className="text-gray-300 mt-3 max-w-2xl">
                {category.description}
              </p>
            )}
          </div>
        </section>

        {/* Filter Bar + Sort */}
        <section className="py-6 border-b border-gray-200 bg-white">
          <div className="container mx-auto px-4 flex flex-wrap items-center justify-between gap-4">
            <BlogFilterBar categories={categories} activeSlug={slug} />
            <BlogSortSelect
              currentSort={sort}
              baseHref={`/blog/category/${slug}`}
            />
          </div>
        </section>

        {/* Content */}
        <section className="py-12">
          <div className="container mx-auto px-4">
            {posts.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-gray-500 text-lg">
                  No articles in {category.name} yet. Check back soon!
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                {posts.map((post: any) => (
                  <BlogPostCard key={post.id} post={post} />
                ))}
              </div>
            )}

            <BlogPagination
              currentPage={page}
              totalPages={totalPages}
              baseHref={`/blog/category/${slug}`}
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
