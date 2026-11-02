import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

const CSV_PATH = 'C:\\Users\\vince\\Downloads\\suggestions_ubersuggest_phl_airport_parking_philadelphia_airport_parking.csv'

function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { if (q && line[i+1] === '"') { cur += '"'; i++ } else q = !q }
    else if (c === ',' && !q) { fields.push(cur.trim()); cur = '' }
    else cur += c
  }
  fields.push(cur.trim())
  return fields
}

function keywordToSlug(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

interface Row { keyword: string; sv: number; cpc: number; seoDiff: number }

const content = fs.readFileSync(CSV_PATH, 'utf-8').replace(/^\uFEFF/, '')
const lines = content.split(/\r?\n/).filter(l => l.trim())
const rows: Row[] = []
for (const line of lines.slice(1)) {
  const f = parseCSVLine(line)
  rows.push({
    keyword: f[1].toLowerCase().replace(/\s+/g, ' ').trim(),
    sv: parseInt(f[3].replace(/,/g, '')) || 0,
    cpc: parseFloat(f[4].replace(/[^\d.]/g, '')) || 0,
    seoDiff: parseInt(f[6]) || 0,
  })
}

const HUB_KW = 'philadelphia airport parking'
const HUB_SLUG = 'philadelphia-airport-parking'

// Hub-synonym filter: these keywords are near-duplicates of the hub and would cannibalize rankings.
// They should be handled as alt-keywords / canonical redirects on the hub post, not separate articles.
const HUB_SYNONYMS = new Set([
  'philadelphia airport parking',
  'airport parking in philadelphia',
  'phl airport parking',
  'philadelphia intl airport parking',
  'parking at philadelphia airport',
  'parking philadelphia airport',
  'parking at phl airport',
  'phl parking',
  'phl airport parking lot',
  'parking at the philadelphia airport',
])

// Sub-pillar definitions (order matters — first match wins)
const subPillars = [
  {
    keyword: 'philadelphia airport long term parking',
    match: (k: string) => /\blong[\s-]?term\b|\bextended\b|\bweekly\b|\bmonthly\b|\b[5-9][\s-]?day\b|\b1[0-4][\s-]?day\b/.test(k),
  },
  {
    keyword: 'philadelphia airport parking rates',
    match: (k: string) => /\bcost\b|\bprice\b|\brate\b|\bfee\b|\bcheap\b|\bdeal\b|\bcoupon\b|\bgroupon\b|\bdiscount\b|\bpromo\b|\baffordab|\bbest\s+price/.test(k),
  },
  {
    keyword: 'philadelphia airport parking by terminal',
    match: (k: string) => /\bterminal\s*[a-f]\b|\bterminal\s+1\b|\bterminal\s+2\b|\bterminal\s+3\b|\bterminal\s+4\b|\bterminal\s+5\b|\bconcourse\b/.test(k),
  },
  {
    keyword: 'philadelphia airport parking garage',
    match: (k: string) => /\bgarage\b|\bstructure\b|\beconomy\b|\blot\s*[a-f]\b/.test(k),
  },
  {
    keyword: 'philadelphia airport hotel parking',
    match: (k: string) => /\bhotel\b|\bpark[\s-]?(and|n)[\s-]?fly\b|\bmotel\b|\binn\b|\bhilton\b|\bmarriott\b|\bhampton\b|\bholiday\b|\bsheraton\b|\bcourtyard\b|\bembassy\b/.test(k),
  },
  {
    keyword: 'philadelphia airport valet parking',
    match: (k: string) => /\bvalet\b/.test(k),
  },
  {
    keyword: 'philadelphia airport off site parking',
    match: (k: string) => /\boff[\s-]?site\b|\boff[\s-]?airport\b|\bnear(by)?\b|\bshuttle\b|\bwallypark\b|\bsmartpark\b|\bthe\s+parking\s+spot\b|\bpark.?n.?go\b|\bpark.?ride\b|\bcolonial\b|\bfairfield\b/.test(k),
  },
  {
    keyword: 'philadelphia airport short term parking',
    match: (k: string) => /\bshort[\s-]?term\b|\bdaily\b|\bhourly\b|\bovernight\b|\b1[\s-]?day\b|\b2[\s-]?day\b|\b3[\s-]?day\b|\b4[\s-]?day\b/.test(k),
  },
  {
    keyword: 'philadelphia airport parking information',
    match: (k: string) => /\bmap\b|\binfo\b|\bservice\b|\bguide\b|\bhours\b|\bphone\b|\bnumber\b|\bhandicap\b|\baccessib|\bada\b|\bev\b|\bcharg|\belectric\b|\bwhere\b|\bhow\s+to\b/.test(k),
  },
]

// Classify each row
const byPillar: Record<string, Row[]> = {}
for (const sp of subPillars) byPillar[keywordToSlug(sp.keyword)] = []
const unmatched: Row[] = []
const droppedSynonyms: Row[] = []
let hubRow: Row | null = null

for (const r of rows) {
  if (HUB_SYNONYMS.has(r.keyword)) {
    if (r.keyword === HUB_KW) hubRow = r
    else droppedSynonyms.push(r)
    continue
  }
  let matched = false
  for (const sp of subPillars) {
    if (sp.match(r.keyword)) {
      byPillar[keywordToSlug(sp.keyword)].push(r)
      matched = true
      break
    }
  }
  if (!matched) unmatched.push(r)
}

// Print summary
console.log(`\n=== Cluster summary ===`)
console.log(`Total keywords:        ${rows.length}`)
console.log(`Hub-synonyms dropped:  ${droppedSynonyms.length}`)
console.log(`Hub:                   1 (already seeded as id 1969)`)
console.log(`Sub-pillars:           ${subPillars.length}`)
let totalSpokesMatched = 0
for (const sp of subPillars) {
  const spokes = byPillar[keywordToSlug(sp.keyword)]
  totalSpokesMatched += spokes.length
  const sv = spokes.reduce((s, r) => s + r.sv, 0)
  console.log(`  • ${sp.keyword.padEnd(48)} ${String(spokes.length).padStart(4)} spokes | ${sv.toLocaleString()} SV`)
}
console.log(`Unmatched → attached to HUB: ${unmatched.length}`)
console.log(`GRAND TOTAL to seed: ${1 + subPillars.length + totalSpokesMatched + unmatched.length}`)

const DRY_RUN = process.argv.includes('--dry-run')
if (DRY_RUN) {
  console.log('\n(dry-run — no CMS writes)')
  process.exit(0)
}

// Ask for confirmation via env flag
if (!process.argv.includes('--confirm')) {
  console.log('\nAdd --confirm to actually seed to CMS.')
  process.exit(0)
}

console.log('\n=== Seeding to CMS ===\n')

// Helper
async function createQueueItem(item: Record<string, unknown>): Promise<number | null> {
  try {
    const r = await fetch(`${CMS}/api/content-queue`, { method: 'POST', headers: h, body: JSON.stringify(item) })
    if (!r.ok) {
      const body = await r.text()
      if (body.includes('duplicate') || body.includes('unique')) return -1
      console.error(`  ✗ "${item.slug}" FAILED: ${r.status} ${body.slice(0, 100)}`)
      return null
    }
    const d = await r.json()
    return d.doc?.id as number
  } catch (e) {
    console.error(`  ✗ "${item.slug}" error: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

let created = 0, skipped = 0, errors = 0

// 1. Seed sub-pillars
console.log('Sub-pillars:')
for (const sp of subPillars) {
  const slug = keywordToSlug(sp.keyword)
  const spokes = byPillar[slug]
  if (spokes.length === 0) continue // skip empty sub-pillars
  const bestSpoke = spokes.sort((a, b) => b.sv - a.sv)[0]
  const item = {
    keyword: sp.keyword,
    airportCode: 'PHL',
    slug,
    articleType: 'sub-pillar',
    priority: 'S1',
    status: 'queued',
    parentSlug: HUB_SLUG,
    hubSlug: HUB_SLUG,
    searchVolume: bestSpoke.sv, // use highest SV in cluster as sub-pillar's SV proxy
    seoDifficulty: bestSpoke.seoDiff,
    targetWords: 3000,
    notes: `Sub-pillar for ${spokes.length} spoke(s) covering ${sp.keyword} variants.`,
  }
  const id = await createQueueItem(item)
  if (id === -1) { skipped++; console.log(`  ⊘ ${slug} exists`) }
  else if (id === null) { errors++ }
  else { created++; console.log(`  ✓ ${slug} → id ${id}`) }
}

// 2. Seed spokes under each sub-pillar
console.log('\nSpokes under sub-pillars:')
for (const sp of subPillars) {
  const parentSlug = keywordToSlug(sp.keyword)
  const spokes = byPillar[parentSlug]
  if (spokes.length === 0) continue
  // Skip the one that became the sub-pillar's keyword itself (if it exactly matches)
  const spokesToSeed = spokes.filter(r => r.keyword !== sp.keyword)
  for (const r of spokesToSeed) {
    const item = {
      keyword: r.keyword,
      airportCode: 'PHL',
      slug: keywordToSlug(r.keyword),
      articleType: 'spoke',
      priority: r.sv >= 100 ? 'S2' : 'S3',
      status: 'queued',
      parentSlug,
      hubSlug: HUB_SLUG,
      searchVolume: r.sv,
      seoDifficulty: r.seoDiff,
      targetWords: 1500,
      notes: `Long-tail spoke under ${sp.keyword}.`,
    }
    const id = await createQueueItem(item)
    if (id === -1) skipped++
    else if (id === null) errors++
    else created++
  }
  console.log(`  ${parentSlug}: +${spokesToSeed.length} spokes`)
}

// 3. Seed unmatched as spokes under hub
console.log('\nUnmatched spokes (attached to hub):')
for (const r of unmatched) {
  const item = {
    keyword: r.keyword,
    airportCode: 'PHL',
    slug: keywordToSlug(r.keyword),
    articleType: 'spoke',
    priority: r.sv >= 100 ? 'S2' : 'S3',
    status: 'queued',
    parentSlug: HUB_SLUG,
    hubSlug: HUB_SLUG,
    searchVolume: r.sv,
    seoDifficulty: r.seoDiff,
    targetWords: 1500,
    notes: `Long-tail spoke attached directly to hub (no sub-pillar match).`,
  }
  const id = await createQueueItem(item)
  if (id === -1) skipped++
  else if (id === null) errors++
  else created++
}
console.log(`  +${unmatched.length} unmatched spokes`)

console.log(`\n=== Done ===`)
console.log(`Created: ${created} | Skipped (exists): ${skipped} | Errors: ${errors}`)
