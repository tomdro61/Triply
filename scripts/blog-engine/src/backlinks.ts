/**
 * backlinks.ts — monthly baseline of who links to triplypro.com (Marketing Plan rank 17).
 *
 * Free sources only (no SerpAPI, no paid tools):
 *   1. Bing Webmaster API — GetLinkCounts (target pages) + GetUrlLinks (linking URLs + anchor),
 *      paged to the end; plus GetCrawlStats' daily `InLinks` count as the trend line.
 *      NOTE (2026-10-01): GetLinkCounts/GetUrlLinks return EMPTY for every site on this key
 *      (also airportparkingboston.com etc.) while InLinks reads 141 — the per-link data is
 *      only in the Bing UI (Backlinks tab → export). The script still pulls it, so if Bing
 *      starts serving it the report fills in with no code change.
 *   2. Microsoft Clarity — ONE call (`--clarity`), dimension=Source, last 3 days: the sites that
 *      actually SEND visitors. Clarity allows 10 calls/project/day; clarity.ts uses 3.
 *   3. Manual CSV (`--import <file.csv>`) — a Bing "Backlinks" export or a GSC
 *      "Links → Top linking sites" export. Any CSV whose first column is a URL or domain.
 *   Google Search Console's API has no Links resource (v1 = searchanalytics, sitemaps, sites,
 *   urlInspection, urlTestingTools), so GSC can only come in via --import.
 *
 * Run (from scripts/blog-engine):
 *   npx tsx src/backlinks.ts                     # Bing only
 *   npx tsx src/backlinks.ts --clarity           # + Clarity referrers (1 API call)
 *   npx tsx src/backlinks.ts --import links.csv  # + a UI export (repeatable flag)
 * Writes reports/backlinks-baseline-YYYY-MM-DD.json + .md
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json'
const CLARITY_API = 'https://www.clarity.ms/export-data/api/v1/project-live-insights'
const OWN_HOSTS = /(^|\.)triplypro\.com$/i
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports')
const MAX_PAGES = 200 // safety cap per paged endpoint

// ── Types ──────────────────────────────────────────────────────────────────

type Category =
  | 'own' | 'search-engine' | 'ai-assistant' | 'social' | 'spam-scraper'
  | 'directory' | 'press' | 'airport' | 'parking-lot' | 'forum' | 'partner-or-other' | 'unknown'

interface LinkRow { source: string; sourceUrl?: string; target?: string; anchor?: string; count?: number; via: string }
interface DomainSummary { domain: string; category: Category; real: boolean; links: number; targets: string[]; anchors: string[]; via: string[] }
interface InLinksPoint { date: string; inLinks: number; inIndex: number }

// ── Bing ───────────────────────────────────────────────────────────────────

const BING_KEY = process.env.BING_WEBMASTER_API_KEY

async function bing(endpoint: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, apikey: BING_KEY || '' })
  const res = await fetch(`${API_BASE}/${endpoint}?${qs}`)
  if (!res.ok) throw new Error(`Bing ${endpoint} ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()).d
}

function bingDate(raw: string): string {
  const m = /\/Date\((-?\d+)/.exec(raw || '')
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : ''
}

/** The verified property is https://triplypro.com/ (no www) — bing.ts uses www, which only works for some calls. */
async function bingSiteUrl(): Promise<string> {
  const sites: { Url: string; IsVerified: boolean }[] = await bing('GetUserSites', {})
  const hit = sites.find(s => s.IsVerified && /triplypro\.com/i.test(s.Url))
  if (!hit) throw new Error('triplypro.com is not a verified site on this Bing key')
  return hit.Url
}

async function bingLinks(siteUrl: string): Promise<{ rows: LinkRow[]; targets: { url: string; count: number }[] }> {
  const targets: { url: string; count: number }[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const d = await bing('GetLinkCounts', { siteUrl, page: String(page) })
    for (const l of d?.Links || []) targets.push({ url: l.Url, count: l.Count })
    if (page + 1 >= (d?.TotalPages || 0)) break
  }
  const rows: LinkRow[] = []
  for (const t of targets) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await bing('GetUrlLinks', { siteUrl, link: t.url, page: String(page) })
      for (const x of d?.Details || []) {
        rows.push({ source: hostOf(x.Url), sourceUrl: x.Url, target: t.url, anchor: x.AnchorText, via: 'bing-api' })
      }
      if (page + 1 >= (d?.TotalPages || 0)) break
    }
  }
  return { rows, targets }
}

async function bingInLinks(siteUrl: string): Promise<InLinksPoint[]> {
  const d: any[] = await bing('GetCrawlStats', { siteUrl })
  return (d || []).map(x => ({ date: bingDate(x.Date), inLinks: x.InLinks, inIndex: x.InIndex }))
    .filter(p => p.date).sort((a, b) => a.date.localeCompare(b.date))
}

// ── Clarity (1 call) ───────────────────────────────────────────────────────

async function clarityReferrers(): Promise<LinkRow[]> {
  const token = (process.env.CLARITY_API_TOKEN || '').trim()
  if (!token) throw new Error('CLARITY_API_TOKEN missing')
  const qs = new URLSearchParams({ numOfDays: '3', dimension1: 'Source' })
  const res = await fetch(`${CLARITY_API}?${qs}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Clarity ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const metrics: { metricName: string; information: Record<string, string | undefined>[] }[] = await res.json()
  const traffic = metrics.find(m => m.metricName === 'Traffic')
  const rows: LinkRow[] = []
  for (const r of traffic?.information || []) {
    const src = (r.Source || '').trim()
    if (!src) continue
    const sessions = parseFloat(r.totalSessionCount || '0') || 0
    rows.push({ source: hostOf(src), count: sessions, via: 'clarity-referrer-3d' })
  }
  return rows
}

// ── CSV import (Bing / GSC UI exports) ─────────────────────────────────────

function importCsv(file: string): LinkRow[] {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const rows: LinkRow[] = []
  for (const line of lines.slice(1)) {
    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim())
    const first = cols[0]
    if (!first || !/[a-z0-9-]+\.[a-z]{2,}/i.test(first)) continue
    const target = cols.find((c, i) => i > 0 && /triplypro\.com/i.test(c))
    const n = cols.slice(1).map(Number).find(n => Number.isFinite(n) && n > 0)
    rows.push({ source: hostOf(first), sourceUrl: /^https?:/.test(first) ? first : undefined, target, count: n, via: `csv:${path.basename(file)}` })
  }
  return rows
}

// ── Classification ─────────────────────────────────────────────────────────

function hostOf(u: string): string {
  try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '').toLowerCase() } catch { return u.toLowerCase() }
}

const RULES: [Category, RegExp][] = [
  ['own', OWN_HOSTS],
  ['search-engine', /^(google|bing|yahoo|duckduckgo|yandex|baidu|ecosia|brave|qwant|aol|ask)$|(^|\.)(google|bing|yahoo|duckduckgo|yandex|baidu|ecosia|brave|qwant|aol|ask)\.[a-z.]+$|^search\./],
  ['ai-assistant', /^(chatgpt|openai|perplexity|copilot|gemini|claude)$|(^|\.)(chatgpt\.com|openai\.com|perplexity\.ai|copilot\.com|copilot\.microsoft\.com|gemini\.google\.com|claude\.ai|you\.com|phind\.com|poe\.com|meta\.ai)$/],
  ['social', /(^|\.)(facebook|instagram|linkedin|twitter|x|t|tiktok|pinterest|youtube|threads|lnkd)\.(com|co|net|in)$/],
  ['forum', /(^|\.)(reddit\.com|quora\.com|tripadvisor\.[a-z.]+|flyertalk\.com|stackexchange\.com|lonelyplanet\.com)$/],
  ['spam-scraper', /(seo|backlink|rank|whois|siteprice|websiteoutlook|statshow|site(info|worth|value)|hypestat|similarsites|sitelike|webstatsdomain|linkody|trafficestimate|\.xyz$|\.top$|\.icu$|\.buzz$|\.click$|\.monster$|\.cfd$|\.sbs$|\.ru$|\.cn$)/],
  ['airport', /(airport|fly2houston\.com|flyaustin\.com|panynj\.gov|massport\.com|flylax\.com|flydenver\.com|flysfo\.com|dfwairport\.com|mwaa\.com|^fly[a-z]+\.(com|org)$)/],
  ['press', /(news|times|post|tribune|journal|gazette|herald|patch\.com|forbes|cnbc|cnn|nbc|abc|cbs|fox|usatoday|thepointsguy|travelandleisure|cntraveler|lifehacker|businessinsider)/],
  ['directory', /(yelp|bbb\.org|crunchbase|g2\.com|capterra|trustpilot|sitejabber|producthunt|yellowpages|manta|foursquare|angi|nextdoor|alignable|chamberofcommerce|hotfrog|brownbook|cylex|f6s|wellfound|angel\.co)/],
  ['parking-lot', /(park|parking|valet|shuttle)/],
]

function classify(domain: string): Category {
  for (const [cat, re] of RULES) if (re.test(domain)) return cat
  return 'unknown'
}

/** "Real" = a human-curated site that could plausibly pass value or send a customer. */
const REAL: Category[] = ['directory', 'press', 'airport', 'parking-lot', 'forum', 'partner-or-other', 'ai-assistant', 'social']

function summarise(rows: LinkRow[]): DomainSummary[] {
  const map = new Map<string, DomainSummary>()
  for (const r of rows) {
    if (!r.source) continue
    const cat = classify(r.source)
    const s = map.get(r.source) || { domain: r.source, category: cat, real: REAL.includes(cat), links: 0, targets: [], anchors: [], via: [] }
    s.links += r.count ?? 1
    if (r.target && !s.targets.includes(r.target)) s.targets.push(r.target)
    if (r.anchor && !s.anchors.includes(r.anchor) && s.anchors.length < 5) s.anchors.push(r.anchor)
    if (!s.via.includes(r.via)) s.via.push(r.via)
    map.set(r.source, s)
  }
  return [...map.values()].filter(s => s.category !== 'own').sort((a, b) => b.links - a.links)
}

function pageType(u: string): string {
  const p = (() => { try { return new URL(u).pathname } catch { return u } })().replace(/\/+$/, '') || '/'
  if (p === '/') return 'home'
  if (/^\/blog\/?$/.test(p)) return 'blog index'
  if (/^\/blog\//.test(p)) return 'blog article/hub'
  if (/^\/(airport|airports|parking|lots?|search|checkout|book)/.test(p)) return 'booking/airport page'
  return 'other'
}

// ── Report ─────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const useClarity = args.includes('--clarity')
  const imports = args.flatMap((a, i) => (a === '--import' && args[i + 1] ? [args[i + 1]] : []))
  if (!BING_KEY) { console.error('BING_WEBMASTER_API_KEY missing from .env'); process.exit(1) }

  const notes: string[] = []
  const siteUrl = await bingSiteUrl()
  console.log(`Bing property: ${siteUrl}`)
  const { rows: bingRows, targets } = await bingLinks(siteUrl)
  const inLinks = await bingInLinks(siteUrl)
  console.log(`Bing link API: ${targets.length} target pages, ${bingRows.length} linking URLs`)
  if (targets.length === 0) notes.push('Bing GetLinkCounts/GetUrlLinks returned no rows (per-link data is UI-only on this key) — export Bing Backlinks + GSC Top linking sites and re-run with --import.')

  let clarityRows: LinkRow[] = []
  const date = new Date().toISOString().slice(0, 10)
  const base = path.join(REPORTS_DIR, `backlinks-baseline-${date}`)
  // Clarity allows 10 calls/day: reuse today's pull on a re-run instead of spending another.
  const prior = fs.existsSync(`${base}.json`) ? JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')) : null
  if (useClarity && prior?.clarityReferrers?.length && !args.includes('--fresh')) {
    clarityRows = prior.clarityReferrers.map((r: DomainSummary) => ({ source: r.domain, count: r.links, via: 'clarity-referrer-3d' }))
    console.log(`Clarity: reused today's ${clarityRows.length} referrer sources (--fresh to re-pull)`)
  } else if (useClarity) {
    try { clarityRows = await clarityReferrers(); console.log(`Clarity: ${clarityRows.length} referrer sources (3 days)`) }
    catch (e) { notes.push(`Clarity failed: ${e instanceof Error ? e.message : e}`) }
  }
  const csvRows = imports.flatMap(importCsv)

  const linkDomains = summarise([...bingRows, ...csvRows])
  const referrers = summarise(clarityRows)
  const latest = inLinks[inLinks.length - 1]
  const pages = new Map<string, number>()
  for (const t of targets) pages.set(pageType(t.url), (pages.get(pageType(t.url)) || 0) + t.count)
  for (const r of csvRows) if (r.target) pages.set(pageType(r.target), (pages.get(pageType(r.target)) || 0) + (r.count ?? 1))

  const out = {
    generatedAt: new Date().toISOString(), siteUrl,
    bing: { inLinksLatest: latest, inLinksSeries: inLinks, targetPages: targets, linkRows: bingRows.length },
    linkingDomains: linkDomains,
    realLinkingDomains: linkDomains.filter(d => d.real).length,
    clarityReferrers: referrers,
    linkedPageTypes: Object.fromEntries(pages),
    imports, notes,
  }
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true })
  fs.writeFileSync(`${base}.json`, JSON.stringify(out, null, 2))
  // Auto .md only when no hand-written baseline exists for today (never clobber an annotated one).
  if (!fs.existsSync(`${base}.md`) || args.includes('--md')) fs.writeFileSync(`${base}.md`, renderMd(out, linkDomains, referrers))
  console.log(`\nInLinks (Bing, ${latest?.date}): ${latest?.inLinks}`)
  console.log(`Linking domains: ${linkDomains.length} (${out.realLinkingDomains} real)`)
  for (const d of linkDomains.slice(0, 15)) console.log(`  ${d.domain.padEnd(40)} ${d.category.padEnd(16)} ${d.links}`)
  if (referrers.length) { console.log('Clarity referrers (3d):'); for (const r of referrers.slice(0, 20)) console.log(`  ${r.domain.padEnd(40)} ${r.category.padEnd(16)} ${r.links} sessions`) }
  for (const n of notes) console.log(`NOTE: ${n}`)
  console.log(`\nSaved ${base}.json + .md`)
}

function renderMd(out: { siteUrl: string; bing: { inLinksLatest?: InLinksPoint; targetPages: { url: string; count: number }[] }; linkedPageTypes: Record<string, number>; notes: string[] }, domains: DomainSummary[], referrers: DomainSummary[]): string {
  const L: string[] = [`# Backlinks — ${out.siteUrl} — ${new Date().toISOString().slice(0, 10)}`, '']
  L.push(`- Bing InLinks (${out.bing.inLinksLatest?.date}): **${out.bing.inLinksLatest?.inLinks ?? 'n/a'}**`)
  L.push(`- Linking domains listed: **${domains.length}** (${domains.filter(d => d.real).length} real)`, '')
  if (domains.length) {
    L.push('| Domain | Category | Links | Targets |', '|---|---|---|---|')
    for (const d of domains) L.push(`| ${d.domain} | ${d.category} | ${d.links} | ${d.targets.slice(0, 3).join(' ')} |`)
    L.push('')
  }
  if (Object.keys(out.linkedPageTypes).length) {
    L.push('| Linked page type | Links |', '|---|---|')
    for (const [k, v] of Object.entries(out.linkedPageTypes)) L.push(`| ${k} | ${v} |`)
    L.push('')
  }
  if (referrers.length) {
    L.push('## Referrers sending visits (Clarity, last 3 days)', '', '| Source | Category | Sessions |', '|---|---|---|')
    for (const r of referrers) L.push(`| ${r.domain} | ${r.category} | ${r.links} |`)
    L.push('')
  }
  for (const n of out.notes) L.push(`- NOTE: ${n}`)
  return L.join('\n') + '\n'
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
