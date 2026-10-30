/**
 * ctr-rescue.ts — CTR title/meta rescue (zero-click-era response)
 *
 * Our blog has huge impressions but ~0.27% CTR. For pages that already rank in a
 * winnable band (position ~5-20) with real impressions, a sharper title + meta
 * description is the cheapest way to recover clicks. This script regenerates ONLY
 * the title + metaTitle + metaDescription (no article re-write) using Haiku — fast
 * and cheap — and stages or applies them.
 *
 * SAFE BY DEFAULT: dry-run prints before/after and changes nothing. --apply PATCHes
 * the post's title + seo.{metaTitle,metaDescription} only. Article body is untouched.
 *
 * Usage:
 *   npm run ctr-rescue                                  # dry-run, top candidates
 *   npm run ctr-rescue -- --apply --limit 10
 *   npm run ctr-rescue -- --min-impressions 500 --max-position 20
 *   npm run ctr-rescue -- --max-ctr 0.005               # only pages under 0.5% CTR
 *   npm run ctr-rescue -- --cooldown-days 30             # skip pages rescued within N days (default 30)
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { env, PERF_MODEL } from './config.js'
import { loadRecord, saveRecord } from './perf-snapshot.js'
import { loadParkingLots, unverifiedTitlePrice } from './airport-data.js'
import { PRICE_STALENESS_MAX_DAYS } from './perf-recommend.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports')
// Use the validated env from config.ts (fails fast with a clear message if unset)
// rather than raw process.env non-null assertions that crash cryptically later.
const CMS_URL = env.PAYLOAD_CMS_URL
const API_KEY = env.PAYLOAD_API_KEY
const headers = { 'Content-Type': 'application/json', Authorization: `users API-Key ${API_KEY}` }
const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
const MODEL = PERF_MODEL // cheap; title/meta is a simple task

const args = process.argv.slice(2)
const flag = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? '') : d }
const APPLY = args.includes('--apply')
const LIMIT = parseInt(flag('--limit', '10') || '10', 10)
const MIN_IMPR = parseInt(flag('--min-impressions', '300') || '300', 10)
const MAX_POS = parseFloat(flag('--max-position', '25') || '25')
const MIN_POS = parseFloat(flag('--min-position', '4') || '4')
// Candidates are ranked by impressions, so without a CTR ceiling the biggest pages win
// the slots whether or not they need rescuing — and the highest-impression pages tend to
// be the ones already converting. On the 2026-08-13 report, 4 of the top 12 were above
// 0.5% CTR, including dfw-airport-parking-promo-code-2023 at 2.26% — the best-performing
// title pattern on the site. Rewriting that risks losing the control we want to copy.
// Default stays Infinity so existing invocations behave exactly as before.
const MAX_CTR = parseFloat(flag('--max-ctr', 'Infinity') || 'Infinity')
// Nothing stopped the tool re-selecting a page it already rewrote (candidates are just
// top-by-impressions) — 12 of the 50 pages in the 2026-09-14 batch got hit twice. A
// cooldown skips any candidate whose perf record already has a title-meta change within
// the window, so a rewrite gets time to actually move CTR before we touch it again.
const COOLDOWN_DAYS = parseFloat(flag('--cooldown-days', '30') || '30')

interface GscPage { slug?: string; position?: number; impressions?: number; clicks?: number; ctr?: number }

const RewriteSchema = z.object({
  title: z.string().min(1),
  metaTitle: z.string().min(1),
  metaDescription: z.string().min(1),
})

function latestGsc(): any {
  const files = fs.readdirSync(REPORTS_DIR).filter(f => f.startsWith('gsc-report-') && f.endsWith('.json')).sort()
  if (!files.length) throw new Error('No GSC reports found. Run `npm run gsc` first.')
  const file = path.join(REPORTS_DIR, files[files.length - 1])
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`GSC report ${path.basename(file)} is not valid JSON (${(e as Error).message}). Re-run \`npm run gsc\`.`)
  }
}

function candidatePages(r: any): GscPage[] {
  const map = new Map<string, GscPage>()
  const buckets: GscPage[][] = []
  if (Array.isArray(r.topPages)) buckets.push(r.topPages)
  if (Array.isArray(r.lowCtrHighImpressions)) buckets.push(r.lowCtrHighImpressions)
  const clusters = Array.isArray(r.airportClusters) ? r.airportClusters : Object.values(r.airportClusters || {})
  for (const c of clusters as any[]) if (Array.isArray(c.topPages)) buckets.push(c.topPages)
  for (const b of buckets) for (const p of b) {
    if (p?.slug && typeof p.position === 'number' && p.position >= MIN_POS && p.position <= MAX_POS && (p.impressions || 0) >= MIN_IMPR && (p.ctr ?? 0) <= MAX_CTR) {
      const prev = map.get(p.slug)
      if (!prev || (p.impressions || 0) > (prev.impressions || 0)) map.set(p.slug, p)
    }
  }
  return [...map.values()].sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
}

/**
 * A candidate is in cooldown if its perf record already has a title-meta change
 * (from this script) dated within the last COOLDOWN_DAYS. Returns the ISO date of
 * the most recent such change, or null if not in cooldown / no record.
 */
function cooldownDate(slug: string): string | null {
  const record = loadRecord(slug)
  if (!record) return null
  const cutoff = Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  let latest: string | null = null
  for (const c of record.changes) {
    if (c.type !== 'title-meta') continue
    const t = Date.parse(c.at)
    if (!Number.isFinite(t) || t < cutoff) continue
    if (!latest || c.at > latest) latest = c.at
  }
  return latest
}

async function getPost(slug: string): Promise<any | null> {
  const r = await fetch(`${CMS_URL}/api/posts?where[slug][equals]=${encodeURIComponent(slug)}&depth=0`, { headers })
  if (!r.ok) return null
  const j = await r.json()
  return (j.docs || [])[0] || null
}

async function rewriteTitleMeta(post: any, g: GscPage): Promise<{ title: string; metaTitle: string; metaDescription: string } | null> {
  const prompt = `You are an SEO CTR specialist. This published airport-parking blog post ranks at ~position ${g.position?.toFixed(1)} with ${g.impressions} monthly impressions but a very low click-through rate. Rewrite its title and meta to earn the click in a competitive, AI-Overview-heavy SERP.

Current title: "${post.title}"
Current metaTitle: "${post.seo?.metaTitle || ''}"
Current metaDescription: "${post.seo?.metaDescription || ''}"
Focus keyword: "${post.keyword || ''}"
Airport: ${post.airportCode || ''}

CRITICAL — PRESERVE REAL DATA: The current title/meta may already contain real, specific prices (e.g. "$8.50/day", "$10.95/day off-site vs $35/day on-airport"). You MUST keep those exact numbers. NEVER replace a specific real price with a vaguer one ("from $15/day") — that loses accuracy and is the #1 mistake here. Only improve framing, clarity, keyword/year placement, and click appeal around the existing facts. If the current meta is already strong and specific, make minimal changes.

Rules:
- metaTitle: ≤60 characters, lead with the concrete answer/benefit, include the focus keyword, and the current year ${new Date().getFullYear()} if the topic is rates/deals/availability.
- metaDescription: 120-160 characters. Keep the real price points from the current meta; lead with a direct answer, one differentiator, and a soft CTA.
- title: a compelling display title (50-65 chars). Specific, benefit-forward, not clickbait.
- NEVER fabricate or vague-ify dollar amounts. Preserve every real number already present.

Respond with ONLY JSON: {"title":"...","metaTitle":"...","metaDescription":"..."}`
  try {
    const res = await client.messages.create({ model: MODEL, max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
    const block = res.content.find((b) => b.type === 'text')
    const text = block && block.type === 'text' ? block.text : ''
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    // Validate shape — main() reads out.metaTitle.length etc, so a malformed
    // object (missing fields, wrong types) must be rejected, not crash later.
    const parsed = RewriteSchema.safeParse(JSON.parse(m[0]))
    if (!parsed.success) { console.error('  ⚠ rewrite response missing required fields — skipping'); return null }
    return parsed.data
  } catch (e) { console.error('  ⚠ rewrite failed:', (e as Error).message); return null }
}

/**
 * Log the rewrite into the article's perf record, exactly as perf-apply does.
 *
 * Without this, a ctr-rescue edit is invisible to the rest of the loop: `maintain`
 * sees no cooldown and can re-treat the same title within the hour (observed
 * 2026-08-14 — a maintain dry-run proposed new titles for pages rescued minutes
 * earlier), `perf measure` never judges whether the rewrite worked, and
 * `perf revert` has no pre-edit state to restore. Recording it makes the cheapest,
 * highest-volume treatment we have a measurable part of the learning loop.
 */
function recordChange(slug: string, preEdit: Record<string, unknown>, baseline: { clicks: number; impressions: number; position: number }): void {
  const record = loadRecord(slug)
  if (!record) return // snapshot-less article — nothing to attach the change to
  record.changes.push({
    at: new Date().toISOString(),
    type: 'title-meta',
    summary: 'ctr-rescue: regenerated title + metaTitle + metaDescription',
    baselineMetrics: baseline,
    preEdit,
  })
  saveRecord(record)
}

async function patchPost(id: string, title: string, metaTitle: string, metaDescription: string): Promise<boolean> {
  const r = await fetch(`${CMS_URL}/api/posts/${id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ title, seo: { metaTitle, metaDescription } }),
  })
  return r.ok
}

async function main() {
  const report = latestGsc()
  const allCands = candidatePages(report)
  // Filter cooldown candidates out FIRST, then slice to LIMIT — a skipped page must
  // not consume a slot that a treatable page could have used.
  const cands: GscPage[] = []
  for (const g of allCands) {
    if (cands.length >= LIMIT) break
    const cd = cooldownDate(g.slug!)
    if (cd) { console.log(`⏸ ${g.slug} — title-meta changed ${cd}, in cooldown`); continue }
    cands.push(g)
  }
  const ctrCap = Number.isFinite(MAX_CTR) ? `, CTR ≤ ${(MAX_CTR * 100).toFixed(2)}%` : ''
  console.log(`\n🎯 CTR rescue — position ${MIN_POS}-${MAX_POS}, impressions ≥ ${MIN_IMPR}${ctrCap}, cooldown ${COOLDOWN_DAYS}d, top ${LIMIT}${APPLY ? '  [APPLY]' : '  [dry-run]'}\n`)
  if (!cands.length) { console.log('No candidates matched.'); return }

  let applied = 0
  for (const g of cands) {
    const post = await getPost(g.slug!)
    if (!post) { console.log(`⊘ ${g.slug} — no published post`); continue }
    const ctrPct = ((g.ctr || 0) * 100).toFixed(2)
    console.log(`\n📄 ${g.slug}  (pos ${g.position?.toFixed(1)}, ${g.impressions} impr, ${ctrPct}% CTR)`)
    console.log(`   OLD title: ${post.title}`)
    console.log(`   OLD meta:  ${post.seo?.metaDescription || '(none)'}`)
    const out = await rewriteTitleMeta(post, g)
    if (!out) { console.log('   ⚠ skipped (no rewrite)'); continue }
    console.log(`   NEW title: ${out.title}`)
    console.log(`   NEW metaTitle: ${out.metaTitle} (${out.metaTitle.length} chars)`)
    console.log(`   NEW meta:  ${out.metaDescription} (${out.metaDescription.length} chars)`)
    // Same rate-staleness rule as perf-recommend: the rewrite may keep prices the page
    // already shows, but any NEW price must be a sellable lot's price verified in the window.
    const lots = post.airportCode ? loadParkingLots(String(post.airportCode)) : null
    const onPage = { title: post.title || '', metaTitle: post.seo?.metaTitle || '', metaDescription: post.seo?.metaDescription || '' }
    const bad = lots && PRICE_STALENESS_MAX_DAYS > 0
      ? unverifiedTitlePrice([out.title, out.metaTitle, out.metaDescription], onPage, lots, PRICE_STALENESS_MAX_DAYS)
      : null
    if (bad) { console.log(`   ⚠ skipped — new price $${bad.price} is ${bad.reason} (rate-staleness guard)`); continue }
    if (APPLY) {
      // Capture pre-edit state BEFORE the PATCH so the change is revertible.
      const preEdit = { title: post.title, seo: post.seo ? JSON.parse(JSON.stringify(post.seo)) : {} }
      const ok = await patchPost(post.id, out.title, out.metaTitle, out.metaDescription)
      console.log(ok ? '   ✓ applied' : '   ✗ PATCH failed')
      if (ok) {
        applied++
        recordChange(g.slug!, preEdit, { clicks: g.clicks || 0, impressions: g.impressions || 0, position: g.position || 0 })
      }
    }
  }
  console.log(`\n${APPLY ? `Done. Applied ${applied}/${cands.length}.` : '[dry-run] Re-run with --apply to write these. Body content is never touched.'}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
