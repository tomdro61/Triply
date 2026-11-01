import { env } from './config.js'
import { withRetry } from './retry.js'

const headers = {
  'Content-Type': 'application/json',
  Authorization: `users API-Key ${env.PAYLOAD_API_KEY}`,
}

// Abort a CMS request that hangs past this, so a stuck connection can't zombie a
// whole batch run. withRetry treats the AbortError as transient and retries it.
const FETCH_TIMEOUT_MS = 30_000

/** Typed CMS HTTP error carrying the status code so retry.ts can classify it. */
class PayloadHttpError extends Error {
  status: number
  body: string
  constructor(status: number, path: string, body: string) {
    super(`Payload API error ${status} on ${path}: ${body}`)
    this.name = 'PayloadHttpError'
    this.status = status
    this.body = body
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function payloadFetch(path: string, options: RequestInit = {}, opts: { retry?: boolean } = {}) {
  const url = `${env.PAYLOAD_CMS_URL}/api${path}`
  const once = async () => {
    const res = await fetchWithTimeout(url, {
      ...options,
      headers: { ...headers, ...options.headers },
    })
    if (!res.ok) {
      const body = await res.text()
      throw new PayloadHttpError(res.status, path, body)
    }
    return res.json()
  }
  if (opts.retry === false) return once()
  return withRetry(once, { label: `payload ${(options.method as string) || 'GET'} ${path}` })
}

/**
 * POST a new doc without ever replaying the create blindly. A timeout or 5xx can arrive AFTER the CMS
 * committed the row; a blind replay then hits the unique slug (400 → a doc that exists is reported as
 * "failed", and if it was created published it is live with nothing pinged) or makes a duplicate. On every
 * retry the collection is queried by slug first and an existing doc is reused. (Review of #141.)
 */
async function createUnlessExists(collection: '/posts' | '/categories' | '/tags', slug: string | null, data: Record<string, unknown>) {
  let attempt = 0
  return withRetry(
    async () => {
      attempt++
      if (attempt > 1 && slug) {
        const found = await payloadFetch(`${collection}?where[slug][equals]=${encodeURIComponent(slug)}&limit=1`, {}, { retry: false })
        const existing = found.docs?.[0]
        if (existing) {
          console.warn(`  ⚠ ${collection}/${slug} already exists — attempt ${attempt - 1} committed before its response arrived; reusing #${existing.id}`)
          return { doc: existing }
        }
      }
      return payloadFetch(collection, { method: 'POST', body: JSON.stringify(data) }, { retry: false })
    },
    { label: `payload POST ${collection}` }
  )
}

// Posts
export async function createPost(data: Record<string, unknown>) {
  return createUnlessExists('/posts', typeof data.slug === 'string' ? data.slug : null, data)
}

export async function getPostById(id: string) {
  return payloadFetch(`/posts/${encodeURIComponent(id)}?depth=0`)
}

export async function updatePost(id: string, data: Record<string, unknown>) {
  return payloadFetch(`/posts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function findPostBySlug(slug: string) {
  const result = await payloadFetch(`/posts?where[slug][equals]=${encodeURIComponent(slug)}&limit=1`)
  return result.docs?.[0] || null
}

export async function findPublishedPostBySlug(slug: string) {
  const result = await payloadFetch(
    `/posts?where[slug][equals]=${encodeURIComponent(slug)}&where[status][equals]=published&limit=1`
  )
  return result.docs?.[0] || null
}

// Media
export async function uploadMedia(file: Buffer, filename: string, alt: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || 'jpg'
  const mimeTypes: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
  }
  const mimeType = mimeTypes[ext] || 'image/jpeg'

  const formData = new FormData()
  // Use File (not Blob) so the Vercel Blob storage adapter gets proper filename/type metadata
  const fileObj = new File([new Uint8Array(file)], filename, { type: mimeType })
  formData.append('file', fileObj)
  formData.append('_payload', JSON.stringify({ alt: alt || 'Airport parking' }))

  const url = `${env.PAYLOAD_CMS_URL}/api/media`
  // MEDIA_UPLOAD_TRIES: the CMS's Vercel layer has hours-long windows where most
  // multipart bodies fail to parse ("No files were uploaded", 2026-07-27 incident).
  // The default 4 tries survives background flakiness; set 8-10 when re-running
  // casualties while a window may still be flickering.
  const tries = Number(process.env.MEDIA_UPLOAD_TRIES) || 4
  return withRetry(
    async () => {
      let res: Response
      try {
        res = await fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            Authorization: `users API-Key ${env.PAYLOAD_API_KEY}`,
          },
          body: formData,
        })
      } catch (e) {
        // A timed-out upload may already be stored (the request reached the CMS; only the response was lost).
        // Replaying it stores a second copy, so a timeout is NOT retried — unlike the parse-glitch 400 below.
        if (e instanceof Error && e.name === 'AbortError') {
          throw new Error(`media upload ${filename} timed out after ${FETCH_TIMEOUT_MS / 1000}s — not retried (a replay could duplicate the file); check the CMS media list before re-running`)
        }
        throw e
      }
      if (!res.ok) {
        const body = await res.text()
        // The "No files were uploaded" 400 is a known transient glitch — retry.ts
        // matches it by message so withRetry recovers instead of crashing the batch.
        throw new PayloadHttpError(res.status, '/media', body)
      }
      return res.json()
    },
    { label: `media upload ${filename}`, tries }
  )
}

// Categories
export async function findOrCreateCategory(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const result = await payloadFetch(`/categories?where[slug][equals]=${encodeURIComponent(slug)}&limit=1`)

  if (result.docs?.[0]) return result.docs[0]

  return createUnlessExists('/categories', slug, { name, slug })
}

// Tags
export async function findOrCreateTag(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const result = await payloadFetch(`/tags?where[slug][equals]=${encodeURIComponent(slug)}&limit=1`)

  if (result.docs?.[0]) return result.docs[0]

  return createUnlessExists('/tags', slug, { name, slug })
}

// Users (for author field — uses the authenticated API key user)
export async function getApiUser() {
  const result = await payloadFetch('/users/me')
  return result.user || null
}

// Published posts (for internal link intelligence)
export interface PublishedPost {
  slug: string
  title: string
  articleType: string
  airportCode: string
}

/**
 * All published posts, paged (W1.1: the old single call capped at limit=500 and silently dropped
 * the rest of a 4,500-post site). Kept under the old name so every caller pages for free.
 */
export async function getAllPublishedSlugs(airportCode?: string): Promise<PublishedPost[]> {
  return getAllPublishedPosts(airportCode)
}

/** Every slug at an airport in ANY status (draft, published, archived) — the duplicate guard's input. Paged. */
export async function getAllSlugsAnyStatus(airportCode?: string): Promise<{ slug: string; status: string }[]> {
  const out: { slug: string; status: string }[] = []
  let page = 1
  while (true) {
    const params = new URLSearchParams({ limit: '200', page: String(page), 'select[slug]': 'true', 'select[status]': 'true' })
    if (airportCode) params.set('where[airportCode][equals]', airportCode.toUpperCase())
    const result = await payloadFetch(`/posts?${params.toString()}`)
    for (const doc of (result.docs || []) as Record<string, unknown>[]) out.push({ slug: String(doc.slug), status: String(doc.status || '') })
    if (!result.hasNextPage) break
    page++
  }
  return out
}

export async function getAllPublishedSlugsSinglePage(airportCode?: string): Promise<PublishedPost[]> {
  const params = new URLSearchParams({
    'where[status][equals]': 'published',
    limit: '500',
    'select[slug]': 'true',
    'select[title]': 'true',
    'select[articleType]': 'true',
    'select[airportCode]': 'true',
  })
  if (airportCode) {
    params.set('where[airportCode][equals]', airportCode.toUpperCase())
  }

  const result = await payloadFetch(`/posts?${params.toString()}`)
  return (result.docs || []).map((doc: Record<string, unknown>) => ({
    slug: doc.slug as string,
    title: doc.title as string,
    articleType: (doc.articleType as string) || 'spoke',
    airportCode: (doc.airportCode as string) || '',
  }))
}

/**
 * Like getAllPublishedSlugs but paginates through ALL published posts (the
 * single-page version caps at 500 → drops the oldest on large clusters). The
 * `maintain` sweep needs every post, so this walks pages until hasNextPage=false.
 */
export async function getAllPublishedPosts(airportCode?: string): Promise<PublishedPost[]> {
  const out: PublishedPost[] = []
  let page = 1
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params = new URLSearchParams({
      'where[status][equals]': 'published',
      limit: '200',
      page: String(page),
      'select[slug]': 'true',
      'select[title]': 'true',
      'select[articleType]': 'true',
      'select[airportCode]': 'true',
    })
    if (airportCode) params.set('where[airportCode][equals]', airportCode.toUpperCase())
    const result = await payloadFetch(`/posts?${params.toString()}`)
    for (const doc of (result.docs || []) as Record<string, unknown>[]) {
      out.push({
        slug: doc.slug as string,
        title: doc.title as string,
        articleType: (doc.articleType as string) || 'spoke',
        airportCode: (doc.airportCode as string) || '',
      })
    }
    if (!result.hasNextPage) break
    page++
  }
  return out
}

// Cluster context — fetch hub + sibling article headings for cross-article awareness
export interface ClusterArticle {
  slug: string
  title: string
  articleType: string
  keyword?: string
  headings: { level: number; text: string }[]
  excerpt: string
}

export async function getClusterContext(item: { airportCode: string; articleType: string; hubSlug?: string; parentSlug?: string; slug: string; keyword?: string }): Promise<ClusterArticle[]> {
  // Dynamically import to avoid circular deps
  const { extractHeadingsFromLexical } = await import('./lexical-to-html.js')

  // W1.2: rank ALL the airport's published posts by similarity to this item (hub first), then
  // load headings for the closest 10 — previously the first 20 in CMS order, whatever they were.
  const { rankBySimilarity } = await import('./similarity.js')
  const all = (await getAllPublishedPosts(item.airportCode)).filter((p) => p.slug !== item.slug)
  const keyword = (item as { keyword?: string }).keyword || item.slug.replace(/-/g, ' ')
  const closest = rankBySimilarity(keyword, item.airportCode, all).slice(0, 10)
  if (closest.length === 0) return []
  const params = new URLSearchParams({
    'where[slug][in]': closest.map((p) => p.slug).join(','),
    limit: String(closest.length),
  })

  const result = await payloadFetch(`/posts?${params.toString()}`)
  const order = new Map(closest.map((p, i) => [p.slug, i]))
  const docs = ((result.docs || []) as Record<string, unknown>[])
    .sort((a, b) => (order.get(a.slug as string) ?? 99) - (order.get(b.slug as string) ?? 99))

  const siblings = docs
    .map((doc: Record<string, unknown>) => ({
      slug: doc.slug as string,
      title: doc.title as string,
      articleType: (doc.articleType as string) || 'spoke',
      headings: extractHeadingsFromLexical(doc.content as Parameters<typeof extractHeadingsFromLexical>[0]),
      excerpt: ((doc.excerpt as string) || '').slice(0, 200),
    }))
    .slice(0, 10)

  // Enrich with keywords from content queue (for cross-link anchor text)
  if (siblings.length > 0) {
    try {
      const queueParams = new URLSearchParams({ limit: '50' })
      const queueResult = await payloadFetch(`/content-queue?${queueParams.toString()}`)
      const queueDocs = (queueResult.docs || []) as Record<string, unknown>[]
      const slugToKeyword = new Map<string, string>()
      for (const q of queueDocs) {
        if (q.slug && q.keyword) slugToKeyword.set(q.slug as string, q.keyword as string)
      }
      for (const sibling of siblings) {
        const kw = slugToKeyword.get(sibling.slug)
        if (kw) (sibling as ClusterArticle & { keyword?: string }).keyword = kw
      }
    } catch (e) {
      // Optional (siblings still link without keywords), but surface the reason so
      // a CMS/network failure here isn't silently masked.
      console.log(`    ⚠ sibling keyword enrichment skipped: ${e instanceof Error ? e.message : e}`)
    }
  }

  return siblings
}

/**
 * Get Unsplash photo IDs already used as featured images by published posts
 * in the same airport cluster. Used to avoid duplicate hero images.
 */
export async function getClusterUsedPhotoIds(airportCode: string): Promise<string[]> {
  const params = new URLSearchParams({
    'where[status][equals]': 'published',
    'where[airportCode][equals]': airportCode.toUpperCase(),
    limit: '50',
    depth: '1', // resolve featuredImage to get filename
  })

  const result = await payloadFetch(`/posts?${params.toString()}`)
  const docs = result.docs || []

  const photoIds: string[] = []
  for (const doc of docs) {
    const img = doc.featuredImage as Record<string, unknown> | undefined
    if (!img) continue
    // Filename is the Unsplash photo ID (e.g., "0XV65AZ1hmY.jpg")
    const filename = (img.filename as string) || ''
    const photoId = filename.replace(/\.\w+$/, '') // strip extension
    if (photoId) photoIds.push(photoId)
  }

  return photoIds
}

// Content Queue
export async function getQueueItems(filters: Record<string, string> = {}) {
  const params = new URLSearchParams({ sort: 'priority' })
  for (const [key, value] of Object.entries(filters)) {
    params.set(key, value)
  }
  if (!params.has('limit')) params.set('limit', '200')
  return payloadFetch(`/content-queue?${params.toString()}`)
}

export async function getQueueItem(id: string) {
  return payloadFetch(`/content-queue/${id}`)
}

export async function updateQueueItem(id: string, data: Record<string, unknown>) {
  return payloadFetch(`/content-queue/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}
