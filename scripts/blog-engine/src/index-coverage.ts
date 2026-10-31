/**
 * Index coverage — how many published posts Google actually has indexed, and why the rest are not.
 *
 * Read-only. Posts with impressions in the window are indexed by definition; every other post
 * goes through the URL Inspection API (quota 2,000/day, so --max caps a run).
 *
 *   npx tsx src/index-coverage.ts                 # 90-day window, inspect up to 1,900
 *   npx tsx src/index-coverage.ts --days 90 --max 500
 *
 * Writes reports/index-coverage-<date>.json and prints a tally by coverage state.
 */

import { google } from 'googleapis'
import { OAuth2Client } from 'google-auth-library'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'
import { getAllPublishedPosts } from './payload.js'
import { fetchAllBlogPagePerf } from './gsc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const args = process.argv.slice(2)
const flag = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const DAYS = parseInt(flag('--days', '90'), 10)
const MAX = parseInt(flag('--max', '1900'), 10)
const CONCURRENCY = 4
const SITE_URL = 'sc-domain:triplypro.com'

function auth(): OAuth2Client {
  const creds = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'gsc-oauth.json'), 'utf-8'))
  const c = creds.installed || creds.web
  const client = new OAuth2Client(c.client_id, c.client_secret, 'http://localhost:3456')
  client.setCredentials(JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'gsc-token.json'), 'utf-8')))
  return client
}

async function main() {
  const posts = await getAllPublishedPosts()
  const { pages } = await fetchAllBlogPagePerf(DAYS)
  const seen = new Set([...pages.keys()])
  const unseen = posts.filter(p => !seen.has(p.slug))
  console.log(`${posts.length} published · ${posts.length - unseen.length} had impressions in ${DAYS}d · ${unseen.length} to inspect (cap ${MAX})`)

  const sc = google.searchconsole({ version: 'v1', auth: auth() })
  const todo = unseen.slice(0, MAX)
  const results: Array<Record<string, unknown>> = []
  let i = 0
  async function worker() {
    while (i < todo.length) {
      const p = todo[i++]
      const url = `https://www.triplypro.com/blog/${p.slug}`
      try {
        const r = await sc.urlInspection.index.inspect({ requestBody: { inspectionUrl: url, siteUrl: SITE_URL } })
        const s = r.data.inspectionResult?.indexStatusResult ?? {}
        results.push({ slug: p.slug, airport: (p as { airportCode?: string }).airportCode, verdict: s.verdict, coverageState: s.coverageState,
          lastCrawlTime: s.lastCrawlTime, googleCanonical: s.googleCanonical, userCanonical: s.userCanonical, robotsTxtState: s.robotsTxtState, indexingState: s.indexingState })
      } catch (e) {
        const msg = (e as Error).message
        results.push({ slug: p.slug, error: msg })
        if (/quota|rate/i.test(msg)) { console.error('Quota hit — stopping'); i = todo.length }
      }
      if (results.length % 100 === 0) console.log(`  inspected ${results.length}/${todo.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const tally: Record<string, number> = {}
  for (const r of results) { const k = String(r.coverageState ?? r.error ?? 'unknown'); tally[k] = (tally[k] ?? 0) + 1 }
  const out = { date: new Date().toISOString(), days: DAYS, published: posts.length, withImpressions: posts.length - unseen.length,
    inspected: results.length, notInspected: unseen.length - todo.length, tally, results }
  const file = path.resolve(__dirname, '..', 'reports', `index-coverage-${new Date().toISOString().slice(0, 10)}.json`)
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log('\nCoverage state of posts with no impressions:')
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`)
  console.log(`\nSaved ${file}`)
}

main().catch(e => { console.error(e); process.exit(1) })
