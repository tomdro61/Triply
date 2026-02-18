const CMS_URL = process.env.NEXT_PUBLIC_CMS_URL || 'http://localhost:3001'

export function resolveCmsImageUrl(url: string): string {
  if (!url) return ''
  if (url.startsWith('http')) return url
  return `${CMS_URL}${url}`
}

export function resolvePostImages(post: any): any {
  if (post?.featuredImage?.url) {
    post.featuredImage.url = resolveCmsImageUrl(post.featuredImage.url)
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
