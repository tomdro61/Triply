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
