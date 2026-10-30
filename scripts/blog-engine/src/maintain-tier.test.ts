// Unit tests for the tier classifier's GEO escalation and the treatment set it unlocks.
//
// Regression context: the GEO override promotes a page-1/top-3 article to Tier 2 when an
// AI Overview is present but doesn't cite us. Tier 2's treatment set is
// ['quick-answer','faq-additions'], so the promotion silently REMOVED the 'title-meta'
// lever the article would have had as Tier 3. A page that already carried a quick-answer
// and FAQ therefore had no applicable treatment at all, produced "no recommendation", and
// consumed a slot on every run forever. Measured 2026-08-17: 33 pages / 185k monthly
// impressions in that state.
//
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, allowedRecTypes, DEFAULT_TIER_CONFIG } from './maintain-tier.js'
import type { ArticlePerfRecord, PerfSnapshot } from './perf-snapshot.js'

const NOW = new Date('2026-08-17T00:00:00Z')

function snapshot(over: {
  impressions: number
  position: number
  bucket: PerfSnapshot['derived']['positionBucket']
  seoScore?: number
  geo?: PerfSnapshot['geo']
  capturedAt?: string
}): PerfSnapshot {
  return {
    capturedAt: over.capturedAt ?? '2026-08-16T00:00:00Z',
    dateRange: { start: '2026-07-19', end: '2026-08-16' },
    gsc: {
      found: true,
      totals: { clicks: 10, impressions: over.impressions, ctr: 0.01, position: over.position },
      queries: [],
    },
    onPage: {
      title: 't', metaTitle: 't', metaDescription: 'd',
      wordCount: 2000, faqCount: 6,
      hasQuickAnswer: true, hasCtaBlock: false,
      contentUpdatedAt: null, publishedAt: '2026-04-01T00:00:00Z',
      seoScore: over.seoScore ?? 95, seoGrade: 'A',
    },
    derived: { positionBucket: over.bucket, missedQueries: [] },
    geo: over.geo,
  }
}

function record(snap: PerfSnapshot): ArticlePerfRecord {
  return {
    slug: 's', url: null, airportCode: 'ATL', articleType: 'spoke',
    keyword: 'k', snapshots: [snap], changes: [],
  }
}

const AIO_UNCITED = { aioPresent: true, aioCitesUs: false, capturedAt: '2026-08-16T00:00:00Z' }
const AIO_CITED = { aioPresent: true, aioCitesUs: true, capturedAt: '2026-08-16T00:00:00Z' }

// ── classify() marks the GEO escalation ──────────────────────────────────────

test('page-1 page an AI Overview ignores escalates to tier 2 and is flagged geoOverride', () => {
  const d = classify(record(snapshot({ impressions: 9000, position: 8.1, bucket: 'page1', geo: AIO_UNCITED })), NOW)
  assert.equal(d.tier, 2)
  assert.equal(d.geoOverride, true)
})

test('top-3 page an AI Overview ignores escalates to tier 2 and is flagged geoOverride', () => {
  const d = classify(record(snapshot({ impressions: 9000, position: 2.4, bucket: 'top3', geo: AIO_UNCITED })), NOW)
  assert.equal(d.tier, 2)
  assert.equal(d.geoOverride, true)
})

test('page-1 page that IS cited stays tier 3 and is not flagged', () => {
  const d = classify(record(snapshot({ impressions: 9000, position: 8.1, bucket: 'page1', geo: AIO_CITED })), NOW)
  assert.equal(d.tier, 3)
  assert.ok(!d.geoOverride)
})

test('striking-distance reaches tier 2 on its own merits, NOT via the GEO override', () => {
  const d = classify(record(snapshot({ impressions: 9000, position: 15.4, bucket: 'striking-distance' })), NOW)
  assert.equal(d.tier, 2)
  assert.ok(!d.geoOverride, 'must not be flagged — it never lost a title-meta lever')
})

// ── allowedRecTypes() — the actual fix ───────────────────────────────────────

test('plain tier 2 keeps the two content levers only', () => {
  assert.deepEqual(allowedRecTypes(2, 'spoke', null), ['quick-answer', 'faq-additions'])
})

test('GEO-escalated tier 2 ALSO keeps title-meta (the regression)', () => {
  const allowed = allowedRecTypes(2, 'spoke', null, { geoOverride: true })
  assert.deepEqual(allowed, ['quick-answer', 'faq-additions', 'title-meta'])
})

test('the escalation never costs a page a lever it would have had as tier 3', () => {
  // The whole point: promoting page1 -> tier 2 must be strictly additive.
  const asTier3 = allowedRecTypes(3, 'spoke', null)
  const escalated = allowedRecTypes(2, 'spoke', null, { geoOverride: true })
  for (const t of asTier3) assert.ok(escalated.includes(t), `escalation dropped "${t}"`)
})

test('tier 3 is unaffected by the geoOverride flag', () => {
  assert.deepEqual(allowedRecTypes(3, 'spoke', null, { geoOverride: true }), ['title-meta'])
})

test('tier 0 and 1 stay empty regardless of the flag', () => {
  assert.deepEqual(allowedRecTypes(0, 'spoke', null, { geoOverride: true }), [])
  assert.deepEqual(allowedRecTypes(1, 'spoke', null, { geoOverride: true }), [])
})

test('learned policy still wins over the GEO extension', () => {
  // The feedback loop must keep the power to disable a proven loser, even one the
  // GEO escalation just re-enabled.
  const policy = { generatedAt: NOW.toISOString(), minSamples: 8, disabled: { 'spoke:title-meta': true } }
  const allowed = allowedRecTypes(2, 'spoke', policy as never, { geoOverride: true })
  assert.deepEqual(allowed, ['quick-answer', 'faq-additions'])
})

test('no policy / no articleType returns the unfiltered set', () => {
  assert.deepEqual(allowedRecTypes(2, undefined, null, { geoOverride: true }), ['quick-answer', 'faq-additions', 'title-meta'])
})

// ── guard: the flag survives the cooldown path ───────────────────────────────

test('a frozen GEO-escalated article still reports geoOverride', () => {
  // classify() returns action 'cooldown' for an unmeasured recent edit but still
  // reports the underlying tier — the flag must survive that path too, or the article
  // silently loses title-meta again the moment it thaws.
  const snap = snapshot({ impressions: 9000, position: 8.1, bucket: 'page1', geo: AIO_UNCITED })
  const r = record(snap)
  r.changes = [{
    at: '2026-08-10T00:00:00Z', type: 'quick-answer', summary: 'x',
    baselineMetrics: { clicks: 1, impressions: 1, position: 1 },
  } as never]
  const d = classify(r, NOW, DEFAULT_TIER_CONFIG)
  assert.equal(d.action, 'cooldown')
  assert.equal(d.geoOverride, true)
})
