/**
 * Google Search Console Integration
 *
 * Pulls search performance data from GSC and generates actionable reports.
 *
 * Setup:
 *   1. Go to https://console.cloud.google.com/apis/credentials/consent?project=triply-pro
 *      - Configure OAuth consent screen (Internal or External)
 *      - App name: "Triply GSC", add your email
 *      - Add scope: https://www.googleapis.com/auth/webmasters.readonly
 *      - If External: add your email as a test user
 *   2. Go to https://console.cloud.google.com/apis/credentials?project=triply-pro
 *      - + CREATE CREDENTIALS → OAuth client ID → Desktop app → Name: "Triply GSC"
 *      - Download JSON → save as `gsc-oauth.json` in blog-engine root
 *   3. Run: npm run gsc:auth
 *      - Opens browser → sign in with your Google account that owns GSC
 *      - Saves refresh token to gsc-token.json (one-time)
 *   4. Run: npm run gsc
 */

import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { config } from 'dotenv'
import http from 'http'
import { execFile } from 'child_process'
import { URL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

// ── Config ──────────────────────────────────────────────────────────────────

const SITE_URL = 'sc-domain:triplypro.com'
const OAUTH_PATH = path.resolve(__dirname, '..', 'gsc-oauth.json')
const TOKEN_PATH = path.resolve(__dirname, '..', 'gsc-token.json')
const REDIRECT_PORT = 3456
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`

// ── Types ───────────────────────────────────────────────────────────────────

interface GSCRow {
  keys: string[]
  clicks: number
  impressions: number
  ctr: number
  position: number
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

interface AirportClusterReport {
  airportCode: string
  totalClicks: number
  totalImpressions: number
  avgPosition: number
  avgCtr: number
  pageCount: number
  topPages: PageData[]
  topQueries: QueryData[]
  underperformingPages: PageData[]
  quickWins: QueryData[]
}

interface FullReport {
  dateRange: { start: string; end: string }
  totals: { clicks: number; impressions: number; ctr: number; position: number }
  blogTotals: { clicks: number; impressions: number; ctr: number; position: number }
  indexedPages: number
  airportClusters: AirportClusterReport[]
  topQueries: QueryData[]
  topPages: PageData[]
  quickWins: QueryData[]
  lowCtrHighImpressions: PageData[]
}

// ── OAuth2 Auth ─────────────────────────────────────────────────────────────

function loadOAuthCredentials(): { clientId: string; clientSecret: string } {
  if (!fs.existsSync(OAUTH_PATH)) {
    console.error(`\n  OAuth credentials not found at: ${OAUTH_PATH}`)
    console.error(`\n  Setup:`)
    console.error(`  1. Go to https://console.cloud.google.com/apis/credentials?project=triply-pro`)
    console.error(`  2. + CREATE CREDENTIALS -> OAuth client ID -> Desktop app`)
    console.error(`  3. Download JSON -> save as gsc-oauth.json in blog-engine root`)
    console.error(`  4. Run: npm run gsc:auth\n`)
    process.exit(1)
  }

  const creds = JSON.parse(fs.readFileSync(OAUTH_PATH, 'utf-8'))
  const installed = creds.installed || creds.web
  if (!installed) {
    console.error('  Invalid OAuth credentials file. Download a new one from Google Cloud Console.')
    process.exit(1)
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret }
}

function createOAuth2Client(): OAuth2Client {
  const { clientId, clientSecret } = loadOAuthCredentials()
  return new OAuth2Client(clientId, clientSecret, REDIRECT_URI)
}

function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    // Use PowerShell to open URLs on Windows — cmd's start command breaks on & characters
    execFile('powershell', ['-Command', `Start-Process "${url}"`], () => {})
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => {})
  } else {
    execFile('xdg-open', [url], () => {})
  }
}

async function authenticate(): Promise<void> {
  const oauth2Client = createOAuth2Client()

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/webmasters.readonly'],
  })

  console.log('\n  Opening browser for Google sign-in...')
  console.log(`  If browser doesn't open, go to:\n`)
  console.log(`  ${authUrl}\n`)

  openBrowser(authUrl)

  // Start local server to catch the redirect
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`)
        const code = url.searchParams.get('code')

        // Ignore favicon and other non-auth requests
        if (!code && !url.searchParams.has('error')) {
          res.writeHead(200)
          res.end()
          return
        }

        if (!code) {
          const error = url.searchParams.get('error') || 'No authorization code'
          res.writeHead(400, { 'Content-Type': 'text/html' })
          res.end(`<h2>Error: ${error}</h2>`)
          server.close()
          reject(new Error(error))
          return
        }

        const { tokens } = await oauth2Client.getToken(code)
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2))

        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
          <html><body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h2 style="color: #22c55e;">GSC Connected Successfully!</h2>
            <p>You can close this tab and return to the terminal.</p>
            <p style="color: #666;">Token saved. Run <code>npm run gsc</code> to pull your report.</p>
          </body></html>
        `)

        console.log('\n  Authenticated successfully! Token saved to gsc-token.json')
        console.log('  Run: npm run gsc\n')

        server.close()
        resolve()
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'text/html' })
        res.end(`<h2>Error: ${err.message}</h2>`)
        server.close()
        reject(err)
      }
    })

    server.listen(REDIRECT_PORT, () => {
      console.log(`  Waiting for Google sign-in (listening on port ${REDIRECT_PORT})...`)
    })

    setTimeout(() => {
      server.close()
      reject(new Error('Authentication timed out after 2 minutes'))
    }, 120000)
  })
}

function getAuthenticatedClient(): OAuth2Client {
  if (!fs.existsSync(TOKEN_PATH)) {
    console.error('\n  Not authenticated. Run: npm run gsc:auth\n')
    process.exit(1)
  }

  const oauth2Client = createOAuth2Client()
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
  oauth2Client.setCredentials(tokens)

  oauth2Client.on('tokens', (newTokens) => {
    const existing = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
    const merged = { ...existing, ...newTokens }
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2))
  })

  return oauth2Client
}

// ── Airport Detection ───────────────────────────────────────────────────────

function detectAirportCode(slug: string): string | null {
  const airportNameMap: Record<string, string> = {
    'jfk': 'JFK', 'kennedy': 'JFK',
    'laguardia': 'LGA', 'lga': 'LGA',
    'sfo': 'SFO', 'san-francisco': 'SFO',
    'boston-logan': 'BOS', 'logan': 'BOS', 'bos': 'BOS',
    'san-diego': 'SAN',
    'lax': 'LAX', 'los-angeles': 'LAX',
    'newark': 'EWR', 'ewr': 'EWR',
    'reagan': 'DCA', 'dca': 'DCA',
    'dulles': 'IAD', 'iad': 'IAD',
    'miami': 'MIA', 'mia': 'MIA',
    'fort-lauderdale': 'FLL', 'fll': 'FLL',
    'philadelphia': 'PHL', 'phl': 'PHL',
    'seattle': 'SEA', 'sea-tac': 'SEA', 'sea': 'SEA',
    'denver': 'DEN', 'den': 'DEN',
    'ohare': 'ORD', 'ord': 'ORD',
    'bwi': 'BWI', 'baltimore': 'BWI',
    'tampa': 'TPA', 'tpa': 'TPA',
    'charlotte': 'CLT', 'clt': 'CLT',
    'orlando': 'MCO', 'mco': 'MCO',
    'minneapolis': 'MSP', 'msp': 'MSP',
    'portland': 'PDX', 'pdx': 'PDX',
    'phoenix': 'PHX', 'phx': 'PHX', 'sky-harbor': 'PHX',
    'austin': 'AUS', 'aus': 'AUS', 'bergstrom': 'AUS',
    'salt-lake': 'SLC', 'slc': 'SLC',
    'las-vegas': 'LAS', 'las': 'LAS', 'harry-reid': 'LAS', 'mccarran': 'LAS',
    'nashville': 'BNA', 'bna': 'BNA',
    'atlanta': 'ATL', 'atl': 'ATL', 'hartsfield': 'ATL',
    'dallas': 'DFW', 'dfw': 'DFW', 'fort-worth': 'DFW',
    'detroit': 'DTW', 'dtw': 'DTW',
    'houston': 'IAH', 'iah': 'IAH', 'bush': 'IAH',
  }

  for (const [pattern, code] of Object.entries(airportNameMap)) {
    if (slug.includes(pattern)) return code
  }
  return null
}

function getDateRange(days: number): { start: string; end: string } {
  const end = new Date()
  end.setDate(end.getDate() - 1)
  const start = new Date(end)
  start.setDate(start.getDate() - days)
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
  }
}

// ── API Calls ───────────────────────────────────────────────────────────────

async function querySearchAnalytics(
  searchconsole: ReturnType<typeof google.searchconsole>,
  params: {
    startDate: string
    endDate: string
    dimensions: string[]
    dimensionFilterGroups?: Array<{
      groupType: string
      filters: Array<{ dimension: string; operator: string; expression: string }>
    }>
    rowLimit?: number
    startRow?: number
  }
): Promise<GSCRow[]> {
  return paginateRows(async (startRow, pageSize) => {
    const response = await searchconsole.searchanalytics.query({
      siteUrl: SITE_URL,
      requestBody: {
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: params.dimensions,
        dimensionFilterGroups: params.dimensionFilterGroups,
        rowLimit: pageSize,
        startRow,
      },
    })
    return (response.data.rows || []).map(r => ({
      keys: r.keys || [],
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: r.ctr || 0,
      position: r.position || 0,
    }))
  }, params.rowLimit || 25000, params.startRow || 0)
}

/** GSC's hard per-request maximum. */
export const GSC_PAGE_SIZE = 25000

/**
 * Page through a GSC Search Analytics result with startRow until a short page
 * (or `rowLimit` rows). Pass rowLimit = Infinity to read the whole result set.
 * Split out so the paging rule is unit-testable without the network.
 */
export async function paginateRows<T>(
  fetchPage: (startRow: number, pageSize: number) => Promise<T[]>,
  rowLimit: number,
  startRow = 0,
): Promise<T[]> {
  const allRows: T[] = []
  const pageSize = Math.min(rowLimit, GSC_PAGE_SIZE)
  while (true) {
    const rows = await fetchPage(startRow, pageSize)
    if (rows.length === 0) break
    allRows.push(...rows)
    if (rows.length < pageSize) break
    startRow += pageSize
    if (allRows.length >= rowLimit) break
  }
  return allRows.length > rowLimit ? allRows.slice(0, rowLimit) : allRows
}

// ── Single-URL performance (for the perf loop) ───────────────────────────────

export interface UrlQueryStat {
  query: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface UrlPerformance {
  slug: string
  url: string | null
  found: boolean
  dateRange: { start: string; end: string }
  totals: { clicks: number; impressions: number; ctr: number; position: number }
  queries: UrlQueryStat[]
}

function normalizeBlogSlug(pageUrl: string): string {
  return pageUrl.replace(/^https?:\/\/[^/]+\/blog\//, '').replace(/\/$/, '')
}

/**
 * Pull GSC performance for a SINGLE blog article by slug: page-level totals plus
 * the per-query breakdown for that exact URL. Reuses the OAuth client + query
 * helper used by the full report. Returns found:false (zeros) when the URL has no
 * GSC data in range (brand new, not indexed, or zero impressions).
 *
 * Caveats baked into the design: GSC data lags ~2-3 days, and CTR is unreliable
 * after the 2025-2026 impression logging bug — downstream consumers should treat
 * impressions + position as the trustworthy signals, CTR as diagnostic only.
 */
export async function fetchUrlPerformance(slug: string, days: number = 28): Promise<UrlPerformance> {
  const auth = getAuthenticatedClient()
  const searchconsole = google.searchconsole({ version: 'v1', auth })
  const { start, end } = getDateRange(days)

  // Step 1 — locate the exact page URL + its totals via a contains filter.
  const pageRows = await querySearchAnalytics(searchconsole, {
    startDate: start, endDate: end,
    dimensions: ['page'],
    dimensionFilterGroups: [{
      groupType: 'and',
      filters: [{ dimension: 'page', operator: 'contains', expression: `/blog/${slug}` }],
    }],
  })

  // contains can catch slug-prefixed siblings (e.g. foo vs foo-2) — keep exact matches only.
  const exact = pageRows.filter(r => normalizeBlogSlug(r.keys[0]) === slug)

  if (exact.length === 0) {
    return {
      slug, url: null, found: false,
      dateRange: { start, end },
      totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
      queries: [],
    }
  }

  // Aggregate defensively (usually one row; sum if GSC split http/https or www variants).
  const totalImpr = exact.reduce((s, r) => s + r.impressions, 0)
  const totalClicks = exact.reduce((s, r) => s + r.clicks, 0)
  const totals = {
    clicks: totalClicks,
    impressions: totalImpr,
    ctr: totalImpr > 0 ? totalClicks / totalImpr : 0,
    position: totalImpr > 0
      ? exact.reduce((s, r) => s + r.position * r.impressions, 0) / totalImpr
      : exact.reduce((s, r) => s + r.position, 0) / exact.length,
  }
  const url = [...exact].sort((a, b) => b.impressions - a.impressions)[0].keys[0]

  // Step 2 — per-query breakdown for that exact URL.
  const queryRows = await querySearchAnalytics(searchconsole, {
    startDate: start, endDate: end,
    dimensions: ['query'],
    dimensionFilterGroups: [{
      groupType: 'and',
      filters: [{ dimension: 'page', operator: 'equals', expression: url }],
    }],
  })

  const queries: UrlQueryStat[] = queryRows
    .map(r => ({
      query: r.keys[0],
      clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
    }))
    .sort((a, b) => b.impressions - a.impressions)

  return { slug, url, found: true, dateRange: { start, end }, totals, queries }
}

// ── Query↔Page pairs (for the cannibalization audit) ─────────────────────────

export interface QueryPageRow {
  query: string
  page: string
  slug: string
  clicks: number
  impressions: number
  position: number
}

/**
 * Pull every (query, blog-page) pair from GSC. Used to detect cannibalization —
 * one search query that multiple of our pages rank for, splitting authority.
 * Reuses the same OAuth client + paginated query helper as the rest of gsc.ts.
 * Reads the WHOLE result set (~486k pairs over 90 days, ~20 requests) — it used to
 * stop at 25,000 rows, so the audit only ever saw the top ~5% of pairs.
 */
export async function fetchQueryPagePairs(days = 90, minImpressions = 5): Promise<QueryPageRow[]> {
  const auth = getAuthenticatedClient()
  const searchconsole = google.searchconsole({ version: 'v1', auth })
  const { start, end } = getDateRange(days)

  const rows = await querySearchAnalytics(searchconsole, {
    startDate: start, endDate: end,
    dimensions: ['query', 'page'],
    dimensionFilterGroups: [{
      groupType: 'and',
      filters: [{ dimension: 'page', operator: 'contains', expression: '/blog/' }],
    }],
    rowLimit: Infinity,
  })

  return rows
    .filter(r => r.impressions >= minImpressions && r.keys.length >= 2)
    .map(r => ({
      query: r.keys[0],
      page: r.keys[1],
      // GSC reports #anchor and ?page=2 variants as separate pages — same document, so collapse them.
      slug: normalizeBlogSlug(r.keys[1].replace(/[?#].*$/, '')),
      clicks: r.clicks, impressions: r.impressions, position: r.position,
    }))
}

// ── Bulk page performance (for tracking every article cheaply) ───────────────

export interface BlogPagePerf { slug: string; url: string; clicks: number; impressions: number; ctr: number; position: number }

/**
 * ONE GSC query for ALL blog pages' totals — the cheap way to snapshot the whole
 * corpus (vs one fetchUrlPerformance call per article). Returns a slug→perf map.
 */
export async function fetchAllBlogPagePerf(days = 28): Promise<{ dateRange: { start: string; end: string }; pages: Map<string, BlogPagePerf> }> {
  const auth = getAuthenticatedClient()
  const searchconsole = google.searchconsole({ version: 'v1', auth })
  const { start, end } = getDateRange(days)

  const rows = await querySearchAnalytics(searchconsole, {
    startDate: start, endDate: end,
    dimensions: ['page'],
    dimensionFilterGroups: [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'contains', expression: '/blog/' }] }],
    rowLimit: 25000,
  })

  const pages = new Map<string, BlogPagePerf>()
  for (const r of rows) {
    const url = r.keys[0]
    const slug = normalizeBlogSlug(url)
    const prev = pages.get(slug)
    if (!prev) { pages.set(slug, { slug, url, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }); continue }
    // GSC occasionally splits http/https/trailing-slash variants — aggregate them.
    const totalImpr = prev.impressions + r.impressions
    prev.position = totalImpr > 0 ? (prev.position * prev.impressions + r.position * r.impressions) / totalImpr : prev.position
    prev.clicks += r.clicks
    prev.impressions = totalImpr
    prev.ctr = totalImpr > 0 ? prev.clicks / totalImpr : 0
    if (r.impressions > 0 && r.impressions >= prev.impressions - r.impressions) prev.url = url
  }
  return { dateRange: { start, end }, pages }
}

// ── Report Generation ───────────────────────────────────────────────────────

async function generateReport(days: number = 28): Promise<FullReport> {
  const auth = getAuthenticatedClient()
  const searchconsole = google.searchconsole({ version: 'v1', auth })
  const { start, end } = getDateRange(days)

  console.log(`\n  Pulling GSC data for ${SITE_URL}`)
  console.log(`  Date range: ${start} to ${end} (${days} days)\n`)

  console.log('  Fetching blog queries...')
  const blogQueryRows = await querySearchAnalytics(searchconsole, {
    startDate: start, endDate: end,
    dimensions: ['query'],
    dimensionFilterGroups: [{
      groupType: 'and',
      filters: [{ dimension: 'page', operator: 'contains', expression: '/blog/' }],
    }],
  })

  console.log('  Fetching blog pages...')
  const blogPageRows = await querySearchAnalytics(searchconsole, {
    startDate: start, endDate: end,
    dimensions: ['page'],
    dimensionFilterGroups: [{
      groupType: 'and',
      filters: [{ dimension: 'page', operator: 'contains', expression: '/blog/' }],
    }],
  })

  console.log('  Fetching site totals...')
  const siteTotalRows = await querySearchAnalytics(searchconsole, {
    startDate: start, endDate: end,
    dimensions: ['date'],
  })

  console.log('  Fetching query-page combinations...')
  const queryPageRows = await querySearchAnalytics(searchconsole, {
    startDate: start, endDate: end,
    dimensions: ['query', 'page'],
    dimensionFilterGroups: [{
      groupType: 'and',
      filters: [{ dimension: 'page', operator: 'contains', expression: '/blog/' }],
    }],
  })

  // Process site totals
  const siteTotals = siteTotalRows.reduce(
    (acc, row) => ({
      clicks: acc.clicks + row.clicks,
      impressions: acc.impressions + row.impressions,
      ctr: 0, position: 0,
    }),
    { clicks: 0, impressions: 0, ctr: 0, position: 0 }
  )
  siteTotals.ctr = siteTotals.impressions > 0 ? siteTotals.clicks / siteTotals.impressions : 0
  siteTotals.position = siteTotalRows.length > 0
    ? siteTotalRows.reduce((sum, r) => sum + r.position, 0) / siteTotalRows.length : 0

  // Process blog totals
  const blogTotals = blogPageRows.reduce(
    (acc, row) => ({
      clicks: acc.clicks + row.clicks,
      impressions: acc.impressions + row.impressions,
      ctr: 0, position: 0,
    }),
    { clicks: 0, impressions: 0, ctr: 0, position: 0 }
  )
  blogTotals.ctr = blogTotals.impressions > 0 ? blogTotals.clicks / blogTotals.impressions : 0
  blogTotals.position = blogPageRows.length > 0
    ? blogPageRows.reduce((sum, r) => sum + r.position * r.impressions, 0) /
      blogPageRows.reduce((sum, r) => sum + r.impressions, 0) : 0

  const pages: PageData[] = blogPageRows
    .map(row => ({
      page: row.keys[0],
      slug: row.keys[0].replace(/^https?:\/\/[^/]+\/blog\//, '').replace(/\/$/, ''),
      clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position,
    }))
    .sort((a, b) => b.impressions - a.impressions)

  const queries: QueryData[] = blogQueryRows
    .map(row => ({
      query: row.keys[0],
      clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position,
    }))
    .sort((a, b) => b.impressions - a.impressions)

  // Group by airport cluster
  const airportMap = new Map<string, { pages: PageData[]; queries: Set<string> }>()
  for (const page of pages) {
    const code = detectAirportCode(page.slug)
    if (!code) continue
    if (!airportMap.has(code)) airportMap.set(code, { pages: [], queries: new Set() })
    airportMap.get(code)!.pages.push(page)
  }
  for (const row of queryPageRows) {
    const slug = row.keys[1].replace(/^https?:\/\/[^/]+\/blog\//, '').replace(/\/$/, '')
    const code = detectAirportCode(slug)
    if (code && airportMap.has(code)) airportMap.get(code)!.queries.add(row.keys[0])
  }

  const airportClusters: AirportClusterReport[] = []
  for (const [code, data] of airportMap.entries()) {
    const clusterQueries = queries.filter(q => data.queries.has(q.query))
    const totalClicks = data.pages.reduce((sum, p) => sum + p.clicks, 0)
    const totalImpressions = data.pages.reduce((sum, p) => sum + p.impressions, 0)

    airportClusters.push({
      airportCode: code,
      totalClicks, totalImpressions,
      avgPosition: totalImpressions > 0
        ? data.pages.reduce((sum, p) => sum + p.position * p.impressions, 0) / totalImpressions : 0,
      avgCtr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
      pageCount: data.pages.length,
      topPages: [...data.pages].sort((a, b) => b.clicks - a.clicks).slice(0, 10),
      topQueries: clusterQueries.sort((a, b) => b.clicks - a.clicks).slice(0, 15),
      underperformingPages: data.pages
        .filter(p => p.impressions >= 50 && p.ctr < 0.02)
        .sort((a, b) => b.impressions - a.impressions).slice(0, 10),
      quickWins: clusterQueries
        .filter(q => q.position >= 5 && q.position <= 20 && q.impressions >= 10)
        .sort((a, b) => b.impressions - a.impressions).slice(0, 10),
    })
  }
  airportClusters.sort((a, b) => b.totalImpressions - a.totalImpressions)

  return {
    dateRange: { start, end },
    totals: siteTotals,
    blogTotals: blogTotals,
    indexedPages: pages.length,
    airportClusters,
    topQueries: queries.slice(0, 30),
    topPages: pages.slice(0, 20),
    quickWins: queries
      .filter(q => q.position >= 5 && q.position <= 20 && q.impressions >= 10)
      .sort((a, b) => b.impressions - a.impressions).slice(0, 25),
    lowCtrHighImpressions: pages
      .filter(p => p.impressions >= 50 && p.ctr < 0.02)
      .sort((a, b) => b.impressions - a.impressions).slice(0, 15),
  }
}

// ── Display ─────────────────────────────────────────────────────────────────

function printReport(report: FullReport): void {
  const { dateRange, totals, blogTotals, indexedPages, airportClusters, topQueries, topPages, quickWins, lowCtrHighImpressions } = report

  console.log('\n' + '='.repeat(70))
  console.log('  GOOGLE SEARCH CONSOLE REPORT -- triplypro.com')
  console.log('  ' + dateRange.start + ' to ' + dateRange.end)
  console.log('='.repeat(70))

  console.log('\n  SITE-WIDE TOTALS')
  console.log('  -----------------------------------------')
  console.log(`  Clicks:       ${totals.clicks.toLocaleString()}`)
  console.log(`  Impressions:  ${totals.impressions.toLocaleString()}`)
  console.log(`  CTR:          ${(totals.ctr * 100).toFixed(2)}%`)
  console.log(`  Avg Position: ${totals.position.toFixed(1)}`)

  console.log('\n  BLOG TOTALS (/blog/*)')
  console.log('  -----------------------------------------')
  console.log(`  Clicks:       ${blogTotals.clicks.toLocaleString()}`)
  console.log(`  Impressions:  ${blogTotals.impressions.toLocaleString()}`)
  console.log(`  CTR:          ${(blogTotals.ctr * 100).toFixed(2)}%`)
  console.log(`  Avg Position: ${blogTotals.position.toFixed(1)}`)
  console.log(`  Indexed Pages: ${indexedPages}`)

  if (airportClusters.length > 0) {
    console.log('\n  AIRPORT CLUSTER PERFORMANCE')
    console.log('  -----------------------------------------')
    console.log('  Code  Pages  Clicks  Impressions  Avg Pos   CTR')
    console.log('  ----  -----  ------  -----------  -------  -----')
    for (const c of airportClusters) {
      console.log(
        `  ${c.airportCode.padEnd(6)}${String(c.pageCount).padStart(5)}  ` +
        `${String(c.totalClicks).padStart(6)}  ${String(c.totalImpressions).padStart(11)}  ` +
        `${c.avgPosition.toFixed(1).padStart(7)}  ${(c.avgCtr * 100).toFixed(2).padStart(5)}%`
      )
    }
  }

  console.log('\n  TOP PAGES (by clicks)')
  console.log('  -----------------------------------------')
  for (const p of topPages.slice(0, 15)) {
    const slug = p.slug.length > 45 ? p.slug.slice(0, 42) + '...' : p.slug
    console.log(
      `  ${slug.padEnd(47)} ${String(p.clicks).padStart(4)}c  ` +
      `${String(p.impressions).padStart(6)}i  pos ${p.position.toFixed(1).padStart(5)}  ` +
      `${(p.ctr * 100).toFixed(1).padStart(5)}%`
    )
  }

  console.log('\n  TOP QUERIES (by impressions)')
  console.log('  -----------------------------------------')
  for (const q of topQueries.slice(0, 20)) {
    const query = q.query.length > 45 ? q.query.slice(0, 42) + '...' : q.query
    console.log(
      `  ${query.padEnd(47)} ${String(q.clicks).padStart(4)}c  ` +
      `${String(q.impressions).padStart(6)}i  pos ${q.position.toFixed(1).padStart(5)}  ` +
      `${(q.ctr * 100).toFixed(1).padStart(5)}%`
    )
  }

  if (quickWins.length > 0) {
    console.log('\n  QUICK WINS (position 5-20, 10+ impressions)')
    console.log('  Close to page 1 -- optimize to boost rankings')
    console.log('  -----------------------------------------')
    for (const q of quickWins.slice(0, 15)) {
      const query = q.query.length > 45 ? q.query.slice(0, 42) + '...' : q.query
      console.log(
        `  ${query.padEnd(47)} pos ${q.position.toFixed(1).padStart(5)}  ` +
        `${String(q.impressions).padStart(6)}i  ${String(q.clicks).padStart(4)}c`
      )
    }
  }

  if (lowCtrHighImpressions.length > 0) {
    console.log('\n  LOW CTR PAGES (50+ impressions, <2% CTR)')
    console.log('  Showing in search but not getting clicks -- fix titles/meta')
    console.log('  -----------------------------------------')
    for (const p of lowCtrHighImpressions.slice(0, 10)) {
      const slug = p.slug.length > 45 ? p.slug.slice(0, 42) + '...' : p.slug
      console.log(
        `  ${slug.padEnd(47)} ${(p.ctr * 100).toFixed(1).padStart(5)}% CTR  ` +
        `${String(p.impressions).padStart(6)}i  pos ${p.position.toFixed(1).padStart(5)}`
      )
    }
  }

  for (const cluster of airportClusters.filter(c => c.totalImpressions >= 50)) {
    console.log(`\n  -- ${cluster.airportCode} CLUSTER DEEP DIVE --`)
    console.log(`  Pages: ${cluster.pageCount} | Clicks: ${cluster.totalClicks} | Impressions: ${cluster.totalImpressions}`)

    if (cluster.topPages.length > 0) {
      console.log('\n  Top pages:')
      for (const p of cluster.topPages.slice(0, 5)) {
        const slug = p.slug.length > 40 ? p.slug.slice(0, 37) + '...' : p.slug
        console.log(`    ${slug.padEnd(42)} ${String(p.clicks).padStart(4)}c  ${String(p.impressions).padStart(5)}i  pos ${p.position.toFixed(1)}`)
      }
    }

    if (cluster.quickWins.length > 0) {
      console.log('\n  Quick wins (almost page 1):')
      for (const q of cluster.quickWins.slice(0, 5)) {
        const query = q.query.length > 40 ? q.query.slice(0, 37) + '...' : q.query
        console.log(`    ${query.padEnd(42)} pos ${q.position.toFixed(1).padStart(5)}  ${String(q.impressions).padStart(5)}i`)
      }
    }

    if (cluster.underperformingPages.length > 0) {
      console.log('\n  Underperforming (high imp, low CTR):')
      for (const p of cluster.underperformingPages.slice(0, 5)) {
        const slug = p.slug.length > 40 ? p.slug.slice(0, 37) + '...' : p.slug
        console.log(`    ${slug.padEnd(42)} ${(p.ctr * 100).toFixed(1)}% CTR  ${String(p.impressions).padStart(5)}i`)
      }
    }
  }

  console.log('\n' + '='.repeat(70))
  console.log('  END REPORT')
  console.log('='.repeat(70) + '\n')
}

function saveReport(report: FullReport): string {
  const reportsDir = path.resolve(__dirname, '..', 'reports')
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true })
  const filename = `gsc-report-${report.dateRange.start}-to-${report.dateRange.end}.json`
  const filepath = path.join(reportsDir, filename)
  fs.writeFileSync(filepath, JSON.stringify(report, null, 2))
  console.log(`  Report saved to: ${filepath}`)
  return filepath
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--auth') || args.includes('auth')) {
    await authenticate()
    return
  }

  const days = args.includes('--days')
    ? parseInt(args[args.indexOf('--days') + 1], 10) : 28
  const jsonOnly = args.includes('--json')

  try {
    const report = await generateReport(days)
    if (jsonOnly) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      printReport(report)
    }
    saveReport(report)
  } catch (error: any) {
    if (error.message?.includes('Not authenticated') || error.message?.includes('token')) {
      console.error('\n  Not authenticated. Run: npm run gsc:auth\n')
    } else if (error.code === 403 || error.status === 403) {
      console.error('\n  GSC API access denied. Make sure:')
      console.error('  1. Search Console API is enabled in Google Cloud Console')
      console.error('  2. You signed in with the Google account that owns the GSC property\n')
    } else {
      console.error('\n  Error:', error.message || error)
      if (error.errors) console.error('  Details:', JSON.stringify(error.errors, null, 2))
    }
    process.exit(1)
  }
}

// Only run the CLI when invoked directly (e.g. `tsx src/gsc.ts`), NOT when this
// module is imported by the perf loop — importing must not trigger a full report.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) main()
