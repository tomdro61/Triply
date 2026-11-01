// Airport-level prose vs the sellable lot list (review of PR #143).
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropOffSiteSentences, scenarioBilledDays, sellableLotRange, getAirportDataBlock, leadEligibleLots, offSiteScenarioRows, figureSource } from './prompts/write.js'
import { collectFigures } from './lint.js'
import type { AirportData } from './airport-data.js'

test('dropOffSiteSentences removes the off-site sentence and keeps the on-airport ones', () => {
  const text = 'On-airport: Garages A, B & C $24/day, Valet $35/day. Off-site: from ~$4/day with shuttle (Best Rate Airport Parking; shuttle 4 AM-10 PM only). Pre-booking recommended during peak theme park seasons.'
  assert.equal(dropOffSiteSentences(text), 'On-airport: Garages A, B & C $24/day, Valet $35/day. Pre-booking recommended during peak theme park seasons.')
})

test('dropOffSiteSentences never splits inside a price or after "incl."', () => {
  const text = 'On-airport: Terminal 1 Parking Plaza $32/day. Off-site bookable on Triply (Nov 2026 live search, C$ per day incl. 13% HST): Chandni Victoria C$6.25, Park For U C$8.35.'
  assert.equal(dropOffSiteSentences(text), 'On-airport: Terminal 1 Parking Plaza $32/day.')
  assert.equal(dropOffSiteSentences('Economy Lot $20/day. Off-site via Triply: $10.62-$30.45/day.'), 'Economy Lot $20/day.')
  // SDF-shaped: the sentence before the off-site one ends in a number.
  assert.equal(
    dropOffSiteSentences('Garage $22, Valet $35. Rates effective July 1, 2026. Off-site via Triply: three Phillips Lane hotel lots at ~$8.35/day, 24/7 shuttles.'),
    'Garage $22, Valet $35. Rates effective July 1, 2026.',
  )
})

test('dropOffSiteSentences keeps the on-airport clause of a mixed sentence and drops sentences naming an unsellable lot', () => {
  const jfk = 'Economy Lot 9 $29/first 24hrs. IMPORTANT: AirTrain costs $8.50/person one-way — off-site lots with direct shuttles save this cost vs. on-airport parking + AirTrain from Lot 9.'
  assert.equal(dropOffSiteSentences(jfk), 'Economy Lot 9 $29/first 24hrs. IMPORTANT: AirTrain costs $8.50/person one-way.')
  const shuttle = 'AirTrain connects all terminals. Some budget lots (Parking 4 Airport, Hyatt Place Flushing) have limited shuttle hours. The Parking Spot East/West runs 24/7 shuttles.'
  assert.equal(dropOffSiteSentences(shuttle, ['Parking 4 Airport (JFK)', 'The Parking Spot (AUS)']), 'AirTrain connects all terminals.')
})

test('dropOffSiteSentences leaves text without off-site sentences untouched', () => {
  const text = 'Daily Park T1/T3 garages C$42/day, C$235 first 7 days; Value Park Garage C$32/day.'
  assert.equal(dropOffSiteSentences(text), text)
  assert.equal(dropOffSiteSentences(''), '')
})

test('scenarioBilledDays: explicit billed days win, N-day = N, N-night = N + 1, unknown = null', () => {
  assert.equal(scenarioBilledDays('7-night trip (Nov 2-9, 2026 — billed as 8 days), quoted 2026-10-16'), 8)
  assert.equal(scenarioBilledDays('7-day trip (7 billing days, e.g. Nov 2-8, 2026)'), 7)
  assert.equal(scenarioBilledDays('7-night trip, Nov 2 10 AM - Nov 9 2 PM, 2026 (Triply bills 8 days), quoted'), 8)
  assert.equal(scenarioBilledDays('6-day trip for 2 travelers'), 6)
  assert.equal(scenarioBilledDays('7-night cruise, 2 travelers, one car.'), 8)
  assert.equal(scenarioBilledDays("7-night cruise, 2 travelers, one car. Off-site prices scaled from Triply's live Nov 2-8, 2026 quote (7 billing days incl. Triply fees) to 8 billing days."), 8, 'the LAST billing-days count is the scenario\'s')
  assert.equal(scenarioBilledDays('7-day trip (7 billing days, e.g. Nov 2-8, 2026)'), 7)
  assert.equal(scenarioBilledDays('One week. On-airport = 7 x official daily max'), null)
  assert.equal(scenarioBilledDays(undefined), null)
})

const base: AirportData = {
  code: 'XXX', fullName: 'Test Airport', lastVerified: '2026-11-01', terminals: [{ name: 'A', airlines: ['Delta'] }],
  roads: ['I-1'], transit: ['Bus 1'], neighborhoods: ['Town'], authority: 'Port', distanceFromCity: '5 mi',
  parkingRates: 'On-airport: Garage $24/day. Off-site: from ~$4/day with shuttle (Old Lot).',
  shuttleInfo: 'On-airport shuttles every 10 minutes. Old Lot and Gone Lot run 24/7 shuttles via Triply. Gone Lot runs hourly overnight.',
  unsellableLotNames: ['Gone Lot (XXX)'],
  parkingLots: [
    { name: 'Cheap Lot', dailyRate: 6.41, sellable: true, notes: 'AIRPORT PARKING ONLY. Never recommend to cruisers.', cruiseShuttle: 'not-available' },
    { name: 'Dead Lot', dailyRate: 7.5, sellable: true, shuttleSuspended: true, notes: 'SHUTTLE SUSPENDED. Do NOT use in CTAs.' },
    { name: 'Dear Lot', dailyRate: 28, sellable: true, knownCoupons: ['Pre-book via competitor.com from $13/day'], notes: 'Added 2026-11-01 from live Triply search; details from the lot listing.' },
  ],
  savingsComparison: {
    scenario: '7-day trip for 2 travelers',
    onAirport: { garage: { parkingCost: '$168 (7 x $24)' } },
    offSiteWithShuttle: { oldLot: { parkingCost: '$28 (7 x $4)' } },
    keyDifference: 'the lots Triply sells cost about $4-11/day',
  },
}

test('the range and the computed rows skip lots whose notes bar them from leading', () => {
  assert.deepEqual(leadEligibleLots(base).map((l) => l.name), ['Cheap Lot', 'Dear Lot'], 'suspended-shuttle lot out; airport-only lot fine on a non-cruise page')
  assert.deepEqual(leadEligibleLots(base, 'cheap cruise parking').map((l) => l.name), [], 'on a cruise keyword only cruise-shuttle lots may lead')
  assert.deepEqual(leadEligibleLots({ ...base, code: 'POE', parkingLots: [...base.parkingLots!, { name: 'Port Lot', dailyRate: 21.7, sellable: true, cruiseShuttle: 'included' }] }).map((l) => l.name), ['Port Lot'])
  assert.equal(sellableLotRange(base), 'from $6.41/day to $28/day across 2 lots')
  assert.equal(sellableLotRange(base, 'cruise parking'), 'none may lead a recommendation (every lot carries a caveat — read the lot notes)')
  assert.equal(sellableLotRange({ ...base, parkingLots: [] }), '')
  assert.equal(sellableLotRange({ ...base, parkingLots: [base.parkingLots![2]] }), '$28/day (one lot)')
  assert.equal(sellableLotRange({ ...base, parkingLots: [{ name: 'A', dailyRate: 8.35, sellable: true }, { name: 'B', dailyRate: 8.35, sellable: true }] }), '$8.35/day across 2 lots')
  assert.deepEqual(offSiteScenarioRows(base).map((r) => [r.name, r.total]), [['Cheap Lot', 44.87], ['Dear Lot', 196]])
})

test('figureSource gives the lint the figures the writer saw: computed totals in, stale off-site prose and coupon pitches out', () => {
  const figures = collectFigures(figureSource(base))
  assert.ok(figures.includes(44.87) && figures.includes(196), 'computed totals are sourced')
  assert.ok(!figures.includes(13), 'coupon pitch "$13/day" is not a known figure')
  assert.ok(!figures.includes(4), 'the dropped "from ~$4/day" is not a known figure')
  assert.ok(figures.includes(24), 'on-airport garage rate still known')
})

test('the airport data block carries no stale off-site figure, no coupon pitch, and the lot caveats', () => {
  const block = getAirportDataBlock(base, 'cheap parking cost')
  assert.ok(!block.includes('from ~$4/day'), 'off-site sentence dropped from the rates line')
  assert.ok(!block.includes('Old Lot'), 'lots we do not sell are gone from rates and shuttle text')
  assert.ok(!block.includes('$4-11/day'), 'keyDifference dropped')
  assert.ok(!block.includes('competitor.com'), 'coupon pitch dropped')
  assert.ok(block.includes('from $6.41/day to $28/day across 2 lots'))
  assert.ok(!block.includes('Dead Lot: $7.5/day ×'), 'a barred lot gets no computed savings row')
  assert.ok(block.includes('**Dead Lot**: $7.5/day'), 'but it is still in the lot list with its caveat')
  assert.ok(!block.includes('Gone Lot'), 'a sentence naming an unsellable lot is dropped even without an off-site keyword')
  assert.ok(block.includes('Cheap Lot: $6.41/day × 7 = $44.87'), 'off-site side computed from the lot list')
  assert.ok(block.includes('Garage'), 'on-airport savings entry kept')
  assert.ok(block.includes('Cruise-port shuttle: not-available'))
  assert.ok(block.includes('Notes: AIRPORT PARKING ONLY'))
  assert.ok(!block.includes('Added 2026-11-01'), 'a provenance-only note is not printed')
  assert.ok(block.includes('On-airport shuttles every 10 minutes'), 'general shuttle sentence kept')
})
