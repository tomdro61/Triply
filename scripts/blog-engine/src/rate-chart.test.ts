import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  barsSvg, chartAlt, chartFileName, chartInputFor, fmtStay, holidayWindows, onAirportRows, orderLots, pickStayWindow,
  shortName, svgToPng, tableSvg, type ChartInput, type ChartLot, type PriceSnapshot,
} from './rate-chart.js'

const lot = (name: string, perDay: number, transfer: ChartLot['transfer'] = 'shuttle', days = 7): ChartLot =>
  ({ name, perDay, stayTotal: Math.round(perDay * days * 100) / 100, billedDays: days, transfer, mayLead: transfer !== 'paid' })

const snap = (airports: PriceSnapshot['airports']): PriceSnapshot => ({ asOf: '2026-11-02', checkin: '2026-11-12', checkout: '2026-11-19', airports })

// ── Stay window ──

test('stay window: first holiday-free Thursday at least 8 days out', () => {
  assert.deepEqual(pickStayWindow('2026-11-02'), { checkin: '2026-11-12', checkout: '2026-11-19' })
})
test('stay window skips US Thanksgiving week (Nov 26, 2026)', () => {
  assert.deepEqual(pickStayWindow('2026-11-10'), { checkin: '2026-12-03', checkout: '2026-12-10' })
})
test('stay window skips Christmas–New Year and MLK weekend', () => {
  assert.deepEqual(pickStayWindow('2026-12-10'), { checkin: '2027-01-07', checkout: '2027-01-14' })
})
test('holiday windows: Thanksgiving 2026 is Sat Nov 21 – Mon Nov 30', () => {
  assert.ok(holidayWindows(2026).some(([a, b]) => a === '2026-11-21' && b === '2026-11-30'))
})

// ── Formatting ──

test('fmtStay: same month, across months, across years', () => {
  assert.equal(fmtStay('2026-11-12', '2026-11-19'), 'Nov 12–19, 2026')
  assert.equal(fmtStay('2026-11-26', '2026-12-03'), 'Nov 26 – Dec 3, 2026')
  assert.equal(fmtStay('2026-12-30', '2027-01-06'), 'Dec 30, 2026 – Jan 6, 2027')
})
test('shortName drops the airport suffix and cuts at a word', () => {
  assert.equal(shortName('The Parking Spot North (DFW)'), 'The Parking Spot North')
  assert.equal(shortName('Hampton Inn & Suites Newark Airport Elizabeth Downtown', 30), 'Hampton Inn & Suites Newark')
})

// ── Order: paid transfers never lead ──

test('orderLots: cheapest first, paid-transfer lots after every other lot, max 6', () => {
  const out = orderLots([lot('Paid', 4, 'paid'), lot('B', 9), lot('A', 7, 'none'), lot('C', 12, 'unknown'), lot('D', 13), lot('E', 14), lot('F', 15)])
  assert.deepEqual(out.map((l) => l.name), ['A', 'B', 'C', 'D', 'E', 'F'])
  assert.deepEqual(orderLots([lot('Paid', 4, 'paid'), lot('B', 9)]).map((l) => l.name), ['B', 'Paid'])
  assert.deepEqual(orderLots([{ ...lot('Suspended', 3, 'none'), mayLead: false }, lot('B', 9)]).map((l) => l.name), ['B', 'Suspended'])
})
test('orderLots goes by the stay total: an 8-day lot that looks cheaper per day but costs more sorts after', () => {
  // HOU, Nov 2: Marriott South $5.94/day × 8 = $47.52 vs DoubleTree $5.95/day × 7 = $41.65
  assert.deepEqual(orderLots([lot('Marriott South', 5.94, 'shuttle', 8), lot('DoubleTree', 5.95)]).map((l) => l.name), ['DoubleTree', 'Marriott South'])
})
test('no stay window crosses a clock change', () => {
  for (const today of ['2026-10-20', '2027-02-25', '2027-10-25']) {
    const { checkin, checkout } = pickStayWindow(today)
    for (const y of [2026, 2027]) for (const [a, b] of holidayWindows(y).slice(-2)) assert.ok(!(checkin <= b && checkout >= a), `${checkin}→${checkout} crosses ${a}`)
  }
})

// ── Chart input ──

test('chartInputFor: failed read → null; nothing sold + on-airport rates → fallback; nothing at all → null', () => {
  assert.equal(chartInputFor('ATL', snap({ ATL: { status: 'error', reason: '503' } })), null)
  const fb = chartInputFor('ATL', snap({ ATL: { status: 'none', currency: 'USD' } }))
  assert.ok(fb && fb.lots.length === 0 && fb.onAirport.length > 0 && fb.onAirportChecked === 'October 2026')
  assert.equal(chartInputFor('BDL', snap({ BDL: { status: 'none', currency: 'USD' } })), null)
  assert.equal(chartInputFor('XYZ', snap({})), null)
})
test('YYZ prints no on-airport rows (October source never verified)', () => {
  assert.deepEqual(onAirportRows('YYZ'), [])
})

// ── Captions ──

const input = (lots: ChartLot[], code = 'DFW', currency: ChartInput['currency'] = 'USD'): ChartInput => ({
  code, currency, asOf: '2026-11-02', checkin: '2026-11-12', checkout: '2026-11-19', lots: orderLots(lots), onAirport: onAirportRows(code), onAirportChecked: onAirportRows(code).length ? 'October 2026' : null,
})

test('caption: dated range over lots that may lead; a paid-transfer lot is never the "from" price', () => {
  const alt = chartAlt(input([lot('Cheap Paid Lot', 3, 'paid'), lot('Westin', 11.92), lot('Hilton', 14.5)]), 'daily')
  assert.match(alt, /from \$11\.92\/day \(Westin\) to \$14\.50\/day \(Hilton\)/)
  assert.doesNotMatch(alt, /\$3\.00/)
  assert.match(alt, /prices as of Nov 2, 2026 for a 7-day stay Nov 12–19, 2026/)
  assert.match(alt, /on-airport parking from \$14\/day \(Remote \(TollTag\)\) to \$55\/day \(Valet\), posted rates checked October 2026/)
})
test('caption: one lot, 7-day total, Canadian dollars', () => {
  const alt = chartAlt(input([lot('Autoparc RM', 13.1)], 'YUL', 'CAD'), 'week')
  assert.match(alt, /^YUL parking 7-day costs compared: one lot bookable on Triply, Autoparc RM, C\$91\.70, taxes and fees included/)
  assert.doesNotMatch(alt, /(?<!C)\$\d/)
})
test('caption: fallback chart never says Triply or bookable', () => {
  const fb = chartInputFor('ATL', snap({ ATL: { status: 'none', currency: 'USD' } }))!
  for (const kind of ['daily', 'week'] as const) {
    assert.doesNotMatch(chartAlt(fb, kind), /triply|bookable/i)
    assert.doesNotMatch(kind === 'daily' ? barsSvg(fb) : tableSvg(fb), /Triply|bookable/)
  }
})

// ── SVG / PNG ──

test('charts print the date and stay, the lots and no-shuttle marker', () => {
  const d = input([lot('The Westin Dallas-Fort Worth', 11.92), lot('Quiet Lot', 9, 'none')])
  const bars = barsSvg(d), table = tableSvg(d)
  for (const svg of [bars, table]) assert.match(svg, /Prices as of Nov 2, 2026 for a 7-day stay, Nov 12–19, 2026/)
  assert.match(bars, />Quiet Lot</)
  assert.match(bars, /\$9\.00\/day<tspan[^>]*>, no shuttle<\/tspan>/)
  assert.match(bars, /\$11\.92\/day/)
  assert.match(table, />No shuttle</)
  assert.match(table, />\$83\.44</)
  assert.doesNotMatch(table, /\*/)
})
test('a lot that bills 8 days for the 7-day stay is starred on both charts and in the caption', () => {
  const d = input([lot('Westin', 8.61, 'shuttle', 8)])
  const table = tableSvg(d), bars = barsSvg(d)
  assert.match(table, />\$68\.88\*</)
  assert.match(bars, /\$8\.61\*\/day/)
  for (const svg of [table, bars]) assert.match(svg, /\* Bills 8 days for this 7-day stay/)
  assert.match(chartAlt(d, 'daily'), /Westin, \$8\.61\/day, billed as 8 days/)
})
test('daily caption range is the lowest and highest per-day price shown (DEN, Nov 2: an 8-day lot is cheapest per day)', () => {
  const alt = chartAlt(input([lot('Eight', 6.44, 'shuttle', 8), lot('A', 6.7), lot('B', 7.2), lot('C', 7.94)]), 'daily')
  assert.match(alt, /from \$6\.44\/day \(Eight, billed as 8 days\) to \$7\.94\/day \(C\)/)
  assert.match(chartAlt(input([lot('Eight', 6.44, 'shuttle', 8), lot('A', 6.7), lot('C', 7.94)]), 'week'), /from \$46\.90 \(A\) to \$55\.58 \(C\)/)
})
test('a tie is one price, not "from $9.20 to $9.20"', () => {
  assert.doesNotMatch(chartAlt(input([lot('Hampton', 9.2), lot('SpringHill', 9.2)]), 'daily'), / to \$9\.20/)
})
test('the "Parking Spot" brand still counts as a lot name', () => {
  assert.equal(pricesOffSiteLots('<svg><text>The Parking Spot $9/day</text></svg>', ['The Parking Spot North (DFW)'], ['Dallas', 'Fort', 'Worth', 'DFW']), true)
})
test('caption counts the shown lots that may not lead', () => {
  assert.match(chartAlt(input([lot('Paid', 3, 'paid'), lot('A', 10), lot('B', 12)]), 'daily'), /from \$10\.00\/day \(A\) to \$12\.00\/day \(B\), plus 1 with a paid shuttle or another caveat/)
})
test('a paid shuttle and a valet are noted after the price, the name keeps its width', () => {
  const bars = barsSvg(input([lot('Courtyard Fort Lauderdale Airport & Cruise Port', 13.1, 'paid'), lot('Drop N Park Valet', 7.76, 'valet')]))
  assert.match(bars, />Courtyard Fort Lauderdale Airport<|>Courtyard Fort Lauderdale Airport &amp;</)
  assert.match(bars, /\$13\.10\/day<tspan[^>]*> \+ paid shuttle<\/tspan>/)
  assert.match(bars, /\$7\.76\/day<tspan[^>]*>, valet<\/tspan>/)
})
test('names are XML-escaped', () => {
  assert.match(barsSvg(input([lot('Park & Fly <A>', 10)])), /Park &amp; Fly &lt;A&gt;/)
})
test('svgToPng renders a PNG', () => {
  const png = svgToPng(barsSvg(input([lot('A', 10)])))
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})
test('file names are distinct from the October families', () => {
  const d = input([lot('A', 10)])
  assert.equal(chartFileName(d, 'daily'), 'dfw-rate-chart-daily-2026-11-02.png')
  assert.doesNotMatch(chartFileName(d, 'week'), /-parking-rates-|-infographic-/)
})

// ── Engine helpers (new posts) ──

import { pricesOffSiteLots, rateChartInsertAt } from './rate-chart.js'

test('rate chart goes after the first paragraph under the first parking-cost heading; none without one', () => {
  const html = '<h2>Getting there</h2><p>Drive.</p><h2>How much does parking cost?</h2><p>It depends.</p><p>More.</p>'
  assert.equal(html.slice(0, rateChartInsertAt(html)).endsWith('<p>It depends.</p>'), true)
  assert.equal(rateChartInsertAt('<h2>Terminal map</h2><p>A.</p><h2>Hours</h2><p>B.</p>'), -1)
})
test('rate chart: whole words only, parking headings only, never the FAQ', () => {
  for (const h of ['Parking Strategies', 'How Accurate Are CVG TSA Wait Times?', 'Lounge Day Pass Cost', 'Rental Car Prices', 'Parking FAQ: rates and refunds', 'Separate Terminals, Operated Lots']) {
    assert.equal(rateChartInsertAt(`<h2>${h}</h2><p>x</p>`), -1, h)
  }
  assert.notEqual(rateChartInsertAt('<h2>Compare parking rates</h2><p>x</p>'), -1)
})
test('a free-form infographic that prices an off-site lot is caught; on-airport prices and the source line are not', () => {
  const lots = ['The Parking Spot North (DFW)', 'Westin Dallas-Fort Worth']
  assert.equal(pricesOffSiteLots('<svg><text>Parking Spot North $10.95/day</text></svg>', lots), true)
  assert.equal(pricesOffSiteLots('<svg><text>Off-site lots on Triply from $8/day</text></svg>', lots), true)
  assert.equal(pricesOffSiteLots('<svg><text>Off-site lots from $8/day</text></svg>', lots), true)
  assert.equal(pricesOffSiteLots('<svg><text>Airport hotels from $9/day</text></svg>', lots), true)
  assert.equal(pricesOffSiteLots('<svg><text>Terminal garage $37/day</text><text>Source: triplypro.com</text></svg>', lots), false)
  assert.equal(pricesOffSiteLots('<svg><text>The Westin Dallas-Fort Worth: free shuttle</text></svg>', lots), false)
})
test("an on-airport infographic that names its own airport is not mistaken for an off-site lot", () => {
  const words = 'William P. Hobby Airport HOU'.split(/[^A-Za-z]+/)
  assert.equal(pricesOffSiteLots('<svg><text>Houston Hobby garage $25/day</text></svg>', ['Houston Hobby Marriott South'], words), false)
  assert.equal(pricesOffSiteLots('<svg><text>Houston Hobby Marriott South $5.94/day</text></svg>', ['Houston Hobby Marriott South'], words), true)
})
