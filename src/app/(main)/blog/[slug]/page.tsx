import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { format } from 'date-fns'
import { RichText } from '@/components/blog/RichText'
import { ArrowLeft } from 'lucide-react'

type Props = {
  params: Promise<{ slug: string }>
}

// Fetch single post by slug from Payload CMS (separate subdomain)
async function getPost(slug: string) {
  try {
    const cmsUrl = process.env.NEXT_PUBLIC_CMS_URL || 'http://localhost:3001'
    const res = await fetch(
      `${cmsUrl}/api/posts?where[slug][equals]=${slug}&where[status][equals]=published&depth=2`,
      { next: { revalidate: 60 } }
    )

    if (!res.ok) {
      return null
    }

    const data = await res.json()
    return data.docs?.[0] || null
  } catch (error) {
    console.error('Error fetching post:', error)
    return null
  }
}

// Generate metadata for SEO
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const post = await getPost(slug)

  if (!post) {
    return {
      title: 'Post Not Found | Triply Blog',
    }
  }

  const title = post.seo?.metaTitle || post.title
  const description = post.seo?.metaDescription || post.excerpt

  return {
    title: `${title} | Triply Blog`,
    description,
    openGraph: {
      title,
      description,
      type: 'article',
      publishedTime: post.publishedAt,
      authors: post.author?.name ? [post.author.name] : undefined,
      images: post.featuredImage?.url ? [post.featuredImage.url] : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: post.featuredImage?.url ? [post.featuredImage.url] : undefined,
    },
  }
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params
  const post = await getPost(slug)

  if (!post) {
    notFound()
  }

  return (
    <main className="min-h-screen bg-white">
      {/* Back Link */}
      <div className="bg-gray-50 border-b">
        <div className="container mx-auto px-4 py-4">
          <Link
            href="/blog"
            className="inline-flex items-center text-gray-600 hover:text-coral transition-colors"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Blog
          </Link>
        </div>
      </div>

      {/* Article Header */}
      <article>
        <header className="py-12 bg-gray-50">
          <div className="container mx-auto px-4 max-w-3xl">
            {post.category && (
              <span className="inline-block px-3 py-1 bg-coral/10 text-coral text-sm font-medium rounded-full mb-4">
                {post.category.name}
              </span>
            )}

            <h1 className="text-3xl md:text-4xl lg:text-5xl font-heading font-bold text-navy mb-6">
              {post.title}
            </h1>

            <p className="text-xl text-gray-600 mb-6">
              {post.excerpt}
            </p>

            <div className="flex items-center gap-4 text-sm text-gray-500">
              {post.author && (
                <span className="font-medium text-navy">
                  {post.author.name || post.author.email}
                </span>
              )}
              {post.publishedAt && (
                <>
                  <span>•</span>
                  <time dateTime={post.publishedAt}>
                    {format(new Date(post.publishedAt), 'MMMM d, yyyy')}
                  </time>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Featured Image */}
        {post.featuredImage?.url && (
          <div className="relative w-full h-64 md:h-96 lg:h-[500px]">
            <Image
              src={post.featuredImage.url}
              alt={post.featuredImage.alt || post.title}
              fill
              className="object-cover"
              priority
            />
          </div>
        )}

        {/* Article Content */}
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-3xl mx-auto">
            <RichText content={post.content} className="text-gray-700" />
          </div>
        </div>

        {/* Tags */}
        {post.tags && post.tags.length > 0 && (
          <div className="container mx-auto px-4 pb-12">
            <div className="max-w-3xl mx-auto">
              <div className="flex flex-wrap gap-2">
                {post.tags.map((tag: any) => (
                  <span
                    key={tag.id}
                    className="px-3 py-1 bg-gray-100 text-gray-600 text-sm rounded-full"
                  >
                    #{tag.name}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* CTA Section */}
        <section className="bg-coral/5 py-12">
          <div className="container mx-auto px-4 text-center">
            <h2 className="text-2xl font-heading font-bold text-navy mb-4">
              Ready to Book Your Airport Parking?
            </h2>
            <p className="text-gray-600 mb-6 max-w-xl mx-auto">
              Compare prices from top-rated parking lots and save up to 70% on your next trip.
            </p>
            <Link
              href="/"
              className="inline-block bg-coral text-white px-8 py-3 rounded-lg font-semibold hover:bg-coral/90 transition-colors"
            >
              Find Parking Now
            </Link>
          </div>
        </section>
      </article>
    </main>
  )
}
