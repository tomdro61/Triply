import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { env, CLAUDE_MODEL, DOMAIN } from './config.js'
import { buildBootstrapPrompt } from './prompts/bootstrap-airport.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '..', 'data', 'airports')

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

function extractJson(text: string): string {
  let s = text.trim()
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*)```\s*$/)
  if (fenceMatch) s = fenceMatch[1].trim()
  if (!s.startsWith('{')) {
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start !== -1 && end > start) s = s.slice(start, end + 1)
  }
  return s
}

// --- URL verification ---

interface UrlCheckResult {
  url: string
  status: number | 'error'
  ok: boolean
  redirectedTo?: string
}

async function checkUrl(url: string, timeoutMs = 10000): Promise<UrlCheckResult> {
  if (url.includes('VERIFY_URL_NEEDED')) {
    return { url, status: 'error', ok: false }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TriplyBot/1.0)' },
    })
    clearTimeout(timer)

    return {
      url,
      status: res.status,
      ok: res.ok,
      redirectedTo: res.url !== url ? res.url : undefined,
    }
  } catch {
    // Try GET as fallback — some servers block HEAD
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TriplyBot/1.0)' },
      })
      clearTimeout(timer)
      // Only read status, don't consume body
      return {
        url,
        status: res.status,
        ok: res.ok,
        redirectedTo: res.url !== url ? res.url : undefined,
      }
    } catch {
      return { url, status: 'error', ok: false }
    }
  }
}

function collectUrls(obj: unknown, prefix = ''): { path: string; url: string }[] {
  const urls: { path: string; url: string }[] = []

  if (typeof obj === 'string' && obj.startsWith('http')) {
    urls.push({ path: prefix, url: obj })
  } else if (typeof obj === 'object' && obj !== null) {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      urls.push(...collectUrls(value, prefix ? `${prefix}.${key}` : key))
    }
  }

  return urls
}

export async function verifyUrls(data: Record<string, unknown>): Promise<{
  total: number
  valid: number
  broken: number
  results: (UrlCheckResult & { path: string })[]
}> {
  const urlEntries = collectUrls(data)
  console.log(`  Checking ${urlEntries.length} URLs...`)

  const results: (UrlCheckResult & { path: string })[] = []
  let valid = 0
  let broken = 0

  // Check 5 URLs concurrently
  const batchSize = 5
  for (let i = 0; i < urlEntries.length; i += batchSize) {
    const batch = urlEntries.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      batch.map(async ({ path: urlPath, url }) => {
        const result = await checkUrl(url)
        return { ...result, path: urlPath }
      })
    )

    for (const r of batchResults) {
      results.push(r)
      if (r.ok) {
        valid++
        console.log(`    ✓ ${r.path}: ${r.status}`)
      } else {
        broken++
        console.log(`    ✗ ${r.path}: ${r.status} — ${r.url}`)
      }
    }
  }

  return { total: urlEntries.length, valid, broken, results }
}

// --- Main bootstrap function ---

export async function bootstrapAirport(airportCode: string): Promise<Record<string, unknown>> {
  const code = airportCode.toUpperCase()

  // Check if file already exists
  const existingPath = path.join(DATA_DIR, `${code}.json`)
  if (fs.existsSync(existingPath)) {
    console.log(`  ⚠ ${code}.json already exists — will generate as ${code}.bootstrap.json`)
  }

  console.log('  Generating base airport data with Claude...')
  const prompt = buildBootstrapPrompt(code)

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8192,
    system: `You are an airport data researcher generating structured data for ${DOMAIN}. Respond with ONLY valid JSON. Be as accurate as possible — mark uncertain data with [UNVERIFIED].`,
    messages: [{ role: 'user', content: prompt }],
  })

  const textBlock = response.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude')
  }

  const jsonStr = extractJson(textBlock.text)
  const data = JSON.parse(jsonStr) as Record<string, unknown>

  // Ensure the code matches
  data.code = code

  return data
}

export function saveBootstrapData(data: Record<string, unknown>): string {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

  const code = (data.code as string).toUpperCase()
  const existingPath = path.join(DATA_DIR, `${code}.json`)

  // Save as .bootstrap.json if the main file exists
  const filename = fs.existsSync(existingPath) ? `${code}.bootstrap.json` : `${code}.json`
  const filepath = path.join(DATA_DIR, filename)
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2))
  return filepath
}

export function printBootstrapSummary(data: Record<string, unknown>): void {
  const code = data.code as string
  const terminals = data.terminals as { name: string; airlines: string[] }[] | undefined
  const roads = data.roads as string[] | undefined
  const transit = data.transit as string[] | undefined
  const neighborhoods = data.neighborhoods as string[] | undefined
  const liveSources = data.liveSources as Record<string, unknown> | undefined

  // Count unverified markers
  const jsonStr = JSON.stringify(data)
  const unverifiedCount = (jsonStr.match(/\[UNVERIFIED\]/g) || []).length
  const verifyNeeded = (jsonStr.match(/VERIFY_URL_NEEDED/g) || []).length

  console.log(`\n  Bootstrap Summary for ${code}`)
  console.log('  ═══════════════════════════════════════════')
  console.log(`  Full name: ${data.fullName}`)
  console.log(`  Authority: ${data.authority}`)
  console.log(`  Distance: ${data.distanceFromCity}`)
  console.log(`  Parking rates: ${data.parkingRates}`)
  console.log(`  Terminals: ${terminals?.length || 0}`)
  if (terminals) {
    for (const t of terminals) {
      console.log(`    - ${t.name}: ${t.airlines.length} airlines`)
    }
  }
  console.log(`  Roads: ${roads?.length || 0}`)
  console.log(`  Transit options: ${transit?.length || 0}`)
  console.log(`  Neighborhoods: ${neighborhoods?.length || 0}`)
  console.log(`  Live source categories: ${liveSources ? Object.keys(liveSources).length : 0}`)
  console.log(`\n  Data quality:`)
  console.log(`    [UNVERIFIED] markers: ${unverifiedCount}`)
  console.log(`    URLs needing verification: ${verifyNeeded}`)

  const urlEntries = collectUrls(data)
  console.log(`    Total URLs: ${urlEntries.length}`)
}
