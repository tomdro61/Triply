import { getQueueItems, updateQueueItem, findPublishedPostBySlug } from './payload.js'

/**
 * Allowed article styles. Must stay in sync with the ContentQueue.articleStyle select
 * options in the CMS (and its Postgres enum) — a value that exists here but not there
 * is rejected on write.
 *
 * NOTE: prompts/write.ts, prompts/write-v2.ts, prompts/edit.ts and seo-scorer.ts each
 * still declare their own local copy of this union. Adding a style means updating all
 * of them; TypeScript will not flag the ones you miss.
 */
export const ARTICLE_STYLES = [
  'standard',
  'narrative',
  'listicle',
  'data-heavy',
  'comparison',
  'rescue',
] as const

export type ArticleStyle = (typeof ARTICLE_STYLES)[number]

export interface QueueItem {
  id: string
  keyword: string
  airportCode: string
  slug: string
  articleType: 'hub' | 'sub-pillar' | 'spoke'
  articleStyle?: ArticleStyle
  parentSlug?: string
  hubSlug?: string
  searchVolume?: number
  seoDifficulty?: number
  targetWords?: number
  priority: 'S1' | 'S2' | 'S3'
  status: 'queued' | 'generating' | 'draft' | 'review' | 'published' | 'error'
  batch?: string
  scheduledPublishDate?: string
  competitorUrls?: { url: string }[]
  outline?: { order: number; anchorId?: string; heading: string; summary?: string; linksTo?: string }[]
  generatedPost?: string | null
  errorMessage?: string
  notes?: string
}

export async function getNextQueuedItems(
  type?: string,
  airport?: string,
  limit = 5,
  minSearchVolume?: number,
  slug?: string
): Promise<QueueItem[]> {
  const filters: Record<string, string> = {
    'where[status][equals]': 'queued',
  }
  // A slug filter targets exactly one article (used by `maintain` Tier-1 rewrites
  // and manual one-off regenerations) — it ignores type/airport/SV noise.
  if (slug) filters['where[slug][equals]'] = slug
  if (type) filters['where[articleType][equals]'] = type
  if (airport) filters['where[airportCode][equals]'] = airport.toUpperCase()
  if (minSearchVolume !== undefined) {
    filters['where[searchVolume][greater_than_equal]'] = String(minSearchVolume)
    filters.sort = '-searchVolume'
  }
  filters.limit = String(limit)

  const result = await getQueueItems(filters)
  return result.docs || []
}

/** Find a single content-queue item by slug regardless of status (for re-queueing a rewrite). */
export async function findQueueItemBySlug(slug: string): Promise<QueueItem | null> {
  const result = await getQueueItems({ 'where[slug][equals]': slug, limit: '1' })
  return result.docs?.[0] || null
}

export async function validatePrerequisites(item: QueueItem): Promise<string | null> {
  // Hubs have no prerequisites
  if (item.articleType === 'hub') return null

  // Sub-pillars need their hub published
  if (item.articleType === 'sub-pillar') {
    if (!item.hubSlug) return 'Missing hubSlug — cannot validate hub prerequisite'
    const hub = await findPublishedPostBySlug(item.hubSlug)
    if (!hub) return `Hub article "${item.hubSlug}" must be published before generating sub-pillars`
    return null
  }

  // Spokes need parent sub-pillar published
  if (item.articleType === 'spoke') {
    if (!item.parentSlug) return 'Missing parentSlug — cannot validate parent prerequisite'
    const parent = await findPublishedPostBySlug(item.parentSlug)
    if (!parent) return `Parent article "${item.parentSlug}" must be published before generating spokes`
    return null
  }

  return null
}

export async function markGenerating(id: string) {
  return updateQueueItem(id, { status: 'generating' })
}

export async function markDraft(id: string, postId: string) {
  return updateQueueItem(id, { status: 'draft', generatedPost: postId })
}

export async function markError(id: string, errorMessage: string) {
  return updateQueueItem(id, { status: 'error', errorMessage })
}

export async function markPublished(id: string) {
  return updateQueueItem(id, { status: 'published' })
}

/** Reset an item back to 'queued' (e.g. after a credit-balance abort that wasn't the item's fault). */
export async function markQueued(id: string) {
  return updateQueueItem(id, { status: 'queued' })
}

export async function getBatchItems(batch: string, statusFilter?: string[]): Promise<QueueItem[]> {
  const filters: Record<string, string> = {
    'where[batch][equals]': batch,
    limit: '100',
  }
  const result = await getQueueItems(filters)
  const items = (result.docs || []) as QueueItem[]

  if (statusFilter && statusFilter.length > 0) {
    return items.filter((item) => statusFilter.includes(item.status))
  }
  return items
}
