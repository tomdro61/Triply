/**
 * indexnow.ts — instant search-engine indexing via the IndexNow protocol (free).
 *
 * IndexNow pings Bing, Yandex, Seznam, Naver & Yep the moment a URL is added or
 * updated, instead of waiting for a crawl (Bing picks it up in seconds vs hrs/days).
 * WHY IT MATTERS HERE: Bing's index feeds ChatGPT Search + Microsoft Copilot, and
 * ~87% of ChatGPT citations match Bing's top results — so fast Bing indexing is a
 * direct GEO lever. For a high-volume automated publisher, it removes the discovery-
 * latency bottleneck that disproportionately hurts newer pages.
 *
 * Setup (one-time, frontend/domain): host the key as a text file at
 *   https://<host>/<INDEXNOW_KEY>.txt   (file contents = the key itself)
 * then set INDEXNOW_KEY in .env. Without the key the submit is a graceful no-op.
 *
 * Submitting is fire-and-forget: it NEVER throws into the pipeline (indexing is
 * best-effort, must not fail a publish). Endpoint accepts up to 10,000 URLs/request.
 *
 * CLI:
 *   tsx src/indexnow.ts https://www.triplypro.com/blog/foo https://.../bar
 *   tsx src/indexnow.ts --all                 # ping every published post (backfill)
 *   tsx src/indexnow.ts --all -a MSP          # one cluster
 *   tsx src/indexnow.ts --all --dry-run       # preview, no submit
 */

import { env, BLOG_BASE_URL } from './config.js'

const ENDPOINT = 'https://api.indexnow.org/indexnow'
const MAX_PER_REQUEST = 10_000

function host(): string {
  try { return new URL(BLOG_BASE_URL).host } catch { return 'www.triplypro.com' }
}

export function postUrlFor(slug: string): string {
  return `${BLOG_BASE_URL}/${slug}`
}

/**
 * Submit URLs to IndexNow. Best-effort: returns how many were accepted; logs and
 * swallows all errors (never throws — indexing must not break a publish/refresh).
 */
/** W1.11 name for the same call: ping on every publish AND every content update. */
export async function pingIndexNow(urls: string[]): Promise<{ submitted: number; ok: boolean }> {
  return submitUrls(urls)
}

export async function submitUrls(urls: string[]): Promise<{ submitted: number; ok: boolean }> {
  const unique = [...new Set(urls.filter(Boolean))]
  if (unique.length === 0) return { submitted: 0, ok: true }

  const key = (env.INDEXNOW_KEY || '').trim()
  if (!key) {
    console.warn(`  ⚠ IndexNow: INDEXNOW_KEY is not set — ${unique.length} URL(s) NOT pinged (Bing/Copilot/ChatGPT will wait for a crawl). Set it in .env; the key file is public/a36d16ee395347eb33ed68ef73858f5f.txt`)
    return { submitted: 0, ok: false }
  }

  const h = host()
  const keyLocation = `https://${h}/${key}.txt`
  let submitted = 0
  let ok = true

  for (let i = 0; i < unique.length; i += MAX_PER_REQUEST) {
    const chunk = unique.slice(i, i + MAX_PER_REQUEST)
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: h, key, keyLocation, urlList: chunk }),
      })
      // 200 = accepted, 202 = accepted pending key validation. Both are success.
      if (res.status === 200 || res.status === 202) {
        submitted += chunk.length
        console.log(`  📣 IndexNow: submitted ${chunk.length} URL(s) → ${res.status}`)
      } else {
        ok = false
        const body = (await res.text()).slice(0, 200)
        // 403 = key file not found/invalid; 422 = URL host mismatch; 429 = rate limited.
        console.warn(`  ⚠ IndexNow ${res.status} (${chunk.length} URLs): ${body}`)
      }
    } catch (e) {
      ok = false
      console.warn(`  ⚠ IndexNow request failed (non-fatal): ${(e as Error).message}`)
    }
  }
  return { submitted, ok }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'url'
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

async function fetchAllPublishedSlugs(airport?: string): Promise<string[]> {
  const slugs: string[] = []
  let page = 1
  while (true) {
    const params = new URLSearchParams({ 'where[status][equals]': 'published', limit: '200', page: String(page) })
    if (airport) params.set('where[airportCode][equals]', airport.toUpperCase())
    const res = await fetch(`${env.PAYLOAD_CMS_URL}/api/posts?${params.toString()}`, {
      headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` },
    })
    if (!res.ok) throw new Error(`Failed to fetch posts: ${res.status} ${await res.text()}`)
    const data = await res.json()
    for (const doc of (data.docs || []) as { slug?: string }[]) if (doc.slug) slugs.push(doc.slug)
    if (!data.hasNextPage) break
    page++
  }
  return slugs
}

if (isDirectRun) {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const useAll = args.includes('--all')
  const aIdx = args.findIndex((a) => a === '-a' || a === '--airport')
  const airport = aIdx >= 0 ? args[aIdx + 1] : undefined

  let urls: string[]
  if (useAll) {
    console.log(`\n🔎 Fetching published posts${airport ? ` for ${airport.toUpperCase()}` : ''}...`)
    urls = (await fetchAllPublishedSlugs(airport)).map(postUrlFor)
    console.log(`   ${urls.length} published URL(s) found`)
  } else {
    urls = args.filter((a) => a.startsWith('http'))
  }

  if (urls.length === 0) {
    console.log('Usage: tsx src/indexnow.ts <url...> | --all [-a AIRPORT] [--dry-run]')
  } else if (dryRun) {
    console.log(`\n[DRY RUN] Would submit ${urls.length} URL(s) to IndexNow:`)
    urls.slice(0, 10).forEach((u) => console.log(`   ${u}`))
    if (urls.length > 10) console.log(`   ... and ${urls.length - 10} more`)
  } else {
    const r = await submitUrls(urls)
    console.log(`\n✅ IndexNow: ${r.submitted}/${urls.length} submitted${r.ok ? '' : ' (some errors — see above)'}\n`)
  }
}
