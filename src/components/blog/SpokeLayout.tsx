import { ArticleBreadcrumbs } from './ArticleBreadcrumbs'
import { getPostBySlug } from '@/lib/cms'
import Link from 'next/link'

interface SpokeLayoutProps {
  post: any
  children: React.ReactNode
}

export async function SpokeLayout({ post, children }: SpokeLayoutProps) {
  const parentPost = post.parentSlug ? await getPostBySlug(post.parentSlug) : null
  const hubPost = post.hubSlug ? await getPostBySlug(post.hubSlug) : null

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
    </>
  )
}
