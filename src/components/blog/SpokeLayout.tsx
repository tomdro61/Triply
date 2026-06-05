import { ArticleBreadcrumbs } from './ArticleBreadcrumbs'
import { RelatedArticles } from './RelatedArticles'
import { getPostBySlug, getRelatedPosts, getSiblingPosts } from '@/lib/cms'
import Link from 'next/link'

interface SpokeLayoutProps {
  post: any
  children: React.ReactNode
}

const RELATED_LIMIT = 6

export async function SpokeLayout({ post, children }: SpokeLayoutProps) {
  const [parentPost, hubPost, siblings] = await Promise.all([
    post.parentSlug ? getPostBySlug(post.parentSlug) : null,
    post.hubSlug ? getPostBySlug(post.hubSlug) : null,
    post.parentSlug ? getSiblingPosts(post.parentSlug, post.slug, RELATED_LIMIT) : [],
  ])

  // True siblings (same parentSlug) first; fill remaining slots with other
  // same-airport posts so spokes from sparse clusters still show a full
  // grid. Over-fetch the fill by the sibling count since siblings are
  // usually same-airport posts too and would dedupe away. A spoke with no
  // airportCode and no siblings intentionally renders no grid rather than
  // pulling unrelated content.
  let relatedPosts = siblings
  if (relatedPosts.length < RELATED_LIMIT && post.airportCode) {
    const fill = await getRelatedPosts(
      post.airportCode,
      post.slug,
      RELATED_LIMIT + relatedPosts.length
    )
    const seen = new Set(relatedPosts.map((p: any) => p.slug))
    relatedPosts = [
      ...relatedPosts,
      ...fill.filter((p: any) => !seen.has(p.slug)),
    ].slice(0, RELATED_LIMIT)
  }

  const breadcrumbs = []
  if (hubPost) {
    breadcrumbs.push({ label: hubPost.title, href: `/blog/${hubPost.slug}` })
  }
  if (parentPost) {
    breadcrumbs.push({ label: parentPost.title, href: `/blog/${parentPost.slug}` })
  }
  breadcrumbs.push({ label: post.title })

  return (
    <>
      <ArticleBreadcrumbs items={breadcrumbs} />
      {children}

      {/* Complete Guide Callout */}
      {hubPost && (
        <div className="mt-8 p-6 bg-coral/5 rounded-lg border border-coral/20">
          <p className="text-sm text-gray-600 mb-2">Looking for the complete guide?</p>
          <Link
            href={`/blog/${hubPost.slug}`}
            className="text-coral font-semibold hover:underline"
          >
            {hubPost.title}
          </Link>
        </div>
      )}

      {relatedPosts.length > 0 && (
        <RelatedArticles
          posts={relatedPosts}
          title={
            post.airportCode
              ? `More ${post.airportCode} Parking Guides`
              : 'Related Articles'
          }
        />
      )}
    </>
  )
}
