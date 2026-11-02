/**
 * perf-serp.ts — competitive SERP + AI-Overview analysis for a keyword.
 *
 * Exposes analyzeSerp() for the recommend stage and a CLI for manual inspection.
 * For each keyword: who ranks organically, whether Google shows an AI Overview
 * and who it cites (are WE cited?), People-Also-Ask, and related searches.
 * ~1 SerpAPI credit per keyword (auto-rotating key via serpapi.ts). Read-only.
 *
 * CLI: tsx src/perf-serp.ts "msp parking" "ecopark iah"
 */

import { serpApiSearch } from './serpapi.js'
import { DOMAIN } from './config.js'

function domainOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u }
}

export interface SerpOrganicResult { position: number; domain: string; title: string; isUs: boolean }
export interface SerpAnalysis {
  keyword: string
  found: boolean
  aioPresent: boolean
  aioCitesUs: boolean
  aioSources: { domain: string; title: string }[]
  organic: SerpOrganicResult[]
  ourPosition: number | null
  paa: string[]
  related: string[]
}

export async function analyzeSerp(keyword: string): Promise<SerpAnalysis> {
  // No explicit TTL → uses SERP_CACHE_TTL_HOURS (default ~6d): a weekly maintenance
  // run always re-pulls fresh (keeps the AI-Overview citation signal current), while
  // a same-week re-run (e.g. geo capture then maintain run --refresh) reuses the pull.
  const data = await serpApiSearch({ q: keyword, num: '10', engine: 'google' })
  if (!data) {
    return { keyword, found: false, aioPresent: false, aioCitesUs: false, aioSources: [], organic: [], ourPosition: null, paa: [], related: [] }
  }

  const organicRaw: any[] = data.organic_results || []
  const aio = data.ai_overview || null
  const refs: any[] = aio?.references || []

  const organic: SerpOrganicResult[] = organicRaw.slice(0, 10).map((r) => ({
    position: r.position ?? 0,
    domain: domainOf(r.link || ''),
    title: r.title || '',
    isUs: (r.link || '').includes(DOMAIN),
  }))
  const ourIdx = organic.findIndex((r) => r.isUs)

  return {
    keyword,
    found: true,
    aioPresent: !!aio && (refs.length > 0 || !!aio.text_blocks || !!aio.page_token),
    aioCitesUs: refs.some((r) => (r.link || '').includes(DOMAIN)),
    aioSources: refs.slice(0, 8).map((r) => ({ domain: domainOf(r.link || ''), title: r.title || '' })),
    organic,
    ourPosition: ourIdx >= 0 ? organic[ourIdx].position : null,
    paa: (data.related_questions || []).map((x: any) => x.question).filter(Boolean),
    related: (data.related_searches || []).map((x: any) => x.query).filter(Boolean),
  }
}

export function printSerpAnalysis(a: SerpAnalysis): void {
  console.log(`\n══════ "${a.keyword}" ══════`)
  if (!a.found) { console.log('  (no SERP data — SerpAPI error or out of quota)'); return }

  if (a.aioPresent) {
    if (a.aioSources.length) {
      console.log(`  AI Overview: PRESENT — ${a.aioSources.length} sources${a.aioCitesUs ? '  ✅ WE ARE CITED' : '  ❌ we are NOT cited'}`)
      a.aioSources.slice(0, 6).forEach((r, i) => console.log(`     ${i + 1}. ${r.domain.padEnd(26)} ${r.title.slice(0, 55)}`))
    } else {
      console.log('  AI Overview: PRESENT (sources behind page_token — not fetched, saves a credit)')
    }
  } else {
    console.log('  AI Overview: none shown')
  }

  console.log(`  Organic top ${Math.min(8, a.organic.length)}:`)
  a.organic.slice(0, 8).forEach((r) =>
    console.log(`     ${String(r.position).padStart(2)}. ${r.domain.padEnd(26)} ${r.title.slice(0, 50)}${r.isUs ? '  ◀ US' : ''}`))
  console.log(a.ourPosition ? `  → Triply organic position: ${a.ourPosition}` : `  → Triply: NOT in top ${a.organic.length}`)

  if (a.paa.length) console.log(`  People Also Ask: ${a.paa.slice(0, 6).join('  •  ')}`)
  if (a.related.length) console.log(`  Related searches: ${a.related.slice(0, 8).join('  •  ')}`)
}

// ── CLI ───────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'url'
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  const keywords = process.argv.slice(2)
  if (!keywords.length) {
    console.log('Usage: tsx src/perf-serp.ts "keyword one" "keyword two"')
  } else {
    console.log(`\n🔎 SERP analysis — ${keywords.length} keyword(s), ~${keywords.length} SerpAPI credit(s)`)
    for (const k of keywords) printSerpAnalysis(await analyzeSerp(k))
    console.log('')
  }
}
