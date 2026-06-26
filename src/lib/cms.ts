import { cache } from 'react'
import { captureAPIError } from '@/lib/sentry'

const CMS_URL = process.env.NEXT_PUBLIC_CMS_URL || 'http://localhost:3001'

// Server-only API key (no NEXT_PUBLIC_ prefix) for authenticating main-app
// reads against the CMS. Sent only when present, so this stays fully
// backward-compatible while the CMS still allows public reads. Once the CMS
// locks read access to authenticated requests (Pass 3 egress fix), this header
// is what keeps the blog rendering server-side while anonymous bot traffic gets
// a 403 with no Postgres hit. fetchFromCms runs only on the server, so the key
// never reaches the client bundle.
const CMS_API_KEY = process.env.PAYLOAD_API_KEY

export function resolveCmsImageUrl(url: string): string {
  if (!url) return ''
  if (url.startsWith('http')) return url
  return `${CMS_URL}${url}`
}

function resolveContentImageUrls(content: any): void {
  if (!content?.root?.children) return
  const walk = (nodes: any[]) => {
    for (const node of nodes) {
      if (node.type === 'upload' && node.value?.url) {
        node.value.url = resolveCmsImageUrl(node.value.url)
      }
      if (node.children) {
        walk(node.children)
      }
    }
  }
  walk(content.root.children)
}

export function resolvePostImages(post: any): any {
  if (post?.featuredImage?.url) {
    post.featuredImage.url = resolveCmsImageUrl(post.featuredImage.url)
  }
  if (post?.content) {
    resolveContentImageUrls(post.content)
  }
  return post
}

async function fetchCmsOnce(url: string, revalidate: number): Promise<Response> {
  return fetch(url, {
    next: { revalidate },
    signal: AbortSignal.timeout(8000),
    ...(CMS_API_KEY
      ? { headers: { Authorization: `users API-Key ${CMS_API_KEY}` } }
      : {}),
  })
}

export async function fetchFromCms(
  path: string,
  params: Record<string, string> = {},
  // 1 hour. Posts publish almost daily and content rarely updates after
  // publish; an hour matches the user's editorial cadence while cutting
  // CMS-to-Postgres traffic ~60× vs the original 60-second window.
  revalidate = 3600
) {
  const searchParams = new URLSearchParams(params)
  const url = `${CMS_URL}/api${path}?${searchParams.toString()}`

  let res: Response
  try {
    res = await fetchCmsOnce(url, revalidate)
    if (res.status >= 500) throw new Error(`CMS ${res.status}`)
  } catch (firstErr) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      res = await fetchCmsOnce(url, revalidate)
    } catch (retryErr) {
      throw new Error(`CMS unreachable: ${path}`, { cause: retryErr })
    }
    if (res.status >= 500) {
      throw new Error(`CMS ${res.status} after retry: ${path}`)
    }
  }

  // 4xx falls through here — real "not found" / bad query, distinct from 5xx/network which throw above so SSR returns 500 (search engines retry) instead of masking as 404.
  if (!res.ok) {
    console.error(`CMS fetch error ${res.status} on ${path}`)
    // A systemic 4xx (e.g. a bad where-clause on a new query field) degrades
    // silently in the UI — surface it to Sentry so it doesn't go unnoticed.
    captureAPIError(new Error(`CMS fetch error ${res.status} on ${path}`), {
      endpoint: path,
      method: 'GET',
      statusCode: res.status,
    })
    return null
  }

  return res.json()
}

export async function getPublishedPosts(
  extraFilters: Record<string, string> = {},
  page = 1,
  limit = 12
) {
  const params: Record<string, string> = {
    'where[status][equals]': 'published',
    'sort': '-publishedAt',
    'depth': '2',
    'page': String(page),
    'limit': String(limit),
    ...extraFilters,
  }

  const data = await fetchFromCms('/posts', params)
  if (!data) return { docs: [], totalPages: 0, totalDocs: 0, page: 1 }

  return {
    docs: (data.docs || []).map(resolvePostImages),
    totalPages: data.totalPages || 1,
    totalDocs: data.totalDocs || 0,
    page: data.page || 1,
  }
}

// Wrapped in React's request-scoped cache because /blog/[slug]/page.tsx
// calls this twice per request — once in generateMetadata, once in the
// page body. Without dedup, every blog page render fires two identical
// CMS requests (and two Payload→Postgres trips). React's cache() returns
// the same Promise for both calls within a single render, so we hit the
// CMS at most once per slug per request.
export const getPostBySlug = cache(async function getPostBySlug(slug: string) {
  const data = await fetchFromCms('/posts', {
    'where[slug][equals]': slug,
    'where[status][equals]': 'published',
    'depth': '2',
  })

  const post = data?.docs?.[0] || null
  return post ? resolvePostImages(post) : null
})

export async function getCategories() {
  const data = await fetchFromCms('/categories', {
    sort: 'name',
    limit: '100',
    depth: '0',
  }, 3600)

  return { docs: data?.docs || [] }
}

export async function getCategoryBySlug(slug: string) {
  const data = await fetchFromCms('/categories', {
    'where[slug][equals]': slug,
    limit: '1',
  })

  return data?.docs?.[0] || null
}

export async function getPublishedPostCount(filters: Record<string, string> = {}) {
  const params: Record<string, string> = {
    'where[status][equals]': 'published',
    limit: '1',
    depth: '0',
    ...filters,
  }

  const data = await fetchFromCms('/posts', params)
  return data?.totalDocs || 0
}

export async function getDistinctAirportCodes() {
  const codes = new Set<string>()
  let page = 1
  while (true) {
    const data = await fetchFromCms('/posts', {
      'where[status][equals]': 'published',
      'where[airportCode][exists]': 'true',
      limit: '500',
      page: String(page),
      depth: '0',
    }, 3600)

    const docs = data?.docs || []
    for (const post of docs) {
      if (post.airportCode) {
        codes.add(post.airportCode.toUpperCase())
      }
    }

    const totalPages = data?.totalPages ?? 1
    if (page >= totalPages || docs.length === 0) break
    page++
  }
  return Array.from(codes).sort()
}

export async function getRelatedPosts(airportCode: string, excludeSlug: string, limit = 3) {
  const data = await fetchFromCms('/posts', {
    'where[status][equals]': 'published',
    'where[airportCode][equals]': airportCode,
    'where[slug][not_equals]': excludeSlug,
    'sort': '-publishedAt',
    'depth': '1',
    'limit': String(limit),
  })

  return (data?.docs || []).map(resolvePostImages)
}

export async function getSiblingPosts(parentSlug: string, excludeSlug: string, limit = 3) {
  const data = await fetchFromCms('/posts', {
    'where[status][equals]': 'published',
    'where[parentSlug][equals]': parentSlug,
    'where[slug][not_equals]': excludeSlug,
    'sort': '-publishedAt',
    'depth': '1',
    'limit': String(limit),
  })

  return (data?.docs || []).map(resolvePostImages)
}

// A post counts as "content updated" only when contentUpdatedAt has been
// explicitly stamped — by an editor, or by the blog engine on a genuine
// content regeneration. (The engine-side write is a pending follow-up; the
// field is null until then, so posts simply show no badge.) We deliberately
// do NOT use Payload's updatedAt: it bumps on every save — SEO scoring
// passes, link updates, admin tweaks — which would flip a false freshness
// signal onto the entire catalog at once. The date only counts when
// contentUpdatedAt is >24h after publishedAt, so launch-day touch-ups don't
// read as a content update. Returns null on missing or unparseable dates —
// a bad timestamp should suppress the freshness signal, never break a page.
// Drives the visible "Updated" badge, JSON-LD dateModified, and sitemap
// lastModified — keep all three consistent by using this one helper.
export function getContentUpdatedAt(post: {
  contentUpdatedAt?: string | null
  publishedAt?: string | null
}): string | null {
  if (!post?.contentUpdatedAt || !post?.publishedAt) return null
  const updated = new Date(post.contentUpdatedAt).getTime()
  const published = new Date(post.publishedAt).getTime()
  if (Number.isNaN(updated) || Number.isNaN(published)) return null
  return updated - published > 24 * 60 * 60 * 1000 ? post.contentUpdatedAt : null
}
