import { ArticleBreadcrumbs } from './ArticleBreadcrumbs'
import { RelatedArticles } from './RelatedArticles'
import { getRelatedPosts, getPostBySlug } from '@/lib/cms'

interface SubPillarLayoutProps {
  post: any
  children: React.ReactNode
}

export async function SubPillarLayout({ post, children }: SubPillarLayoutProps) {
  const hubPost = post.hubSlug ? await getPostBySlug(post.hubSlug) : null

  const relatedPosts = post.airportCode
    ? await getRelatedPosts(post.airportCode, post.slug, 6)
    : []

  const spokes = relatedPosts.filter(
    (p: any) => p.articleType === 'spoke' && p.parentSlug === post.slug
  )

  const breadcrumbs = []
  if (hubPost) {
    breadcrumbs.push({ label: hubPost.title, href: `/blog/${hubPost.slug}` })
  }
  breadcrumbs.push({ label: post.title })

  return (
    <>
      <ArticleBreadcrumbs items={breadcrumbs} />
      {children}

      {spokes.length > 0 && (
        <RelatedArticles posts={spokes} title="Related Topics" />
      )}
    </>
  )
}
