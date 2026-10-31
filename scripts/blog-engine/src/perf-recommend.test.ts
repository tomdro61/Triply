// Unit tests for the rate-staleness guard.
//
// Context: the anti-fabrication guard proves a price appears in the ARTICLE, not that it
// is still TRUE. Article prices come from data/airports/<code>.json, which nothing in the
// engine refreshes — on 2026-08-17 the median file was 130 days old and JFK/LGA were 172.
// title-meta treatments deliberately front-load a price, so the loop was promoting
// months-old figures into SERP titles, where a wrong number wins the click and then breaks
// at checkout.
//
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { staleRatePromotion } from './perf-recommend.js'
import { rateAgeDays, unverifiedTitlePrice, lotRateIsFresh, freshLotPrices } from './airport-data.js'

// A threshold no real data file can exceed — used to assert "not stale".
const NEVER_STALE = 10_000_000
// A threshold every real data file exceeds — used to assert "stale".
const ALWAYS_STALE = 1

const onPage = { title: 'JFK Parking Guide', metaTitle: 'JFK Parking', metaDescription: 'Compare JFK lots.' }
const onPageWithPrice = { title: 'JFK Parking from $36/day', metaTitle: 'JFK Parking $36', metaDescription: 'From $36/day.' }

const rec = (over: Record<string, unknown> = {}) => ({
  type: 'title-meta', tier: 'A', confidence: 'high', autoApply: true, rationale: 'r',
  title: 'JFK Terminal 8 Parking: $36/day Pre-Booked',
  metaTitle: 'JFK T8 Parking $36/day',
  metaDescription: 'Red Garage $36/day pre-booked.',
  ...over,
}) as never

// ── rateAgeDays ──────────────────────────────────────────────────────────────

test('rateAgeDays returns a positive age for a real airport', () => {
  const days = rateAgeDays('JFK')
  assert.equal(typeof days, 'number')
  assert.ok((days as number) > 0)
})

test('rateAgeDays is null for an unknown airport', () => {
  assert.equal(rateAgeDays('ZZZ'), null)
})

test('rateAgeDays is quiet — no warning side effect on the caller', () => {
  // Regression guard: loadAirportData warns at >90d. If this ever routes through it,
  // the perf loop would emit one warning line per treated article.
  const warn = console.warn
  let warned = 0
  console.warn = () => { warned++ }
  try { rateAgeDays('JFK') } finally { console.warn = warn }
  assert.equal(warned, 0)
})

// ── the guard itself (per lot since 2026-09-28) ──────────────────────────────
//
// Fixture lots, so the rule is tested independently of how old the real files are.
const NOW = new Date('2026-09-28T12:00:00Z')
const LIMIT = 150
const lots: Record<string, unknown>[] = [
  // sellable, verified today — its prices may go in a title
  { name: 'Verified Lot', dailyRate: 36, totalFor7Days: 280.5, sellable: true, rateVerified: '2026-09-28' },
  // verified long ago — its price may not
  { name: 'Old Lot', dailyRate: 70, rateVerified: '2026-03-01' },
  // absent from live search — never, however recent its rateVerified
  { name: 'Unsellable Lot', dailyRate: 12, sellable: false, rateVerified: '2026-09-28' },
  // never verified at all
  { name: 'Catalogue Lot', dailyRate: 9.95 },
]
type TM = { title?: string; metaTitle?: string; metaDescription?: string }
const guard = (r: TM, page = onPage, l: Record<string, unknown>[] = lots, max = LIMIT) =>
  unverifiedTitlePrice([r.title, r.metaTitle, r.metaDescription], page, l, max, NOW)
const tm = (over: TM = {}): TM => ({
  title: 'JFK Terminal 8 Parking: $36/day Pre-Booked',
  metaTitle: 'JFK T8 Parking $36/day',
  metaDescription: 'Red Garage $36/day pre-booked.',
  ...over,
})

test('allows a NEW price that is a sellable lot verified within the window', () => {
  assert.equal(guard(tm()), null) // $36 = Verified Lot dailyRate
})

test('allows a verified lot total as well as its daily rate', () => {
  assert.equal(guard(tm({ metaDescription: '7 days from $280.50 at Verified Lot.' })), null)
})

test('blocks a NEW price from a lot verified outside the window', () => {
  const hit = guard(tm({ metaDescription: 'Old Lot $70/day.' }))
  assert.ok(hit)
  assert.equal(hit!.price, '70')
})

test('blocks a price from an UNSELLABLE lot even if its rateVerified is recent', () => {
  const hit = guard(tm({ metaDescription: 'Unsellable Lot from $12/day.' }))
  assert.ok(hit)
  assert.equal(hit!.price, '12')
})

test('blocks a price from a lot that was never verified', () => {
  const hit = guard(tm({ metaDescription: 'Catalogue Lot $9.95/day.' }))
  assert.ok(hit)
  assert.equal(hit!.price, '9.95')
})

test('blocks a price that matches no lot at all (e.g. an on-airport garage rate)', () => {
  const hit = guard(tm({ metaDescription: 'Red Garage $45/day walk-in.' }))
  assert.ok(hit)
  assert.equal(hit!.price, '45')
})

test('exact match only — a rounded figure does not borrow a verified rate', () => {
  const l = [{ name: 'X', dailyRate: 35.95, sellable: true, rateVerified: '2026-09-28' }]
  assert.ok(guard(tm(), onPage, l)) // "$36" is not 35.95
  assert.equal(guard({ title: 'JFK $35.95/day', metaTitle: 'JFK $35.95', metaDescription: 'From $35.95/day.' }, onPage, l), null)
})

test('an airport with unsellable lots is NOT stale as a whole — verified lots still pass', () => {
  // The old per-file rule blocked everything here because the file date was held back.
  const mixed = [lots[0], lots[2], lots[3], { name: 'Gone', dailyRate: 8, sellable: false }]
  assert.equal(guard(tm(), onPage, mixed), null)
})

test('no verified lot at the airport blocks every new price, with that reason', () => {
  const hit = guard(tm(), onPage, [lots[1], lots[2], lots[3]])
  assert.ok(hit)
  assert.match(hit!.reason, /no sellable lot/)
})

test('allows re-stating a price the page ALREADY publishes, even if unverified', () => {
  assert.equal(guard(tm({ metaDescription: 'Old Lot $70/day.' }), { ...onPageWithPrice, metaDescription: 'From $70/day.' }), null)
})

test('still blocks a rec that adds a second, unverified price next to a published one', () => {
  const hit = guard(tm({ metaDescription: 'Red Garage $36/day pre-booked or $70/day walk-in.' }), onPageWithPrice)
  assert.ok(hit)
  assert.equal(hit!.price, '70')
})

test('a price-free title-meta rec is never blocked', () => {
  const noPrice = {
    title: 'JFK Terminal 8 Parking: Rates, Shuttle & Tips',
    metaTitle: 'JFK T8 Parking Guide',
    metaDescription: 'Compare Red Garage and off-site options near JFK Terminal 8.',
  }
  assert.equal(guard(noPrice, onPage, []), null)
})

test('lotRateIsFresh: window is inclusive of maxDays; taxes are not title prices', () => {
  assert.equal(lotRateIsFresh({ rateVerified: '2026-05-01', dailyRate: 1 }, 150, NOW), true) // 150d
  assert.equal(lotRateIsFresh({ rateVerified: '2026-04-30', dailyRate: 1 }, 150, NOW), false) // 151d
  assert.equal(lotRateIsFresh({ rateVerified: 'not a date' }, 150, NOW), false)
  assert.deepEqual(freshLotPrices([{ dailyRate: 10, taxesFor6Days: 5, rateVerified: '2026-09-28' }], 150, NOW), [10])
})

// ── the wrapper that reads the real airport file ─────────────────────────────

test('does NOT gate quick-answer — content levers keep their prices', () => {
  // Gating these would strip the GEO push from exactly the pages that need it.
  const qa = rec({ type: 'quick-answer', quickAnswerHtml: '<h3>Quick answer</h3><p>$36/day.</p>' })
  assert.equal(staleRatePromotion(qa, 'JFK', onPage, ALWAYS_STALE), null)
})

test('does NOT gate faq-additions', () => {
  const faq = rec({ type: 'faq-additions', faqItems: [{ question: 'Cost?', answer: '$36/day.' }] })
  assert.equal(staleRatePromotion(faq, 'JFK', onPage, ALWAYS_STALE), null)
})

test('wrapper blocks a made-up price against the real JFK file', () => {
  const hit = staleRatePromotion(rec({ title: 'JFK Parking Guide', metaTitle: 'JFK Parking', metaDescription: 'JFK parking from $1.23/day.' }), 'JFK', onPage, NEVER_STALE)
  assert.ok(hit)
  assert.equal(hit!.price, '1.23')
})

test('maxDays of 0 disables the guard entirely', () => {
  assert.equal(staleRatePromotion(rec(), 'JFK', onPage, 0), null)
})

test('no airport code means no opinion (cannot check staleness)', () => {
  assert.equal(staleRatePromotion(rec(), null, onPage, ALWAYS_STALE), null)
})

test('unknown airport means no opinion rather than a false block', () => {
  assert.equal(staleRatePromotion(rec(), 'ZZZ', onPage, ALWAYS_STALE), null)
})
