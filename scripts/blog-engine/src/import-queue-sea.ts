import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

const CSV_PATH = 'C:\\Users\\vince\\Downloads\\suggestions_ubersuggest_sea_airport_parking_seattle_airport_parking.csv'

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

const HUB_KW = 'seattle airport parking'
const HUB_SLUG = 'seattle-airport-parking'

// SEA hub-synonym filter: searches that mean the same thing as the hub.
// These would cannibalize rankings if generated as separate articles.
const HUB_SYNONYMS = new Set([
  'seattle airport parking',
  'sea airport parking',
  'sea parking',
  'seatac parking',
  'seatac airport parking',
  'sea tac airport parking',
  'sea tac parking',
  'seattle sea tac airport parking',
  'parking by seattle airport',
  'parking at seattle airport',
  'parking at sea airport',
  'parking at seatac airport',
  'parking at sea tac airport',
  'seattle washington airport parking',
  'airport parking in seattle',
  'airport parking in seattle wa',
  'car parking near seattle airport',
  'seattle wa airport parking',
])

const subPillars = [
  {
    keyword: 'seattle airport long term parking',
    match: (k: string) => /\blong[\s-]?term\b|\bextended\b|\bweekly\b|\bmonthly\b|\b[5-9][\s-]?day\b|\b1[0-4][\s-]?day\b/.test(k),
  },
  {
    keyword: 'seattle airport parking rates',
    match: (k: string) => /\bcost\b|\bprice\b|\brate\b|\bfee\b|\bcheap\b|\bdeal\b|\bcoupon\b|\bgroupon\b|\bdiscount\b|\bpromo\b|\baffordab|\bbest\s+price|\bcheapest\b/.test(k),
  },
  {
    keyword: 'seattle airport parking by terminal',
    match: (k: string) => /\bterminal\s*[a-z]?\b|\bterminal\s+[1-5]\b|\bconcourse\b|\bgate\b|\barrivals?\b|\bdepartures?\b/.test(k),
  },
  {
    keyword: 'seattle airport parking garage',
    match: (k: string) => /\bgarage\b|\bstructure\b|\beconomy\b|\bgeneral\b|\blevel\s*[0-9]\b/.test(k),
  },
  {
    keyword: 'seattle airport hotel parking',
    match: (k: string) => /\bhotel\b|\bpark[\s-]?(and|n)[\s-]?fly\b|\bmotel\b|\binn\b|\bhilton\b|\bmarriott\b|\bhampton\b|\bholiday\b|\bsheraton\b|\bcourtyard\b|\bembassy\b|\bdoubletree\b|\bquality\s+inn\b|\bcomfort\b|\bradisson\b/.test(k),
  },
  {
    keyword: 'seattle airport valet parking',
    match: (k: string) => /\bvalet\b/.test(k),
  },
  {
    keyword: 'seattle airport off site parking',
    match: (k: string) => /\boff[\s-]?site\b|\boff[\s-]?airport\b|\bnear(by)?\b|\bshuttle\b|\bwallypark\b|\bmasterpark\b|\bdoug\s+fox\b|\bajax\b|\buvp\b|\bextra\s+car\b|\bthe\s+parking\s+spot\b|\bpark.?n.?go\b|\bpark.?ride\b/.test(k),
  },
  {
    keyword: 'seattle airport short term parking',
    match: (k: string) => /\bshort[\s-]?term\b|\bdaily\b|\bhourly\b|\bovernight\b|\b1[\s-]?day\b|\b2[\s-]?day\b|\b3[\s-]?day\b|\b4[\s-]?day\b/.test(k),
  },
  {
    keyword: 'seattle airport parking information',
    match: (k: string) => /\bmap\b|\binfo\b|\bservice\b|\bguide\b|\bhours\b|\bphone\b|\bnumber\b|\bhandicap\b|\baccessib|\bada\b|\bev\b|\bcharg|\belectric\b|\bwhere\b|\bhow\s+to\b|\bphoto\b|\bzip\b|\baddress\b|\buber\b|\blyft\b|\bemployee\b/.test(k),
  },
]

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
    if (sp.match(r.keyword)) { byPillar[keywordToSlug(sp.keyword)].push(r); matched = true; break }
  }
  if (!matched) unmatched.push(r)
}

console.log(`\n=== SEA cluster summary ===`)
console.log(`Total keywords:        ${rows.length}`)
console.log(`Hub-synonyms dropped:  ${droppedSynonyms.length}  (combined SV: ${droppedSynonyms.reduce((s, r) => s + r.sv, 0).toLocaleString()})`)
console.log(`Hub:                   1`)
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
if (DRY_RUN) { console.log('\n(dry-run — no CMS writes)'); process.exit(0) }
if (!process.argv.includes('--confirm')) { console.log('\nAdd --confirm to seed to CMS.'); process.exit(0) }

console.log('\n=== Seeding to CMS ===\n')
async function createItem(item: Record<string, unknown>): Promise<number | null> {
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

console.log('Sub-pillars:')
for (const sp of subPillars) {
  const slug = keywordToSlug(sp.keyword)
  const spokes = byPillar[slug]
  if (spokes.length === 0) continue
  const best = spokes.sort((a, b) => b.sv - a.sv)[0]
  const id = await createItem({
    keyword: sp.keyword, airportCode: 'SEA', slug, articleType: 'sub-pillar',
    priority: 'S1', status: 'queued', parentSlug: HUB_SLUG, hubSlug: HUB_SLUG,
    searchVolume: best.sv, seoDifficulty: best.seoDiff, targetWords: 3000,
    notes: `Sub-pillar for ${spokes.length} spoke(s) covering ${sp.keyword} variants.`,
  })
  if (id === -1) { skipped++; console.log(`  ⊘ ${slug} exists`) }
  else if (id === null) errors++
  else { created++; console.log(`  ✓ ${slug} → id ${id}`) }
}

console.log('\nSpokes under sub-pillars:')
for (const sp of subPillars) {
  const parentSlug = keywordToSlug(sp.keyword)
  const spokes = byPillar[parentSlug].filter(r => r.keyword !== sp.keyword)
  for (const r of spokes) {
    const id = await createItem({
      keyword: r.keyword, airportCode: 'SEA', slug: keywordToSlug(r.keyword),
      articleType: 'spoke', priority: r.sv >= 100 ? 'S2' : 'S3', status: 'queued',
      parentSlug, hubSlug: HUB_SLUG, searchVolume: r.sv, seoDifficulty: r.seoDiff, targetWords: 1500,
      notes: `Long-tail spoke under ${sp.keyword}.`,
    })
    if (id === -1) skipped++; else if (id === null) errors++; else created++
  }
  console.log(`  ${parentSlug}: +${spokes.length} spokes`)
}

console.log('\nUnmatched spokes (attached to hub):')
for (const r of unmatched) {
  const id = await createItem({
    keyword: r.keyword, airportCode: 'SEA', slug: keywordToSlug(r.keyword),
    articleType: 'spoke', priority: r.sv >= 100 ? 'S2' : 'S3', status: 'queued',
    parentSlug: HUB_SLUG, hubSlug: HUB_SLUG,
    searchVolume: r.sv, seoDifficulty: r.seoDiff, targetWords: 1500,
    notes: 'Long-tail spoke attached directly to hub (no sub-pillar match).',
  })
  if (id === -1) skipped++; else if (id === null) errors++; else created++
}
console.log(`  +${unmatched.length} unmatched spokes`)

console.log(`\n=== Done ===`)
console.log(`Created: ${created} | Skipped (exists): ${skipped} | Errors: ${errors}`)
