const CMS_URL = process.env.NEXT_PUBLIC_CMS_URL || 'http://localhost:3001'

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

export async function fetchFromCms(
  path: string,
  params: Record<string, string> = {},
  revalidate = 60
) {
  const searchParams = new URLSearchParams(params)
  const url = `${CMS_URL}/api${path}?${searchParams.toString()}`

  const res = await fetch(url, { next: { revalidate } })

  if (!res.ok) {
    console.error(`CMS fetch error ${res.status} on ${path}`)
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

export async function getPostBySlug(slug: string) {
  const data = await fetchFromCms('/posts', {
    'where[slug][equals]': slug,
    'where[status][equals]': 'published',
    'depth': '2',
  })

  const post = data?.docs?.[0] || null
  return post ? resolvePostImages(post) : null
}

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
