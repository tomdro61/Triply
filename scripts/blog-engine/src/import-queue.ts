import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const CMS_URL = process.env.PAYLOAD_CMS_URL!
const API_KEY = process.env.PAYLOAD_API_KEY!

const headers = {
  'Content-Type': 'application/json',
  Authorization: `users API-Key ${API_KEY}`,
}

// Parse CSV line handling quoted fields with commas
function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  fields.push(current.trim())
  return fields
}

function parseCSV(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []

  const headerLine = parseCSVLine(lines[0])
  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line)
    const row: Record<string, string> = {}
    headerLine.forEach((h, i) => {
      row[h] = values[i] || ''
    })
    return row
  })
}

// Map CSV priority to CMS priority values
function mapPriority(csvPriority: string): string {
  // Hub: H1 -> S1, Sub-pillars: S1-S6 -> S1/S2/S3, Spokes: K1-K85 -> S1/S2/S3
  if (csvPriority === 'H1') return 'S1'
  if (csvPriority.startsWith('S')) {
    const n = parseInt(csvPriority.slice(1))
    if (n <= 2) return 'S1'
    if (n <= 4) return 'S2'
    return 'S3'
  }
  if (csvPriority.startsWith('K')) {
    const n = parseInt(csvPriority.slice(1))
    if (n <= 20) return 'S1'
    if (n <= 50) return 'S2'
    return 'S3'
  }
  return 'S2'
}

// Map CSV tier to CMS articleType
function mapArticleType(tier: string): string {
  switch (tier.toUpperCase()) {
    case 'HUB': return 'hub'
    case 'SUB-PILLAR': return 'sub-pillar'
    case 'SPOKE': return 'spoke'
    default: return 'spoke'
  }
}

// Parse target words like "3,500-4,000" or "2,500" or "1,000-1,500"
function parseTargetWords(tw: string): number {
  const cleaned = tw.replace(/,/g, '')
  const match = cleaned.match(/(\d+)(?:\s*-\s*(\d+))?/)
  if (!match) return 1500
  if (match[2]) return Math.round((parseInt(match[1]) + parseInt(match[2])) / 2)
  return parseInt(match[1])
}

// Strip /blog/ prefix from slug
function cleanSlug(slug: string): string {
  return slug.replace(/^\/blog\//, '')
}

interface OutlineItem {
  order: number
  anchorId: string
  heading: string
  summary: string
  linksTo: string
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
  const docsDir = path.resolve(__dirname, '..', '..', '..', 'docs')

  // Read CSVs
  const dashboardFile = path.join(docsDir, 'triply-pro-blog-plan-v3.xlsx - Content Dashboard.csv')
  const hubOutlineFile = path.join(docsDir, 'triply-pro-blog-plan-v3.xlsx - Hub Outline.csv')
  const subPillarOutlineFile = path.join(docsDir, 'triply-pro-blog-plan-v3.xlsx - Sub-Pillar Outlines.csv')

  const dashboard = parseCSV(dashboardFile)
  const hubOutline = parseCSV(hubOutlineFile)
  const subPillarOutlines = parseCSV(subPillarOutlineFile)

  console.log(`Loaded ${dashboard.length} items from Content Dashboard`)
  console.log(`Loaded ${hubOutline.length} hub outline rows`)
  console.log(`Loaded ${subPillarOutlines.length} sub-pillar outline rows`)

  // Build hub outline
  const hubOutlineItems: OutlineItem[] = hubOutline.map((row) => ({
    order: parseInt(row['H2 Order']) || 0,
    anchorId: row['H2 Anchor ID'] || '',
    heading: row['H2 Heading'] || '',
    summary: row['Content Summary'] || '',
    linksTo: row['Links To Sub-Pillar'] ? cleanSlug(row['Links To Sub-Pillar']) : '',
  }))

  // Build sub-pillar outlines grouped by slug
  const subPillarOutlineMap = new Map<string, OutlineItem[]>()
  for (const row of subPillarOutlines) {
    if (!row['Sub-Pillar'] || !row['H2 Heading']) continue
    const slug = cleanSlug(row['Slug'] || '')
    if (!slug) continue

    if (!subPillarOutlineMap.has(slug)) {
      subPillarOutlineMap.set(slug, [])
    }
    subPillarOutlineMap.get(slug)!.push({
      order: parseInt(row['H2 Order']) || 0,
      anchorId: row['H2 Anchor ID'] || '',
      heading: row['H2 Heading'] || '',
      summary: row['Spoke Keywords That Link Here'] || '',
      linksTo: '',
    })
  }

  // Hub slug for all items
  const HUB_SLUG = 'jfk-airport-parking'

  let created = 0
  let skipped = 0
  let errors = 0

  for (const row of dashboard) {
    const tier = row['Tier'] || ''
    const articleType = mapArticleType(tier)
    const slug = cleanSlug(row['Slug'] || '')
    const parentHub = row['Parent Hub'] ? cleanSlug(row['Parent Hub']) : ''

    if (!slug) {
      console.log(`  Skipping row #${row['#']} - no slug`)
      skipped++
      continue
    }

    // Build the queue item
    const item: Record<string, unknown> = {
      keyword: row['Keyword'] || '',
      suggestedTitle: row['Title'] || `${row['Keyword']} - Triply Pro Guide`,
      airportCode: row['Airport'] || 'JFK',
      slug,
      articleType,
      priority: mapPriority(row['Priority'] || 'S2'),
      status: 'queued',
      notes: row['Notes'] || '',
    }

    // Search volume (handle commas)
    const sv = row['Search Vol']
    if (sv) item.searchVolume = parseInt(sv.replace(/,/g, '')) || 0

    // SEO difficulty
    const sd = row['SEO Diff']
    if (sd) item.seoDifficulty = parseInt(sd) || 0

    // Target words
    const tw = row['Target Words']
    if (tw) item.targetWords = parseTargetWords(tw)

    // Parent and hub slugs
    if (articleType === 'hub') {
      // Hub has no parent
    } else if (articleType === 'sub-pillar') {
      item.parentSlug = HUB_SLUG
      item.hubSlug = HUB_SLUG
    } else {
      // Spoke: parentSlug is the parent hub column, hubSlug is always the main hub
      item.parentSlug = parentHub || HUB_SLUG
      item.hubSlug = HUB_SLUG
    }

    // Attach outline
    if (articleType === 'hub') {
      item.outline = hubOutlineItems
    } else if (articleType === 'sub-pillar' && subPillarOutlineMap.has(slug)) {
      item.outline = subPillarOutlineMap.get(slug)
    }

    try {
      const result = await createQueueItem(item)
      created++
      console.log(`  ✓ #${row['#']} ${articleType.toUpperCase()} "${slug}" → id: ${result.doc?.id}`)
    } catch (err: unknown) {
      errors++
      const msg = err instanceof Error ? err.message : String(err)
      // Check for duplicate slug
      if (msg.includes('duplicate') || msg.includes('unique')) {
        console.log(`  ⊘ #${row['#']} "${slug}" already exists, skipping`)
        skipped++
        errors--
      } else {
        console.error(`  ✗ #${row['#']} "${slug}" FAILED: ${msg}`)
      }
    }
  }

  console.log(`\nDone! Created: ${created}, Skipped: ${skipped}, Errors: ${errors}`)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
