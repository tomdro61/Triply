import { ArticleBreadcrumbs } from './ArticleBreadcrumbs'
import { RelatedArticles } from './RelatedArticles'
import { getRelatedPosts } from '@/lib/cms'

interface HubLayoutProps {
  post: any
  children: React.ReactNode
}

export async function HubLayout({ post, children }: HubLayoutProps) {
  const relatedPosts = post.airportCode
    ? await getRelatedPosts(post.airportCode, post.slug, 6)
    : []

  const subPillars = relatedPosts.filter((p: any) => p.articleType === 'sub-pillar')

  return (
    <>
      <ArticleBreadcrumbs
        items={[{ label: post.title }]}
      />
      {children}

      {subPillars.length > 0 && (
        <RelatedArticles
          posts={subPillars}
          title={`${post.airportCode} Airport Parking Topics`}
        />
      )}
    </>
  )
}
