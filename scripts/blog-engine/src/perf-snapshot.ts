/**
 * Per-article performance snapshot (perf loop — Phase 1, data layer).
 *
 * Assembles ONE published article's combined performance + on-page state into a
 * growing per-URL record at `reports/articles/{slug}.json`. Each call appends a
 * new entry to `snapshots[]` so the file becomes a history the recommender can
 * learn from. `changes[]` (applied edits + measured verdicts) is owned by the
 * apply/measure stages and is preserved untouched here.
 *
 * Phase 1 sources: GSC single-URL (via fetchUrlPerformance) + on-page audit
 * (lexicalToHtml + scoreArticle, the same inputs the `score` command builds).
 * Bing/SerpAPI enrichment is Phase 2.
 *
 * MEASUREMENT NOTE: GSC impressions/position are the trustworthy signals; CTR is
 * diagnostic-only (2025-2026 GSC logging bug). Real success = bookings (GA4),
 * which is a Phase-0 prerequisite handled on the frontend.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { env } from './config.js'
import { findPostBySlug } from './payload.js'
import { lexicalToHtml } from './lexical-to-html.js'
import { scoreArticle } from './seo-scorer.js'
import type { SeoScore } from './seo-scorer.js'
import { fetchUrlPerformance } from './gsc.js'
import type { UrlPerformance, UrlQueryStat } from './gsc.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ARTICLES_DIR = path.resolve(__dirname, '..', 'reports', 'articles')

// ── Record shapes ─────────────────────────────────────────────────────────────

export interface OnPageState {
  title: string
  metaTitle: string
  metaDescription: string
  wordCount: number
  faqCount: number
  hasQuickAnswer: boolean
  hasCtaBlock: boolean
  contentUpdatedAt: string | null
  publishedAt: string | null
  seoScore: number
  seoGrade: string
}

export interface PerfSnapshot {
  capturedAt: string
  dateRange: { start: string; end: string }
  gsc: {
    found: boolean
    totals: UrlPerformance['totals']
    queries: UrlQueryStat[]
  }
  onPage: OnPageState
  derived: {
    positionBucket: 'top3' | 'page1' | 'striking-distance' | 'page2plus' | 'unranked'
    /** High-impression queries getting ~no clicks — GEO/CTR opportunity. Diagnostic. */
    missedQueries: UrlQueryStat[]
  }
  /**
   * AI-Overview status for the keyword, captured opportunistically whenever a SERP
   * pull happens (the `recommend` stage). Absent until the article's first
   * treatment. Lets the tiering router see "we rank but the AI Overview doesn't
   * cite us" — a GEO problem no amount of position-climbing fixes.
   */
  geo?: {
    aioPresent: boolean
    aioCitesUs: boolean
    capturedAt: string
  }
}

/** A change applied by the apply stage; measured later by the measure stage. */
export interface PerfChange {
  at: string
  type: string
  summary: string
  baselineMetrics: { clicks: number; impressions: number; position: number }
  /** Exact pre-edit CMS values for this change, so it can be reverted losslessly. */
  preEdit?: Record<string, unknown>
  reverted?: boolean
  /**
   * The PATCH's outcome could not be confirmed (response lost AND the re-read failed). perf measure, maintain learn
   * and the tier cooldown skip it until a person checks the CMS and clears the flag; revert still restores preEdit.
   */
  patchUnverified?: boolean
  measuredAfter?: {
    at: string
    impressionsDelta: number
    positionDelta: number
    verdict: 'helped' | 'hurt' | 'neutral' | 'inconclusive'
    /** How the verdict was reached — control-adjusted vs raw, and the control movement. */
    note?: string
  }
  // ── GEO track (AI-Overview citation) — independent of the Google verdict above ──
  /** AI-Overview citation state at apply time — set for quick-answer/faq edits. */
  citationBaseline?: boolean
  /** AI-Overview citation state after the window (set by `maintain geo measure`). */
  citationAfter?: boolean
  /** Did the edit move AI citation? */
  citationDelta?: 'gained' | 'lost' | 'held' | 'unknown'
}

/**
 * Maintenance tier state (owned by the `maintain` loop). Additive/optional so
 * pre-existing records stay valid. `tier` mirrors maintain-tier.ts: 0=watch,
 * 1=full-rewrite, 2=standard, 3=small. `nextDueAt` = lastMaintainedAt + cadence.
 */
export interface MaintenanceState {
  tier: 0 | 1 | 2 | 3
  action: string
  reason: string
  classifiedAt: string
  lastMaintainedAt: string | null
  lastAction: string | null
  nextDueAt: string | null
}

export interface ArticlePerfRecord {
  slug: string
  url: string | null
  airportCode: string | null
  articleType: string
  keyword: string
  snapshots: PerfSnapshot[]
  changes: PerfChange[]
  maintenance?: MaintenanceState
  /**
   * When true, this article is in the never-touched holdout cohort: `maintain run`
   * skips it so it serves as a control for program-wide lift measurement
   * (`maintain lift`). Assigned deterministically by `maintain holdout --assign`.
   */
  holdout?: boolean
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function recordPath(slug: string): string {
  return path.join(ARTICLES_DIR, `${slug}.json`)
}

export interface BulkPerf { found: boolean; clicks: number; impressions: number; ctr: number; position: number }

/**
 * Build + persist a snapshot from ALREADY-FETCHED data (NO network) — for the
 * `track-all` bulk backfill so every published article gets a record cheaply.
 * Mirrors buildSnapshot's snapshot shape but sources GSC from a single bulk page
 * pull and skips the per-query breakdown (filled later by a per-article refresh).
 * Kept separate from buildSnapshot so the proven per-article path is untouched.
 */
export function upsertBulkSnapshot(
  post: Record<string, any>,
  keyword: string,
  url: string | null,
  perf: BulkPerf,
  dateRange: { start: string; end: string },
): ArticlePerfRecord {
  const html: string = post.content ? lexicalToHtml(post.content) : ''
  const articleType: string = post.articleType || 'spoke'
  const targetWords = articleType === 'hub' ? 2500 : articleType === 'sub-pillar' ? 1500 : 1000
  const score: SeoScore = scoreArticle({
    html, keyword, slug: post.slug,
    metaTitle: post.seo?.metaTitle || post.title || '',
    metaDescription: post.seo?.metaDescription || post.excerpt || '',
    excerpt: post.excerpt || '',
    faqItems: post.faqItems || [],
    articleType: articleType as 'hub' | 'sub-pillar' | 'spoke',
    targetWords,
    hasImage: !!post.featuredImage,
    imageAlt: typeof post.featuredImage === 'object' ? post.featuredImage?.alt : null,
    airportCode: post.airportCode || undefined,
    parentSlug: post.parentSlug || undefined,
    hubSlug: post.hubSlug || undefined,
  })
  const totals = { clicks: perf.clicks, impressions: perf.impressions, ctr: perf.ctr, position: perf.position }
  const snapshot: PerfSnapshot = {
    capturedAt: new Date().toISOString(),
    dateRange,
    gsc: { found: perf.found, totals, queries: [] },
    onPage: {
      title: post.title || '',
      metaTitle: post.seo?.metaTitle || '',
      metaDescription: post.seo?.metaDescription || '',
      wordCount: countWords(html),
      faqCount: Array.isArray(post.faqItems) ? post.faqItems.length : 0,
      hasQuickAnswer: detectQuickAnswer(html),
      hasCtaBlock: detectCtaBlock(html),
      contentUpdatedAt: post.contentUpdatedAt || null,
      publishedAt: post.publishedAt || null,
      seoScore: score.total,
      seoGrade: score.grade,
    },
    derived: { positionBucket: positionBucket(perf.found, totals.position), missedQueries: [] },
  }
  const existing = loadRecord(post.slug)
  const record: ArticlePerfRecord = existing || {
    slug: post.slug, url, airportCode: post.airportCode || null, articleType, keyword, snapshots: [], changes: [],
  }
  record.url = url || record.url
  record.airportCode = post.airportCode || record.airportCode
  record.articleType = articleType
  record.keyword = keyword
  record.snapshots.push(snapshot)
  // Cap history so a daily bulk backfill can't grow records unbounded (60 days of
  // trend is plenty for the 28-day attribution window + decay detection).
  if (record.snapshots.length > 60) record.snapshots = record.snapshots.slice(-60)
  saveRecord(record)
  return record
}

export function loadRecord(slug: string): ArticlePerfRecord | null {
  const p = recordPath(slug)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ArticlePerfRecord
}

export function saveRecord(record: ArticlePerfRecord): string {
  if (!fs.existsSync(ARTICLES_DIR)) fs.mkdirSync(ARTICLES_DIR, { recursive: true })
  const p = recordPath(record.slug)
  fs.writeFileSync(p, JSON.stringify(record, null, 2))
  return p
}

function countWords(html: string): number {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ')
  const words = text.trim().split(/\s+/).filter(Boolean)
  return words.length
}

/** Best-effort Phase-1 detection — refined once real components exist (Tom). */
function detectQuickAnswer(html: string): boolean {
  return /quick answer|tl;dr|in short[:,]|short answer/i.test(html)
}

function detectCtaBlock(html: string): boolean {
  // A booking/price-check CTA: an anchor whose text/href reads transactional.
  const anchorRe = /<a\b[^>]*>(.*?)<\/a>/gis
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html))) {
    const whole = m[0].toLowerCase()
    if (/book|reserve|check (your )?price|get (a )?quote|compare (rates|prices)|find parking/.test(whole)) {
      return true
    }
  }
  return false
}

function positionBucket(found: boolean, position: number): PerfSnapshot['derived']['positionBucket'] {
  if (!found || position <= 0) return 'unranked'
  if (position <= 3) return 'top3'
  if (position <= 10) return 'page1'
  if (position <= 20) return 'striking-distance'
  return 'page2plus'
}

async function fetchQueueItemBySlug(slug: string): Promise<Record<string, unknown> | null> {
  const url = `${env.PAYLOAD_CMS_URL}/api/content-queue?where[slug][equals]=${encodeURIComponent(slug)}&limit=1&depth=0`
  const res = await fetch(url, { headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` } })
  if (!res.ok) return null
  const data = await res.json()
  return data.docs?.[0] || null
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Build a fresh snapshot for `slug`, append it to the per-article record, and
 * return the updated record. Throws if the post isn't found in the CMS.
 */
export async function buildSnapshot(slug: string, days: number = 28): Promise<ArticlePerfRecord> {
  const post = await findPostBySlug(slug)
  if (!post) throw new Error(`No CMS post found for slug "${slug}"`)

  const html: string = post.content ? lexicalToHtml(post.content) : ''
  const articleType: string = post.articleType || 'spoke'

  // Recover the focus keyword + target words from the content-queue item (the post
  // record itself doesn't store the focus keyword) — mirrors the `score` command.
  const queueItem = await fetchQueueItemBySlug(slug)
  const keyword = (queueItem?.keyword as string) || post.slug.replace(/-/g, ' ')
  const targetWords = (queueItem?.targetWords as number)
    || (articleType === 'hub' ? 2500 : articleType === 'sub-pillar' ? 1500 : 1000)

  // GSC single-URL performance.
  const perf: UrlPerformance = await fetchUrlPerformance(slug, days)

  // On-page audit (same ScorerInput the `score` command builds).
  const hasImage = !!post.featuredImage
  const imageAlt = typeof post.featuredImage === 'object' ? post.featuredImage?.alt : null
  const score: SeoScore = scoreArticle({
    html,
    keyword,
    slug: post.slug,
    metaTitle: post.seo?.metaTitle || post.title || '',
    metaDescription: post.seo?.metaDescription || post.excerpt || '',
    excerpt: post.excerpt || '',
    faqItems: post.faqItems || [],
    articleType: articleType as 'hub' | 'sub-pillar' | 'spoke',
    targetWords,
    hasImage,
    imageAlt,
    airportCode: post.airportCode || undefined,
    parentSlug: post.parentSlug || undefined,
    hubSlug: post.hubSlug || undefined,
  })

  const missedQueries = perf.queries
    .filter((q) => q.impressions >= 20 && (q.clicks === 0 || q.ctr < 0.01))
    .slice(0, 10)

  const snapshot: PerfSnapshot = {
    capturedAt: new Date().toISOString(),
    dateRange: perf.dateRange,
    gsc: { found: perf.found, totals: perf.totals, queries: perf.queries },
    onPage: {
      title: post.title || '',
      metaTitle: post.seo?.metaTitle || '',
      metaDescription: post.seo?.metaDescription || '',
      wordCount: countWords(html),
      faqCount: Array.isArray(post.faqItems) ? post.faqItems.length : 0,
      hasQuickAnswer: detectQuickAnswer(html),
      hasCtaBlock: detectCtaBlock(html),
      contentUpdatedAt: post.contentUpdatedAt || null,
      publishedAt: post.publishedAt || null,
      seoScore: score.total,
      seoGrade: score.grade,
    },
    derived: {
      positionBucket: positionBucket(perf.found, perf.totals.position),
      missedQueries,
    },
  }

  const existing = loadRecord(slug)
  const record: ArticlePerfRecord = existing || {
    slug,
    url: perf.url,
    airportCode: post.airportCode || null,
    articleType,
    keyword,
    snapshots: [],
    changes: [],
  }
  // Keep identity fields fresh on each run.
  record.url = perf.url || record.url
  record.airportCode = post.airportCode || record.airportCode
  record.articleType = articleType
  record.keyword = keyword
  record.snapshots.push(snapshot)

  const savedTo = saveRecord(record)

  // Console summary.
  console.log(`\n📊 Snapshot — ${slug}`)
  console.log(`   URL: ${perf.url || '(not found in GSC)'}`)
  if (perf.found) {
    console.log(`   GSC (${perf.dateRange.start}→${perf.dateRange.end}): ` +
      `${perf.totals.impressions.toLocaleString()} impr · ${perf.totals.clicks} clicks · pos ${perf.totals.position.toFixed(1)} ` +
      `[${snapshot.derived.positionBucket}]`)
    console.log(`   CTR ${(perf.totals.ctr * 100).toFixed(2)}% (diagnostic only — GSC CTR unreliable)`)
    console.log(`   Queries: ${perf.queries.length} · missed (high-impr, ~no clicks): ${missedQueries.length}`)
  } else {
    console.log(`   GSC: no data in range (new / not indexed / zero impressions)`)
  }
  console.log(`   On-page: ${snapshot.onPage.wordCount} words · SEO ${score.total} (${score.grade}) · ` +
    `FAQ ${snapshot.onPage.faqCount} · quick-answer ${snapshot.onPage.hasQuickAnswer ? 'yes' : 'no'} · ` +
    `CTA ${snapshot.onPage.hasCtaBlock ? 'yes' : 'no'}`)
  console.log(`   Saved → ${savedTo} (${record.snapshots.length} snapshot(s) total)\n`)

  return record
}
