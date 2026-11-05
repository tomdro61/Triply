import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lintArticle, isRatesPost, priceAllowList, collectDailyRates, collectMoneyFigures, collectRangeEnds } from './lint.js'
import { chartAlt, onAirportRows, type ChartInput } from './rate-chart.js'

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
  const r = lintArticle({ ...base, html: goodHtml + '<p>Once your booking is confirmed, the gate code 4821 is in your email. Your Confirmation code RTL855661 is confirmed by email; the gate-code AB12 is confirmed too. Enter 3rd Street, use 2nd-level parking, or use LINK light rail. Promo codes change often.</p>' })
  assert.ok(!rules(r).includes('verified-code'), JSON.stringify(r.errors))
  assert.ok(!rules(r).includes('unapproved-code'), JSON.stringify(r.errors))
})
test('a code in lower case or in code position is still checked', () => {
  const r = lintArticle({ ...base, html: goodHtml + '<p>Use promo code save20 at checkout.</p>' })
  assert.ok(rules(r).includes('unapproved-code'), JSON.stringify(r.errors))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>Promo codes: enter WELCOME at checkout.</p>' })).includes('unapproved-code'))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>Code TRIPLY10 is verified for 2026.</p>' })).includes('verified-code'))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>Promo codes vary. Use booking code TRIPLY20 at checkout.</p>' })).includes('unapproved-code'), 'a "booking code" the sentence tells you to USE is a promo code')
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

test('W1.8 P3c: with knownPrices, a $ figure the writer was not given fails the write', () => {
  const knownPrices = [18, 40]
  assert.deepEqual(lintArticle({ ...base, html: goodHtml, knownPrices }).errors, [], 'figures from the data pass')
  const r = lintArticle({ ...base, html: goodHtml + '<p>Lot B is $9/day.</p>', knownPrices })
  assert.ok(rules(r).includes('unsourced-price'))
  assert.match(r.errors.find((e) => e.rule === 'unsourced-price')!.message, /\$9/)
  assert.ok(!rules(r).includes('unsourced-figure') && !r.warnings.some((w) => w.rule === 'unsourced-figure'), 'the W1.3 warning does not double up')
})
test('W1.8 P3c: an outside source link exempts its paragraph; a Triply or internal link does not', () => {
  const knownPrices = [18, 40]
  assert.ok(!rules(lintArticle({ ...base, html: goodHtml + '<p>The cell lot is $9/hour per <a href="https://www.newarkairport.com/parking">the airport</a>.</p>', knownPrices })).includes('unsourced-price'))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>Lot B is $9/day, <a href="https://www.triplypro.com/search?airport=EWR">book it</a>.</p>', knownPrices })).includes('unsourced-price'))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>Lot B is $9/day, <a href="/blog/ewr-x">see more</a>.</p>', knownPrices })).includes('unsourced-price'))
})
test('W1.8 P3c: title, meta, excerpt and FAQ have no exemption; both ends of a range count', () => {
  const knownPrices = [18, 40]
  assert.ok(rules(lintArticle({ ...base, title: 'EWR Parking From $9/Day (2026)', html: goodHtml, knownPrices })).includes('unsourced-price'))
  assert.ok(rules(lintArticle({ ...base, metaDescription: 'Park near EWR from $9 a day.', html: goodHtml, knownPrices })).includes('unsourced-price'))
  assert.ok(rules(lintArticle({ ...base, excerpt: 'Lots from $9/day.', html: goodHtml, knownPrices })).includes('unsourced-price'))
  assert.ok(rules(lintArticle({ ...base, html: goodHtml, faqItems: [{ question: 'How much?', answer: '<p>About $9/day per <a href="https://x.gov">x</a>.</p>' }], knownPrices })).includes('unsourced-price'), 'a link in a FAQ answer is not a source')
  assert.ok(rules(lintArticle({ ...base, html: goodHtml + '<p>Rates run $18–77/day.</p>', knownPrices })).includes('unsourced-price'))
})
test('W1.8 P3c: without knownPrices (apply-edit, perf-apply, posts with no data file) nothing new blocks', () => {
  const r = lintArticle({ ...base, html: goodHtml + '<p>Lot B is $9/day.</p>', knownFigures: [18, 40] })
  assert.ok(!rules(r).includes('unsourced-price'))
  assert.ok(r.warnings.some((w) => w.rule === 'unsourced-figure'), 'the W1.3 warning still prints')
})
test('W1.8 P3c rollout: priceGateWarnOnly reports the same figures as a warning and lets the write through', () => {
  const r = lintArticle({ ...base, html: goodHtml + '<p>Lot B is $9/day.</p>', knownPrices: [18, 40], priceGateWarnOnly: true })
  assert.ok(r.ok && !rules(r).includes('unsourced-price'))
  assert.match(r.warnings.find((w) => w.rule === 'unsourced-price')!.message, /\$9/)
})

const chartRow = { status: 'ok', lots: [{ perDay: 6.05, stayTotal: 42.33, billedDays: 7, baseRate: 5.2 }], listed: 3 }
const ricData = { parkingLots: [{ dailyRate: 10.45, reservationRate: 10.45 }], onAirport: [{ dailyMax: 15 }], transit: { fare: '$1.50 per ride' }, toll: '$1 toll' }
const ricKnown = () => priceAllowList([10.45, 15, 1.5, 1], collectDailyRates(ricData), chartRow)
const gate = (html: string) => { const k = ricKnown(); return rules(lintArticle({ ...base, title: 'RIC parking', metaTitle: 'RIC parking', html, knownPrices: k.all, knownDailyPrices: k.perDay })) }

test('W1.8 P3c: N-day totals of daily rates and the rate chart prices pass', () => {
  assert.ok(!gate('<p>A week at DoubleTree is $73.15, the garage runs $105 for 7 days, the chart shows $6.05/day ($42.33 total), and $36.40 a week at $5.20.</p>').includes('unsourced-price'))
  assert.ok(!gate('<p>Rides cost $1.50 and the toll is $1.</p>').includes('unsourced-price'))
})

test('W1.8 P3c: prose figures are not multiplied, so invented whole-dollar prices still fail', () => {
  for (const p of ['$9', '$12', '$25', '$3', '$4.80', '$33.60']) assert.ok(gate(`<p>Lots start at ${p}/day.</p>`).includes('unsourced-price'), p)
})

test('W1.8 P3c: collectDailyRates reads structured daily keys only; counts and tiny or huge rates are not multiplied', () => {
  assert.deepEqual(collectDailyRates(ricData).sort((x, y) => x - y), [10.45, 10.45, 15])
  assert.deepEqual(collectDailyRates({ minimumBookingDays: 3, dailyMaxCAD: 22 }), [22])
  const k = ricKnown().all
  assert.ok(!k.includes(7), 'billedDays is a count, not a price')
  assert.ok(!priceAllowList([], [4]).all.includes(8), 'rates under $5 are not multiplied')
  assert.ok(!priceAllowList([], [150]).all.includes(300), 'rates over $100 are not multiplied')
  assert.deepEqual(priceAllowList([], [], undefined), { all: [], perDay: [] })
})

test('W1.8 P3c: a per-day figure cannot borrow an N-day total ($20/day at a $10 lot fails; $20 for 2 days passes)', () => {
  const k = priceAllowList([10], [10])
  const g = (html: string) => rules(lintArticle({ ...base, title: 'RIC parking', metaTitle: 'RIC parking', html, knownPrices: k.all, knownDailyPrices: k.perDay }))
  for (const p of ['$20/day', '$20 per day', '$20 a day', '$20 daily']) assert.ok(g(`<p>Economy is ${p}.</p>`).includes('unsourced-price'), p)
  assert.ok(!g('<p>Two days in economy cost $20, or $10/day.</p>').includes('unsourced-price'))
})

test('W1.8 P3c: collectDailyRates follows nested daily keys, $ strings and the other per-day key names', () => {
  assert.deepEqual(collectDailyRates({ dailyMax: { covered: 15, uncovered: 12 } }), [15, 12])
  assert.deepEqual(collectDailyRates({ dailyMax: '$25.00', note: '$3' }), [25])
  assert.deepEqual(collectDailyRates({ preBookRate: 18, advanceReservationRate: 20, onlineRate: 9, weeklyRate: 70 }), [18, 20, 9])
})

test('W1.8 P3c: per-day wording is caught before and after the figure; a fare or fee in the data is no daily rate', () => {
  const data = { lots: [{ dailyRate: 10 }], taxi: { toMarietta: '$55-$70' }, fees: '$5 surcharge', onAirport: [{ rate: '$15/day ($3/hr)' }] }
  const k = priceAllowList([10, 55, 70, 5, 15, 3], collectDailyRates(data))
  const g = (html: string) => rules(lintArticle({ ...base, title: 'RIC parking', metaTitle: 'RIC parking', html, knownPrices: k.all, knownDailyPrices: k.perDay }))
  for (const p of ['$55/day', '$5/day', '$20/night', '$20 per 24 hours', '$20 per-day', '$20 each day', '$20 a night']) assert.ok(g(`<p>Parking is ${p}.</p>`).includes('unsourced-price'), p)
  assert.ok(g('<p>The daily rate of $20 applies.</p>').includes('unsourced-price'))
  assert.ok(!g('<p>Garage parking is $15/day, economy $10 per day; a taxi is $55-$70.</p>').includes('unsourced-price'))
  assert.ok(!g('<p>That is a $70 daily-parking total for the week.</p>').includes('unsourced-price'), 'daily- is not a per-day unit')
  assert.deepEqual([...new Set(collectDailyRates({ dailyMax: '$15.00 per day', note: '$3', coveredRate: 12, rate: '~$38/day (saves ~36%)' }))].sort((x, y) => x - y), [12, 15, 38])
})

test('W1.8 P3c: "first 24 hours" is per-day; old prices and luggage storage are not daily rates', () => {
  assert.deepEqual(collectDailyRates({ lot9: '$29 for first 24 hours' }), [29])
  assert.deepEqual(collectDailyRates({ note: 'Increased from $19/day to $22/day' }), [22])
  assert.deepEqual(collectDailyRates({ luggageStorage: { bounce: '$5.95/day' } }), [])
  assert.deepEqual(collectDailyRates({ onAirportParking: { dailyParkT1: { parkingCost: 'C$235 (first 7 days)' } } }), [])
})

// Review of #158, 5 Nov: the gate refused the engine's own chart caption, the top of a sourced range and a sourced
// old price, and let plural "Daily rates: $20" through as a 2-day total.
const gateWith = (k: { all: number[]; perDay: number[] }, html: string, title = 'RIC parking') =>
  rules(lintArticle({ ...base, title, metaTitle: 'RIC parking', html, knownPrices: k.all, knownDailyPrices: k.perDay }))

test('W1.8 P3c: the rate chart caption passes, both the daily chart and the 7-day table', () => {
  const lot = { name: 'PARK AC JFK Airport Parking', perDay: 15.13, stayTotal: 105.92, billedDays: 7, transfer: 'shuttle' as const, mayLead: true }
  const chart: ChartInput = { code: 'JFK', currency: 'USD', asOf: '2026-11-02', checkin: '2026-11-23', checkout: '2026-11-30', lots: [lot], onAirport: onAirportRows('JFK'), onAirportChecked: 'October 2026' }
  const k = priceAllowList([], [], { lots: [lot] }, onAirportRows('JFK'))
  for (const kind of ['daily', 'week'] as const) {
    const caption = chartAlt(chart, kind)
    assert.ok(!gateWith(k, `<figure><img src="x" alt="" /><figcaption>${caption}</figcaption></figure>`).includes('unsourced-price'), caption)
  }
  assert.ok(gateWith(priceAllowList([], [], { lots: [lot] }), `<figure><figcaption>${chartAlt(chart, 'daily')}</figcaption></figure>`).includes('unsourced-price'), 'without the on-airport rows the caption fails')
  assert.ok(priceAllowList([], [], undefined, [{ lo: 15, hi: 15, week: 90 }]).all.includes(90), 'an explicit weekly figure is sourced')
})

test('W1.8 P3c: both ends of a sourced range pass; a per-day range in the data is two daily rates', () => {
  assert.deepEqual(collectRangeEnds({ taxi: '$15-25 each way', bus: 'C$8–10 per 20 minutes', fare: '$55-$70', lone: '$12' }), [25, 10, 70])
  const data = { taxi: '$15-25 each way', onAirport: { rate: '$18–24/day' } }
  const k = priceAllowList([...collectMoneyFigures(data), ...collectRangeEnds(data)], collectDailyRates(data))
  assert.ok(!gateWith(k, '<p>A taxi is $15-25 each way and the garage is $18–$24/day.</p>').includes('unsourced-price'))
  assert.ok(gateWith(priceAllowList(collectMoneyFigures(data), collectDailyRates(data)), '<p>A taxi is $15-25 each way.</p>').includes('unsourced-price'), 'collectMoneyFigures alone misses $25')
})

test('W1.8 P3c: a sourced old price written per-day passes; a bare "from $X/day" is still a current rate', () => {
  const k = priceAllowList([19, 30], collectDailyRates({ note: 'Increased from $19/day to $30/day' }))
  for (const p of ['rose from $19/day to $30/day', 'were previously $19/day', 'went up from $19/day']) assert.ok(!gateWith(k, `<p>Daily Decks ${p}.</p>`).includes('unsourced-price'), p)
  for (const p of ['are $19/day', 'start from $19/day']) assert.ok(gateWith(k, `<p>Daily Decks ${p}.</p>`).includes('unsourced-price'), p)
})

test('W1.8 P3c: plural and "parking" per-day labels are per-day, in the body and the title', () => {
  const k = priceAllowList([10], [10]) // $20 is a 2-day total here, never a daily rate
  for (const t of ['Daily rates: $20', 'Daily parking rates: from $20', 'Daily prices start at $20', 'Daily rates are $20']) assert.ok(gateWith(k, `<p>${t}.</p>`).includes('unsourced-price'), t)
  assert.ok(gateWith(k, '<p>Parking is cheap.</p>', 'RIC Daily Parking Rates: From $20 (2026)').includes('unsourced-price'))
  assert.ok(!gateWith(k, '<p>Two days cost $20.</p>').includes('unsourced-price'), 'a total that is not labelled per-day still passes')
})
