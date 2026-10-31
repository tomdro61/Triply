/**
 * maintain-tier.ts — the pure classifier for the tiered maintenance loop.
 *
 * Given one article's performance record, decide WHICH tier of treatment it
 * deserves and WHETHER it's due this cycle. No I/O, no side effects — pure and
 * unit-testable. The `maintain` CLI (maintain.ts) owns fetching, dispatching,
 * and persisting; this file only decides.
 *
 * Tier signal = SEARCH PERFORMANCE (GSC position + impressions), with the
 * internal SEO score as an escalation override only. GSC impressions/position
 * are the trustworthy signals; CTR is diagnostic-only (2025-26 GSC logging bug).
 *
 *   Tier 1 — full rewrite : real demand, failing rank (or broken on-page score)
 *   Tier 2 — standard      : striking distance (pos 11-20) — one push from page 1
 *   Tier 3 — small         : page 1 (pos 4-10) — ranking, just needs the click
 *   Tier 0 — watch         : winning, or too little demand/data to act on
 *
 * A cooldown (an unmeasured change younger than the attribution window) freezes
 * an article so we never stack edits before `perf measure` can judge the last one.
 */

import type { ArticlePerfRecord, PerfSnapshot } from './perf-snapshot.js'
import type { TreatmentPolicy } from './maintain-learn.js'

export type Tier = 0 | 1 | 2 | 3
export type MaintAction = 'rewrite' | 'standard' | 'small' | 'watch' | 'cooldown'

export interface TierConfig {
  /** Re-poll cadence per tier, in days. An article is "due" this long after its last maintenance. */
  cadenceDays: Record<Tier, number>
  /** Attribution window (days). Don't touch a slug with an unmeasured change younger than this. */
  cooldownDays: number
  /** Below this many 28-day impressions → Tier 0 (insufficient demand/data to justify spend). */
  minImpressions: number
  /** A page2plus/unranked page needs at least this many impressions to justify a full rewrite. */
  rewriteMinImpressions: number
  /** seoScore below this (with real impressions) escalates straight to a full rewrite. */
  seoFloor: number
  /** Rough $/article per tier — used only for the plan's projected-cost roll-up. */
  costPerTier: Record<Tier, number>
}

export const DEFAULT_TIER_CONFIG: TierConfig = {
  cadenceDays: { 0: 90, 1: 120, 2: 60, 3: 45 },
  cooldownDays: 28,
  minImpressions: 10,
  rewriteMinImpressions: 50,
  seoFloor: 70,
  costPerTier: { 0: 0, 1: 0.35, 2: 0.04, 3: 0.02 },
}

export interface TierDecision {
  tier: Tier
  action: MaintAction
  reason: string
  /** True when a treatment should run this cycle (past cadence AND not in cooldown). */
  dueNow: boolean
  /** Latest 28-day impressions — used by the runner to order work (highest demand first). */
  impressions: number
  /** Estimated cost of running this tier's treatment (0 for watch/cooldown). */
  estCost: number
  /**
   * True when this article reached Tier 2 via the GEO escalation (an AI Overview is
   * present but doesn't cite us) rather than on its own search performance. The
   * distinction matters at treatment time — see allowedRecTypes().
   */
  geoOverride?: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

function daysBetween(a: Date, bIso: string): number {
  return (a.getTime() - new Date(bIso).getTime()) / DAY_MS
}

/**
 * Is the article frozen by an in-flight edit? True if any logged change has no
 * measuredAfter verdict yet AND was applied within the attribution window.
 * Reuses record.changes[] owned by the apply/measure stages.
 */
export function inCooldown(record: ArticlePerfRecord, now: Date, cooldownDays: number): boolean {
  // A patchUnverified entry (the edit MAY be live) still counts: stacking another edit on an unknown state is the confound the cooldown prevents.
  return record.changes.some((c) => !c.measuredAfter && !c.reverted && daysBetween(now, c.at) < cooldownDays)
}

/** Due when never maintained, or when cadence[tier] days have elapsed since last maintenance. */
function isDue(record: ArticlePerfRecord, tier: Tier, now: Date, config: TierConfig): boolean {
  const last = record.maintenance?.lastMaintainedAt
  if (!last) return true
  return daysBetween(now, last) >= config.cadenceDays[tier]
}

/**
 * Most recent AI-Overview reading across the record's snapshots, within maxAgeDays.
 * Citation is captured on its own cadence (SerpAPI-gated), so it may live on an older
 * snapshot than the latest GSC one — scan back rather than only reading the newest.
 */
export function recentGeo(record: ArticlePerfRecord, now: Date, maxAgeDays = 45): PerfSnapshot['geo'] | undefined {
  const cutoff = now.getTime() - maxAgeDays * DAY_MS
  for (let i = record.snapshots.length - 1; i >= 0; i--) {
    const g = record.snapshots[i].geo
    if (g && new Date(g.capturedAt).getTime() >= cutoff) return g
  }
  return undefined
}

/**
 * Snapshot-over-snapshot movement, used to tell "AI Overview ate the clicks" from
 * true content decay WITHOUT a SerpAPI reading (saves the quota-limited credit).
 * Compares the latest snapshot to the newest one at least `minSpanDays` older.
 */
export interface Trend {
  hasTrend: boolean
  days: number
  priorClicks: number
  priorImpressions: number
  clicksDelta: number
  impressionsDelta: number
  positionDelta: number
}

export function computeTrend(record: ArticlePerfRecord, minSpanDays = 14): Trend {
  const none: Trend = { hasTrend: false, days: 0, priorClicks: 0, priorImpressions: 0, clicksDelta: 0, impressionsDelta: 0, positionDelta: 0 }
  const snaps = record.snapshots
  if (!snaps || snaps.length < 2) return none
  const latest = snaps[snaps.length - 1]
  const lt = new Date(latest.capturedAt).getTime()
  let base: PerfSnapshot | null = null
  for (let i = snaps.length - 2; i >= 0; i--) {
    if ((lt - new Date(snaps[i].capturedAt).getTime()) / DAY_MS >= minSpanDays) { base = snaps[i]; break }
  }
  if (!base) base = snaps[0]
  const days = (lt - new Date(base.capturedAt).getTime()) / DAY_MS
  if (days <= 0) return none
  const lg = latest.gsc.totals, bg = base.gsc.totals
  return {
    hasTrend: true, days,
    priorClicks: bg.clicks, priorImpressions: bg.impressions,
    clicksDelta: lg.clicks - bg.clicks, impressionsDelta: lg.impressions - bg.impressions, positionDelta: lg.position - bg.position,
  }
}

/**
 * The decay-vs-AIO fork: clicks materially DOWN while impressions and position
 * held steady is the fingerprint of an AI Overview capturing the clicks — refreshing
 * won't win them back; a citation push will. (True decay shows clicks down AND
 * impressions down AND position worsening — which the position bucket already routes.)
 */
function looksLikeAioCapture(t: Trend): boolean {
  if (!t.hasTrend || t.priorClicks < 5) return false
  const clicksDrop = -t.clicksDelta / t.priorClicks
  const imprChange = t.priorImpressions > 0 ? t.impressionsDelta / t.priorImpressions : 0
  return clicksDrop >= 0.2 && Math.abs(imprChange) <= 0.15 && Math.abs(t.positionDelta) <= 1.5
}

/** Map a snapshot to its base tier + action + human reason, using search performance. */
function baseTier(snap: PerfSnapshot, config: TierConfig, geo?: PerfSnapshot['geo'], trend?: Trend): { tier: Tier; action: MaintAction; reason: string; geoOverride?: boolean } {
  const impr = snap.gsc.totals.impressions
  const pos = snap.gsc.totals.position
  const bucket = snap.derived.positionBucket
  const seo = snap.onPage.seoScore
  // "We rank but the AI Overview doesn't cite us" — a GEO problem that climbing
  // position won't fix. Uses the most recent citation reading (may predate this snapshot).
  const aioUncited = !!(geo?.aioPresent && !geo.aioCitesUs)
  // Inferred AIO capture from GSC trend alone (no SerpAPI needed): clicks falling
  // while impressions + position hold steady.
  const aioInferred = !aioUncited && !!trend && looksLikeAioCapture(trend)
  const dropPct = trend && trend.priorClicks > 0 ? Math.round((-trend.clicksDelta / trend.priorClicks) * 100) : 0

  // Escalation override: a fundamentally broken on-page score with real demand
  // gets a full rewrite regardless of where it currently ranks.
  if (seo < config.seoFloor && impr >= config.minImpressions) {
    return { tier: 1, action: 'rewrite', reason: `SEO ${seo} < ${config.seoFloor} floor with ${impr} impr — rewrite` }
  }

  // Too little demand/data to spend on.
  if (impr < config.minImpressions) {
    return { tier: 0, action: 'watch', reason: `only ${impr} impr — insufficient demand/data` }
  }

  if (bucket === 'top3') {
    // A top-3 page losing clicks to an AI Overview it isn't in is a GEO opportunity,
    // NOT a leave-alone — a Quick Answer block is the lever to get cited.
    if (aioUncited) return { tier: 2, action: 'standard', reason: `top 3 (pos ${pos.toFixed(1)}) but AI Overview doesn't cite us — GEO push`, geoOverride: true }
    if (aioInferred) return { tier: 2, action: 'standard', reason: `top 3 (pos ${pos.toFixed(1)}) but clicks down ${dropPct}% with steady impressions/position — likely AI Overview capture, GEO push`, geoOverride: true }
    return { tier: 0, action: 'watch', reason: `winning (top 3, pos ${pos.toFixed(1)}) — leave alone` }
  }
  if (bucket === 'page1') {
    // If an AIO owns the clicks, a title/meta tweak won't win them — go for GEO citation.
    if (aioUncited) return { tier: 2, action: 'standard', reason: `page 1 (pos ${pos.toFixed(1)}) but AI Overview doesn't cite us — GEO push over CTR tweak`, geoOverride: true }
    if (aioInferred) return { tier: 2, action: 'standard', reason: `page 1 (pos ${pos.toFixed(1)}) but clicks down ${dropPct}% with steady impressions/position — likely AI Overview capture, GEO push over CTR tweak`, geoOverride: true }
    return { tier: 3, action: 'small', reason: `page 1 (pos ${pos.toFixed(1)}) — title/meta CTR rescue` }
  }
  if (bucket === 'striking-distance') {
    return { tier: 2, action: 'standard', reason: `striking distance (pos ${pos.toFixed(1)}) — content push to page 1` }
  }
  // page2plus / unranked
  if (impr >= config.rewriteMinImpressions) {
    return { tier: 1, action: 'rewrite', reason: `${impr} impr but ${bucket} — demand exists, rewrite` }
  }
  return { tier: 0, action: 'watch', reason: `low demand (${impr} impr) on ${bucket} — not worth a rewrite yet` }
}

/**
 * Classify one article. Requires at least one snapshot in the record; without
 * data it defaults to Tier 0 watch (nothing to act on).
 */
export function classify(
  record: ArticlePerfRecord,
  now: Date = new Date(),
  config: TierConfig = DEFAULT_TIER_CONFIG,
): TierDecision {
  const snap = record.snapshots[record.snapshots.length - 1]
  if (!snap) {
    return { tier: 0, action: 'watch', reason: 'no snapshot yet — run maintain plan --refresh', dueNow: false, impressions: 0, estCost: 0 }
  }

  const { tier, action, reason, geoOverride } = baseTier(snap, config, recentGeo(record, now, 45), computeTrend(record))
  const impressions = snap.gsc.totals.impressions

  // Cooldown freezes any treatment (but we still report the underlying tier).
  if (action !== 'watch' && inCooldown(record, now, config.cooldownDays)) {
    return { tier, action: 'cooldown', reason: `${reason} — but frozen: unmeasured edit < ${config.cooldownDays}d old`, dueNow: false, impressions, estCost: 0, geoOverride }
  }

  const dueNow = action !== 'watch' && isDue(record, tier, now, config)
  return { tier, action, reason, dueNow, impressions, estCost: dueNow ? config.costPerTier[tier] : 0, geoOverride }
}

/**
 * Recommendation types the apply stage may run for a given tier, minus any the
 * learned policy has disabled for this article-type (the feedback loop — we stop
 * doing what measurably loses). Pure: the policy is passed in, not read from disk.
 */
export function allowedRecTypes(
  tier: Tier,
  articleType?: string,
  policy?: TreatmentPolicy | null,
  opts?: { geoOverride?: boolean },
): string[] {
  let base = tier === 3 ? ['title-meta'] : tier === 2 ? ['quick-answer', 'faq-additions'] : []

  // The GEO escalation promotes a page-1/top-3 article to Tier 2 because an AI Overview
  // ignores it. Left alone, that promotion also REMOVES the title-meta lever the article
  // would have had as Tier 3 — so a page that already carries a quick-answer and FAQ
  // lands in a tier with nothing left to give, produces "no recommendation", and burns a
  // slot on every future run. Worse, applying the quick-answer is what creates that state,
  // so the trap tightens with each cycle. Extend the set instead of replacing it: keep the
  // GEO content push AND keep the CTR lever.
  if (tier === 2 && opts?.geoOverride && !base.includes('title-meta')) base = [...base, 'title-meta']

  if (!policy || !articleType) return base
  return base.filter((type) => !policy.disabled[`${articleType}:${type}`])
}

/** Shallow-merge an optional operator-tuned override over the defaults (nested tier maps merged too). */
export function resolveTierConfig(base: TierConfig, override?: Partial<TierConfig> | null): TierConfig {
  if (!override) return base
  return {
    ...base,
    ...override,
    cadenceDays: { ...base.cadenceDays, ...(override.cadenceDays || {}) },
    costPerTier: { ...base.costPerTier, ...(override.costPerTier || {}) },
  }
}

/** nextDueAt = now + cadence[tier], as an ISO string. */
export function nextDueAt(tier: Tier, now: Date, config: TierConfig = DEFAULT_TIER_CONFIG): string {
  return new Date(now.getTime() + config.cadenceDays[tier] * DAY_MS).toISOString()
}
