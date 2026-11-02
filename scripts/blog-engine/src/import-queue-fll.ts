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

function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else { inQuotes = !inQuotes }
    } else if (char === ',' && !inQuotes) { fields.push(current.trim()); current = '' }
    else { current += char }
  }
  fields.push(current.trim())
  return fields
}

function parseXlsxToRows(filePath: string): Record<string, string>[] {
  const quotedPath = isWindows ? `"${filePath}"` : filePath
  const csv = execFileSync('npx', ['--yes', 'xlsx-cli', quotedPath], { encoding: 'utf-8', shell: isWindows })
  const lines = csv.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return []
  const startIdx = lines[0].includes(',') ? 0 : 1
  const headerLine = parseCSVLine(lines[startIdx])
  return lines.slice(startIdx + 1).map((line) => {
    const values = parseCSVLine(line)
    const row: Record<string, string> = {}
    headerLine.forEach((h, i) => { row[h.replace(/^\uFEFF/, '')] = values[i] || '' })
    return row
  })
}

function keywordToSlug(keyword: string): string {
  return keyword.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function mapPriority(p: string): string {
  if (p === 'P0') return 'S1'
  if (p === 'P1') return 'S1'
  return 'S2'
}

function mapArticleType(tier: string): string {
  switch (tier.toUpperCase()) {
    case 'HUB': return 'hub'
    case 'SUB-PILLAR': return 'sub-pillar'
    default: return 'spoke'
  }
}

function parseTargetWords(tw: string): number {
  const cleaned = tw.replace(/,/g, '')
  const match = cleaned.match(/(\d+)(?:\s*[–-]\s*(\d+))?/)
  if (!match) return 1500
  if (match[2]) return Math.round((parseInt(match[1]) + parseInt(match[2])) / 2)
  return parseInt(match[1])
}

async function createQueueItem(data: Record<string, unknown>) {
  const res = await fetch(`${CMS_URL}/api/content-queue`, { method: 'POST', headers, body: JSON.stringify(data) })
  if (!res.ok) { const body = await res.text(); throw new Error(`Failed: ${res.status} ${body}`) }
  return res.json()
}

async function main() {
  const docsDir = path.resolve(__dirname, '..', '..', '..', '..', 'docs')
  const xlsxFile = path.join(docsDir, 'triply-pro-blog-plan-fort-lauderdale.xlsx')

  console.log(`Reading ${xlsxFile}...`)
  const dashboard = parseXlsxToRows(xlsxFile)
  console.log(`Loaded ${dashboard.length} items from Content Dashboard`)

  const HUB_SLUG = 'fort-lauderdale-airport-parking'

  const subPillarSlugs = new Map<string, string>()
  for (const row of dashboard) {
    if (mapArticleType(row['Tier'] || '') === 'sub-pillar') {
      const keyword = (row['Keyword'] || '').toLowerCase()
      subPillarSlugs.set(keyword, keywordToSlug(row['Keyword'] || ''))
      console.log(`  Sub-pillar: "${keyword}" → ${subPillarSlugs.get(keyword)}`)
    }
  }

  let created = 0, skipped = 0, errors = 0

  for (const row of dashboard) {
    const articleType = mapArticleType(row['Tier'] || '')
    const keyword = row['Keyword'] || ''
    const slug = keywordToSlug(keyword)
    if (!slug) { skipped++; continue }

    const item: Record<string, unknown> = {
      keyword, airportCode: 'FLL', slug, articleType,
      priority: mapPriority(row['Priority'] || 'P2'),
      status: 'queued', notes: row['Notes'] || '',
    }

    const sv = row['Search Vol']; if (sv) item.searchVolume = parseInt(sv.replace(/,/g, '')) || 0
    const sd = row['SEO Diff']; if (sd) item.seoDifficulty = parseInt(sd) || 0
    const tw = row['Target Words']; if (tw) item.targetWords = parseTargetWords(tw)

    if (articleType === 'hub') { /* no parent */ }
    else if (articleType === 'sub-pillar') { item.parentSlug = HUB_SLUG; item.hubSlug = HUB_SLUG }
    else {
      const parentKeyword = (row['Parent Hub'] || '').toLowerCase()
      item.parentSlug = subPillarSlugs.get(parentKeyword) || keywordToSlug(row['Parent Hub'] || '') || HUB_SLUG
      item.hubSlug = HUB_SLUG
    }

    try {
      const result = await createQueueItem(item)
      created++
      console.log(`  ✓ #${row['#']} ${articleType.toUpperCase()} "${slug}" → id: ${result.doc?.id}`)
    } catch (err: unknown) {
      errors++
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('duplicate') || msg.includes('unique')) { skipped++; errors--; console.log(`  ⊘ #${row['#']} "${slug}" exists`) }
      else { console.error(`  ✗ #${row['#']} "${slug}" FAILED: ${msg}`) }
    }
  }

  console.log(`\nDone! Created: ${created}, Skipped: ${skipped}, Errors: ${errors}`)
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1) })
