// Unit tests for lot-sync's diff/merge logic (2026-11-05). No network: live lists are fixtures
// shaped like /api/search results (see notes/live-price-check-2026-11-06/raw).
//
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendLots,
  codeTokens,
  formatLot,
  matchLots,
  mergeSamples,
  newLotFromLive,
  notAirportReason,
  planCalls,
  planSync,
  reportLines,
  streetKey,
  NOT_AIRPORT_NOTE,
  type MergedLive,
  type SyncLive,
} from './lot-sync.js'
import { applyLotEdits, reproduces, type CatalogueLot } from './refresh-rates.js'
import { DO_NOT_LEAD, leadEligibleLots } from './prompts/write.js'
import type { AirportData } from './airport-data.js'

const TODAY = '2026-11-05'
const opts = { today: TODAY, defaultDays: 7, acceptFuzzy: false, checkinDates: 2 }

function live(name: string, extra: Partial<SyncLive> & { price?: number } = {}): SyncLive {
  const { price = 10, ...rest } = extra
  return { name, airportCode: 'EWR', pricing: { minPrice: price, grandTotal: price * 7 + 5, taxTotal: 5, numberOfDays: 7 }, ...rest }
}
const merged = (lots: SyncLive[], days = 7): MergedLive[] => mergeSamples([{ days, lots }], 'EWR').live

test('streetKey treats Street/St. and Avenue/Ave alike, and needs a house number', () => {
  assert.equal(streetKey('819 Spring Street, Elizabeth, NJ 07201'), streetKey('819 Spring St. Elizabeth, NJ'))
  assert.equal(streetKey('128-20 152nd Ave'), streetKey('128-20, 152nd Avenue, South Ozone Park, NY'))
  assert.equal(streetKey('Airport Road'), null)
  assert.equal(streetKey(null), null)
})

test('codeTokens drops the airport code and filler words', () => {
  assert.deepEqual([...codeTokens('Apex EWR Airport Parking', 'EWR')], ['apex'])
  assert.deepEqual([...codeTokens('Apex Airport Parking', 'EWR')], ['apex'])
})

test('EWR-shaped: Apex is a token match (not its shared address) — reported for confirmation, applied with its id only under --accept-fuzzy', () => {
  const file = (): CatalogueLot[] => [
    { name: 'Apex EWR Airport Parking', address: '819 Spring Street, Elizabeth, NJ 07201', dailyRate: 8.95, sellable: false },
  ]
  const m = merged([
    live('Apex Airport Parking', { address: '819 Spring St. Elizabeth, NJ', price: 9.2625, reslabLocationId: 10 }),
    live('EWR Airport Parking', { address: '819 Spring St, Elizabeth, NJ', price: 18.195, reslabLocationId: 11 }),
  ])
  const lots = file()
  const { report, newLots, edits } = planSync('EWR', lots, m, opts)
  assert.deepEqual(report.needsConfirmation, [{ lot: 'Apex EWR Airport Parking', live: 'Apex Airport Parking', via: 'tokens', score: 1 }])
  assert.deepEqual(report.matched, [])
  assert.equal(edits.length, 0, 'a weak match writes nothing')
  assert.equal(lots[0].sellable, false)
  assert.ok(!('reslabLocationId' in lots[0]))
  assert.deepEqual(newLots.map((l) => l.name), ['EWR Airport Parking'], 'the pending live lot is not added as a duplicate')

  const accepted = file()
  const a = planSync('EWR', accepted, m, { ...opts, acceptFuzzy: true })
  assert.deepEqual(a.report.matched, [{ lot: 'Apex EWR Airport Parking', live: 'Apex Airport Parking', via: 'tokens' }])
  assert.deepEqual(a.report.priceChanges, [{ lot: 'Apex EWR Airport Parking', from: 8.95, to: 9.26, days: 7 }])
  assert.equal(accepted[0].sellable, true)
  assert.equal(accepted[0].reslabLocationId, 10, 'confirmed by the human: the id is written so refresh-rates matches it next time')
})

test('LAS-shaped: a subset match ("Best Western McCarran Inn" ~ live "Best Western") writes no id, no sellable, no price', () => {
  const lots: CatalogueLot[] = [{ name: 'Best Western McCarran Inn', slug: 'best-western-mccarran-inn-las', dailyRate: 7.99, reservationRate: 5.99, sellable: false }]
  const m = mergeSamples([{ days: 7, lots: [{ ...live('Best Western', { reslabLocationId: 91, price: 12.55 }), airportCode: 'LAS' }] }], 'LAS').live
  const { report, edits, newLots } = planSync('LAS', lots, m, opts)
  assert.equal(edits.length, 0)
  assert.equal(newLots.length, 0)
  assert.deepEqual(report.needsConfirmation.map((x) => [x.lot, x.live, x.via]), [['Best Western McCarran Inn', 'Best Western', 'subset']])
  assert.deepEqual(report.idSet, [])
  assert.deepEqual(lots[0], { name: 'Best Western McCarran Inn', slug: 'best-western-mccarran-inn-las', dailyRate: 7.99, reservationRate: 5.99, sellable: false })
  assert.ok(reportLines(report).some((l) => l.includes('needs confirmation (subset)')))
})

test('a strong match that sets the id is still shown in the report (via name, slug or address)', () => {
  const lots: CatalogueLot[] = [{ name: 'Hilton Newark Airport', dailyRate: 16, sellable: true }]
  const { report } = planSync('EWR', lots, merged([live('Hilton Newark Airport', { reslabLocationId: 2, price: 16 })]), opts)
  assert.deepEqual(report.idSet, [{ lot: 'Hilton Newark Airport', live: 'Hilton Newark Airport', id: 2, via: 'name' }])
  assert.ok(reportLines(report).some((l) => l.includes('reslabLocationId 2 set') && l.includes('matched by name')))
})

test('ResLab id beats a name that would point at a different live lot', () => {
  const lots: CatalogueLot[] = [{ name: 'Hilton', reslabLocationId: 2, dailyRate: 10, sellable: true }]
  const m = merged([live('Hilton', { reslabLocationId: 1 }), live('Hilton Newark Airport Parking', { reslabLocationId: 2, price: 16.09 })])
  const { report } = planSync('EWR', lots, m, opts)
  assert.equal(report.matched[0].live, 'Hilton Newark Airport Parking')
  assert.equal(report.matched[0].via, 'id')
})

test('a lot absent from search is marked sellable:false, never deleted; an already-false absent lot is left alone', () => {
  const lots: CatalogueLot[] = [
    { name: 'Gone Lot', dailyRate: 12, sellable: true },
    { name: 'Old Lot', dailyRate: 9, sellable: false, sellableCheckedOn: '2026-10-01' },
  ]
  const { report, edits } = planSync('EWR', lots, merged([live('Something Else')]), opts)
  assert.deepEqual(report.gone, ['Gone Lot'])
  assert.equal(lots.length, 2)
  assert.equal(lots[0].sellable, false)
  assert.equal(lots[0].sellableCheckedOn, TODAY)
  assert.equal(lots[1].sellableCheckedOn, '2026-10-01')
  assert.ok(!edits.some((e) => e.lotIndex === 1))
})

test('an empty live list changes nothing', () => {
  const lots: CatalogueLot[] = [{ name: 'A', dailyRate: 5, sellable: true }]
  const { edits, newLots, report } = planSync('EWR', lots, [], opts)
  assert.equal(edits.length + newLots.length, 0)
  assert.ok(report.note)
  assert.equal(lots[0].sellable, true)
})

test('fuzzy matches are reported, not applied, and the live lot is not added as a duplicate', () => {
  const lots: CatalogueLot[] = [{ name: 'Courtyard Marriott Newark Elizabeth Downtown', dailyRate: 13.87, sellable: true }]
  const m = merged([live('Courtyard Marriott Newark Elizabeth Center', { price: 16.015 })])
  const r = planSync('EWR', lots, m, opts)
  assert.equal(r.report.needsConfirmation.length, 1)
  assert.equal(r.report.needsConfirmation[0].via, 'fuzzy')
  assert.equal(r.newLots.length, 0)
  assert.equal(r.edits.length, 0)
  const accepted = planSync('EWR', [{ ...lots[0] }], m, { ...opts, acceptFuzzy: true })
  assert.equal(accepted.report.matched[0].via, 'fuzzy')
  assert.equal(accepted.report.priceChanges[0].to, 16.02)
})

test('a rejected (>3x) price move writes nothing: not the price, not sellable, not the id', () => {
  const lots: CatalogueLot[] = [{ name: 'Best Rate', dailyRate: 40, sellable: false }]
  const { report, edits } = planSync('EWR', lots, merged([live('Best Rate', { price: 10.24, reslabLocationId: 77 })]), opts)
  assert.deepEqual(report.implausible, [{ lot: 'Best Rate', from: 40, to: 10.24, via: 'name' }])
  assert.equal(edits.length, 0)
  assert.deepEqual(lots[0], { name: 'Best Rate', dailyRate: 40, sellable: false })
  assert.deepEqual(report.flippedToSellable, [])
  assert.deepEqual(report.idSet, [])
})

test('a lot with totalFor8Days is priced on the 8-day sample and keeps its totals in step', () => {
  const lots: CatalogueLot[] = [{ name: 'Bolt', dailyRate: 21.9, totalFor8Days: 190, taxesFor8Days: 15, sellable: true }]
  const m = mergeSamples(
    [
      { days: 7, lots: [live('Bolt', { price: 25 })] },
      { days: 8, lots: [{ ...live('Bolt'), pricing: { minPrice: 26.68, grandTotal: 230.1, taxTotal: 16.66, numberOfDays: 8 } }] },
    ],
    'EWR'
  ).live
  const { report } = planSync('EWR', lots, m, opts)
  assert.deepEqual(report.priceChanges, [{ lot: 'Bolt', from: 21.9, to: 26.68, days: 8 }])
  assert.equal(lots[0].totalFor8Days, 230.1)
  assert.equal(lots[0].taxesFor8Days, 16.66)
})

test('mergeSamples: union across dates, first sample prices, same-name listings collapsed', () => {
  const r = mergeSamples(
    [
      { days: 7, lots: [live('Clarion', { id: 'reslab-370', price: 8.35 }), live('Clarion', { id: 'reslab-371', price: 9 }), live('A', { id: 'a', price: 5 })] },
      { days: 7, lots: [live('A', { id: 'a', price: 6 }), live('B', { id: 'b' })] },
    ],
    'EWR'
  )
  assert.deepEqual(r.live.map((m) => m.lot.name).sort(), ['A', 'B', 'Clarion'])
  assert.equal(r.live.find((m) => m.lot.name === 'A')!.pricing.get(7)!.minPrice, 5)
  assert.equal(r.live.find((m) => m.lot.name === 'Clarion')!.lot.id, 'reslab-370')
  assert.equal(r.collapsed.length, 1)
  assert.deepEqual(r.otherAirport, [])
})

test('mergeSamples, production-shaped: search stamps EVERY result with the searched code, so the airportCode guard never drops an LGA lot', () => {
  // search.ts maps availableLots to { ...lot, airportCode: airportInfo.code } before the own-airport filter, and on an
  // ownAirportFallback response the radius list (other airports' lots) comes back under the SEARCHED code. So this guard
  // cannot catch them; fetchLive refuses ownAirportFallback responses instead (see refresh-rates.test.ts).
  const stamped = [live('Flushing Lot (LGA)', { id: 'f' }), live('JFK Lot', { id: 'j' })].map((l) => ({ ...l, airportCode: 'JFK' }))
  const r = mergeSamples([{ days: 7, lots: stamped }], 'JFK')
  assert.deepEqual(r.otherAirport, [])
  assert.equal(r.live.length, 2, 'both pass — which is why a fallback sample must never reach mergeSamples')
  // The guard still drops a lot that does carry another code (kept as belt-and-braces).
  assert.deepEqual(mergeSamples([{ days: 7, lots: [{ ...live('X'), airportCode: 'LGA' }] }], 'JFK').otherAirport, ['X (LGA)'])
})

test('one live lot can match only one file lot (a duplicate entry goes unsellable)', () => {
  const lots: CatalogueLot[] = [
    { name: 'Doubletree Baltimore', sellable: true, dailyRate: 6.16 },
    { name: 'Doubletree  Baltimore', sellable: true, dailyRate: 7.95 },
  ]
  const r = matchLots(lots, [live('Doubletree Baltimore')], 'BWI')
  assert.equal(r.size, 1)
})

test('newLotFromLive carries only searched fields plus the review flag', () => {
  const [m] = merged([
    live('Red Carpet Inn', {
      slug: 'red-carpet-inn', reslabLocationId: 184, address: '100 Union Avenue, Irvington, NJ', distanceFromAirport: 3.8,
      phone: '973-375-4102', shuttleInfo: { summary: 'No Shuttle.  Uber and Lyft are available.' },
      amenities: [{ displayName: 'Wheelchair Access' }], dueAtLocation: false, minimumBookingDays: 1, price: 5.1975,
    }),
  ])
  const lot = newLotFromLive(m, 7, TODAY)
  assert.deepEqual(lot, {
    name: 'Red Carpet Inn', slug: 'red-carpet-inn', reslabLocationId: 184, address: '100 Union Avenue, Irvington, NJ',
    distanceFromAirport: '3.8 mi', phone: '973-375-4102', shuttleInfo: 'No Shuttle. Uber and Lyft are available.',
    amenities: ['Wheelchair Access'], paymentMethod: 'Pay Online', dailyRate: 5.2, rateVerified: TODAY,
    sellable: true, sellableCheckedOn: TODAY,
    needsReview: `added by lot-sync ${TODAY} from live search: parkingType, driveTime and overview not filled`,
  })
  assert.ok(!('parkingType' in lot) && !('driveTime' in lot) && !('overview' in lot))
})

test('surgical write: edits + appended lots reproduce the intended object and keep the file layout', () => {
  const text = `{
  "code": "EWR",
  "lastVerified": "2026-11-01",
  "parkingLots": [
    {
      "name": "Apex Airport Parking",
      "amenities": ["Valet", "Shuttle"],
      "dailyRate": 8.95,
      "sellable": false
    }
  ],
  "after": 1
}
`
  const data = JSON.parse(text) as { parkingLots: CatalogueLot[] }
  const lots = data.parkingLots
  const m = merged([live('Apex Airport Parking', { price: 9.2625, reslabLocationId: 10 }), live('Maas Parking Newark', { price: 10.4475, amenities: [{ displayName: 'Covered' }] })])
  const { edits, newLots } = planSync('EWR', lots, m, opts)
  assert.ok(edits.some((e) => e.field === 'reslabLocationId'), 'a strong match adds the id as a new field')
  data.parkingLots = [...lots, ...newLots]
  const edited = applyLotEdits(text, edits, null)
  assert.ok(edited)
  const out = appendLots(edited, newLots)
  assert.ok(out)
  assert.ok(reproduces(out, data))
  assert.ok(out.includes('"amenities": ["Valet", "Shuttle"]'), 'untouched lines stay byte-identical')
  assert.ok(out.includes('      "amenities": ["Covered"]'), 'new lot laid out like the others')
  assert.ok(out.includes('"lastVerified": "2026-11-01"'), 'file-level date is not moved')
  assert.ok(out.endsWith('  "after": 1\n}\n'))
})

test('formatLot inlines primitive arrays', () => {
  assert.equal(formatLot({ name: 'A', amenities: ['x', 'y'] }, '    '), '    {\n      "name": "A",\n      "amenities": ["x", "y"]\n    }')
})

test('subset tier: "Red Roof Inn Dallas DFW Airport North" ~ live "Red Roof Inn" is found, but only applied under --accept-fuzzy', () => {
  const lots: CatalogueLot[] = [
    { name: 'Red Roof Inn Dallas DFW Airport North (Parking)', dailyRate: 7.99, sellable: false },
    { name: 'Hilton Garden Inn', dailyRate: 9, sellable: true },
  ]
  const m = mergeSamples([{ days: 7, lots: [live('Red Roof Inn', { price: 4.99 }), live('Hilton', { price: 9 })].map((l) => ({ ...l, airportCode: 'DFW' })) }], 'DFW').live
  const { report, newLots } = planSync('DFW', lots, m, opts)
  assert.deepEqual(report.needsConfirmation.map((x) => x.via), ['subset'])
  assert.deepEqual(report.flippedToSellable, [])
  assert.equal(lots[0].sellable, false)
  assert.deepEqual(newLots.map((l) => l.name), ['Hilton'])
  assert.deepEqual(report.gone, ['Hilton Garden Inn'])
  const acc = planSync('DFW', [{ ...lots[0] }], m, { ...opts, acceptFuzzy: true })
  assert.deepEqual(acc.report.matched[0], { lot: 'Red Roof Inn Dallas DFW Airport North (Parking)', live: 'Red Roof Inn', via: 'subset' })
})

test('subset tier refuses when two file lots could claim the same live lot', () => {
  const lots: CatalogueLot[] = [
    { name: 'Comfort Suites North', sellable: true },
    { name: 'Comfort Suites South', sellable: true },
  ]
  const r = matchLots(lots, [live('Comfort Suites')], 'EWR')
  assert.ok([...r.values()].every((m) => m.via === 'fuzzy'), 'at most a fuzzy match, which is reported, not applied')
})

test('gone needs 2 check-in dates: with one date a missing lot is reported only, nothing written', () => {
  const lots: CatalogueLot[] = [{ name: 'Gone Lot', dailyRate: 12, sellable: true }]
  const { report, edits } = planSync('EWR', lots, merged([live('Something Else')]), { ...opts, checkinDates: 1 })
  assert.deepEqual(report.gone, [])
  assert.deepEqual(report.missingOneDate, ['Gone Lot'])
  assert.ok(!edits.some((e) => e.lotIndex === 0))
  assert.equal(lots[0].sellable, true)
})

test('planCalls: when call 2 is another stay length on the SAME date, a third call adds a second check-in date', () => {
  const withEight = planCalls([{ name: 'A', totalFor8Days: 1 }, { name: 'B' }], 7, 21)
  assert.deepEqual(withEight.calls, [{ days: 7, lead: 21 }, { days: 8, lead: 21 }, { days: 7, lead: 33 }])
  assert.equal(withEight.checkinDates, 2)
  const plain = planCalls([{ name: 'A' }], 7, 21)
  assert.deepEqual(plain.calls, [{ days: 7, lead: 21 }, { days: 7, lead: 33 }])
  assert.equal(plain.checkinDates, 2)
  assert.equal(planCalls(null, 7, 21).calls.length, 1, 'no file: report only, one call')
  // Pulled into the 60-day window, the two leads can collapse to one date — then nothing is marked gone.
  assert.equal(planCalls([{ name: 'A' }], 7, 60).checkinDates, 1)
})

test('cruise/downtown lots (MIA/FLL-shaped) get a "do not use in CTAs" note that write.ts DO_NOT_LEAD honours, and no cruiseShuttle', () => {
  assert.ok(DO_NOT_LEAD.test(NOT_AIRPORT_NOTE), 'the writer must actually match this wording')
  const m = mergeSamples(
    [
      {
        days: 7,
        lots: [
          live('Bayfront Garage Miami', { distanceFromAirport: 6.2, shuttleInfo: { summary: 'No shuttle' }, price: 8.4 }),
          live('WePark in Miami Cruise Parking', { distanceFromAirport: 6.2, shuttleInfo: { summary: 'To Cruise Terminal: 11 AM' }, price: 15.41 }),
          live('Park By The Ports Cruise Parking', { distanceFromAirport: 1.6, shuttleInfo: { summary: '7 AM to 2 PM' }, price: 9 }),
          live('Holiday Inn Miami Airport', { distanceFromAirport: 1.7, shuttleInfo: { summary: '24/7 On demand' }, price: 10.18 }),
        ].map((l) => ({ ...l, airportCode: 'MIA' })),
      },
    ],
    'MIA'
  ).live
  const { newLots, report } = planSync('MIA', [], m, opts)
  const noted = newLots.filter((l) => l.notes === NOT_AIRPORT_NOTE).map((l) => l.name).sort()
  assert.deepEqual(noted, ['Bayfront Garage Miami', 'Park By The Ports Cruise Parking', 'WePark in Miami Cruise Parking'])
  assert.equal(report.notAirport.length, 3)
  assert.ok(newLots.every((l) => !('cruiseShuttle' in l)))
  assert.equal(notAirportReason({ name: 'Holiday Inn Miami Airport', shuttleInfo: '24/7 On demand', distanceFromAirport: '1.7 mi' }), '', '"Airport" is not "port"')
  const lead = leadEligibleLots({ code: 'MIA', parkingLots: newLots } as unknown as AirportData).map((l) => l.name)
  assert.deepEqual(lead, ['Holiday Inn Miami Airport'])
})

test('a lot an earlier run added (needsReview still lot-sync\'s, no notes) gets the cruise note on a re-run; a reviewed lot does not', () => {
  const added = 'added by lot-sync 2026-11-06 from live search: parkingType, driveTime and overview not filled'
  const lots: CatalogueLot[] = [
    { name: 'Bayfront Garage Miami', reslabLocationId: 406, distanceFromAirport: '6.2 mi', shuttleInfo: 'No shuttle', dailyRate: 8.4, sellable: true, needsReview: added },
    { name: 'Far Lot', reslabLocationId: 407, distanceFromAirport: '9 mi', shuttleInfo: 'No shuttle', dailyRate: 8.4, sellable: true },
  ]
  const m = mergeSamples([{ days: 7, lots: [live('Bayfront Garage Miami', { reslabLocationId: 406, price: 8.4 }), live('Far Lot', { reslabLocationId: 407, price: 8.4 })].map((l) => ({ ...l, airportCode: 'MIA' })) }], 'MIA').live
  const { report } = planSync('MIA', lots, m, opts)
  assert.equal(lots[0].notes, NOT_AIRPORT_NOTE)
  assert.ok(!('notes' in lots[1]))
  assert.deepEqual(report.notAirport, ['Bayfront Garage Miami (no shuttle, 6.2 mi out)'])
})
