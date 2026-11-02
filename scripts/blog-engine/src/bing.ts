/**
 * Bing Webmaster Tools Integration
 *
 * Pulls search performance data from Bing and generates reports.
 * Much simpler auth than GSC — just an API key.
 *
 * Setup:
 *   1. Go to https://www.bing.com/webmasters
 *   2. Sign in and verify triplypro.com (if not already)
 *   3. Click Settings (gear icon, top right) → API Access → Generate API Key
 *   4. Add to .env: BING_WEBMASTER_API_KEY=your_key_here
 *   5. Run: npm run bing
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

// ── Config ──────────────────────────────────────────────────────────────────

const SITE_URL = 'https://www.triplypro.com/'
const API_KEY = process.env.BING_WEBMASTER_API_KEY
const API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json'

// ── Types ───────────────────────────────────────────────────────────────────

interface BingQueryStat {
  Query: string
  Date: string
  Clicks: number
  Impressions: number
  AvgClickPosition: number
  AvgImpressionPosition: number
}

interface BingPageStat {
  Query: string
  Date: string
  Clicks: number
  Impressions: number
  AvgClickPosition: number
  AvgImpressionPosition: number
}

interface QueryData {
  query: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

interface PageData {
  page: string
  slug: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

interface BingReport {
  dateRange: string
  totals: { clicks: number; impressions: number; ctr: number; position: number }
  topQueries: QueryData[]
  topPages: PageData[]
  quickWins: QueryData[]
}

// ── Auth Check ──────────────────────────────────────────────────────────────

function checkAuth(): void {
  if (!API_KEY) {
    console.error(`\n  Bing Webmaster API key not found.`)
    console.error(`\n  Setup:`)
    console.error(`  1. Go to https://www.bing.com/webmasters`)
    console.error(`  2. Sign in and verify triplypro.com`)
    console.error(`  3. Settings (gear icon) -> API Access -> Generate API Key`)
    console.error(`  4. Add to .env: BING_WEBMASTER_API_KEY=your_key_here\n`)
    process.exit(1)
  }
}

// ── API Calls ───────────────────────────────────────────────────────────────

async function bingApiGet(endpoint: string): Promise<any> {
  const url = `${API_BASE}/${endpoint}?siteUrl=${encodeURIComponent(SITE_URL)}&apikey=${API_KEY}`
  const response = await fetch(url)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Bing API error ${response.status}: ${text}`)
  }
  return response.json()
}

async function getQueryStats(): Promise<BingQueryStat[]> {
  const data = await bingApiGet('GetQueryStats')
  return data.d || []
}

async function getPageStats(pageUrl: string): Promise<BingPageStat[]> {
  const url = `${API_BASE}/GetPageQueryStats?siteUrl=${encodeURIComponent(SITE_URL)}&page=${encodeURIComponent(pageUrl)}&apikey=${API_KEY}`
  const response = await fetch(url)
  if (!response.ok) return []
  const data = await response.json()
  return data.d || []
}

/**
 * Page-level stats for the whole site in ONE call.
 *
 * topPages used to be hardcoded to [] with the note "would need to iterate pages —
 * expensive", which was true of GetPageQueryStats (per-page). GetPageStats is the bulk
 * sibling: it returns one row per page per day, so a single request covers the site.
 * Bing reuses the query DTO here, so the page URL arrives in the `Query` field.
 */
async function getAllPageStats(): Promise<BingPageStat[]> {
  const data = await bingApiGet('GetPageStats')
  return data.d || []
}

/**
 * Bing serialises dates in legacy .NET format — `/Date(1776409200000-0700)/` — which has
 * no 'T' to split on, so the old `split('T')[0]` passed the raw string straight through
 * into the report. Pull the epoch millis out and format properly.
 */
function parseBingDate(raw: string): string | null {
  if (!raw) return null
  const m = /\/Date\((-?\d+)/.exec(raw)
  const ms = m ? Number(m[1]) : Date.parse(raw)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString().split('T')[0]
}

async function getRankAndTrafficStats(): Promise<any[]> {
  const data = await bingApiGet('GetRankAndTrafficStats')
  return data.d || []
}

// ── Report Generation ───────────────────────────────────────────────────────

async function generateReport(): Promise<BingReport> {
  checkAuth()

  console.log(`\n  Pulling Bing Webmaster data for ${SITE_URL}\n`)

  // Get query-level stats
  console.log('  Fetching query stats...')
  const queryStats = await getQueryStats()

  // Get traffic stats
  console.log('  Fetching rank & traffic stats...')
  const trafficStats = await getRankAndTrafficStats()

  // Aggregate queries (Bing returns daily rows, we want totals)
  const queryMap = new Map<string, { clicks: number; impressions: number; positionSum: number; days: number }>()
  for (const stat of queryStats) {
    const existing = queryMap.get(stat.Query) || { clicks: 0, impressions: 0, positionSum: 0, days: 0 }
    existing.clicks += stat.Clicks
    existing.impressions += stat.Impressions
    existing.positionSum += stat.AvgImpressionPosition
    existing.days++
    queryMap.set(stat.Query, existing)
  }

  const queries: QueryData[] = Array.from(queryMap.entries())
    .map(([query, data]) => ({
      query,
      clicks: data.clicks,
      impressions: data.impressions,
      ctr: data.impressions > 0 ? data.clicks / data.impressions : 0,
      position: data.days > 0 ? data.positionSum / data.days : 0,
    }))
    .sort((a, b) => b.impressions - a.impressions)

  // Calculate totals
  const totals = queries.reduce(
    (acc, q) => ({
      clicks: acc.clicks + q.clicks,
      impressions: acc.impressions + q.impressions,
      ctr: 0, position: 0,
    }),
    { clicks: 0, impressions: 0, ctr: 0, position: 0 }
  )
  totals.ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0
  totals.position = queries.length > 0
    ? queries.reduce((sum, q) => sum + q.position * q.impressions, 0) / totals.impressions : 0

  // Quick wins
  const quickWins = queries
    .filter(q => q.position >= 5 && q.position <= 20 && q.impressions >= 5)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20)

  // Page-level stats — one bulk call, aggregated the same way as queries.
  console.log('  Fetching page stats...')
  let pages: PageData[] = []
  try {
    const pageStats = await getAllPageStats()
    const pageMap = new Map<string, { clicks: number; impressions: number; positionSum: number; days: number }>()
    for (const stat of pageStats) {
      const url = stat.Query  // Bing returns the page URL in the shared DTO's Query field
      if (!url) continue
      const existing = pageMap.get(url) || { clicks: 0, impressions: 0, positionSum: 0, days: 0 }
      existing.clicks += stat.Clicks
      existing.impressions += stat.Impressions
      existing.positionSum += stat.AvgImpressionPosition
      existing.days++
      pageMap.set(url, existing)
    }
    pages = Array.from(pageMap.entries())
      .map(([page, data]) => ({
        page,
        // Bing may return a path or a full URL — take the last non-empty segment either way.
        slug: page.replace(/\/+$/, '').split('/').filter(Boolean).pop() || page,
        clicks: data.clicks,
        impressions: data.impressions,
        ctr: data.impressions > 0 ? data.clicks / data.impressions : 0,
        position: data.days > 0 ? data.positionSum / data.days : 0,
      }))
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 50)
    console.log(`  ${pages.length} pages with traffic.`)
  } catch (err: any) {
    // Page stats are a bonus signal — a Bing-side failure must not cost us the query
    // report, but it should be visible rather than silently yielding an empty list.
    console.error(`  ⚠ Page stats unavailable (${err.message}) — topPages will be empty.`)
  }

  // Date range from the data
  const dates = queryStats.map(s => parseBingDate(s.Date)).filter((d): d is string => !!d).sort()
  const dateRange = dates.length > 0
    ? `${dates[0]} to ${dates[dates.length - 1]}`
    : 'No data'

  return {
    dateRange,
    totals,
    topQueries: queries.slice(0, 30),
    topPages: pages,
    quickWins,
  }
}

// ── Display ─────────────────────────────────────────────────────────────────

function printReport(report: BingReport): void {
  console.log('\n' + '='.repeat(70))
  console.log('  BING WEBMASTER TOOLS REPORT -- triplypro.com')
  console.log('  ' + report.dateRange)
  console.log('='.repeat(70))

  console.log('\n  BING TOTALS')
  console.log('  -----------------------------------------')
  console.log(`  Clicks:       ${report.totals.clicks.toLocaleString()}`)
  console.log(`  Impressions:  ${report.totals.impressions.toLocaleString()}`)
  console.log(`  CTR:          ${(report.totals.ctr * 100).toFixed(2)}%`)
  console.log(`  Avg Position: ${report.totals.position.toFixed(1)}`)

  if (report.topQueries.length > 0) {
    console.log('\n  TOP BING QUERIES (by impressions)')
    console.log('  -----------------------------------------')
    for (const q of report.topQueries.slice(0, 20)) {
      const query = q.query.length > 45 ? q.query.slice(0, 42) + '...' : q.query
      console.log(
        `  ${query.padEnd(47)} ${String(q.clicks).padStart(4)}c  ` +
        `${String(q.impressions).padStart(6)}i  pos ${q.position.toFixed(1).padStart(5)}  ` +
        `${(q.ctr * 100).toFixed(1).padStart(5)}%`
      )
    }
  }

  if (report.topPages.length > 0) {
    console.log('\n  TOP BING PAGES (by impressions)')
    console.log('  -----------------------------------------')
    for (const p of report.topPages.slice(0, 20)) {
      const slug = p.slug.length > 45 ? p.slug.slice(0, 42) + '...' : p.slug
      console.log(
        `  ${slug.padEnd(47)} ${String(p.clicks).padStart(4)}c  ` +
        `${String(p.impressions).padStart(6)}i  pos ${p.position.toFixed(1).padStart(5)}  ` +
        `${(p.ctr * 100).toFixed(1).padStart(5)}%`
      )
    }
  }

  if (report.quickWins.length > 0) {
    console.log('\n  BING QUICK WINS (position 5-20)')
    console.log('  -----------------------------------------')
    for (const q of report.quickWins.slice(0, 10)) {
      const query = q.query.length > 45 ? q.query.slice(0, 42) + '...' : q.query
      console.log(
        `  ${query.padEnd(47)} pos ${q.position.toFixed(1).padStart(5)}  ` +
        `${String(q.impressions).padStart(6)}i  ${String(q.clicks).padStart(4)}c`
      )
    }
  }

  console.log('\n' + '='.repeat(70))
  console.log('  END BING REPORT')
  console.log('='.repeat(70) + '\n')
}

function saveReport(report: BingReport): void {
  const reportsDir = path.resolve(__dirname, '..', 'reports')
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true })
  const filename = `bing-report-${new Date().toISOString().split('T')[0]}.json`
  const filepath = path.join(reportsDir, filename)
  fs.writeFileSync(filepath, JSON.stringify(report, null, 2))
  console.log(`  Report saved to: ${filepath}`)
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const jsonOnly = args.includes('--json')

  try {
    const report = await generateReport()
    if (jsonOnly) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      printReport(report)
    }
    saveReport(report)
  } catch (error: any) {
    if (error.message?.includes('401') || error.message?.includes('403')) {
      console.error('\n  Bing API authentication failed. Check your API key in .env\n')
    } else {
      console.error('\n  Error:', error.message || error)
    }
    process.exit(1)
  }
}

main()
