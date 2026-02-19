import { env } from './config.js'

interface UnsplashPhoto {
  id: string
  urls: { regular: string; small: string }
  alt_description: string | null
  user: { name: string; links: { html: string } }
}

export async function searchPhoto(query: string): Promise<UnsplashPhoto | null> {
  if (!env.UNSPLASH_ACCESS_KEY) {
    console.log('  ⚠ No UNSPLASH_ACCESS_KEY — skipping image search. Upload manually.')
    return null
  }

  const params = new URLSearchParams({
    query,
    per_page: '1',
    orientation: 'landscape',
  })

  const res = await fetch(`https://api.unsplash.com/search/photos?${params.toString()}`, {
    headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` },
  })

  if (!res.ok) {
    console.error(`  Unsplash error ${res.status}: ${await res.text()}`)
    return null
  }

  const data = await res.json()
  return data.results?.[0] || null
}

export async function downloadPhoto(photo: UnsplashPhoto): Promise<{
  buffer: Buffer
  filename: string
  alt: string
} | null> {
  try {
    const res = await fetch(photo.urls.regular)
    if (!res.ok) return null

    const buffer = Buffer.from(await res.arrayBuffer())
    const filename = `${photo.id}.jpg`
    const alt = `${photo.alt_description || 'Airport parking'} — Photo by ${photo.user.name} on Unsplash`

    // Trigger Unsplash download endpoint (required by API guidelines)
    if (env.UNSPLASH_ACCESS_KEY) {
      fetch(`https://api.unsplash.com/photos/${photo.id}/download`, {
        headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` },
      }).catch(() => {})
    }

    return { buffer, filename, alt }
  } catch (err) {
    console.error(`  Error downloading photo: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

export async function getAirportPhoto(airportCode: string): Promise<{
  buffer: Buffer
  filename: string
  alt: string
} | null> {
  const queries = [
    `${airportCode} airport parking`,
    `${airportCode} airport`,
    'airport parking lot',
  ]

  for (const query of queries) {
    const photo = await searchPhoto(query)
    if (photo) {
      const result = await downloadPhoto(photo)
      if (result) return result
    }
  }

  return null
}
