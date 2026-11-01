// Airport-level prose vs the sellable lot list (review of PR #143).
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropOffSiteSentences, scenarioBilledDays, sellableLotRange, getAirportDataBlock } from './prompts/write.js'
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
  assert.equal(scenarioBilledDays('One week. On-airport = 7 x official daily max'), null)
  assert.equal(scenarioBilledDays(undefined), null)
})

const base: AirportData = {
  code: 'XXX', fullName: 'Test Airport', lastVerified: '2026-11-01', terminals: [{ name: 'A', airlines: ['Delta'] }],
  roads: ['I-1'], transit: ['Bus 1'], neighborhoods: ['Town'], authority: 'Port', distanceFromCity: '5 mi',
  parkingRates: 'On-airport: Garage $24/day. Off-site: from ~$4/day with shuttle (Old Lot).',
  shuttleInfo: 'On-airport shuttles every 10 minutes. Old Lot and Gone Lot run 24/7 shuttles via Triply.',
  parkingLots: [
    { name: 'Cheap Lot', dailyRate: 6.41, sellable: true, notes: 'AIRPORT PARKING ONLY. Never recommend to cruisers.', cruiseShuttle: 'not-available' },
    { name: 'Dear Lot', dailyRate: 28, sellable: true, knownCoupons: ['Pre-book via competitor.com from $13/day'], notes: 'Added 2026-11-01 from live Triply search; details from the lot listing.' },
  ],
  savingsComparison: {
    scenario: '7-day trip for 2 travelers',
    onAirport: { garage: { parkingCost: '$168 (7 x $24)' } },
    offSiteWithShuttle: { oldLot: { parkingCost: '$28 (7 x $4)' } },
    keyDifference: 'the lots Triply sells cost about $4-11/day',
  },
}

test('sellableLotRange reads the priced lots', () => {
  assert.equal(sellableLotRange(base), 'from $6.41/day to $28/day across 2 lots Triply sells')
  assert.equal(sellableLotRange({ ...base, parkingLots: [] }), '')
  assert.equal(sellableLotRange({ ...base, parkingLots: [base.parkingLots![1]] }), '$28/day (one lot Triply sells)')
})

test('the airport data block carries no stale off-site figure, no coupon pitch, and the lot caveats', () => {
  const block = getAirportDataBlock(base, 'cheap parking cost')
  assert.ok(!block.includes('from ~$4/day'), 'off-site sentence dropped from the rates line')
  assert.ok(!block.includes('Old Lot'), 'lots we do not sell are gone from rates and shuttle text')
  assert.ok(!block.includes('$4-11/day'), 'keyDifference dropped')
  assert.ok(!block.includes('competitor.com'), 'coupon pitch dropped')
  assert.ok(block.includes('from $6.41/day to $28/day across 2 lots Triply sells'))
  assert.ok(block.includes('Cheap Lot: $6.41/day × 7 = $44.87'), 'off-site side computed from the lot list')
  assert.ok(block.includes('Garage'), 'on-airport savings entry kept')
  assert.ok(block.includes('Cruise-port shuttle: not-available'))
  assert.ok(block.includes('Notes: AIRPORT PARKING ONLY'))
  assert.ok(!block.includes('Added 2026-11-01'), 'a provenance-only note is not printed')
  assert.ok(block.includes('On-airport shuttles every 10 minutes'), 'general shuttle sentence kept')
})
