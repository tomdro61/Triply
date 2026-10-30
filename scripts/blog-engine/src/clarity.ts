/**
 * clarity.ts — pull Microsoft Clarity behavior data, tabulate it, and (optionally)
 * have Claude turn it into a prioritized list of UX/content fixes.
 *
 * Clarity's Data Export API returns AGGREGATED behavior JSON (not session
 * recordings — those stay in the Clarity UI): traffic, engagement time, scroll
 * depth, and the frustration signals that predict lost bookings — dead clicks,
 * rage clicks, quickback clicks, excessive scroll, script/error clicks — broken
 * down by dimension (we pull overall + by URL + by Device).
 *
 * HARD CONSTRAINT (why this makes a FIXED, small number of calls — never a loop):
 *   - Max 10 API requests / project / DAY · only the last 1–3 days · ≤1,000 rows.
 * Each run here makes 3 calls (overall, URL, Device), well under the cap.
 *
 * Setup: Clarity → Settings → Data Export → Generate new API token → set
 * CLARITY_API_TOKEN in .env.
 *
 * CLI:
 *   tsx src/clarity.ts insights [days]   # fetch + print tables (default; days 1-3)
 *   tsx src/clarity.ts suggest  [days]   # same, then Claude → ranked UX fixes (saved)
 *   tsx src/clarity.ts 3                 # back-compat: bare number = insights
 */

import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import Anthropic from '@anthropic-ai/sdk'
import { env, DOMAIN, MODEL_PRICING } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLARITY_API = 'https://www.clarity.ms/export-data/api/v1/project-live-insights'
const SUGGEST_MODEL = 'claude-haiku-4-5-20251001' // cheap; analysis, not the product
const reportsDir = path.resolve(__dirname, '..', 'reports')

interface ClarityMetric {
  metricName: string
  information: { [k: string]: string | undefined }[]
}

function requireToken(): string {
  const t = (env.CLARITY_API_TOKEN || '').trim()
  if (!t) { console.error('CLARITY_API_TOKEN missing from .env (Clarity → Settings → Data Export → Generate new API token)'); process.exit(1) }
  return t
}

async function fetchInsights(numOfDays: 1 | 2 | 3, dims: string[] = []): Promise<ClarityMetric[]> {
  const token = requireToken()
  const qs = new URLSearchParams({ numOfDays: String(numOfDays) })
  dims.forEach((d, i) => qs.append(`dimension${i + 1}`, d))
  const res = await fetch(`${CLARITY_API}?${qs.toString()}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const body = await res.text()
    // 401 bad/expired token · 403 not authorized · 429 daily 10-call limit hit.
    throw new Error(`Clarity API ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

function pickNum(info: Record<string, string | undefined>, keys: string[]): number {
  for (const k of keys) {
    const v = info[k]
    if (v !== undefined && v !== null && v !== '') return parseFloat(v) || 0
  }
  return 0
}

/** Fetch overall + by-URL + by-Device (3 API calls). Returns the raw metric arrays. */
async function collectAll(days: 1 | 2 | 3): Promise<{ overall: ClarityMetric[]; byUrl: ClarityMetric[]; byDevice: ClarityMetric[] }> {
  const overall = await fetchInsights(days)
  let byUrl: ClarityMetric[] = []
  let byDevice: ClarityMetric[] = []
  try { byUrl = await fetchInsights(days, ['URL']) } catch (e) { console.log(`  (URL breakdown failed: ${e instanceof Error ? e.message : e})`) }
  try { byDevice = await fetchInsights(days, ['Device']) } catch { console.log('  (device breakdown failed)') }
  return { overall, byUrl, byDevice }
}

function printInsights(days: number, data: { overall: ClarityMetric[]; byUrl: ClarityMetric[]; byDevice: ClarityMetric[] }): void {
  const { overall, byUrl, byDevice } = data
  console.log(`\n🔍 Clarity Insights — last ${days} day(s)\n`)

  console.log('=== OVERALL (last ' + days + 'd) ===')
  for (const m of overall) {
    const info = m.information[0] || {}
    // Behavior metrics carry their real count in subTotal; Traffic uses session count.
    const count = m.metricName === 'Traffic'
      ? pickNum(info, ['totalSessionCount', 'sessionsCount'])
      : pickNum(info, ['subTotal', 'sessionsCount', 'totalSessionCount'])
    const pct = pickNum(info, ['sessionsWithMetricPercentage'])
    console.log(`  ${m.metricName.padEnd(20)} ${String(count).padStart(8)}${pct ? `  (${pct.toFixed(1)}% of sessions)` : ''}`)
  }

  console.log('\n=== BY URL (top 15 by dead+rage clicks) ===')
  const pages: Record<string, Record<string, number>> = {}
  for (const m of byUrl) for (const info of m.information) {
    const url = (info.Url || info.URL || info.url) as string | undefined
    if (!url) continue // skip the null-URL aggregate row
    if (!pages[url]) pages[url] = {}
    // Traffic rows carry session counts; behavior rows carry the count in subTotal.
    pages[url][m.metricName] = m.metricName === 'Traffic'
      ? pickNum(info, ['totalSessionCount', 'sessionsCount'])
      : pickNum(info, ['subTotal', 'sessionsCount'])
  }
  // Rank by friction (dead+rage) so the worst pages surface first.
  const sorted = Object.entries(pages).sort((a, b) =>
    ((b[1].DeadClickCount || 0) + (b[1].RageClickCount || 0)) - ((a[1].DeadClickCount || 0) + (a[1].RageClickCount || 0)))
  console.log(`${'Page'.padEnd(52)} ${'Sess'.padStart(5)} ${'Rage'.padStart(5)} ${'Dead'.padStart(5)} ${'QBack'.padStart(5)} ${'ErrSc'.padStart(5)}`)
  for (const [url, m] of sorted.slice(0, 15)) {
    const short = url.replace(/^https?:\/\/(www\.)?triplypro\.com/, '').slice(0, 51)
    console.log(`${short.padEnd(52)} ${String(m.Traffic || 0).padStart(5)} ${String(m.RageClickCount || 0).padStart(5)} ${String(m.DeadClickCount || 0).padStart(5)} ${String(m.QuickbackClick || 0).padStart(5)} ${String(m.ScriptErrorCount || 0).padStart(5)}`)
  }

  console.log('\n=== BY DEVICE ===')
  const devices: Record<string, Record<string, number>> = {}
  for (const m of byDevice) for (const info of m.information) {
    const dev = info.Device
    if (!dev) continue
    if (!devices[dev]) devices[dev] = {}
    devices[dev][m.metricName] = m.metricName === 'Traffic'
      ? pickNum(info, ['totalSessionCount', 'sessionsCount'])
      : pickNum(info, ['subTotal', 'sessionsCount'])
  }
  for (const [dev, m] of Object.entries(devices)) console.log(`  ${dev.padEnd(12)} sessions=${m.Traffic || 0} rage=${m.RageClickCount || 0} dead=${m.DeadClickCount || 0} qback=${m.QuickbackClick || 0}`)
}

/** Send the raw behavior data to Claude → prioritized, page-specific UX fixes.
 *  Exported so the maintenance loop can consume Clarity signals later. */
export async function suggestFromClarity(data: { overall: ClarityMetric[]; byUrl: ClarityMetric[]; byDevice: ClarityMetric[] }): Promise<{ text: string; cost: number }> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  const trim = (ms: ClarityMetric[]) => ms.map((m) => ({ metricName: m.metricName, information: (m.information || []).slice(0, 40) }))
  const payload = { overall: trim(data.overall), byUrl: trim(data.byUrl), byDevice: trim(data.byDevice) }

  const system = `You are a senior CRO/UX analyst for ${DOMAIN}, an airport-parking marketplace. You are given AGGREGATED Microsoft Clarity behavior data (by page URL and device): session counts, engagement time, scroll depth, and frustration signals — dead clicks, rage clicks, quickback clicks, excessive scroll, script/error clicks.

Produce a PRIORITIZED action list. For each issue:
  1. Page/area affected (URL if available).
  2. The metric that triggered it, WITH the number (e.g. "rage clicks = 34 on /blog/jfk-...").
  3. Most likely cause (broken/ambiguous element, dead-end, slow/confusing section, weak CTA, mobile layout).
  4. A specific fix — and tag it [CONTENT] (feeds our blog engine) or [UI] (frontend dev work).
Rank by impact on conversion to a parking booking. Terse, specific, no preamble. If data is too sparse to conclude, say so plainly.`

  const res = await client.messages.create({
    model: SUGGEST_MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: `Clarity data (JSON):\n\n${JSON.stringify(payload, null, 1)}` }],
  })
  const block = res.content.find((b) => b.type === 'text')
  const text = block && block.type === 'text' ? block.text : '(no suggestions returned)'
  const u = res.usage as unknown as Record<string, number>
  const p = MODEL_PRICING[SUGGEST_MODEL]
  const cost = ((u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output) / 1_000_000
  return { text, cost }
}

async function main() {
  const arg0 = process.argv[2]
  const cmd = arg0 === 'suggest' ? 'suggest' : 'insights'
  const daysArg = arg0 && /^[123]$/.test(arg0) ? arg0 : (process.argv[3] || '3')
  const days = (parseInt(daysArg, 10) || 3) as 1 | 2 | 3

  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true })
  const data = await collectAll(days)
  printInsights(days, data)

  const today = new Date().toISOString().slice(0, 10)
  fs.writeFileSync(path.join(reportsDir, `clarity-report-${today}.json`), JSON.stringify({ days, timestamp: new Date().toISOString(), ...data }, null, 2))
  console.log(`\n📄 Saved: reports/clarity-report-${today}.json`)

  if (cmd === 'suggest') {
    console.log('\n🤖 Asking Claude for prioritized UX fixes...\n')
    const { text, cost } = await suggestFromClarity(data)
    console.log(text)
    console.log(`\n  💰 Suggestion cost: $${cost.toFixed(4)}`)
    const out = path.join(reportsDir, 'clarity', `suggestions-${today}.md`)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, `# Clarity UX suggestions — ${today}\n\n${text}\n`)
    console.log(`  📄 Saved: reports/clarity/suggestions-${today}.md\n`)
  }
}

// Only run the CLI when invoked directly — keeps the module importable (e.g. the
// maintenance loop reusing suggestFromClarity) without triggering a live fetch.
import { pathToFileURL } from 'url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('Error:', e instanceof Error ? e.message : String(e)); process.exit(1) })
}
