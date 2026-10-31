// Upsert a content queue spreadsheet for a given airport.
// Existing items (matched by slug + airportCode) get PATCHED with SV/SEO/CPC/TargetWords/priority/notes.
// New items get POSTED.
// Published items are left untouched (status preserved).
//
// Usage: tsx upsert-queue.ts <AIRPORT_CODE> <xlsx_path> [--hub-slug=<slug>] [--hub-keyword=<keyword>]

import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const isWindows = process.platform === 'win32'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const CMS_URL = process.env.PAYLOAD_CMS_URL!
const API_KEY = process.env.PAYLOAD_API_KEY!
const headers = { 'Content-Type': 'application/json', Authorization: `users API-Key ${API_KEY}` }

const args = process.argv.slice(2)
const airportCode = args[0]?.toUpperCase()
const xlsxFile = args[1]
const hubSlugArg = args.find(a => a.startsWith('--hub-slug='))?.split('=')[1]
const hubKeywordArg = args.find(a => a.startsWith('--hub-keyword='))?.split('=')[1]

if (!airportCode || !xlsxFile) {
  console.error('Usage: tsx upsert-queue.ts <AIRPORT_CODE> <xlsx_path> [--hub-slug=<slug>] [--hub-keyword=<keyword>]')
  process.exit(1)
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
    headerLine.forEach((h, i) => { row[h.replace(/^﻿/, '')] = values[i] || '' })
    return row
  })
}

function keywordToSlug(keyword: string): string {
  return keyword.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function mapPriority(p: string): string {
  const upper = (p || '').toUpperCase()
  if (upper === 'HIGH' || upper === 'P0' || upper === 'P1') return 'S1'
  if (upper === 'MEDIUM' || upper === 'P2') return 'S2'
  return 'S3'
}

function mapArticleType(tier: string): string {
  switch ((tier || '').toUpperCase()) {
    case 'HUB': return 'hub'
    case 'SUB-PILLAR': return 'sub-pillar'
    default: return 'spoke'
  }
}

function parseTargetWords(tw: string): number {
  const cleaned = (tw || '').replace(/,/g, '')
  const match = cleaned.match(/(\d+)(?:\s*[–-]\s*(\d+))?/)
  if (!match) return 1500
  if (match[2]) return Math.round((parseInt(match[1]) + parseInt(match[2])) / 2)
  return parseInt(match[1])
}

function parseCpc(c: string): number {
  if (!c) return 0
  const cleaned = c.replace(/[$,]/g, '')
  return parseFloat(cleaned) || 0
}

async function findExistingBySlug(slug: string): Promise<{ id: number, status: string } | null> {
  const r = await fetch(`${CMS_URL}/api/content-queue?where[slug][equals]=${encodeURIComponent(slug)}&where[airportCode][equals]=${airportCode}&limit=1&depth=0`, { headers })
  const d = await r.json()
  if (d.docs?.length) return { id: d.docs[0].id, status: d.docs[0].status }
  return null
}

async function patchItem(id: number, data: Record<string, unknown>) {
  const res = await fetch(`${CMS_URL}/api/content-queue/${id}`, { method: 'PATCH', headers, body: JSON.stringify(data) })
  if (!res.ok) throw new Error(`PATCH ${res.status}: ${await res.text()}`)
  return res.json()
}

async function postItem(data: Record<string, unknown>) {
  const res = await fetch(`${CMS_URL}/api/content-queue`, { method: 'POST', headers, body: JSON.stringify(data) })
  if (!res.ok) throw new Error(`POST ${res.status}: ${await res.text()}`)
  return res.json()
}

async function main() {
  console.log(`\nUpserting queue for airport ${airportCode} from ${xlsxFile}`)
  if (hubSlugArg) console.log(`Hub override: slug=${hubSlugArg}, keyword=${hubKeywordArg || '(auto)'}`)

  const rows = parseXlsxToRows(xlsxFile)
  console.log(`Loaded ${rows.length} rows from spreadsheet\n`)

  const hubRow = rows.find((r) => mapArticleType(r['Tier'] || '') === 'hub')
  const hubOriginalKeyword = (hubRow?.['Keyword'] || '').toLowerCase()
  const HUB_SLUG = hubSlugArg || keywordToSlug(hubRow?.['Keyword'] || '')
  const HUB_KEYWORD = hubKeywordArg || hubRow?.['Keyword'] || ''
  console.log(`Hub: slug=${HUB_SLUG}, keyword="${HUB_KEYWORD}"`)
  console.log(`Hub original keyword (sheet): "${hubOriginalKeyword}"\n`)

  // Build sub-pillar map (lowercased keyword → slug)
  const subPillarSlugs = new Map<string, string>()
  for (const row of rows) {
    if (mapArticleType(row['Tier'] || '') === 'sub-pillar') {
      const keyword = (row['Keyword'] || '').toLowerCase()
      subPillarSlugs.set(keyword, keywordToSlug(row['Keyword'] || ''))
    }
  }
  console.log(`Found ${subPillarSlugs.size} sub-pillars\n`)

  let patched = 0, created = 0, skippedPublished = 0, errors = 0

  for (const row of rows) {
    const articleType = mapArticleType(row['Tier'] || '')
    let keyword = row['Keyword'] || ''
    let slug = keywordToSlug(keyword)
    const suggestedTitle = keyword

    // HUB OVERRIDE: replace long title with clean head term
    if (articleType === 'hub' && hubSlugArg) {
      keyword = HUB_KEYWORD
      slug = HUB_SLUG
    }

    if (!slug) continue

    // Build base data
    const data: Record<string, unknown> = {
      keyword, airportCode, slug, articleType,
      priority: mapPriority(row['Priority'] || ''),
      notes: row['Notes'] || '',
      suggestedTitle,
    }
    const sv = row['Search Vol']; if (sv) data.searchVolume = parseInt(sv.replace(/,/g, '')) || 0
    const sd = row['SEO Diff']; if (sd) data.seoDifficulty = parseInt(sd) || 0
    const cpc = row['CPC']; if (cpc) data.cpc = parseCpc(cpc)
    const tw = row['Target Words']; if (tw) data.targetWords = parseTargetWords(tw)

    // Parent linking
    if (articleType === 'hub') {
      // No parent
    } else if (articleType === 'sub-pillar') {
      data.parentSlug = HUB_SLUG
      data.hubSlug = HUB_SLUG
    } else {
      const parentRaw = (row['Parent Hub'] || '').toLowerCase().trim()
      if (parentRaw === hubOriginalKeyword || parentRaw === HUB_KEYWORD.toLowerCase()) {
        data.parentSlug = HUB_SLUG
      } else {
        data.parentSlug = subPillarSlugs.get(parentRaw) || keywordToSlug(row['Parent Hub'] || '') || HUB_SLUG
      }
      data.hubSlug = HUB_SLUG
    }

    try {
      const existing = await findExistingBySlug(slug)
      if (existing) {
        // Don't overwrite published/draft status — preserve, just update metadata
        if (existing.status === 'published' || existing.status === 'draft' || existing.status === 'generating') {
          // Update metadata only (SV/SEO/CPC/notes/etc.), don't touch status
          await patchItem(existing.id, data)
          skippedPublished++
          console.log(`  ↻ #${row['#']} ${articleType.toUpperCase().padEnd(11)} sv=${String(data.searchVolume||0).padStart(5)} "${slug}" updated (status=${existing.status} preserved) → id: ${existing.id}`)
        } else {
          // queued or error → update fully, set status=queued to allow re-generation
          data.status = 'queued'
          await patchItem(existing.id, data)
          patched++
          console.log(`  ✓ #${row['#']} ${articleType.toUpperCase().padEnd(11)} sv=${String(data.searchVolume||0).padStart(5)} "${slug}" patched → id: ${existing.id}`)
        }
      } else {
        data.status = 'queued'
        const result = await postItem(data)
        created++
        console.log(`  + #${row['#']} ${articleType.toUpperCase().padEnd(11)} sv=${String(data.searchVolume||0).padStart(5)} "${slug}" created → id: ${result.doc?.id}`)
      }
    } catch (err) {
      errors++
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  ✗ #${row['#']} "${slug}" FAILED: ${msg}`)
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`Done! Patched (queued/error): ${patched} | Updated metadata (published/draft preserved): ${skippedPublished} | Created new: ${created} | Errors: ${errors}`)
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1) })
