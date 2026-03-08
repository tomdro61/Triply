import { env } from './config.js'

const headers = {
  'Content-Type': 'application/json',
  Authorization: `users API-Key ${env.PAYLOAD_API_KEY}`,
}

async function payloadFetch(path: string, options: RequestInit = {}) {
  const url = `${env.PAYLOAD_CMS_URL}/api${path}`
  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Payload API error ${res.status} on ${path}: ${body}`)
  }

  return res.json()
}

// Posts
export async function createPost(data: Record<string, unknown>) {
  return payloadFetch('/posts', {
    method: 'POST',
    body: JSON.stringify(data),
  })
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
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `users API-Key ${env.PAYLOAD_API_KEY}`,
    },
    body: formData,
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Media upload error ${res.status}: ${body}`)
  }

  return res.json()
}

// Categories
export async function findOrCreateCategory(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const result = await payloadFetch(`/categories?where[slug][equals]=${encodeURIComponent(slug)}&limit=1`)

  if (result.docs?.[0]) return result.docs[0]

  return payloadFetch('/categories', {
    method: 'POST',
    body: JSON.stringify({ name, slug }),
  })
}

// Tags
export async function findOrCreateTag(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const result = await payloadFetch(`/tags?where[slug][equals]=${encodeURIComponent(slug)}&limit=1`)

  if (result.docs?.[0]) return result.docs[0]

  return payloadFetch('/tags', {
    method: 'POST',
    body: JSON.stringify({ name, slug }),
  })
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

export async function getAllPublishedSlugs(airportCode?: string): Promise<PublishedPost[]> {
  const params = new URLSearchParams({
    'where[status][equals]': 'published',
    limit: '500',
    select: 'slug,title,articleType,airportCode',
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

// Cluster context — fetch hub + sibling article headings for cross-article awareness
export interface ClusterArticle {
  slug: string
  title: string
  articleType: string
  headings: { level: number; text: string }[]
  excerpt: string
}

export async function getClusterContext(item: { airportCode: string; articleType: string; hubSlug?: string; parentSlug?: string; slug: string }): Promise<ClusterArticle[]> {
  // Dynamically import to avoid circular deps
  const { extractHeadingsFromLexical } = await import('./lexical-to-html.js')

  const params = new URLSearchParams({
    'where[status][equals]': 'published',
    'where[airportCode][equals]': item.airportCode.toUpperCase(),
    limit: '20',
  })

  const result = await payloadFetch(`/posts?${params.toString()}`)
  const docs = result.docs || []

  return docs
    .filter((doc: Record<string, unknown>) => doc.slug !== item.slug)
    .map((doc: Record<string, unknown>) => ({
      slug: doc.slug as string,
      title: doc.title as string,
      articleType: (doc.articleType as string) || 'spoke',
      headings: extractHeadingsFromLexical(doc.content as Parameters<typeof extractHeadingsFromLexical>[0]),
      excerpt: ((doc.excerpt as string) || '').slice(0, 200),
    }))
    .slice(0, 10)
}

// Content Queue
export async function getQueueItems(filters: Record<string, string> = {}) {
  const params = new URLSearchParams({ sort: 'priority' })
  for (const [key, value] of Object.entries(filters)) {
    params.set(key, value)
  }
  if (!params.has('limit')) params.set('limit', '50')
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
