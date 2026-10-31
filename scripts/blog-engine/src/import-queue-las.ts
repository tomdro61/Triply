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

const HUB_SLUG = 'las-airport-parking'
const AIRPORT = 'LAS'

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

// NOTE: The LAS spreadsheet is a HYBRID. Its "Content Dashboard" uses the newer
// column template (like MSP), but its "Hub Outline" / "Sub-Pillar Outlines"
// sheets use the OLDER flat single-column markers: a leading "H1: <title>" row
// followed by "H2: <heading>" rows. Each sub-pillar block ends with an
// "H2: Related Spoke Keywords" planning section whose "→ keyword (vol…)" lines
// are NOT article sections — we terminate the block there and drop them.

// Read a single-column sheet as an array of trimmed strings (skipping blanks).
function readColumn(sheet: XLSX.WorkSheet): string[] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
  return rows
    .map((r) => String((r as unknown[])[0] ?? '').trim())
    .filter((v) => v.length > 0)
}

const SPOKE_KEYWORDS_MARKER = /related spoke keywords/i

// Parse the flat Hub Outline sheet: collect every "H2:" heading after the H1.
function parseHubOutline(sheet: XLSX.WorkSheet): OutlineItem[] {
  const lines = readColumn(sheet)
  const items: OutlineItem[] = []
  let order = 1
  for (const line of lines) {
    if (/^H2:/i.test(line)) {
      const heading = line.replace(/^H2:\s*/i, '').trim()
      if (!heading || SPOKE_KEYWORDS_MARKER.test(heading)) continue
      items.push({ order: order++, anchorId: '', heading, summary: '', linksTo: '' })
    }
  }
  return items
}

// Parse the flat Sub-Pillar Outlines sheet into ordered blocks. Each block
// starts at an "H1:" row; its "H2:" rows become the outline (stopping at the
// "Related Spoke Keywords" section). Returns blocks in sheet order so main()
// can zip them to the dashboard's sub-pillars by position.
function parseSubPillarOutlineBlocks(sheet: XLSX.WorkSheet): { title: string; items: OutlineItem[] }[] {
  const lines = readColumn(sheet)
  const blocks: { title: string; items: OutlineItem[] }[] = []
  let current: { title: string; items: OutlineItem[] } | null = null
  let order = 1
  let inSpokeSection = false

  for (const line of lines) {
    if (/^H1:/i.test(line)) {
      if (current) blocks.push(current)
      current = { title: line.replace(/^H1:\s*/i, '').trim(), items: [] }
      order = 1
      inSpokeSection = false
      continue
    }
    if (/^H2:/i.test(line)) {
      const heading = line.replace(/^H2:\s*/i, '').trim()
      if (SPOKE_KEYWORDS_MARKER.test(heading)) {
        inSpokeSection = true // everything after this in the block is keyword planning
        continue
      }
      if (!inSpokeSection && current && heading) {
        current.items.push({ order: order++, anchorId: '', heading, summary: '', linksTo: '' })
      }
      continue
    }
    // "→ keyword (vol…)" lines and anything else are ignored.
  }
  if (current) blocks.push(current)
  return blocks
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
  const dryRun = process.argv.includes('--dry-run')
  const xlsxPath = path.resolve(
    __dirname, '..', '..', '..', '..', 'docs', 'triply-pro-blog-plan-las-vegas.xlsx'
  )
  const wb = XLSX.readFile(xlsxPath)

  const dashboard = XLSX.utils.sheet_to_json<Record<string, string | number>>(
    wb.Sheets['Content Dashboard'],
    { defval: '' }
  )
  const hubOutlineItems = parseHubOutline(wb.Sheets['Hub Outline'])
  const subPillarBlocks = parseSubPillarOutlineBlocks(wb.Sheets['Sub-Pillar Outlines'])

  console.log(`Loaded ${dashboard.length} dashboard rows`)
  console.log(`Loaded ${hubOutlineItems.length} hub H2 items`)
  console.log(`Loaded ${subPillarBlocks.length} sub-pillar outline blocks`)
  if (dryRun) console.log('*** DRY RUN — no queue items will be created ***')

  // Bridge dashboard sub-pillars → outline blocks by ordered position.
  const keywordToSlugMap = new Map<string, string>()
  const keywordToOutlineItems = new Map<string, OutlineItem[]>()
  let subPillarIdx = 0
  for (const row of dashboard) {
    const tier = mapArticleType(String(row['Tier']))
    const keyword = String(row['Keyword'] || '').trim()
    if (!keyword) continue
    if (tier === 'hub') {
      keywordToSlugMap.set(keyword, HUB_SLUG)
    } else if (tier === 'sub-pillar') {
      keywordToSlugMap.set(keyword, keywordToSlug(keyword))
      const block = subPillarBlocks[subPillarIdx++]
      if (block) keywordToOutlineItems.set(keyword, block.items)
    }
  }

  const reservedSlugs = new Set<string>(keywordToSlugMap.values())

  console.log(`\nKeyword → slug map (hub + sub-pillars):`)
  for (const [kw, slug] of keywordToSlugMap) {
    const n = keywordToOutlineItems.get(kw)?.length
    console.log(`  "${kw}" → ${slug}${n ? `  [${n} H2s]` : ''}`)
  }

  let created = 0, skipped = 0, errors = 0, collisions = 0

  for (const row of dashboard) {
    const tier = String(row['Tier'] || '')
    const articleType = mapArticleType(tier)
    const keyword = String(row['Keyword'] || '').trim()
    if (!keyword) { skipped++; continue }

    const slug = articleType === 'hub' ? HUB_SLUG : keywordToSlug(keyword)

    if (articleType === 'spoke' && reservedSlugs.has(slug)) {
      console.log(`  ⊘ #${row['#']} SPOKE "${keyword}" → slug "${slug}" COLLIDES with hub/sub-pillar, skipping`)
      collisions++; skipped++; continue
    }

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

    if (articleType === 'hub') {
      item.outline = hubOutlineItems
    } else if (articleType === 'sub-pillar') {
      const items = keywordToOutlineItems.get(keyword)
      if (items && items.length) {
        item.outline = items
      } else {
        console.log(`  ⚠ #${row['#']} SUB-PILLAR "${keyword}" has no matched outline, importing without one`)
      }
    }

    if (dryRun) {
      created++
      console.log(`  · #${row['#']} ${articleType.toUpperCase()} "${slug}" SV=${item.searchVolume || 0}${item.outline ? ` (outline: ${(item.outline as OutlineItem[]).length} H2s)` : ''}`)
      continue
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
