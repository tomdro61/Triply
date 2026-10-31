import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lintArticle, isRatesPost } from './lint.js'

const NOW = new Date('2026-10-30T12:00:00Z')
const base = { title: 'EWR Airport Parking Rates: From $18/Day (2026)', metaTitle: 'EWR Parking Rates 2026', keyword: 'ewr airport parking rates', slug: 'ewr-airport-parking-rates', isNew: true, approvedCodes: ['TRIPLY10'], now: NOW }
const goodHtml = '<p>Parking at Newark Airport costs $18/day in the economy lot and $40/day in the terminal garages as of October 2026.</p><h2>Rates</h2><p>Daily rates are set by the Port Authority.</p>'
const rules = (r: ReturnType<typeof lintArticle>) => r.errors.map((e) => e.rule)

test('a clean rates post passes', () => {
  const r = lintArticle({ ...base, html: goodHtml })
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors))
})
test('artifact phrases fail the write', () => {
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + "<p>Wait, let's be precise: the garage is $40.</p>" })).includes('artifact-phrase'))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>No competitor article covers this.</p>' })).includes('artifact-phrase'))
})
test('money without a currency sign fails', () => {
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>The cell lot costs 5/day and the garage 13/day.</p>' })).includes('bare-money'))
  assert.ok(!rules(lintArticle({ ...base, html: goodHtml + '<p>The cell lot costs C$5/day. Shuttles run every 10 minutes.</p>' })).includes('bare-money'))
})
test('verified/working next to a code, and unapproved code strings, fail', () => {
  const r = lintArticle({ ...base, html: goodHtml + '<p>Working coupon and promo codes: use EARLYBIRD at checkout.</p>' })
  assert.ok(rules(r).includes('verified-code'))
  assert.ok(rules(r).includes('unapproved-code'))
  const ok = lintArticle({ ...base, html: goodHtml + '<p>Use code TRIPLY10 at checkout for 10% off the parking rate, <a href="https://www.triplypro.com/">on triplypro.com</a>.</p>' })
  assert.ok(!rules(ok).includes('unapproved-code'), JSON.stringify(ok.errors))
  assert.ok(!rules(ok).includes('verified-code'))
})
test('save up to N % needs a source link in its paragraph', () => {
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>Save up to 40% with off-site lots.</p>' })).includes('unsourced-saving'))
  assert.ok(!rules(lintArticle({ ...base, html: goodHtml + '<p>Save up to 40% with off-site lots, per <a href="https://www.panynj.gov/">the Port Authority rate sheet</a>.</p>' })).includes('unsourced-saving'))
})
test('a stale year in the title fails for NEW posts only', () => {
  assert.ok(rules(lintArticle({ ...base, title: 'Logan Terminal E Parking Guide (2028)', html: goodHtml })).includes('stale-year'))
  assert.ok(!rules(lintArticle({ ...base, title: 'Logan Terminal E Parking Guide (2025)', html: goodHtml, isNew: false })).includes('stale-year'))
})
test('answer-first: a new rates post needs a $ figure and as-of month in the first paragraph', () => {
  const r = lintArticle({ ...base, html: '<p>Parking at Newark is easy once you know your options.</p><p>Economy costs $18/day as of October 2026.</p>' })
  assert.equal(rules(r).filter((x) => x === 'answer-first').length, 2)
  assert.ok(!rules(lintArticle({ ...base, keyword: 'ewr airport parking shuttle', slug: 'ewr-parking-shuttle', html: '<p>Shuttles run every 10 minutes.</p>' })).includes('answer-first'))
  assert.ok(!rules(lintArticle({ ...base, isNew: false, html: '<p>Parking at Newark is easy.</p>' })).includes('answer-first'))
})
test('isRatesPost', () => {
  assert.equal(isRatesPost('ewr-airport-parking-rates'), true)
  assert.equal(isRatesPost('ewr parking shuttle'), false)
})

// ── Review of #141: the lint must not refuse ordinary copy, and must not let unsourced savings through ──
test('answer-first accepts "As of October 2026" (capital A) and rejects "as of Sunday"', () => {
  assert.ok(!rules(lintArticle({ ...base, html: '<p>As of October 2026, economy parking at Newark costs $18/day.</p>' })).includes('answer-first'))
  assert.ok(!rules(lintArticle({ ...base, html: '<p>Economy parking costs $18/day as of Oct. 15, 2026.</p>' })).includes('answer-first'))
  assert.ok(rules(lintArticle({ ...base, html: '<p>Parking costs $18/day as of Sunday; prices may rise.</p>' })).includes('answer-first'))
})
test('times, counts and price ranges are not bare money', () => {
  const ok = goodHtml + '<p>The cell phone lot is open from 5:00 a.m. to midnight. Shuttles run from 10 a.m. every 20 minutes from 3 stops. The garage has only 2 levels and serves 12 airlines.</p><p>Hotel lots charge $25–35/day.</p>'
  assert.ok(!rules(lintArticle({ ...base, html: ok })).includes('bare-money'), JSON.stringify(lintArticle({ ...base, html: ok }).errors))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>The hotel lot charges from 12 a day.</p>' })).includes('bare-money'))
})
test('"QR code" / "NJ TRANSIT" in a post are not promo talk', () => {
  const r = lintArticle({ ...base, html: goodHtml + '<p>Once your booking is confirmed, a QR code is emailed to you. Show it to NJ TRANSIT staff. The zip code is 07114.</p>' })
  assert.ok(!rules(r).includes('verified-code'), JSON.stringify(r.errors))
  assert.ok(!rules(r).includes('unapproved-code'), JSON.stringify(r.errors))
})
test('gate codes, ordinals and ordinary all-caps words are not promo codes', () => {
  const r = lintArticle({ ...base, html: goodHtml + '<p>Once your booking is confirmed, the gate code 4821 is in your email. Enter 3rd Street, use 2nd-level parking, or use LINK light rail. Promo codes change often.</p>' })
  assert.ok(!rules(r).includes('verified-code'), JSON.stringify(r.errors))
  assert.ok(!rules(r).includes('unapproved-code'), JSON.stringify(r.errors))
})
test('a code in lower case or in code position is still checked', () => {
  const r = lintArticle({ ...base, html: goodHtml + '<p>Use promo code save20 at checkout.</p>' })
  assert.ok(rules(r).includes('unapproved-code'), JSON.stringify(r.errors))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>Promo codes: enter WELCOME at checkout.</p>' })).includes('unapproved-code'))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>Code TRIPLY10 is verified for 2026.</p>' })).includes('verified-code'))
})
test('a savings claim needs an OUTSIDE source; a Triply link or an FAQ with no link is not one', () => {
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>Save up to 60% vs. the garage — <a href="/search?airport=EWR">compare lots</a>.</p>' })).includes('unsourced-saving'))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>Off-site lots run 40-60% below the garage — <a href="https://www.triplypro.com/search">book here</a>.</p>' })).includes('unsourced-saving'))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml, faqItems: [{ question: 'How much can I save?', answer: 'Save up to 60% vs the garage.' }] })).includes('unsourced-saving'))
  // our own approved code is its own source — for ITS offer only
  const offers = { approvedOffers: { TRIPLY10: 10 } }
  assert.ok(!rules(lintArticle({ ...base, ...offers, html: goodHtml + '<h2>Promo code TRIPLY10: 10% off</h2><p>TRIPLY10 takes 10% off the parking rate on <a href="https://www.triplypro.com/search?airport=EWR">bookings made on triplypro.com</a>.</p>' })).includes('unsourced-saving'))
  assert.ok(rules(lintArticle({ ...base, ...offers, html: goodHtml + '<p>TRIPLY10 takes 90% off the parking rate.</p>' })).includes('unsourced-saving'))
  assert.ok(rules(lintArticle({ ...base, ...offers, html: goodHtml + '<p>Use TRIPLY10 for 10% off — and save up to 60% vs the garage.</p>' })).includes('unsourced-saving'))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>TRIPLY10 takes 10% off the parking rate.</p>' })).includes('unsourced-saving'), 'a code with no documented offer sources nothing')
})
