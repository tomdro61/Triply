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

const HUB_SLUG = 'atlanta-airport-parking'
const AIRPORT = 'ATL'

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

// Parse the flat Hub Outline sheet: skip H1 rows, take H2 rows in order.
function parseHubOutline(sheet: XLSX.WorkSheet): OutlineItem[] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
  const items: OutlineItem[] = []
  let order = 1
  for (const r of rows) {
    const cell = String(r[0] || '').trim()
    if (cell.startsWith('H2:')) {
      items.push({
        order: order++,
        anchorId: '',
        heading: cell.replace(/^H2:\s*/, ''),
        summary: '',
        linksTo: '',
      })
    }
  }
  return items
}

// Parse the flat Sub-Pillar Outlines sheet: group H2 rows under each H1 marker.
function parseSubPillarOutlines(sheet: XLSX.WorkSheet): Map<string, OutlineItem[]> {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
  const map = new Map<string, OutlineItem[]>()
  let currentSubPillar: string | null = null
  let order = 1
  for (const r of rows) {
    const cell = String(r[0] || '').trim()
    if (cell.startsWith('H1:')) {
      currentSubPillar = cell.replace(/^H1:\s*/, '')
      order = 1
      map.set(currentSubPillar, [])
    } else if (cell.startsWith('H2:') && currentSubPillar) {
      // Stop including outline items once we hit "Related Spoke Keywords"
      const heading = cell.replace(/^H2:\s*/, '')
      if (heading.toLowerCase().includes('related spoke keyword')) continue
      map.get(currentSubPillar)!.push({
        order: order++,
        anchorId: '',
        heading,
        summary: '',
        linksTo: '',
      })
    }
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
  const xlsxPath = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'triply-pro-blog-plan-atlanta.xlsx')
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

  // Build keyword → slug map for the hub and all sub-pillars
  const keywordToSlugMap = new Map<string, string>()
  for (const row of dashboard) {
    const tier = mapArticleType(String(row['Tier']))
    const keyword = String(row['Keyword'] || '').trim()
    if (!keyword) continue
    if (tier === 'hub') {
      keywordToSlugMap.set(keyword, HUB_SLUG)
    } else if (tier === 'sub-pillar') {
      keywordToSlugMap.set(keyword, keywordToSlug(keyword))
    }
  }

  // Build the set of reserved slugs (hub + sub-pillars) so we can detect collisions
  const reservedSlugs = new Set<string>(keywordToSlugMap.values())

  console.log(`\nKeyword → slug map (hub + sub-pillars):`)
  for (const [kw, slug] of keywordToSlugMap) {
    console.log(`  "${kw}" → ${slug}`)
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
    } else if (articleType === 'sub-pillar' && subPillarOutlineMap.has(keyword)) {
      item.outline = subPillarOutlineMap.get(keyword)
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
