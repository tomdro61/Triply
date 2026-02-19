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
  formData.append('file', new Blob([new Uint8Array(file)], { type: mimeType }), filename)
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
