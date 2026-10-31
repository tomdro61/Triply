/**
 * monthly-prices.ts — Marketing Plan rank 96: a dated "<Airport> parking prices — <Month YYYY>"
 * block on each airport's hub page, refreshed monthly. UPDATE-only: never creates pages.
 *
 * What it writes, per airport (one block, near the top of the hub post):
 *   H2  "<Airport> parking prices — October 2026"
 *   table: Option | Daily rate | Verified
 *     - the airport's own terminal garage / economy lot, ONLY when that onAirportParking entry
 *       carries its own `lastVerified` within --onsite-days (default 31) and a numeric dailyMax
 *     - every off-site lot that is not `sellable:false`, has `rateVerified` within --lot-days
 *       (default 7), has no `rateSpreadPct` >= --max-spread (default 25), and is not tagged
 *       with another airport's code (JFK's file carries LGA lots in Flushing)
 *   paragraph "Checked <D Month YYYY>. Book up to 100 days ahead; holiday dates sell out first."
 *
 * Idempotent: an existing block is found by its H2 text matching /parking prices — <Month> <YYYY>$/
 * and the three nodes (heading, table, "Checked" paragraph) are replaced in place. Any other
 * shape aborts that post. Everything else in the Lexical tree is verified byte-identical
 * (JSON) after the edit, and link/upload counts must be unchanged; otherwise the post is skipped.
 *
 * Edits the stored Lexical JSON directly (no HTML round-trip). Writes a pre-edit backup,
 * sets contentUpdatedAt, re-fetches to verify, and IndexNow-pings changed URLs.
 *
 * Usage:
 *   npx tsx src/monthly-prices.ts                       # dry run, all airports with qualifying rows
 *   npx tsx src/monthly-prices.ts --airports=AUS,JFK    # limit scope
 *   npx tsx src/monthly-prices.ts --apply               # write (add --stamp to move contentUpdatedAt)
 * No SerpAPI / Claude calls.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env } from './config.js'
import { updatePost } from './payload.js'
import { submitUrls, postUrlFor } from './indexnow.js'
import { stampField } from './stamp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const AIRPORT_DIR = path.join(ROOT, 'data', 'airports')
const REPORTS = path.join(ROOT, 'reports')
// Backups are per RUN, not per day: a second --apply on the same day must not overwrite the true pre-edit backup.
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-')

// ---------- args ----------
const argv = process.argv.slice(2)
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const APPLY = argv.includes('--apply')
const TODAY = arg('date') || new Date().toISOString().slice(0, 10)
const LOT_DAYS = Number(arg('lot-days') || 7)
const ONSITE_DAYS = Number(arg('onsite-days') || 31)
const MAX_SPREAD = Number(arg('max-spread') || 25)
const ONLY = arg('airports')?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3))
const [Y, M, D] = TODAY.split('-').map(Number)
const MONTH_LABEL = `${MONTHS[M - 1]} ${Y}`
const CHECKED_LABEL = `${D} ${MONTHS[M - 1]} ${Y}`
const MARKER_RE = /parking prices — [A-Z][a-z]+ \d{4}$/

const NAMES: Record<string, string> = {
  ATL: 'Atlanta airport', AUS: 'Austin airport', BNA: 'Nashville airport', BOS: 'Boston Logan',
  BWI: 'BWI airport', CLT: 'Charlotte airport', DCA: 'Reagan National (DCA)', DEN: 'Denver airport',
  DFW: 'DFW airport', DTW: 'Detroit airport', EWR: 'Newark airport', FLL: 'Fort Lauderdale airport',
  IAD: 'Dulles airport', IAH: 'Houston IAH', JFK: 'JFK airport', LAS: 'Las Vegas airport',
  LAX: 'LAX', LGA: 'LaGuardia airport', MCO: 'Orlando airport', MIA: 'Miami airport',
  MSP: 'MSP airport', ORD: "O'Hare airport", PDX: 'Portland airport', PHL: 'Philadelphia airport',
  PHX: 'Phoenix Sky Harbor', SAN: 'San Diego airport', SEA: 'Sea-Tac airport', SFO: 'SFO',
  SLC: 'Salt Lake City airport', TPA: 'Tampa airport',
}

// ---------- rows from airport JSON ----------
interface Row { label: string; rate: string; verified: string; sort: number; kind: 'onsite' | 'lot' }
interface Skip { name: string; why: string }

function daysOld(d: unknown): number {
  if (typeof d !== 'string') return Infinity
  const ms = new Date(TODAY).getTime() - new Date(d).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : Infinity
}
const money = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`)
const shortDate = (d: string) => { const [, m, dd] = d.split('-').map(Number); return `${dd} ${MONTHS_SHORT[m - 1]}` }

function buildRows(code: string, data: any): { rows: Row[]; skipped: Skip[] } {
  const rows: Row[] = []
  const skipped: Skip[] = []

  // On-airport: one garage row + one economy row, from entries carrying their own lastVerified.
  const groups: Record<'garage' | 'economy', { rate: number; verified: string }[]> = { garage: [], economy: [] }
  for (const [key, v] of Object.entries<any>(data.onAirportParking || {})) {
    if (!v || typeof v !== 'object') continue
    const text = `${key} ${v.name || ''}`
    const kind = /econom/i.test(text) ? 'economy' : /garage|deck|plaza|terminal ?lot/i.test(text) ? 'garage' : null
    if (!kind) continue
    const label = v.name || key
    if (typeof v.dailyMax !== 'number') { skipped.push({ name: `${label} (on-airport)`, why: 'no numeric dailyMax' }); continue }
    if (daysOld(v.lastVerified) > ONSITE_DAYS) {
      skipped.push({ name: `${label} (on-airport)`, why: v.lastVerified ? `verified ${v.lastVerified} (> ${ONSITE_DAYS}d)` : 'no lastVerified on entry' })
      continue
    }
    groups[kind].push({ rate: v.dailyMax, verified: v.lastVerified })
  }
  for (const kind of ['garage', 'economy'] as const) {
    const g = groups[kind]
    if (!g.length) continue
    const lo = Math.min(...g.map((x) => x.rate)), hi = Math.max(...g.map((x) => x.rate))
    const oldest = g.map((x) => x.verified).sort()[0]
    rows.push({
      label: kind === 'garage' ? 'Airport terminal garage' : 'Airport economy lot',
      rate: lo === hi ? `${money(lo)}/day` : `${money(lo)}–${money(hi)}/day`,
      verified: shortDate(oldest), sort: -1, kind: 'onsite',
    })
  }

  // Off-site lots we sell.
  for (const l of data.parkingLots || []) {
    const name: string = l.name
    if (l.sellable === false) { skipped.push({ name, why: 'sellable:false' }); continue }
    const tag = name.match(/\(([A-Z]{3})\)\s*$/)?.[1]
    if (tag && tag !== code) { skipped.push({ name, why: `lot belongs to ${tag}` }); continue }
    if (daysOld(l.rateVerified) > LOT_DAYS) {
      skipped.push({ name, why: l.rateVerified ? `rate verified ${l.rateVerified} (> ${LOT_DAYS}d)` : 'rate never verified' })
      continue
    }
    if (typeof l.rateSpreadPct === 'number' && l.rateSpreadPct >= MAX_SPREAD) {
      skipped.push({ name, why: `rateSpreadPct ${l.rateSpreadPct}% (volatile)` }); continue
    }
    const rate = typeof l.reservationRate === 'number' ? l.reservationRate : l.dailyRate
    if (typeof rate !== 'number' || !(rate > 0)) { skipped.push({ name, why: 'no rate' }); continue }
    rows.push({ label: name.replace(new RegExp(`\\s*\\(${code}\\)\\s*$`), ''), rate: `from ${money(rate)}/day`, verified: shortDate(l.rateVerified), sort: rate, kind: 'lot' })
  }
  rows.sort((a, b) => a.sort - b.sort)
  return { rows, skipped }
}

// ---------- Lexical ----------
const base = { direction: 'ltr', format: '', indent: 0, version: 1 }
const text = (t: string, format = 0) => ({ type: 'text', text: t, format, detail: 0, mode: 'normal', style: '', version: 1 })
const para = (children: any[]) => ({ type: 'paragraph', children, ...base, textFormat: 0, textStyle: '' })
const cell = (t: string, header: 0 | 1) => ({ type: 'tablecell', headerState: header, children: [para([text(t, header ? 1 : 0)])], ...base })
const trow = (cells: any[]) => ({ type: 'tablerow', children: cells, ...base })

function buildBlock(code: string, rows: Row[]): any[] {
  const heading = { type: 'heading', tag: 'h2', children: [text(`${NAMES[code] || code} parking prices — ${MONTH_LABEL}`)], ...base, textFormat: 0, textStyle: '' }
  const table = {
    type: 'table', ...base,
    children: [
      trow([cell('Option', 1), cell('Daily rate', 1), cell('Verified', 1)]),
      ...rows.map((r) => trow([cell(r.label, 0), cell(r.rate, 0), cell(r.verified, 0)])),
    ],
  }
  const note = para([text(`Checked ${CHECKED_LABEL}. Book up to 100 days ahead; holiday dates sell out first.`)])
  return [heading, table, note]
}

function plain(n: any): string {
  if (!n) return ''
  if (typeof n.text === 'string') return n.text
  return (n.children || []).map(plain).join('')
}
function countTypes(n: any, acc = { links: 0, uploads: 0, hrefs: [] as string[] }) {
  if (!n || typeof n !== 'object') return acc
  if (n.type === 'link' || n.type === 'autolink') { acc.links++; acc.hrefs.push(n.fields?.url || n.url || '') }
  if (n.type === 'upload') acc.uploads++
  for (const c of n.children || []) countTypes(c, acc)
  return acc
}

/** Index where a new block goes: before the first H2 (i.e. after the intro), else after node 0. */
function insertIndex(children: any[]): number {
  const i = children.findIndex((c) => c.type === 'heading' && c.tag === 'h2')
  return i > 0 ? i : Math.min(1, children.length)
}

// ---------- CMS ----------
const H = { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` }
async function cms(p: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${env.PAYLOAD_CMS_URL}/api${p}`, { headers: H, signal: AbortSignal.timeout(90_000) })
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`)
      return await r.json()
    } catch (e) {
      if (attempt >= 3) throw e
      console.warn(`  retry ${attempt} ${p}: ${(e as Error).message}`)
    }
  }
}
async function findHub(code: string): Promise<any | null> {
  const j: any = await cms(`/posts?where[airportCode][equals]=${code}&where[articleType][equals]=hub&where[status][equals]=published&limit=10&depth=0`)
  const docs: any[] = j.docs || []
  if (!docs.length) return null
  // Prefer the "<city>-airport-parking" pillar: shortest slug ending in airport-parking.
  docs.sort((a, b) => Number(!/airport-parking$/.test(a.slug)) - Number(!/airport-parking$/.test(b.slug)) || a.slug.length - b.slug.length)
  return docs[0]
}

// ---------- main ----------
interface Result { code: string; id?: number; slug?: string; action: string; rows: Row[]; skipped: Skip[]; links?: string; uploads?: string; note?: string }

async function main() {
  const codes = (ONLY || fs.readdirSync(AIRPORT_DIR).filter((f) => /^[A-Z]{3}\.json$/.test(f)).map((f) => f.slice(0, 3))).sort()
  console.log(`monthly-prices ${APPLY ? 'APPLY' : 'DRY RUN'} — ${MONTH_LABEL} — ${codes.length} airport(s)`)
  const results: Result[] = []
  const backup: Record<string, unknown> = {}
  const changedUrls: string[] = []

  for (const code of codes) {
    const data = JSON.parse(fs.readFileSync(path.join(AIRPORT_DIR, `${code}.json`), 'utf8'))
    const { rows, skipped } = buildRows(code, data)
    const res: Result = { code, action: '', rows, skipped }
    results.push(res)
    if (!rows.some((r) => r.kind === 'lot')) { res.action = 'skip: no verified sellable off-site lot'; console.log(`${code}: ${res.action}`); continue }

    const hub = await findHub(code)
    if (!hub) { res.action = 'skip: no published hub post'; console.log(`${code}: ${res.action}`); continue }
    res.id = hub.id; res.slug = hub.slug
    const content = hub.content
    const children: any[] = content?.root?.children
    if (!Array.isArray(children)) { res.action = 'skip: no Lexical content'; continue }

    const before = countTypes(content.root)
    const block = buildBlock(code, rows)
    const existing = children.findIndex((c) => c.type === 'heading' && MARKER_RE.test(plain(c).trim()))
    let next: any[]
    let at: number
    let removed = 0
    if (existing >= 0) {
      const [h, t, p] = children.slice(existing, existing + 3)
      if (!(h && t?.type === 'table' && p?.type === 'paragraph' && /^Checked /.test(plain(p)))) {
        res.action = 'ABORT: existing price heading found but block shape unexpected'; console.log(`${code}: ${res.action}`); continue
      }
      if (countTypes({ children: [h, t, p] }).links || countTypes({ children: [h, t, p] }).uploads) {
        res.action = 'ABORT: existing block contains links/uploads'; continue
      }
      at = existing; removed = 3
      next = [...children.slice(0, existing), ...block, ...children.slice(existing + 3)]
      res.action = 'replaced'
    } else {
      at = insertIndex(children)
      next = [...children.slice(0, at), ...block, ...children.slice(at)]
      res.action = 'inserted'
    }

    // Verify: everything outside the block is untouched; links/uploads unchanged.
    const outsideBefore = JSON.stringify([...children.slice(0, at), ...children.slice(at + removed)])
    const outsideAfter = JSON.stringify([...next.slice(0, at), ...next.slice(at + block.length)])
    const newContent = { ...content, root: { ...content.root, children: next } }
    const after = countTypes(newContent.root)
    res.links = `${before.links}→${after.links}`; res.uploads = `${before.uploads}→${after.uploads}`
    if (outsideBefore !== outsideAfter || before.links !== after.links || before.uploads !== after.uploads) {
      res.action = 'ABORT: verification failed (content outside block or link/image counts changed)'; console.log(`${code}: ${res.action}`); continue
    }
    // W1.7: an identical block is not a change — no write, no stamp (a same-month re-run used to re-stamp the page).
    if (removed && JSON.stringify(children.slice(at, at + removed)) === JSON.stringify(block)) {
      res.action = 'unchanged: the page already carries this exact block'; console.log(`${code}: ${res.action}`); continue
    }
    console.log(`${code}: ${res.action} at node ${at} on ${hub.id} ${hub.slug} — ${rows.length} rows; links ${res.links}, images ${res.uploads}`)
    for (const r of rows) console.log(`    ${r.label} | ${r.rate} | ${r.verified}`)

    if (!APPLY) continue
    backup[hub.id] = { slug: hub.slug, contentUpdatedAt: hub.contentUpdatedAt ?? null, content }
    fs.mkdirSync(REPORTS, { recursive: true })
    fs.writeFileSync(path.join(REPORTS, `monthly-prices-${RUN_STAMP}-preedit.json`), JSON.stringify(backup, null, 1))

    // W1.7: we only get here when the block differs from what is on the page (checked above), so this IS a fact
    // change; the date still moves only with --stamp.
    await updatePost(String(hub.id), { content: newContent, ...stampField({ factsChanged: true, reason: `${MONTH_LABEL} price block ${res.action}` }) })
    const fresh: any = await cms(`/posts/${hub.id}?depth=0`)
    const post = countTypes(fresh.content.root)
    const missing = before.hrefs.filter((h) => !post.hrefs.includes(h))
    const blockOk = fresh.content.root.children.some((c: any) => c.type === 'heading' && plain(c).endsWith(MONTH_LABEL))
    if (post.links !== before.links || post.uploads !== before.uploads || missing.length || !blockOk) {
      res.note = `POST-SAVE CHECK FAILED: links ${before.links}→${post.links}, images ${before.uploads}→${post.uploads}, missing hrefs ${missing.length}, block ${blockOk}. Restore from monthly-prices-${RUN_STAMP}-preedit.json.`
      console.error(`${code}: ${res.note}`)
      process.exitCode = 1
    } else {
      res.note = `verified after save (contentUpdatedAt ${fresh.contentUpdatedAt})`
      changedUrls.push(postUrlFor(hub.slug))
    }
  }

  if (APPLY && changedUrls.length) {
    const r = await submitUrls(changedUrls)
    console.log(`IndexNow: ${r.submitted}/${changedUrls.length} submitted (ok=${r.ok})`)
  }
  fs.mkdirSync(REPORTS, { recursive: true })
  fs.writeFileSync(path.join(REPORTS, `monthly-prices-${TODAY}${APPLY ? '' : '-dryrun'}.json`), JSON.stringify({ date: TODAY, apply: APPLY, lotDays: LOT_DAYS, onsiteDays: ONSITE_DAYS, maxSpread: MAX_SPREAD, results, changedUrls }, null, 1))
}

main().catch((e) => { console.error(e); process.exit(1) })
