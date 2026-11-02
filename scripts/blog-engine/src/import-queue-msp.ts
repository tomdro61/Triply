import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const XLSX = require('xlsx') as typeof import('xlsx')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const CMS_URL = process.env.PAYLOAD_CMS_URL!
const API_KEY = process.env.PAYLOAD_API_KEY!

const headers = {
  'Content-Type': 'application/json',
  Authorization: `users API-Key ${API_KEY}`,
}

const HUB_SLUG = 'msp-airport-parking'
const AIRPORT = 'MSP'

function keywordToSlug(keyword: string): string {
  return keyword
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function mapPriority(p: string): 'S1' | 'S2' | 'S3' {
  const norm = String(p || '').trim().toLowerCase()
  if (norm === 'high') return 'S1'
  if (norm === 'medium') return 'S2'
  return 'S3'
}

function mapArticleType(tier: string): 'hub' | 'sub-pillar' | 'spoke' {
  const t = String(tier || '').toUpperCase()
  if (t === 'HUB') return 'hub'
  if (t === 'SUB-PILLAR') return 'sub-pillar'
  return 'spoke'
}

// Handles "4,000-5,000", "4,000–5,000" (em-dash), "1,000", etc.
function parseTargetWords(tw: string): number {
  if (!tw) return 1500
  const cleaned = String(tw).replace(/,/g, '')
  const match = cleaned.match(/(\d+)(?:\s*[-–—]\s*(\d+))?/)
  if (!match) return 1500
  if (match[2]) return Math.round((parseInt(match[1]) + parseInt(match[2])) / 2)
  return parseInt(match[1])
}

interface OutlineItem {
  order: number
  anchorId: string
  heading: string
  summary: string
  linksTo: string
}

// NOTE: This spreadsheet (MSP, newer template) stores outlines as proper
// columns — "H2 Heading" + "Key Points" — not the flat "H1:"/"H2:" text
// markers the older ORD/LGA sheets used. So we read by column name and
// fold "Key Points" into the outline item's `summary` (older imports left
// summary blank).

// Parse the Hub Outline sheet: one row per H2 section.
function parseHubOutline(sheet: XLSX.WorkSheet): OutlineItem[] {
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' })
  const items: OutlineItem[] = []
  let order = 1
  for (const r of rows) {
    const heading = String(r['H2 Heading'] || '').trim()
    if (!heading) continue
    items.push({
      order: order++,
      anchorId: '',
      heading,
      summary: String(r['Key Points'] || '').trim(),
      linksTo: '',
    })
  }
  return items
}

// Parse the Sub-Pillar Outlines sheet: group H2 rows under each descriptive
// "Sub-Pillar" title. Returned map is keyed by that title (e.g. "MSP Airport
// Parking Rates & Pricing"), NOT by the dashboard keyword — main() bridges the
// two by ordered position.
function parseSubPillarOutlines(sheet: XLSX.WorkSheet): Map<string, OutlineItem[]> {
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' })
  const map = new Map<string, OutlineItem[]>()
  const orderByTitle = new Map<string, number>()
  for (const r of rows) {
    const title = String(r['Sub-Pillar'] || '').trim()
    const heading = String(r['H2 Heading'] || '').trim()
    if (!title || !heading) continue
    if (!map.has(title)) {
      map.set(title, [])
      orderByTitle.set(title, 1)
    }
    const order = orderByTitle.get(title)!
    map.get(title)!.push({
      order,
      anchorId: '',
      heading,
      summary: String(r['Key Points'] || '').trim(),
      linksTo: '',
    })
    orderByTitle.set(title, order + 1)
  }
  return map
}

async function createQueueItem(data: Record<string, unknown>) {
  const res = await fetch(`${CMS_URL}/api/content-queue`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Failed to create queue item: ${res.status} ${body}`)
  }
  return res.json()
}

async function main() {
  const xlsxPath = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'triply-pro-blog-plan-minneapolis-saint-paul.xlsx')
  const wb = XLSX.readFile(xlsxPath)

  const dashboard = XLSX.utils.sheet_to_json<Record<string, string | number>>(
    wb.Sheets['Content Dashboard'],
    { defval: '' }
  )
  const hubOutlineItems = parseHubOutline(wb.Sheets['Hub Outline'])
  const subPillarOutlineMap = parseSubPillarOutlines(wb.Sheets['Sub-Pillar Outlines'])

  console.log(`Loaded ${dashboard.length} dashboard rows`)
  console.log(`Loaded ${hubOutlineItems.length} hub H2 items`)
  console.log(`Loaded ${subPillarOutlineMap.size} sub-pillar outline groups`)

  // Ordered list of sub-pillar descriptive titles, in sheet order.
  const subPillarTitlesInOrder = [...subPillarOutlineMap.keys()]

  // Build keyword → slug map for the hub and all sub-pillars, and (by ordered
  // position) keyword → outline-title so we can attach the right outline.
  const keywordToSlugMap = new Map<string, string>()
  const keywordToOutlineTitle = new Map<string, string>()
  let subPillarIdx = 0
  for (const row of dashboard) {
    const tier = mapArticleType(String(row['Tier']))
    const keyword = String(row['Keyword'] || '').trim()
    if (!keyword) continue
    if (tier === 'hub') {
      keywordToSlugMap.set(keyword, HUB_SLUG)
    } else if (tier === 'sub-pillar') {
      keywordToSlugMap.set(keyword, keywordToSlug(keyword))
      const title = subPillarTitlesInOrder[subPillarIdx++]
      if (title) keywordToOutlineTitle.set(keyword, title)
    }
  }

  // Build the set of reserved slugs (hub + sub-pillars) so we can detect collisions
  const reservedSlugs = new Set<string>(keywordToSlugMap.values())

  console.log(`\nKeyword → slug map (hub + sub-pillars):`)
  for (const [kw, slug] of keywordToSlugMap) {
    const title = keywordToOutlineTitle.get(kw)
    console.log(`  "${kw}" → ${slug}${title ? `  [outline: "${title}"]` : ''}`)
  }

  let created = 0
  let skipped = 0
  let errors = 0
  let collisions = 0

  for (const row of dashboard) {
    const tier = String(row['Tier'] || '')
    const articleType = mapArticleType(tier)
    const keyword = String(row['Keyword'] || '').trim()
    if (!keyword) {
      skipped++
      continue
    }

    // Derive slug: HUB → fixed, sub-pillar → from its keyword, spoke → from its keyword
    let slug: string
    if (articleType === 'hub') {
      slug = HUB_SLUG
    } else {
      slug = keywordToSlug(keyword)
    }

    // Spoke slug collision check (would clash with hub or a sub-pillar)
    if (articleType === 'spoke' && reservedSlugs.has(slug)) {
      console.log(`  ⊘ #${row['#']} SPOKE "${keyword}" → slug "${slug}" COLLIDES with hub/sub-pillar, skipping`)
      collisions++
      skipped++
      continue
    }

    // Parent slug: HUB has none; SUB-PILLAR → hub; SPOKE → lookup by Parent Hub keyword
    let parentSlug = ''
    if (articleType === 'sub-pillar') {
      parentSlug = HUB_SLUG
    } else if (articleType === 'spoke') {
      const parentKeyword = String(row['Parent Hub'] || '').trim()
      if (!parentKeyword || parentKeyword === '—') {
        parentSlug = HUB_SLUG
      } else if (keywordToSlugMap.has(parentKeyword)) {
        parentSlug = keywordToSlugMap.get(parentKeyword)!
      } else {
        // Unknown parent — default to hub but warn
        console.log(`  ⚠ #${row['#']} SPOKE "${keyword}" has unknown Parent Hub "${parentKeyword}", defaulting to hub`)
        parentSlug = HUB_SLUG
      }
    }

    const item: Record<string, unknown> = {
      keyword,
      airportCode: String(row['Airport'] || AIRPORT),
      slug,
      articleType,
      priority: mapPriority(String(row['Priority'] || 'Medium')),
      status: 'queued',
      notes: String(row['Notes'] || ''),
    }

    const sv = row['Search Vol']
    if (sv !== '' && sv !== undefined) {
      item.searchVolume = parseInt(String(sv).replace(/,/g, '')) || 0
    }

    const sd = row['SEO Diff']
    if (sd !== '' && sd !== undefined) {
      item.seoDifficulty = parseInt(String(sd)) || 0
    }

    const tw = row['Target Words']
    if (tw) item.targetWords = parseTargetWords(String(tw))

    if (articleType !== 'hub') {
      item.parentSlug = parentSlug
      item.hubSlug = HUB_SLUG
    }

    // Attach outline
    if (articleType === 'hub') {
      item.outline = hubOutlineItems
    } else if (articleType === 'sub-pillar') {
      const title = keywordToOutlineTitle.get(keyword)
      if (title && subPillarOutlineMap.has(title)) {
        item.outline = subPillarOutlineMap.get(title)
      } else {
        console.log(`  ⚠ #${row['#']} SUB-PILLAR "${keyword}" has no matched outline, importing without one`)
      }
    }

    try {
      const result = await createQueueItem(item)
      created++
      console.log(`  ✓ #${row['#']} ${articleType.toUpperCase()} "${slug}" SV=${item.searchVolume || 0} → id: ${(result as { doc?: { id?: string } }).doc?.id}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('duplicate') || msg.includes('unique')) {
        console.log(`  ⊘ #${row['#']} "${slug}" already exists, skipping`)
        skipped++
      } else {
        errors++
        console.error(`  ✗ #${row['#']} "${slug}" FAILED: ${msg.slice(0, 200)}`)
      }
    }
  }

  console.log(`\nDone! Created: ${created}, Skipped: ${skipped} (collisions: ${collisions}), Errors: ${errors}`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
