import { getQueueItems, updateQueueItem, findPublishedPostBySlug } from './payload.js'

export interface QueueItem {
  id: string
  keyword: string
  suggestedTitle: string
  airportCode: string
  slug: string
  articleType: 'hub' | 'sub-pillar' | 'spoke'
  articleStyle?: 'standard' | 'narrative' | 'listicle' | 'data-heavy' | 'comparison'
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
  limit = 5
): Promise<QueueItem[]> {
  const filters: Record<string, string> = {
    'where[status][equals]': 'queued',
  }
  if (type) filters['where[articleType][equals]'] = type
  if (airport) filters['where[airportCode][equals]'] = airport.toUpperCase()
  filters.limit = String(limit)

  const result = await getQueueItems(filters)
  return result.docs || []
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
