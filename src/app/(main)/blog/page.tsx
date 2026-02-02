import { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import { format } from 'date-fns'

export const metadata: Metadata = {
  title: 'Blog | Triply - Airport Parking Tips & Travel Guides',
  description: 'Expert tips on airport parking, travel hacks, and guides to make your trip easier. Your Trip Simplified.',
}

// Fetch posts from Payload CMS (separate subdomain)
async function getPosts() {
  try {
    const cmsUrl = process.env.NEXT_PUBLIC_CMS_URL || 'http://localhost:3001'
    const res = await fetch(`${cmsUrl}/api/posts?where[status][equals]=published&sort=-publishedAt&depth=2`, {
      next: { revalidate: 60 }, // Revalidate every 60 seconds
    })

    if (!res.ok) {
      console.error('Failed to fetch posts:', res.status)
      return []
    }

    const data = await res.json()
    return data.docs || []
  } catch (error) {
    console.error('Error fetching posts:', error)
    return []
  }
}

export default async function BlogPage() {
  const posts = await getPosts()

  return (
    <main className="min-h-screen bg-gray-50">
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
        </div>
      </section>
    </main>
  )
}
