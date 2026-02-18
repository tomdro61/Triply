import Link from 'next/link'
import Image from 'next/image'

interface RelatedPost {
  id: string
  title: string
  slug: string
  excerpt: string
  articleType?: string
  featuredImage?: { url?: string; alt?: string }
}

interface RelatedArticlesProps {
  posts: RelatedPost[]
  title?: string
}

export function RelatedArticles({ posts, title = 'Related Articles' }: RelatedArticlesProps) {
  if (!posts || posts.length === 0) return null

  return (
    <section className="mt-12 pt-8 border-t">
      <h2 className="text-xl font-heading font-bold text-navy mb-6">{title}</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {posts.map((post) => (
          <Link
            key={post.id}
            href={`/blog/${post.slug}`}
            className="group bg-gray-50 rounded-lg overflow-hidden hover:shadow-md transition-shadow"
          >
            {post.featuredImage?.url ? (
              <div className="relative h-32 w-full">
                <Image
                  src={post.featuredImage.url}
                  alt={post.featuredImage.alt || post.title}
                  fill
                  className="object-cover"
                />
              </div>
            ) : (
              <div className="h-32 w-full bg-gray-200" />
            )}
            <div className="p-4">
              {post.articleType && (
                <span className="inline-block px-2 py-0.5 bg-coral/10 text-coral text-xs font-medium rounded mb-2">
                  {post.articleType}
                </span>
              )}
              <h3 className="text-sm font-semibold text-navy group-hover:text-coral transition-colors line-clamp-2">
                {post.title}
              </h3>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}
