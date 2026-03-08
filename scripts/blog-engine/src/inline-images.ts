import { parse, HTMLElement, NodeType } from 'node-html-parser'
import { searchPhoto, downloadPhoto } from './unsplash.js'
import { uploadMedia } from './payload.js'

/** Maximum inline images per article to avoid Unsplash rate limits */
const MAX_INLINE_IMAGES = 3

interface ResolvedImage {
  mediaId: string
  url: string
  alt: string
  width: number
  height: number
}

/**
 * Scan HTML for <img> tags (standalone or inside <figure>), source images from
 * Unsplash, upload to Payload media library, and enrich the HTML with data
 * attributes that html-to-lexical reads to build LexicalUploadNode objects.
 *
 * Images that fail to resolve are removed from the HTML so they don't produce
 * broken upload nodes.
 */
export async function resolveInlineImages(
  html: string,
  airportCode: string
): Promise<{ html: string; imagesResolved: number }> {
  const root = parse(html, { lowerCaseTagName: true, comment: false })
  const imgElements = root.querySelectorAll('img')

  if (imgElements.length === 0) {
    return { html, imagesResolved: 0 }
  }

  console.log(`  Found ${imgElements.length} inline image(s) to resolve...`)

  let resolved = 0

  for (const imgEl of imgElements) {
    if (resolved >= MAX_INLINE_IMAGES) {
      console.log(`  ⚠ Reached max ${MAX_INLINE_IMAGES} inline images — removing remaining`)
      removeImgElement(imgEl)
      continue
    }

    const alt = imgEl.getAttribute('alt') || ''
    if (!alt) {
      console.log('  ⚠ Skipping <img> with no alt text')
      removeImgElement(imgEl)
      continue
    }

    try {
      const image = await sourceAndUploadImage(alt, airportCode)
      if (image) {
        imgEl.setAttribute('data-media-id', image.mediaId)
        imgEl.setAttribute('src', image.url)
        imgEl.setAttribute('alt', image.alt)
        imgEl.setAttribute('data-width', String(image.width))
        imgEl.setAttribute('data-height', String(image.height))
        resolved++
        console.log(`  ✓ Inline image ${resolved}: "${alt.slice(0, 50)}"`)
      } else {
        console.log(`  ⚠ Could not source image for: "${alt.slice(0, 50)}" — removing`)
        removeImgElement(imgEl)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  ⚠ Image resolution failed: ${msg} — removing`)
      removeImgElement(imgEl)
    }
  }

  return { html: root.toString(), imagesResolved: resolved }
}

/**
 * Search Unsplash for an image matching the alt text, download it,
 * and upload to Payload's media library.
 */
async function sourceAndUploadImage(
  alt: string,
  airportCode: string
): Promise<ResolvedImage | null> {
  // Build search queries from most specific to most generic
  const queries = [
    `${airportCode} airport ${alt}`,
    `airport ${alt}`,
    alt,
  ]

  for (const query of queries) {
    const photo = await searchPhoto(query)
    if (!photo) continue

    const downloaded = await downloadPhoto(photo)
    if (!downloaded) continue

    // Upload to Payload media library
    const media = await uploadMedia(downloaded.buffer, downloaded.filename, alt)
    const mediaId = media.doc?.id || media.id
    const mediaUrl = media.doc?.url || media.url

    const width = photo.width
    const height = photo.height

    return {
      mediaId,
      url: mediaUrl,
      alt: downloaded.alt,
      width,
      height,
    }
  }

  return null
}

/**
 * Remove an <img> element from the DOM. If it's inside a <figure>, remove
 * the entire figure to avoid orphaned figcaptions.
 */
function removeImgElement(imgEl: HTMLElement): void {
  const parent = imgEl.parentNode as HTMLElement | null
  if (parent && parent.tagName?.toLowerCase() === 'figure') {
    parent.remove()
  } else {
    imgEl.remove()
  }
}
