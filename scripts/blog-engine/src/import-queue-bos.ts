import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const isWindows = process.platform === 'win32'

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

function parseXlsxToRows(filePath: string): Record<string, string>[] {
  // Use xlsx-cli to convert xlsx to CSV, then parse
  // On Windows, npx is a .cmd script — needs shell:true for execFileSync
  // Quote filePath for shell mode (handles spaces in path)
  const quotedPath = isWindows ? `"${filePath}"` : filePath
  const csv = execFileSync('npx', ['--yes', 'xlsx-cli', quotedPath], { encoding: 'utf-8', shell: isWindows })
  const lines = csv.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []

  // Skip sheet name line if present (first line is "Content Dashboard" without commas)
  const startIdx = lines[0].includes(',') ? 0 : 1
  const headerLine = parseCSVLine(lines[startIdx])

  return lines.slice(startIdx + 1).map((line) => {
    const values = parseCSVLine(line)
    const row: Record<string, string> = {}
    headerLine.forEach((h, i) => {
      // Strip BOM from first header
      const key = h.replace(/^\uFEFF/, '')
      row[key] = values[i] || ''
    })
    return row
  })
}

// Generate slug from keyword (kebab-case)
function keywordToSlug(keyword: string): string {
  return keyword
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// Map priority: BOS spreadsheet uses P0/P1/P2
function mapPriority(csvPriority: string): string {
  if (csvPriority === 'P0') return 'S1'
  if (csvPriority === 'P1') return 'S1'
  if (csvPriority === 'P2') return 'S2'
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

// Parse target words like "4,000–5,000" or "2,500–3,500" or "1,200–1,800"
function parseTargetWords(tw: string): number {
  const cleaned = tw.replace(/,/g, '')
  // Handle en-dash (–) and regular hyphen (-)
  const match = cleaned.match(/(\d+)(?:\s*[–-]\s*(\d+))?/)
  if (!match) return 1500
  if (match[2]) return Math.round((parseInt(match[1]) + parseInt(match[2])) / 2)
  return parseInt(match[1])
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
  const docsDir = path.resolve(__dirname, '..', '..', '..', '..', 'docs')
  const xlsxFile = path.join(docsDir, 'triply-pro-blog-plan-boston-logan.xlsx')

  console.log(`Reading ${xlsxFile}...`)
  const dashboard = parseXlsxToRows(xlsxFile)
  console.log(`Loaded ${dashboard.length} items from Content Dashboard`)

  const HUB_SLUG = 'boston-logan-airport-parking'

  // Build sub-pillar keyword → slug map for parentSlug lookups
  const subPillarSlugs = new Map<string, string>()
  for (const row of dashboard) {
    if (mapArticleType(row['Tier'] || '') === 'sub-pillar') {
      const keyword = (row['Keyword'] || '').toLowerCase()
      const slug = keywordToSlug(row['Keyword'] || '')
      subPillarSlugs.set(keyword, slug)
      console.log(`  Sub-pillar: "${keyword}" → ${slug}`)
    }
  }

  let created = 0
  let skipped = 0
  let errors = 0

  for (const row of dashboard) {
    const tier = row['Tier'] || ''
    const articleType = mapArticleType(tier)
    const keyword = row['Keyword'] || ''
    const slug = keywordToSlug(keyword)

    if (!slug) {
      console.log(`  Skipping row #${row['#']} - no slug`)
      skipped++
      continue
    }

    // Build the queue item
    const item: Record<string, unknown> = {
      keyword,
      airportCode: 'BOS',
      slug,
      articleType,
      priority: mapPriority(row['Priority'] || 'P2'),
      status: 'queued',
      notes: row['Notes'] || '',
    }

    // Search volume
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
      // Spoke: derive parentSlug from Parent Hub keyword
      const parentKeyword = (row['Parent Hub'] || '').toLowerCase()
      // If the parent is a sub-pillar, use its slug; otherwise derive from keyword
      const parentSlug = subPillarSlugs.get(parentKeyword) || keywordToSlug(row['Parent Hub'] || '')
      item.parentSlug = parentSlug || HUB_SLUG
      item.hubSlug = HUB_SLUG
    }

    try {
      const result = await createQueueItem(item)
      created++
      console.log(`  ✓ #${row['#']} ${articleType.toUpperCase()} "${slug}" → id: ${result.doc?.id}`)
    } catch (err: unknown) {
      errors++
      const msg = err instanceof Error ? err.message : String(err)
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
