import fs from 'fs'
import path from 'path'

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

interface Row { no: number; keyword: string; sv: number; cpc: number; seoDiff: number }

const content = fs.readFileSync(CSV_PATH, 'utf-8').replace(/^\uFEFF/, '')
const lines = content.split(/\r?\n/).filter(l => l.trim())
const rows: Row[] = []
for (const line of lines.slice(1)) {
  const f = parseCSVLine(line)
  rows.push({
    no: parseInt(f[0]) || 0,
    keyword: f[1].toLowerCase(),
    sv: parseInt(f[3].replace(/,/g, '')) || 0,
    cpc: parseFloat(f[4].replace(/[^\d.]/g, '')) || 0,
    seoDiff: parseInt(f[6]) || 0,
  })
}

console.log(`Parsed ${rows.length} keywords from Ubersuggest CSV`)

// HUB already seeded: "philadelphia airport parking"
const HUB_KW = 'philadelphia airport parking'
const HUB_SLUG = 'philadelphia-airport-parking'

// Define sub-pillar patterns (order matters — first match wins)
// Each pattern: { subPillarKeyword, slug, matcher }
const subPillars: { keyword: string; slug: string; match: (kw: string) => boolean; minSubPillarSv: number }[] = [
  {
    keyword: 'philadelphia airport long term parking',
    slug: 'philadelphia-airport-long-term-parking',
    match: (k) => /\blong[\s-]?term\b|\bextended\b|\bweekly\b|\bmonthly\b|\b5[\s-]?day\b|\b7[\s-]?day\b|\b10[\s-]?day\b/.test(k),
    minSubPillarSv: 9900,
  },
  {
    keyword: 'philadelphia airport parking rates',
    slug: 'philadelphia-airport-parking-rates',
    match: (k) => /\bcost\b|\bprice\b|\brate\b|\bfee\b|\bcheap\b|\bdeal\b|\bcoupon\b|\bgroupon\b|\bdiscount\b|\bpromo\b/.test(k),
    minSubPillarSv: 2400,
  },
  {
    keyword: 'philadelphia airport parking garage',
    slug: 'philadelphia-airport-parking-garage',
    match: (k) => /\bgarage\b|\bstructure\b|\blot\s*[a-f]\b|\beconomy\b/.test(k),
    minSubPillarSv: 1000,
  },
  {
    keyword: 'philadelphia airport hotel parking',
    slug: 'philadelphia-airport-hotel-parking',
    match: (k) => /\bhotel\b|\bpark[\s-]?(and|n)[\s-]?fly\b|\bmotel\b|\binn\b|\bhilton\b|\bmarriott\b|\bhampton\b|\bholiday\b|\bsheraton\b/.test(k),
    minSubPillarSv: 880,
  },
  {
    keyword: 'philadelphia airport valet parking',
    slug: 'philadelphia-airport-valet-parking',
    match: (k) => /\bvalet\b/.test(k),
    minSubPillarSv: 720,
  },
  {
    keyword: 'philadelphia airport off site parking',
    slug: 'philadelphia-airport-off-site-parking',
    match: (k) => /\boff[\s-]?site\b|\boff[\s-]?airport\b|\bnear(by)?\b|\bshuttle\b|\bwallypark\b|\bsmartpark\b|\bthe\s+parking\s+spot\b|\bpark.?n.?go\b|\bpark.?ride\b/.test(k),
    minSubPillarSv: 590,
  },
  {
    keyword: 'philadelphia airport short term parking',
    slug: 'philadelphia-airport-short-term-parking',
    match: (k) => /\bshort[\s-]?term\b|\bdaily\b|\bhourly\b|\bovernight\b|\b1[\s-]?day\b|\b2[\s-]?day\b/.test(k),
    minSubPillarSv: 390,
  },
]

// Classify
const unmatched: Row[] = []
const byPillar: Record<string, Row[]> = {}
for (const sp of subPillars) byPillar[sp.slug] = []

let hubRow: Row | null = null
for (const r of rows) {
  if (r.keyword === HUB_KW) { hubRow = r; continue }

  let matched = false
  for (const sp of subPillars) {
    if (sp.match(r.keyword)) {
      byPillar[sp.slug].push(r)
      matched = true
      break
    }
  }
  if (!matched) unmatched.push(r)
}

// Report
console.log(`\n=== Proposed cluster structure ===\n`)
console.log(`HUB: "${HUB_KW}" (SV: ${hubRow?.sv || 'N/A'}) — already seeded as id 1969\n`)
console.log(`SUB-PILLARS (${subPillars.length}):\n`)

for (const sp of subPillars) {
  const spokes = byPillar[sp.slug].sort((a, b) => b.sv - a.sv)
  const totalSv = spokes.reduce((s, r) => s + r.sv, 0)
  console.log(`  • ${sp.keyword}`)
  console.log(`    └─ ${spokes.length} spokes | ${totalSv.toLocaleString()} combined SV`)
  console.log(`    └─ Top 3: ${spokes.slice(0, 3).map(r => `"${r.keyword}" (${r.sv})`).join(', ')}`)
}

console.log(`\nUNMATCHED (will become top-level spokes under HUB): ${unmatched.length}`)
if (unmatched.length > 0) {
  const top = unmatched.sort((a, b) => b.sv - a.sv).slice(0, 10)
  console.log(`  Top 10 unmatched:`)
  for (const r of top) console.log(`    ${String(r.sv).padStart(6)} "${r.keyword}"`)
}

const totalSpokes = rows.length - 1 // minus hub
const totalInPillars = Object.values(byPillar).reduce((s, a) => s + a.length, 0)
console.log(`\n=== Totals ===`)
console.log(`  Hub:          1`)
console.log(`  Sub-pillars:  ${subPillars.length}`)
console.log(`  Spokes:       ${totalSpokes}  (${totalInPillars} matched to sub-pillars, ${unmatched.length} would attach to hub)`)
console.log(`  GRAND TOTAL:  ${1 + subPillars.length + totalSpokes}`)

const totalSv = rows.reduce((s, r) => s + r.sv, 0)
console.log(`  Combined SV:  ${totalSv.toLocaleString()}/mo`)
