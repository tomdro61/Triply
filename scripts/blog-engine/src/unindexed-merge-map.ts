/**
 * Unindexed merge map — for every published post Google has NOT indexed (per
 * reports/index-coverage-<date>.json), decide MERGE (301 into an indexed same-airport
 * sibling with the same intent) or KEEP-IMPROVE, and write a reviewable map.
 *
 * READ-ONLY: GSC Search Analytics GETs + Payload GETs. Writes only to reports/.
 *
 *   npx tsx src/unindexed-merge-map.ts                       # uses cached pulls if present
 *   npx tsx src/unindexed-merge-map.ts --refresh             # re-pull CMS + GSC
 *   npx tsx src/unindexed-merge-map.ts --coverage reports/index-coverage-2026-09-28.json
 *
 * Output: reports/unindexed-merge-map-<date>.json + .md
 * Manual decisions after review live in reports/unindexed-merge-map-overrides.json (slug → {action, target?, reason}).
 * Pulls are cached in reports/.unindexed-merge-map-cache-<date>.json.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { env } from './config.js'
import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import { fetchAllBlogPagePerf } from './gsc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPORTS = path.resolve(__dirname, '..', 'reports')
const args = process.argv.slice(2)
const flag = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const COVERAGE = path.resolve(__dirname, '..', flag('--coverage', 'reports/index-coverage-2026-09-28.json'))
const DATE = (COVERAGE.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || new Date().toISOString().slice(0, 10)
const CACHE = path.join(REPORTS, `.unindexed-merge-map-cache-${DATE}.json`)
const REFRESH = args.includes('--refresh')
const MIN_TARGET_INTENT_IMPR = 1

// Construction articles (task 62) — CMS post IDs, keep regardless.
const CONSTRUCTION_IDS = new Set([3784, 3785, 3786, 3787, 3788])

// ── Data pulls (read-only) ────────────────────────────────────────────────────

interface Post { id: number; slug: string; title: string; articleType: string; airportCode: string; parentSlug: string; hubSlug: string; metaTitle: string }
interface Perf { impressions: number; clicks: number; position: number }
interface QP { query: string; slug: string; impressions: number; position: number }
interface Cache { posts: Post[]; perf: Record<string, Perf>; qp: QP[]; pulledAt: string }

async function getPosts(): Promise<Post[]> {
  const out: Post[] = []
  for (let page = 1; ; page++) {
    const p = new URLSearchParams({ 'where[status][equals]': 'published', limit: '200', page: String(page), depth: '0' })
    for (const f of ['slug', 'title', 'articleType', 'airportCode', 'parentSlug', 'hubSlug', 'seo']) p.set(`select[${f}]`, 'true')
    const res = await fetch(`${env.PAYLOAD_CMS_URL}/api/posts?${p}`, { headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` } })
    if (!res.ok) throw new Error(`CMS GET ${res.status}`)
    const j = await res.json() as { docs: Record<string, unknown>[]; hasNextPage: boolean }
    for (const d of j.docs) out.push({
      id: d.id as number, slug: d.slug as string, title: (d.title as string) || '', articleType: (d.articleType as string) || 'spoke',
      airportCode: (d.airportCode as string) || '', parentSlug: (d.parentSlug as string) || '', hubSlug: (d.hubSlug as string) || '',
      metaTitle: ((d.seo as { metaTitle?: string } | undefined)?.metaTitle) || '',
    })
    if (!j.hasNextPage) break
  }
  return out
}

// fetchQueryPagePairs() in gsc.ts stops at 25,000 rows; this pages through all of them (read-only).
async function allQueryPagePairs(days: number): Promise<QP[]> {
  const creds = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'gsc-oauth.json'), 'utf-8'))
  const c = creds.installed || creds.web
  const client = new OAuth2Client(c.client_id, c.client_secret, 'http://localhost:3456')
  client.setCredentials(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'gsc-token.json'), 'utf-8')))
  const sc = google.searchconsole({ version: 'v1', auth: client })
  const end = new Date(Date.now() - 3 * 86400e3); const start = new Date(end.getTime() - (days - 1) * 86400e3)
  const out: QP[] = []
  for (let startRow = 0; ; startRow += 25000) {
    const r = await sc.searchanalytics.query({ siteUrl: 'sc-domain:triplypro.com', requestBody: {
      startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), dimensions: ['query', 'page'], rowLimit: 25000, startRow,
      dimensionFilterGroups: [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'contains', expression: '/blog/' }] }] } })
    const rows = r.data.rows || []
    for (const x of rows) {
      const slug = (x.keys![1].split('/blog/')[1] || '').replace(/[/?#].*$/, '')
      out.push({ query: x.keys![0], slug, impressions: x.impressions || 0, position: x.position || 0 })
    }
    if (rows.length < 25000) break
  }
  return out
}

async function load(): Promise<Cache> {
  if (!REFRESH && fs.existsSync(CACHE)) return JSON.parse(fs.readFileSync(CACHE, 'utf-8'))
  const posts = await getPosts()
  const { pages } = await fetchAllBlogPagePerf(90)
  const perf: Record<string, Perf> = {}
  for (const [s, v] of pages) perf[s] = { impressions: v.impressions, clicks: v.clicks, position: v.position }
  const qp = await allQueryPagePairs(90)
  const c: Cache = { posts, perf, qp, pulledAt: new Date().toISOString() }
  fs.writeFileSync(CACHE, JSON.stringify(c))
  return c
}

// ── Intent normalisation ──────────────────────────────────────────────────────

// Words that name the airport/city — identity, not intent (same airport is enforced separately).
const AIRPORT_WORDS: Record<string, string[]> = {
  ATL: ['atl', 'atlanta', 'hartsfield', 'jackson', 'hartsfield-jackson', 'georgia', 'ga'],
  AUS: ['aus', 'austin', 'bergstrom', 'texas', 'tx'],
  BNA: ['bna', 'nashville', 'tennessee', 'tn'],
  BOS: ['bos', 'boston', 'logan', 'massachusetts', 'ma'],
  BWI: ['bwi', 'baltimore', 'thurgood', 'marshall', 'washington', 'maryland', 'md'],
  CLT: ['clt', 'charlotte', 'douglas', 'nc', 'north', 'carolina'],
  DCA: ['dca', 'reagan', 'ronald', 'national', 'washington', 'dc', 'd', 'c', 'arlington', 'virginia', 'va'],
  DEN: ['den', 'denver', 'colorado', 'co', 'dia'],
  DFW: ['dfw', 'dallas', 'fort', 'worth', 'ft', 'texas', 'tx'],
  DTW: ['dtw', 'detroit', 'metro', 'wayne', 'michigan', 'mi'],
  EWR: ['ewr', 'newark', 'liberty', 'new', 'jersey', 'nj'],
  FLL: ['fll', 'fort', 'ft', 'lauderdale', 'hollywood', 'florida', 'fl'],
  IAD: ['iad', 'dulles', 'washington', 'dc', 'virginia', 'va'],
  IAH: ['iah', 'houston', 'bush', 'george', 'intercontinental', 'texas', 'tx'],
  JFK: ['jfk', 'kennedy', 'john', 'f', 'new', 'york', 'ny', 'nyc', 'queens'],
  LAS: ['las', 'vegas', 'harry', 'reid', 'mccarran', 'nevada', 'nv'],
  LAX: ['lax', 'los', 'angeles', 'la', 'california', 'ca'],
  LGA: ['lga', 'laguardia', 'la', 'guardia', 'new', 'york', 'ny', 'nyc', 'queens'],
  MCO: ['mco', 'orlando', 'orange', 'florida', 'fl'],
  MIA: ['mia', 'miami', 'florida', 'fl'],
  MSP: ['msp', 'minneapolis', 'st', 'saint', 'paul', 'minnesota', 'mn'],
  ORD: ['ord', 'ohare', "o'hare", 'o', 'hare', 'chicago', 'illinois', 'il'],
  PDX: ['pdx', 'portland', 'oregon', 'or'],
  PHL: ['phl', 'philadelphia', 'philly', 'pennsylvania', 'pa'],
  PHX: ['phx', 'phoenix', 'sky', 'harbor', 'arizona', 'az'],
  SAN: ['san', 'diego', 'lindbergh', 'california', 'ca'],
  SEA: ['sea', 'seattle', 'tacoma', 'seatac', 'sea-tac', 'washington', 'wa'],
  SFO: ['sfo', 'san', 'francisco', 'fransico', 'sf', 'california', 'ca', 'bay', 'area'],
  SLC: ['slc', 'salt', 'lake', 'city', 'utah', 'ut'],
  TPA: ['tpa', 'tampa', 'florida', 'fl', 'bay'],
}
// Filler: carries no intent of its own.
const GENERIC = new Set(['airport', 'airports', 'parking', 'park', 'international', 'intl', 'the', 'a', 'an', 'at', 'in', 'on', 'for', 'by', 'to', 'of',
  'and', 'or', 'with', 'near', 'nearby', 'around', 'close', 'closest', 'me', 'my', 'your', 'you', 'is', 'are', 'what', 'where', 'how', 'do', 'does',
  'guide', 'complete', 'car', 'best', 'top', 'options', 'option', 'info', 'information', 'us', 'usa', 'reddit', 'tips', 'vs', 'from', 'lot', 'lots',
  '2024', '2025', '2026', '2027', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'])
// Synonyms → one canonical intent token.
const SYN: Record<string, string> = {
  cheapest: 'cheap', affordable: 'cheap', budget: 'cheap', inexpensive: 'cheap', discount: 'deal', discounts: 'deal', deals: 'deal', coupon: 'deal',
  coupons: 'deal', promo: 'deal', code: 'deal', codes: 'deal', voucher: 'deal', rates: 'price', rate: 'price', prices: 'price', pricing: 'price',
  cost: 'price', costs: 'price', fees: 'price', fee: 'price', much: 'price', daily: 'price', day: 'price', per: 'price', hourly: 'price', hour: 'price',
  garages: 'garage', 'long-term': 'longterm', 'short-term': 'shortterm', offsite: 'offsite', 'off-site': 'offsite', 'on-site': 'onsite', onsite: 'onsite',
  hotels: 'hotel', shuttles: 'shuttle', terminals: 'terminal', reservation: 'reserve', reservations: 'reserve', reserved: 'reserve', book: 'reserve',
  booking: 'reserve', prebook: 'reserve', 'pre-book': 'reserve', week: 'weekly', month: 'monthly', overnight: 'overnight', phone: 'contact', number: 'contact',
  'customer': 'contact', service: 'contact', help: 'contact', uncovered: 'outdoor', covered: 'covered', map: 'map', directions: 'directions', address: 'directions',
  availability: 'availability', available: 'availability', today: 'availability', open: 'availability', now: 'availability', status: 'availability', full: 'availability',
  free: 'free', cheap: 'cheap', promotional: 'deal', extended: 'longterm', prepay: 'reserve', prepaid: 'reserve', one: '1', two: '2', three: '3', four: '4',
}

function tokens(text: string, airport: string): Set<string> {
  const idw = new Set(AIRPORT_WORDS[airport] || [])
  const raw = text.toLowerCase().replace(/o['’]hare/g, 'ohare').replace(/long[\s-]+term/g, ' longterm ').replace(/short[\s-]+term/g, ' shortterm ')
    .replace(/off[\s-]+(site|airport)/g, ' offsite ').replace(/on[\s-]+(site|airport)/g, ' onsite ').replace(/cell[\s-]+phone/g, ' cellphone ')
    .replace(/park[\s-]+(and|n|&)?[\s-]*(sleep[\s-]+(and[\s-]+)?)?fly/g, ' parkfly ').replace(/(drop[\s-]+off|pick[\s-]+up)/g, ' pickup ')
    .replace(/sea[\s-]+tac/g, ' seatac ').replace(/extended[\s-]+stay/g, ' extendedstay ')
    .replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/)
  const out = new Set<string>()
  for (let w of raw) {
    if (!w) continue
    if (idw.has(w) || GENERIC.has(w)) continue
    w = SYN[w] || w
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
    if (GENERIC.has(w)) continue
    out.add(w)
  }
  return out
}
const slugTokens = (slug: string, airport: string) => tokens(slug.replace(/-/g, ' '), airport)
const subset = (a: Set<string>, b: Set<string>) => [...a].every(x => b.has(x))
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size && !b.size) return 1; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i) }

// ── Manual overrides after row-by-row review (slug → decision) ────────────────
// action 'KEEP-IMPROVE' with reason, or 'MERGE' with target.
const OVERRIDES: Record<string, { action: 'MERGE' | 'KEEP-IMPROVE'; target?: string; reason: string }> = JSON.parse(
  fs.existsSync(path.join(REPORTS, 'unindexed-merge-map-overrides.json')) ? fs.readFileSync(path.join(REPORTS, 'unindexed-merge-map-overrides.json'), 'utf-8') : '{}')

// ── Classify ─────────────────────────────────────────────────────────────────

interface Row { slug: string; airport: string; articleType: string; coverageState: string; action: string; target: string | null; targetImpressions: number | null;
  targetIntentImpressions: number | null; targetPosition: number | null; score: number | null; flags: string[]; reason: string }

async function main() {
  const cov = JSON.parse(fs.readFileSync(COVERAGE, 'utf-8')) as { results: { slug: string; airport: string; coverageState: string }[] }
  const unindexed = cov.results.filter(r => r.coverageState !== 'Submitted and indexed')
  const { posts, perf, qp } = await load()
  const bySlug = new Map(posts.map(p => [p.slug, p]))
  const unSet = new Set(unindexed.map(u => u.slug))
  const qpBySlug = new Map<string, QP[]>()
  for (const r of qp) { if (!qpBySlug.has(r.slug)) qpBySlug.set(r.slug, []); qpBySlug.get(r.slug)!.push(r) }

  const rows: Row[] = []
  const debug: Record<string, unknown>[] = []
  for (const u of unindexed) {
    const p = bySlug.get(u.slug)
    const airport = p?.airportCode || u.airport
    const at = p?.articleType || 'unknown'
    const flags: string[] = []
    const row: Row = { slug: u.slug, airport, articleType: at, coverageState: u.coverageState, action: '', target: null, targetImpressions: null,
      targetIntentImpressions: null, targetPosition: null, score: null, flags, reason: '' }
    rows.push(row)
    if (!p) { row.action = 'KEEP-IMPROVE'; row.reason = 'not found among published posts (unpublished since report?)'; flags.push('missing-post'); continue }

    if (/-parking-sold-out$/.test(u.slug)) { flags.push('rescue') }
    if (CONSTRUCTION_IDS.has(p.id) || /construction/.test(u.slug)) flags.push('construction')
    if (at === 'hub' || at === 'sub-pillar' || at === 'pillar' || at === 'subpillar') flags.push(at)
    const protectedRow = flags.some(f => f === 'rescue' || f === 'construction' || f === 'hub' || f === 'sub-pillar' || f === 'pillar' || f === 'subpillar')

    const ut = new Set([...slugTokens(u.slug, airport)])
    const titleT = tokens(p.title, airport)
    // candidate siblings: same airport, indexed (has impressions), not itself unindexed
    const cands = posts.filter(c => c.airportCode === airport && c.slug !== u.slug && !unSet.has(c.slug) && (perf[c.slug]?.impressions || 0) > 0)
    const scored = cands.map(c => {
      const ct = slugTokens(c.slug, airport)
      const ctt = tokens(c.title, airport)
      const qs = qpBySlug.get(c.slug) || []
      // impressions from c's queries that carry the unindexed page's intent (query tokens ⊇ u tokens, and nothing contradicting)
      let intentImpr = 0; let exactImpr = 0
      for (const q of qs) {
        const qt = tokens(q.query, airport)
        if (subset(ut, qt)) { intentImpr += q.impressions; if (jaccard(ut, qt) === 1) exactImpr += q.impressions }
      }
      const sim = Math.max(jaccard(ut, ct), jaccard(ut, ctt) * 0.9)
      return { c, ct, sim, intentImpr, exactImpr, impr: perf[c.slug].impressions, pos: perf[c.slug].position }
    })
    // eligible = same-intent slug (equal token sets) OR the sibling's slug covers all of u's intent tokens and adds ≤1
    // ...or the sibling is u minus one "soft" modifier (e.g. "garage-1-rates" → "garage-1")
    const SOFT = new Set(['price', 'direction', 'reserve', 'availability'])
    const softDrop = (s: { ct: Set<string> }) => s.ct.size > 0 && subset(s.ct, ut) && ut.size - s.ct.size === 1 && [...ut].every(x => s.ct.has(x) || SOFT.has(x))
    const eligible = scored.filter(s => (jaccard(ut, s.ct) === 1) || (ut.size > 0 && subset(ut, s.ct) && s.ct.size - ut.size <= 1) ||
      (ut.size === 0 && s.ct.size === 0) || softDrop(s))
    eligible.sort((a, b) => (b.exactImpr - a.exactImpr) || (b.intentImpr - a.intentImpr) || (b.sim - a.sim) || (b.impr - a.impr))
    const bestAll = eligible.find(s => s.intentImpr >= MIN_TARGET_INTENT_IMPR) || eligible[0]
    // prefer a sibling with exactly the same intent tokens unless a broader one clearly owns the query
    const bestEq = eligible.find(s => jaccard(ut, s.ct) === 1 && s.intentImpr > 0)
    let best: (typeof scored)[number] | undefined = bestEq && bestAll && bestEq.exactImpr >= 0.25 * bestAll.exactImpr ? bestEq : bestAll
    // generic head term → the airport hub when it is indexed and holds a fair share of the generic query
    let hubUnindexed = ''
    if (ut.size === 0) {
      const hub = scored.find(s => s.c.articleType === 'hub')
      const pool = scored.filter(s => s.ct.size === 0).sort((a, b) => (b.exactImpr - a.exactImpr) || (b.impr - a.impr))
      best = pool[0] && (!hub || pool[0].exactImpr >= 50) ? pool[0] : hub
      if (hub && best && best !== hub && hub.exactImpr >= 0.25 * best.exactImpr) best = hub
      if (!hub) hubUnindexed = posts.find(x => x.airportCode === airport && x.articleType === 'hub')?.slug || ''
      if (!hub && best && best.exactImpr < 50) best = undefined
    }
    // fallback: no slug-twin, but one sibling clearly owns the exact query (≥100 impr) and shares a modifier → query owner
    let queryOwner = false
    if (!best && ut.size > 0) {
      const qo = [...scored].sort((a, b) => b.exactImpr - a.exactImpr)[0]
      if (qo && qo.exactImpr >= 100 && [...ut].some(x => qo.ct.has(x) || tokens(qo.c.title, airport).has(x))) { best = qo; queryOwner = true }
    }
    // nearest overall (for reason text when keeping)
    const nearest = [...scored].sort((a, b) => (b.sim - a.sim) || (b.intentImpr - a.intentImpr))[0]
    debug.push({ slug: u.slug, ut: [...ut], titleT: [...titleT], best: best && { slug: best.c.slug, ct: [...best.ct], intentImpr: best.intentImpr }, nearest: nearest && { slug: nearest.c.slug, sim: +nearest.sim.toFixed(2) } })

    const ov = OVERRIDES[u.slug]
    if (protectedRow) {
      row.action = flags.includes('rescue') || flags.includes('construction') ? 'KEEP-PROTECTED' : 'FLAG-HUB-SUBPILLAR'
      row.reason = `${flags.join(', ')} — never merged`
      if (best) { row.target = best.c.slug; row.targetImpressions = best.impr; row.reason += `; closest indexed sibling ${best.c.slug}` }
      continue
    }
    if (ov) {
      row.action = ov.action; row.reason = ov.reason
      if (ov.target) { const t = perf[ov.target]; row.target = ov.target; row.targetImpressions = t?.impressions ?? 0; row.targetPosition = t ? +t.position.toFixed(1) : null
        const s = scored.find(x => x.c.slug === ov.target); row.targetIntentImpressions = s?.intentImpr ?? null }
      flags.push('manual')
      continue
    }
    if (best) {
      row.action = 'MERGE'; row.target = best.c.slug; row.targetImpressions = best.impr; row.targetIntentImpressions = best.intentImpr
      row.targetPosition = +best.pos.toFixed(1); row.score = +best.sim.toFixed(2)
      row.reason = ut.size ? `same intent [${[...ut].join(' ')}]; target ranks for it (${best.intentImpr} intent impr)` : `generic head term; target is the airport's strongest generic page (${best.intentImpr} generic impr)`
      if (queryOwner) { flags.push('query-owner'); row.reason = `no slug-twin; ${best.c.slug} holds the exact query [${[...ut].join(' ') || 'generic'}] (${best.exactImpr} impr)` }
      if (best.intentImpr === 0) flags.push('no-query-evidence')
      if (best.impr < 50) flags.push('weak-target')
    } else {
      row.action = 'KEEP-IMPROVE'
      row.reason = hubUnindexed
        ? `generic head term; the airport hub ${hubUnindexed} is itself unindexed — 301 here into the hub once the hub is fixed`
        : `no indexed sibling covers [${[...ut].join(' ')}]` + (nearest ? `; nearest ${nearest.c.slug} (sim ${nearest.sim.toFixed(2)})` : '')
      if (hubUnindexed) flags.push('hub-unindexed')
      if (nearest) { row.target = null }
    }
  }

  fs.writeFileSync(path.join(REPORTS, `.unindexed-merge-map-debug-${DATE}.json`), JSON.stringify(debug, null, 1))
  const outRows = rows.map(r => ({ slug: r.slug, airport: r.airport, articleType: r.articleType, coverageState: r.coverageState, action: r.action, target: r.target,
    targetImpressions: r.targetImpressions, targetIntentImpressions: r.targetIntentImpressions, targetPosition: r.targetPosition, flags: r.flags, reason: r.reason }))
  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.action] = (counts[r.action] || 0) + 1
  fs.writeFileSync(path.join(REPORTS, `unindexed-merge-map-${DATE}.json`), JSON.stringify({ date: DATE, source: path.basename(COVERAGE), total: rows.length, counts, rows: outRows }, null, 1))

  // ── Markdown ──
  const airports = [...new Set(rows.map(r => r.airport))].sort()
  const actions = ['MERGE', 'KEEP-IMPROVE', 'KEEP-PROTECTED', 'FLAG-HUB-SUBPILLAR']
  const byAp = airports.map(a => ({ a, n: rows.filter(r => r.airport === a).length, c: actions.map(x => rows.filter(r => r.airport === a && r.action === x).length) })).sort((x, y) => y.n - x.n)
  const merges = rows.filter(r => r.action === 'MERGE')
  const targets = new Map<string, number>()
  for (const m of merges) targets.set(m.target!, (targets.get(m.target!) || 0) + 1)
  const L: string[] = []
  L.push(`# Unindexed posts — merge map (${DATE})`, '', `Source: \`${path.basename(COVERAGE)}\` — ${rows.length} published posts with zero impressions in 90d AND not indexed. Impressions = GSC 90d. Read-only analysis; nothing applied.`, '')
  L.push('## Counts by action', '', '| Action | Posts |', '|---|---:|', ...actions.map(a => `| ${a} | ${counts[a] || 0} |`), '')
  L.push('## By airport', '', `| Airport | Total | ${actions.join(' | ')} |`, `|---|---:|${actions.map(() => '---:').join('|')}|`, ...byAp.map(x => `| ${x.a} | ${x.n} | ${x.c.join(' | ')} |`), '')
  const prot = rows.filter(r => r.action === 'KEEP-PROTECTED' || r.action === 'FLAG-HUB-SUBPILLAR')
  L.push('## Protected / flagged (never merged)', '', prot.length ? '| Slug | Airport | Type | Flags | Closest indexed sibling |\n|---|---|---|---|---|\n' + prot.map(r => `| ${r.slug} | ${r.airport} | ${r.articleType} | ${r.flags.join(', ')} | ${r.target || '—'} |`).join('\n') : 'None.', '')
  L.push('## Top 20 merges by target impressions', '', '| Source | Target | Target impr (90d) | Intent impr | Target pos |', '|---|---|---:|---:|---:|')
  for (const m of [...merges].sort((a, b) => (b.targetImpressions! - a.targetImpressions!)).slice(0, 20)) L.push(`| ${m.slug} | ${m.target} | ${m.targetImpressions} | ${m.targetIntentImpressions ?? '—'} | ${m.targetPosition ?? '—'} |`)
  L.push('', `Distinct merge targets: ${targets.size}. Busiest: ${[...targets].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t} (${n})`).join(', ')}.`, '')
  L.push('## KEEP-IMPROVE', '', '| Slug | Airport | Type | Reason |', '|---|---|---|---|', ...rows.filter(r => r.action === 'KEEP-IMPROVE').map(r => `| ${r.slug} | ${r.airport} | ${r.articleType} | ${r.reason} |`), '')
  L.push('## redirects() array (MERGE rows only)', '', '```js', 'const unindexedMergeRedirects = [')
  for (const m of [...merges].sort((a, b) => a.airport.localeCompare(b.airport) || a.slug.localeCompare(b.slug))) L.push(`  { source: '/blog/${m.slug}', destination: '/blog/${m.target}', permanent: true },`)
  L.push(']', '```', '')
  fs.writeFileSync(path.join(REPORTS, `unindexed-merge-map-${DATE}.md`), L.join('\n'))
  console.log(counts)
}

main().catch(e => { console.error(e); process.exit(1) })
