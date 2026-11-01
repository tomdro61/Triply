/**
 * maintain-geo.ts — the GEO track: make AI-search (Google AI Overview) citation a
 * MEASURED, per-article objective, parallel to Google position.
 *
 *   capture — pull AIO citation status for RANKING articles (reuse analyzeSerp),
 *             store snap.geo, report citation rate + ranked-but-uncited opportunities.
 *   measure — for GEO treatments past the window, re-check citation → citationDelta.
 *   report  — corpus citation KPIs from stored geo.
 *
 * Only Google AI Overview is API-reachable (via SerpAPI); Perplexity/ChatGPT/Gemini
 * have no citation API and are deferred. Citation only matters where we already rank,
 * so capture is gated to ranking pages + a --limit to bound SerpAPI spend.
 */

import { analyzeSerp } from './perf-serp.js'
import { loadRecord, saveRecord } from './perf-snapshot.js'
import type { ArticlePerfRecord, PerfSnapshot } from './perf-snapshot.js'
import { getAllPublishedPosts } from './payload.js'

const DAY_MS = 24 * 60 * 60 * 1000
const GEO_TREATMENTS = ['quick-answer', 'faq-additions']
/** Buckets where being cited is achievable — no point spending a SERP credit on unranked pages. */
const RANKING_BUCKETS: PerfSnapshot['derived']['positionBucket'][] = ['top3', 'page1', 'striking-distance']

function latestSnap(rec: ArticlePerfRecord): PerfSnapshot | undefined {
  return rec.snapshots[rec.snapshots.length - 1]
}

// ── capture ─────────────────────────────────────────────────────────────────

/**
 * Populate AI-Overview citation status for the highest-demand RANKING articles.
 * Attaches {aioPresent, aioCitesUs, capturedAt} to each article's latest snapshot so
 * the tiering GEO override (via recentGeo) fires corpus-wide, not just on treated pages.
 */
export async function captureCitation(opts: { airport?: string; limit?: number }): Promise<void> {
  const limit = opts.limit ?? 20
  const posts = await getAllPublishedPosts(opts.airport)

  // Eligible = ranks somewhere citable; rank by impressions so we spend credits on demand.
  const eligible: { rec: ArticlePerfRecord; snap: PerfSnapshot; impr: number }[] = []
  for (const p of posts) {
    const rec = loadRecord(p.slug)
    const snap = rec && latestSnap(rec)
    if (!rec || !snap || !snap.gsc.found) continue
    if (!RANKING_BUCKETS.includes(snap.derived.positionBucket)) continue
    eligible.push({ rec, snap, impr: snap.gsc.totals.impressions })
  }
  eligible.sort((a, b) => b.impr - a.impr)
  const batch = eligible.slice(0, limit)

  console.log(`\n🔎 GEO capture${opts.airport ? ` · ${opts.airport.toUpperCase()}` : ''} — ${batch.length} ranking article(s) (of ${eligible.length} eligible; ~1 SerpAPI credit each)\n`)

  let present = 0, cited = 0, done = 0
  const uncited: { slug: string; impr: number }[] = []
  for (const { rec, snap, impr } of batch) {
    try {
      const serp = await analyzeSerp(rec.keyword)
      if (!serp.found) { console.log(`  · ${rec.slug}: SERP unavailable`); continue }
      snap.geo = { aioPresent: serp.aioPresent, aioCitesUs: serp.aioCitesUs, capturedAt: new Date().toISOString() }
      saveRecord(rec)
      done++
      if (serp.aioPresent) present++
      if (serp.aioCitesUs) cited++
      const mark = !serp.aioPresent ? '—' : serp.aioCitesUs ? '✓ cited' : '✗ NOT cited'
      console.log(`  · ${rec.slug.padEnd(42)} AIO ${serp.aioPresent ? 'present' : 'none'} · ${mark}`)
      if (serp.aioPresent && !serp.aioCitesUs) uncited.push({ slug: rec.slug, impr })
    } catch (e) {
      console.log(`  ⚠ ${rec.slug}: ${e instanceof Error ? e.message.slice(0, 80) : e}`)
    }
  }

  console.log(`\n📊 Captured ${done} · AIO present ${present} · we're cited ${cited}` +
    (present ? ` (${((cited / present) * 100).toFixed(0)}% citation rate where AIO shows)` : ''))
  if (uncited.length) {
    console.log(`\n   ⚑ Ranked but NOT cited (Tier-2 GEO opportunities), by demand:`)
    uncited.sort((a, b) => b.impr - a.impr).slice(0, 15).forEach((u) => console.log(`     · ${u.slug} (${u.impr} impr)`))
  }
  console.log('')
}

// ── measure ─────────────────────────────────────────────────────────────────

function citationDelta(before: boolean, after: boolean): 'gained' | 'lost' | 'held' {
  if (!before && after) return 'gained'
  if (before && !after) return 'lost'
  return 'held'
}

/**
 * For GEO treatments (quick-answer/faq) past the window that have a citationBaseline
 * but no measured citationDelta yet, re-pull the SERP once per article and record
 * whether the edit won or lost the AI citation.
 */
export async function measureCitation(opts: { airport?: string; window?: number }): Promise<void> {
  const windowDays = opts.window ?? 28
  const now = Date.now()
  const posts = await getAllPublishedPosts(opts.airport)

  console.log(`\n📐 GEO measure${opts.airport ? ` · ${opts.airport.toUpperCase()}` : ''} — window ${windowDays}d\n`)
  let measured = 0, gained = 0, lost = 0, held = 0

  for (const p of posts) {
    const rec = loadRecord(p.slug)
    if (!rec) continue
    const due = rec.changes.filter((c) =>
      GEO_TREATMENTS.includes(c.type) && c.citationBaseline !== undefined && c.citationDelta === undefined &&
      !c.reverted && !c.patchUnverified && (now - new Date(c.at).getTime()) >= windowDays * DAY_MS)
    if (!due.length) continue

    let after: boolean | null = null
    try {
      const serp = await analyzeSerp(rec.keyword)
      after = serp.found ? serp.aioCitesUs : null
    } catch { after = null }

    for (const c of due) {
      if (after === null) { c.citationDelta = 'unknown' }
      else {
        c.citationAfter = after
        c.citationDelta = citationDelta(c.citationBaseline!, after)
        c.citationDelta === 'gained' ? gained++ : c.citationDelta === 'lost' ? lost++ : held++
      }
      measured++
      console.log(`  · ${rec.slug} [${c.type}] citation → ${c.citationDelta!.toUpperCase()}`)
    }
    saveRecord(rec)
  }
  console.log(`\n   Measured ${measured} GEO change(s): ${gained} gained · ${lost} lost · ${held} held citation\n`)
}

// ── report ──────────────────────────────────────────────────────────────────

/** Corpus AI-citation dashboard from stored snapshot geo (no SERP calls). */
export async function geoReport(opts: { airport?: string }): Promise<void> {
  const posts = await getAllPublishedPosts(opts.airport)
  let withGeo = 0, present = 0, cited = 0
  const uncited: { slug: string; impr: number }[] = []
  for (const p of posts) {
    const rec = loadRecord(p.slug)
    const snap = rec && latestSnap(rec)
    // Most recent geo across snapshots (citation is captured on its own cadence).
    const geo = rec?.snapshots.slice().reverse().find((s) => s.geo)?.geo
    if (!rec || !geo) continue
    withGeo++
    if (geo.aioPresent) present++
    if (geo.aioCitesUs) cited++
    if (geo.aioPresent && !geo.aioCitesUs) uncited.push({ slug: p.slug, impr: snap?.gsc.totals.impressions ?? 0 })
  }
  console.log(`\n🌐 GEO report${opts.airport ? ` · ${opts.airport.toUpperCase()}` : ''} — ${withGeo} article(s) with citation data`)
  if (!withGeo) { console.log(`   None yet — run \`maintain geo capture\` first.\n`); return }
  console.log(`   AIO present: ${present} · we're cited: ${cited}` +
    (present ? ` · citation rate ${((cited / present) * 100).toFixed(0)}% (where AIO shows)` : ''))
  console.log(`   Ranked but not cited (GEO opportunities): ${uncited.length}`)
  uncited.sort((a, b) => b.impr - a.impr).slice(0, 15).forEach((u) => console.log(`     · ${u.slug} (${u.impr} impr)`))
  console.log('')
}
