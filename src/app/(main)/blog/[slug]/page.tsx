import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { format } from 'date-fns'
import { RichText } from '@/components/blog/RichText'
import { ArrowLeft } from 'lucide-react'
import { Navbar, Footer } from '@/components/shared'
import { getPostBySlug } from '@/lib/cms'
import { FaqAccordion } from '@/components/blog/FaqAccordion'
import { HubLayout } from '@/components/blog/HubLayout'
import { SubPillarLayout } from '@/components/blog/SubPillarLayout'
import { SpokeLayout } from '@/components/blog/SpokeLayout'

type Props = {
  params: Promise<{ slug: string }>
}

// Generate metadata for SEO
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const post = await getPostBySlug(slug)

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
    alternates: { canonical: `/blog/${slug}` },
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

async function ArticleContent({ post }: { post: any }) {
  const content = (
    <>
      <RichText content={post.content} className="text-gray-700" />

      {/* Tags */}
      {post.tags && post.tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-8 pt-6 border-t">
          {post.tags.map((tag: any) => (
            <span
              key={tag.id}
              className="px-3 py-1 bg-gray-100 text-gray-600 text-sm rounded-full"
            >
              #{tag.name}
            </span>
          ))}
        </div>
      )}

      {/* FAQ Accordion */}
      {post.faqItems && post.faqItems.length > 0 && (
        <FaqAccordion items={post.faqItems} />
      )}
    </>
  )

  switch (post.articleType) {
    case 'hub':
      return <HubLayout post={post}>{content}</HubLayout>
    case 'sub-pillar':
      return <SubPillarLayout post={post}>{content}</SubPillarLayout>
    case 'spoke':
      return <SpokeLayout post={post}>{content}</SpokeLayout>
    default:
      return content
  }
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params
  const post = await getPostBySlug(slug)

  if (!post) {
    notFound()
  }

  return (
    <>
    <Navbar forceSolid />
    {/* Article JSON-LD */}
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: post.title,
          description: post.excerpt,
          image: post.featuredImage?.url,
          datePublished: post.publishedAt,
          dateModified: post.updatedAt || post.publishedAt,
          author: {
            '@type': 'Person',
            name: post.author?.name || post.author?.email || 'Triply',
          },
          publisher: {
            '@type': 'Organization',
            name: 'Triply',
            url: 'https://www.triplypro.com',
          },
          mainEntityOfPage: {
            '@type': 'WebPage',
            '@id': `https://www.triplypro.com/blog/${slug}`,
          },
        }),
      }}
    />
    <main className="min-h-screen bg-white pt-20">
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

        {/* Article Content with Layout */}
        <div className="container mx-auto px-4 py-12">
          <div className="max-w-3xl mx-auto">
            <ArticleContent post={post} />
          </div>
        </div>

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
    <Footer />
    </>
  )
}
