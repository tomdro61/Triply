/**
 * SerpAPI search with automatic API-key rotation.
 *
 * Tries each configured key in order (SERPAPI_API_KEY, then SERPAPI_API_KEY_2).
 * When a key is out of its monthly quota (429 "run out of searches"), it
 * transparently falls back to the next key. This is the single choke point for
 * all SerpAPI usage (scraper.ts, geo-tracker.ts, and the perf loop) so quota
 * exhaustion no longer silently kills a batch — it just rolls to the backup key.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { env } from './config.js'

function serpApiKeys(): string[] {
  return [env.SERPAPI_API_KEY, env.SERPAPI_API_KEY_2]
    .map((k) => (k || '').trim())
    .filter(Boolean) as string[]
}

const OUT_OF_SEARCHES = /run out of searches|account has run out/i

export function hasSerpApiKey(): boolean {
  return serpApiKeys().length > 0
}

// ── Disk cache (reduces SerpAPI credit spend) ──────────────────────────────────
// The single choke point for all SERP usage, so caching here cuts spend across
// the scraper, the perf loop, and the geo tracker at once. A repeat search with
// identical params inside the TTL reuses the stored response — no network, no
// credit. TTL is per-call (opts.cacheTtlHours), defaulting to SERP_CACHE_TTL_HOURS
// (6 days). 0 disables caching → identical to the pre-cache behavior.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.resolve(__dirname, '..', 'reports', 'serp-cache')
const DEFAULT_TTL_HOURS = 144 // 6 days: weekly runs stay fresh, same-week re-runs reuse

function effectiveTtlHours(opt?: number): number {
  const ttl = opt ?? env.SERP_CACHE_TTL_HOURS ?? DEFAULT_TTL_HOURS
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0
}

function cacheFileFor(params: Record<string, string>): string {
  // Stable key: sorted param entries (api_key is never in params).
  const stable = JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))
  const hash = crypto.createHash('sha1').update(stable).digest('hex')
  return path.join(CACHE_DIR, `${hash}.json`)
}

function readCache(file: string, ttlHours: number): any | null {
  try {
    const stat = fs.statSync(file)
    const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000
    if (ageHours > ttlHours) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')).data
  } catch {
    return null // missing or unreadable → treat as a miss
  }
}

function writeCache(file: string, params: Record<string, string>, data: any): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ cachedAt: new Date().toISOString(), params, data }))
  } catch (e) {
    console.warn(`  ⚠ SERP cache write failed (non-fatal): ${(e as Error).message}`)
  }
}

/**
 * Run a SerpAPI search. Pass all params EXCEPT api_key (this injects it).
 * Returns parsed JSON on success, or null on a non-quota error / all keys
 * exhausted (the reason is logged). Callers keep their existing null-handling.
 */
export async function serpApiSearch(
  params: Record<string, string>,
  opts?: { cacheTtlHours?: number },
): Promise<any | null> {
  const keys = serpApiKeys()
  if (keys.length === 0) return null

  const ttlHours = effectiveTtlHours(opts?.cacheTtlHours)
  const cacheFile = ttlHours > 0 ? cacheFileFor(params) : ''
  if (cacheFile) {
    const cached = readCache(cacheFile, ttlHours)
    if (cached !== null) {
      console.log(`  ⚡ SERP cache hit (${params.q ?? 'query'}) — no credit spent`)
      return cached
    }
  }

  let lastErr = ''
  for (let i = 0; i < keys.length; i++) {
    const qp = new URLSearchParams({ ...params, api_key: keys[i] })
    const res = await fetch(`https://serpapi.com/search?${qp.toString()}`)

    if (res.ok) {
      const data = await res.json()
      if (cacheFile) writeCache(cacheFile, params, data)
      return data
    }

    const body = await res.text()
    lastErr = `${res.status}: ${body.slice(0, 160)}`

    // Out of monthly quota → try the next key.
    if (res.status === 429 && OUT_OF_SEARCHES.test(body)) {
      if (i < keys.length - 1) {
        console.log(`  ⚠ SerpAPI key ${i + 1} out of searches — falling back to key ${i + 2}`)
        continue
      }
      console.error(`  ✗ SerpAPI: all ${keys.length} key(s) out of searches.`)
      return null
    }

    // Any other error (bad request, transient 5xx, rate limit) — surface it and
    // stop, rather than burning a second key's quota on a likely-repeat failure.
    console.error(`  SerpAPI error ${lastErr}`)
    return null
  }

  console.error(`  SerpAPI error ${lastErr}`)
  return null
}
