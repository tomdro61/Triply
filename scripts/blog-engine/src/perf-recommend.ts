/**
 * perf-recommend.ts — the "research → recommendations" brain of the perf loop.
 *
 * Reads the article's latest snapshot (GSC + on-page) from its record, pulls the
 * live SERP + AI-Overview for its keyword, factors in the history of prior
 * changes + verdicts, and asks Claude for a small set of specific, reversible,
 * data-grounded improvements. Output is zod-validated (rejects malformed JSON).
 *
 * Recommendation types (all additive/reversible → auto-appliable):
 *   - title-meta      : rewrite title + meta (e.g. lead with price like the SERP winners)
 *   - quick-answer    : prepend a 40-75w answer-first block (GEO / AI-citation lever)
 *   - faq-additions   : append Q&A answering SERP People-Also-Ask gaps
 *   - flag            : surfaced for a human (full refresh / consolidate) — NOT applied
 *
 * Strategy bias (from the 2026 research): CTR + GEO + freshness + commercial intent.
 * seoScore is context only. Never invent prices/facts.
 */

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { env, PERF_MODEL } from './config.js'
import { loadRecord, saveRecord } from './perf-snapshot.js'
import type { ArticlePerfRecord } from './perf-snapshot.js'
import { analyzeSerp } from './perf-serp.js'
import type { SerpAnalysis } from './perf-serp.js'
import { findPostBySlug } from './payload.js'
import { lexicalToHtml } from './lexical-to-html.js'
import { parseJsonResponse } from './claude.js'
import { loadParkingLots, unverifiedTitlePrice } from './airport-data.js'

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
const MODEL = PERF_MODEL

const FaqItem = z.object({ question: z.string(), answer: z.string() })
const Rec = z.object({
  type: z.enum(['title-meta', 'quick-answer', 'faq-additions', 'flag']),
  tier: z.enum(['A', 'B', 'C']),
  rationale: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  autoApply: z.boolean(),
  title: z.string().optional(),
  metaTitle: z.string().optional(),
  metaDescription: z.string().optional(),
  quickAnswerHtml: z.string().optional(),
  faqItems: z.array(FaqItem).optional(),
})
export type Recommendation = z.infer<typeof Rec>

/** Salvage common model mistakes before validation (e.g. type set to a payload field name). */
function normalizeRec(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw
  const t = raw.type
  const valid = ['title-meta', 'quick-answer', 'faq-additions', 'flag']
  if (!valid.includes(t)) {
    if (raw.quickAnswerHtml) raw.type = 'quick-answer'
    else if (raw.faqItems) raw.type = 'faq-additions'
    else if (raw.title || raw.metaTitle || raw.metaDescription) raw.type = 'title-meta'
    else raw.type = 'flag'
  }
  if (typeof raw.autoApply !== 'boolean') raw.autoApply = raw.type !== 'flag'
  if (!['A', 'B', 'C'].includes(raw.tier)) raw.tier = 'C'
  if (!['high', 'medium', 'low'].includes(raw.confidence)) raw.confidence = 'medium'
  return raw
}

function serpSummary(s: SerpAnalysis): string {
  if (!s.found) return 'SERP: unavailable (SerpAPI error/quota).'
  const top = s.organic.slice(0, 6).map((r) => `${r.position}. ${r.domain}${r.isUs ? '(US)' : ''} "${r.title.slice(0, 55)}"`).join('\n')
  return [
    `AI Overview: ${s.aioPresent ? (s.aioCitesUs ? 'present, WE are cited' : 'present, we are NOT cited') : 'none'}`,
    `Our organic position: ${s.ourPosition ?? 'not in top 10'}`,
    `Top organic:\n${top}`,
    s.paa.length ? `People Also Ask: ${s.paa.slice(0, 6).join(' | ')}` : '',
    s.related.length ? `Related: ${s.related.slice(0, 8).join(' | ')}` : '',
  ].filter(Boolean).join('\n')
}

function historySummary(rec: ArticlePerfRecord): string {
  if (!rec.changes.length) return 'No prior changes.'
  return rec.changes.slice(-6).map((c) => {
    const v = c.measuredAfter ? c.measuredAfter.verdict : 'not-yet-measured'
    return `- ${c.type} (${c.at.slice(0, 10)}): ${v}`
  }).join('\n')
}

/** All dollar figures (digits only) mentioned in a string, e.g. "$10.62/day" → "10.62". */
function dollarFigures(s: string): string[] {
  return (s.match(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g) || []).map((x) => x.replace(/[^\d.]/g, ''))
}

/**
 * Anti-fabrication guard: every dollar figure a recommendation wants to publish
 * MUST already appear in the article's real content (which was written from
 * verified airport data). Recs citing an unverifiable price are dropped — we
 * never let the loop invent a rate into a live title/meta/answer.
 */
function priceGuard(rec: Recommendation, articleText: string): boolean {
  const fields = [rec.title, rec.metaTitle, rec.metaDescription, rec.quickAnswerHtml,
    ...(rec.faqItems || []).flatMap((f) => [f.question, f.answer])].filter(Boolean) as string[]
  for (const f of fields) {
    for (const num of dollarFigures(f)) {
      if (!articleText.includes(num)) return false
    }
  }
  return true
}

/**
 * Brand/accuracy guard: reject edits with absolute or legally-risky claims the
 * auto-revert (which only watches rankings) would never catch. Complements the
 * price guard. Targeted to real FTC/brand risk, not legit copy like "cheapest".
 */
const RISKY_PATTERNS: [RegExp, string][] = [
  [/\bguarantee(d|s)?\b/i, 'guarantee'],
  [/\b100\s?%/i, '100%'],
  [/(\B#\s?1\b|\bnumber one\b)/i, '#1'],
  [/\bno hidden fees?\b/i, 'no hidden fees'],
  [/\bprice match\b/i, 'price match'],
  [/\b(cheapest|lowest)\b[^.]{0,30}\b(anywhere|guaranteed|in the world|in the us|nationwide)\b/i, 'unqualified superlative'],
]
function brandAccuracyRisk(rec: Recommendation): string | null {
  const fields = [rec.title, rec.metaTitle, rec.metaDescription, rec.quickAnswerHtml,
    ...(rec.faqItems || []).flatMap((f) => [f.question, f.answer])].filter(Boolean) as string[]
  for (const f of fields) for (const [re, label] of RISKY_PATTERNS) if (re.test(f)) return label
  return null
}

/**
 * A lot's price verified longer ago than this may not be promoted into a SERP title/meta
 * (per lot since 2026-09-28 — see staleRatePromotion). 0 disables the guard.
 *
 * 150 is chosen against the real distribution (2026-08-17: 28 airports at 130-136 days,
 * JFK/LGA outliers at 172). It blocks the genuinely worst data now while leaving the bulk
 * working, and tightens automatically as files age — a tripwire that arms itself rather
 * than a switch that fires across the whole corpus today. Lower it once the airport JSONs
 * are refreshed; anything below 130 currently blocks every price-led title.
 */
export const PRICE_STALENESS_MAX_DAYS = Number(process.env.PRICE_STALENESS_MAX_DAYS ?? 150)

/**
 * Rate-staleness guard: the anti-fabrication guard above proves a price exists in the
 * ARTICLE — not that it is still TRUE. Article prices come from data/airports/<code>.json,
 * and nothing in the engine refreshes those files (`bootstrap` is a new-airport generator
 * that strips fields, not a refresher), so lastVerified only ever gets older.
 *
 * That is tolerable while a number sits in paragraph nine with its context. It is not
 * tolerable in a SERP title, because the CTR thesis is to front-load the price — which
 * turns a possibly-stale figure into the promise that wins the click and then breaks at
 * checkout. So this guard is deliberately narrow:
 *   - title-meta ONLY. quick-answer/faq keep their prices — those carry the GEO push, and
 *     gating them would strip the content levers a GEO-escalated page depends on.
 *   - only a price NOT already published in the live title/meta. Re-stating a price the
 *     page already shows promises nothing new, so blocking it would cost a treatment for
 *     no safety gain.
 */
/*
 * PER-LOT, not per-file (2026-09-28). The guard used to compare the FILE's lastVerified
 * to the limit, so one unsellable catalogue lot that could never be re-verified held a
 * whole airport stale (28 of 30 files at 172-178d). It now asks the narrower, truer
 * question: is every NEW price in the title/meta the price of a lot that is still
 * sellable and was verified live within `maxDays`? A price that matches no such lot —
 * an unsellable lot, an unverified lot, an on-airport garage rate, or a number the
 * article derived itself — is blocked, however recent the file date. Exact match only:
 * "$36" does not pass on a verified $35.95.
 */
export function staleRatePromotion(
  rec: Recommendation,
  airportCode: string | null,
  onPage: { title: string; metaTitle: string; metaDescription: string },
  maxDays: number = PRICE_STALENESS_MAX_DAYS,
  now: Date = new Date(),
): { price: string; reason: string } | null {
  if (maxDays <= 0 || rec.type !== 'title-meta' || !airportCode) return null
  const lots = loadParkingLots(airportCode)
  if (lots === null) return null
  return unverifiedTitlePrice([rec.title, rec.metaTitle, rec.metaDescription], onPage, lots, maxDays, now)
}

// Loose outer schema — each recommendation is validated individually below (a
// single malformed item is dropped, not fatal), so the array holds unknowns here.
const OuterRecSchema = z.object({ recommendations: z.array(z.unknown()).optional() })

/**
 * Build the article excerpt shown to the model. It's the first `headLen` chars PLUS
 * any later fragments that contain a real dollar figure — so the model can reference
 * accurate prices that appear deep in the article, not just the intro. (The
 * anti-fabrication priceGuard already checks the FULL text; this keeps the model's
 * view of real prices from being truncated.)
 */
function buildRatesExcerpt(text: string, headLen = 2500, maxLen = 4000): string {
  let out = text.slice(0, headLen)
  const tail = text.slice(headLen)
  const priceBits = tail.match(/[^.]*\$\s?\d[\d,]*(?:\.\d+)?[^.]*\./g) || []
  for (const bit of priceBits) {
    if (out.length >= maxLen) break
    out += '\n' + bit.trim()
  }
  return out
}

/**
 * Generate recommendations for a slug. Requires a snapshot already in the record
 * (call buildSnapshot first — `perf run` does this). Pulls live SERP unless
 * withSerp=false. Returns the validated recommendations and stores them on the
 * record's latest snapshot for the apply stage.
 */
export async function recommend(slug: string, withSerp = true, onlyTypes?: string[]): Promise<Recommendation[]> {
  const rec = loadRecord(slug)
  if (!rec || rec.snapshots.length === 0) {
    throw new Error(`No snapshot for "${slug}" — run \`perf snapshot --slug ${slug}\` first.`)
  }
  const snap = rec.snapshots[rec.snapshots.length - 1]

  // Fetch the real article text — used both to ground the model on OUR actual
  // rates and to hard-reject any recommendation citing a price we can't verify.
  const post = await findPostBySlug(slug)
  const articleHtml: string = post?.content ? lexicalToHtml(post.content) : ''
  const articleText = articleHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const ratesExcerpt = buildRatesExcerpt(articleText)

  const serp: SerpAnalysis = withSerp
    ? await analyzeSerp(rec.keyword)
    : { keyword: rec.keyword, found: false, aioPresent: false, aioCitesUs: false, aioSources: [], organic: [], ourPosition: null, paa: [], related: [] }

  // Persist AI-Overview status onto the snapshot we're recommending from, so the
  // maintenance router can later see "we rank but the AIO doesn't cite us" (a GEO
  // problem) without spending another SERP credit at classification time.
  if (serp.found) {
    snap.geo = { aioPresent: serp.aioPresent, aioCitesUs: serp.aioCitesUs, capturedAt: new Date().toISOString() }
    saveRecord(rec)
  }

  const missed = snap.derived.missedQueries.slice(0, 8).map((q) => `"${q.query}" (${q.impressions} impr, ${q.clicks} clicks)`).join(', ') || 'none'

  const prompt = `You are optimizing ONE published airport-parking article for more clicks, AI-search citation, and bookings. Recommend at most 3 SPECIFIC, additive, reversible improvements, grounded in the data below. Bias toward CTR (title/meta), GEO (answer-first Quick Answer box), and answering real user questions. Treat the internal SEO score as context only — it does NOT predict ranking.

ARTICLE
- keyword (primary intent): "${rec.keyword}"
- type: ${rec.articleType}
- current title: "${snap.onPage.title}"
- current metaTitle: "${snap.onPage.metaTitle}"
- current metaDescription: "${snap.onPage.metaDescription}"
- word count: ${snap.onPage.wordCount}, FAQ count: ${snap.onPage.faqCount}
- already has quick-answer block: ${snap.onPage.hasQuickAnswer}; has CTA block: ${snap.onPage.hasCtaBlock}
- internal SEO score: ${snap.onPage.seoScore} (${snap.onPage.seoGrade}) [context only]

GOOGLE (last ${snap.dateRange.start}→${snap.dateRange.end}) — impressions/position are trustworthy, CTR is NOT
- impressions: ${snap.gsc.totals.impressions}, clicks: ${snap.gsc.totals.clicks}, avg position: ${snap.gsc.totals.position.toFixed(1)} [${snap.derived.positionBucket}]
- high-impression queries getting ~no clicks: ${missed}

LIVE SERP for "${rec.keyword}"
${serpSummary(serp)}

HISTORY (learn from this — do not re-propose what was done; avoid what hurt)
${historySummary(rec)}

ARTICLE CONTENT (the ONLY source of truth for prices/facts — do not use any dollar figure not present here):
"""
${ratesExcerpt}
"""

RULES
- Do NOT invent specific prices, rates, or facts. Only cite a dollar figure if it appears verbatim in the ARTICLE CONTENT above. If unsure, answer qualitatively (e.g. "budget-friendly off-site lots") with NO number.
- metaTitle <= 60 chars; metaDescription 120-160 chars. If competitors lead with price/value and the query is commercial, lead the title with the value angle — but stay accurate to the article.
- quickAnswerHtml: only if hasQuickAnswer is false. Format EXACTLY as "<h3>Quick answer</h3><p>...</p>" with a direct 40-75 word answer to the primary query. No fabricated numbers.
- faq-additions: 2-4 Q&A answering the People-Also-Ask questions not already covered; answers 40-60 words, no fabricated numbers.
- Every rationale MUST cite a specific number or SERP fact from above.
- type 'flag' (autoApply:false) for anything needing a full rewrite/consolidation — describe it in rationale, no payload.

Respond with ONLY JSON:
{"recommendations":[{"type":"title-meta","tier":"C","confidence":"high","autoApply":true,"rationale":"...","title":"...","metaTitle":"...","metaDescription":"..."}]}`

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = res.content[0].type === 'text' ? res.content[0].text : ''
  // Reuse the engine's repair-capable parser (control-char + unescaped-quote fixes)
  // instead of a raw JSON.parse — the model often returns HTML with literal quotes
  // inside quickAnswerHtml/faq answers, which would otherwise throw and abort the run.
  let obj: { recommendations?: unknown[] }
  try {
    obj = parseJsonResponse(text, OuterRecSchema)
  } catch (e) {
    console.log(`  ⚠ could not parse recommendations JSON (${e instanceof Error ? e.message : e}) — no recs this run`)
    return []
  }
  const rawRecs = Array.isArray(obj.recommendations) ? obj.recommendations : []

  // Validate each recommendation independently — a single malformed item is dropped
  // (with a warning) rather than aborting the whole run.
  let dropped = 0
  const validated: Recommendation[] = []
  for (const raw of rawRecs) {
    const parsed = Rec.safeParse(normalizeRec(raw))
    if (parsed.success) validated.push(parsed.data)
    else dropped++
  }
  if (dropped) console.log(`  ⚠ dropped ${dropped} malformed recommendation(s)`)

  // Keep only recs whose required payload for their type is present.
  const wellFormed = validated.filter((r) => {
    if (r.type === 'title-meta') return !!(r.title || r.metaTitle || r.metaDescription)
    if (r.type === 'quick-answer') return !!r.quickAnswerHtml && !snap.onPage.hasQuickAnswer
    if (r.type === 'faq-additions') return !!(r.faqItems && r.faqItems.length)
    return true // flag
  })

  // Guards: (1) anti-fabrication — no dollar figure that isn't in the real article;
  // (2) brand/accuracy — no absolute/legal-risk claims the ranking-only revert can't catch;
  // (3) rate-staleness — don't promote an unrefreshed price into the SERP title/meta.
  const recs = wellFormed.filter((r) => {
    if (!priceGuard(r, articleText)) {
      console.log(`  ⚠ dropped a ${r.type} rec — cited a price not found in the article (anti-fabrication guard)`)
      return false
    }
    const risk = brandAccuracyRisk(r)
    if (risk) {
      console.log(`  ⚠ dropped a ${r.type} rec — risky/absolute claim "${risk}" (brand/accuracy guard)`)
      return false
    }
    const stale = staleRatePromotion(r, rec.airportCode, snap.onPage)
    if (stale) {
      console.log(`  ⚠ dropped a ${r.type} rec — would promote $${stale.price} into the SERP title/meta, but it is ${stale.reason} at ${rec.airportCode} (rate-staleness guard)`)
      return false
    }
    return true
  })

  // Optional caller-side restriction (e.g. a bulk quick-answer rollout that wants
  // ONLY quick-answer recs out of this slug, ignoring any title-meta/faq the model
  // also proposed). Additive — omitted/undefined preserves today's behavior.
  const filtered = onlyTypes && onlyTypes.length ? recs.filter((r) => onlyTypes.includes(r.type)) : recs

  printRecommendations(slug, filtered)
  return filtered
}

export function printRecommendations(slug: string, recs: Recommendation[]): void {
  console.log(`\n🧠 Recommendations — ${slug} (${recs.length})`)
  recs.forEach((r, i) => {
    console.log(`\n  ${i + 1}. [${r.type}] tier ${r.tier} · ${r.confidence} confidence · ${r.autoApply ? 'auto-apply' : 'FLAG (manual)'}`)
    console.log(`     why: ${r.rationale}`)
    if (r.type === 'title-meta') {
      if (r.title) console.log(`     title → ${r.title}`)
      if (r.metaTitle) console.log(`     metaTitle → ${r.metaTitle}`)
      if (r.metaDescription) console.log(`     metaDescription → ${r.metaDescription}`)
    }
    if (r.type === 'quick-answer') console.log(`     quick-answer → ${r.quickAnswerHtml?.replace(/<[^>]+>/g, ' ').trim().slice(0, 160)}...`)
    if (r.type === 'faq-additions') r.faqItems?.forEach((f) => console.log(`     Q: ${f.question}`))
  })
  console.log('')
}
