import { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import { format } from 'date-fns'
import { Navbar, Footer } from '@/components/shared'
import { getPublishedPosts } from '@/lib/cms'

export const metadata: Metadata = {
  title: 'Blog | Triply - Airport Parking Tips & Travel Guides',
  description: 'Expert tips on airport parking, travel hacks, and guides to make your trip easier. Your Trip Simplified.',
  alternates: { canonical: '/blog' },
}

type SearchParams = Promise<{ page?: string; airport?: string }>

export default async function BlogPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const page = parseInt(params.page || '1', 10)
  const airportFilter = params.airport?.toUpperCase()

  const extraFilters: Record<string, string> = {}
  if (airportFilter) {
    extraFilters['where[airportCode][equals]'] = airportFilter
  }

  const { docs: posts, totalPages } = await getPublishedPosts(extraFilters, page, 12)

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
            Expert tips on airport parking, travel hacks, and guides to make your trip easier.
          </p>
        </div>
      </section>

      {/* Blog Posts Grid */}
      <section className="py-12">
        <div className="container mx-auto px-4">
          {posts.length === 0 ? (
            <div className="text-center py-16">
              <p className="text-gray-500 text-lg">No blog posts yet. Check back soon!</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {posts.map((post: any) => (
                <article
                  key={post.id}
                  className="bg-white rounded-xl shadow-sm overflow-hidden hover:shadow-md transition-shadow"
                >
                  <Link href={`/blog/${post.slug}`}>
                    {post.featuredImage?.url ? (
                      <div className="relative h-48 w-full">
                        <Image
                          src={post.featuredImage.url}
                          alt={post.featuredImage.alt || post.title}
                          fill
                          className="object-cover"
                        />
                      </div>
                    ) : (
                      <div className="h-48 w-full bg-gray-200 flex items-center justify-center">
                        <span className="text-gray-400">No image</span>
                      </div>
                    )}
                  </Link>

                  <div className="p-6">
                    {post.category && (
                      <span className="inline-block px-3 py-1 bg-coral/10 text-coral text-sm font-medium rounded-full mb-3">
                        {post.category.name}
                      </span>
                    )}

                    <Link href={`/blog/${post.slug}`}>
                      <h2 className="text-xl font-heading font-semibold text-navy mb-2 hover:text-coral transition-colors">
                        {post.title}
                      </h2>
                    </Link>

                    <p className="text-gray-600 text-sm mb-4 line-clamp-3">
                      {post.excerpt}
                    </p>

                    <div className="flex items-center justify-between text-sm text-gray-500">
                      {post.author && (
                        <span>{post.author.name || post.author.email}</span>
                      )}
                      {post.publishedAt && (
                        <time dateTime={post.publishedAt}>
                          {format(new Date(post.publishedAt), 'MMM d, yyyy')}
                        </time>
                      )}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-center items-center gap-2 mt-12">
              {page > 1 && (
                <Link
                  href={`/blog?page=${page - 1}${airportFilter ? `&airport=${airportFilter}` : ''}`}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Previous
                </Link>
              )}
              <span className="px-4 py-2 text-sm text-gray-500">
                Page {page} of {totalPages}
              </span>
              {page < totalPages && (
                <Link
                  href={`/blog?page=${page + 1}${airportFilter ? `&airport=${airportFilter}` : ''}`}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Next
                </Link>
              )}
            </div>
          )}
        </div>
      </section>
    </main>
    <Footer />
    </>
  )
}
