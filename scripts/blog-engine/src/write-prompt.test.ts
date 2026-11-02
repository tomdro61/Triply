// Airport-level prose vs the sellable lot list (review of PR #143).
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropOffSiteSentences, scenarioBilledDays, sellableLotRange, getAirportDataBlock, leadEligibleLots, offSiteScenarioRows, figureSource, printableNotes, cutAt, paidOrNoTransfer } from './prompts/write.js'
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
  const shuttle = 'AirTrain connects all terminals. Some budget lots (Parking 4 Airport, Hyatt Place Flushing) have limited shuttle hours. The Parking Spot East/West runs 24/7 shuttles. Ausby shuttle runs 10 AM-9:30 PM. Doug Fox has the fastest shuttle.'
  assert.equal(dropOffSiteSentences(shuttle, ['Parking 4 Airport (JFK)', 'The Parking Spot East AUS', 'Ausby Airport Parking (DFW)', 'Doug Fox Airport Parking']), 'AirTrain connects all terminals.')
  assert.equal(dropOffSiteSentences('Park & Zoom has shuttles on airport property. Royal Inn has NO shuttle. Economy Lot shuttle every 10 min.', ['Park & Zoom AUS', 'Royal Inn CLT Airport Parking']), 'Economy Lot shuttle every 10 min.')
  assert.equal(dropOffSiteSentences('The Westin Dallas-Fort Worth runs hourly. Garage $27/day.', ['The Westin Dallas Fort Worth (DFW)']), 'Garage $27/day.', 'hyphen and space are the same in a name')
  assert.equal(dropOffSiteSentences('Rates effective July 1, 2026. 3-day minimum applies. Off-site via Triply from $8.'), 'Rates effective July 1, 2026. 3-day minimum applies.', 'a sentence may start with a digit')
  assert.equal(dropOffSiteSentences('First 30 min free in Hourly lots. Off-site via Triply: four lots on Howell Ave / S. 13th St from ~$5.50/day.'), 'First 30 min free in Hourly lots.', '"S. 13th" is an abbreviation, not a sentence end')
  assert.equal(dropOffSiteSentences('7-night trip, Nov 2-9, 2026 (8 billing days on Triply for 10 AM drop-off / 2 PM pick-up).'), '7-night trip, Nov 2-9, 2026 (8 billing days on Triply for 10 AM drop-off / 2 PM pick-up).', '"on Triply" alone is not off-site wording')
  // A brand we also sell is never a drop key.
  assert.equal(dropOffSiteSentences('Motel 6 runs 24/7 every 30-45 min.', ['Motel 6 (SEA)'], ['Motel 6']), 'Motel 6 runs 24/7 every 30-45 min.')
  // Only a leading clause with a figure is salvaged; a trailing fragment is not.
  assert.equal(dropOffSiteSentences('Economy shuttle every 10 min. Off-site lots vary — most run 24/7 with 5-15 minute frequency.'), 'Economy shuttle every 10 min.')
  assert.equal(dropOffSiteSentences('Garage $24/day. Hotel shuttles vary — off-site lots run hourly.'), 'Garage $24/day.')
})

test('printableNotes drops the provenance line and per-day prices but keeps per-person fees; cutAt never cuts mid-number', () => {
  assert.equal(printableNotes('Added 2026-11-01 from live Triply search; details from the lot listing. Good value at $7.99/day. Cruise port shuttle costs $20 per person one way.'), 'Cruise port shuttle costs $20 per person one way.')
  assert.equal(printableNotes('Added 2026-11-01 from live Triply search; details from the lot listing.'), '')
  assert.equal(printableNotes('Added 2026-10-06 from live triplypro.com search (ResLab 70). Rate = all-in daily for a 7-day stay booked 3 weeks out.'), 'Rate = all-in daily for a 7-day stay booked 3 weeks out.')
  assert.equal(printableNotes('Large vehicles pay C$12/day extra AT THE LOT. Pre-book online for the $6.95 rate — walk-up is $8.95/day. Use it always with the $20pp caveat. Walk-up $24.95/24 hrs.'), 'Large vehicles pay C$12/day extra AT THE LOT. Use it always with the $20pp caveat.')
  assert.equal(printableNotes('Triply online rate before service fee; 7-day quote Nov 2-8, 2026 = $26.12. Pay at the lot.', true), 'Pay at the lot.')
  // Pass-5: a lot price rescued by fee wording, "$X pre-booked" order, week quotes and reviewer meta-text are all stale.
  assert.equal(printableNotes('At $20.95/day with NO shuttle, budget ~$15-25 each way for Uber. 3-day minimum.'), '3-day minimum.')
  assert.equal(printableNotes('Same $6.95/day as Express Park Fly but $1 more in fees. Do not promise covered parking at that price.'), 'Do not promise covered parking at that price.')
  assert.equal(printableNotes('Old "$6.45 pre-booked" / "$9.95" are false. 4-DAY MINIMUM: not bookable for 1-3 day trips.'), '4-DAY MINIMUM: not bookable for 1-3 day trips.')
  assert.equal(printableNotes('$52.90 grand total for Nov 2-9 (8 billed days). C$7.61/day before HST. 3-day minimum. Keys stay with you.'), '3-day minimum. Keys stay with you.')
  assert.equal(printableNotes('Oversized vehicles pay an extra $25/day at the lot. The listing adds ~27% tax.'), 'Oversized vehicles pay an extra $25/day at the lot. The listing adds ~27% tax.')
  // Pass-6: a caveat that shares its sentence with a price keeps its words, loses the figures.
  assert.equal(printableNotes('Lowest base rate at DTW ($10.40/day) but the listing adds ~27% tax: the Nov 2-9 checkout is $104.54 ($13.07/day all-in), the highest of the four.'), 'Lowest base rate at DTW but the listing adds ~27% tax: the Nov 2-9 checkout is [price omitted] , the highest of the four.'.replace(' ,', ','))
  assert.equal(printableNotes('The $8.05/day Triply minimum may be the rooftop product; do not promise covered parking at that price.'), 'The [price omitted] Triply minimum may be the rooftop product; do not promise covered parking at that price.')
  assert.equal(printableNotes('SUV surcharges: small/midsize $6/day, large SUV/trucks $10/day. Quoted $50.40 total (incl. tax) for Nov 2-8. Same daily rate as Radisson (C$8.35) but C$69.96 total.'), 'SUV surcharges: small/midsize $6/day, large SUV/trucks $10/day.')
  // Pass-7: quote breakdowns with "fees/tax" are not caveats; a caveat keeps at most one placeholder; date-colon quotes are stale.
  assert.equal(printableNotes('$78.76 grand total for Nov 2-9 (8 billed days; $62.50 subtotal + fees/tax), same on all three test weeks.'), '')
  assert.equal(printableNotes('Covered parking at $26/day is still cheaper than on-airport garages. 24/7 shuttle + covered parking at $10.25 is excellent value.'), '')
  assert.equal(printableNotes('Most of the total is paid at the lot (live quote: $101.15 due at location of $120.68).'), 'Most of the total is paid at the lot.')
  assert.equal(printableNotes('Shuttle on demand (Nov 2-9: $82.00 of $94.00 due at the lot).'), '', 'a caveat that lived only inside the figures goes with them')
  assert.equal(printableNotes('C$8.01/day before HST, no minimum stay. Keys must be left.'), 'Keys must be left.', '"no minimum" is not a caveat')
  // Pass-8: a fee figure in "at $X" / "($X)" form is a fee, not the lot's price.
  assert.equal(printableNotes('Shuttle to the cruise port at $10 per person. Extra passengers pay a fee ($10). Large vehicles pay a surcharge at $12/day.'), 'Shuttle to the cruise port at $10 per person. Extra passengers pay a fee ($10). Large vehicles pay a surcharge at $12/day.')
  assert.equal(cutAt('Shuttle runs every hour to the terminal. Help: 416-555-0100 ' + 'x'.repeat(200), 60), 'Shuttle runs every hour to the terminal.')
  const long = 'Shuttle 5:00 AM-11:00 PM except statutory holidays; this plan uses the 7:00 AM-10:30 PM schedule. Call 403-717-1234 after collecting bags. ' + 'x'.repeat(200)
  const cut = cutAt(long, 240)
  assert.ok(cut.endsWith('.') && !/\d-$/.test(cut) && cut.length <= 241, cut)
  assert.equal(cutAt('short', 240), 'short')
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
  unsellableLotNames: ['Gone Lot Airport Parking'],
  parkingLots: [
    { name: 'Cheap Lot', dailyRate: 6.41, sellable: true, notes: 'Hotel lot, well lit.' },
    { name: 'Dead Lot', dailyRate: 7.5, sellable: true, shuttleSuspended: true, notes: 'SHUTTLE SUSPENDED. Do NOT use in CTAs.' },
    { name: 'Dear Lot', dailyRate: 28, sellable: true, knownCoupons: ['Pre-book via competitor.com from $13/day'], notes: 'Added 2026-11-01 from live Triply search; details from the lot listing. Good value at $7.99/day. Oversized vehicles pay a $20 surcharge at the lot.' },
  ],
  parkSleepFly: { description: 'Hotel + parking combos. Triply sells parking-only at the three hotels.', priceRange: 'Parking-only via Triply from ~$5.49/day (2026-10-16 quote); room package pricing — ask the hotel.' },
  savingsComparison: {
    scenario: '7-day trip for 2 travelers',
    onAirport: { garage: { parkingCost: '$168 (7 x $24)' } },
    offSiteWithShuttle: { oldLot: { parkingCost: '$28 (7 x $4)' } },
    keyDifference: 'the lots Triply sells cost about $4-11/day',
  },
}

test('the range and the computed rows skip lots whose notes bar them from leading', () => {
  assert.deepEqual(leadEligibleLots(base).map((l) => l.name), ['Cheap Lot', 'Dear Lot'], 'suspended-shuttle lot out')
  assert.deepEqual(leadEligibleLots(base, 'cheap cruise parking').map((l) => l.name), ['Cheap Lot', 'Dear Lot'], 'a cruise keyword at an airport page (no cruise-shuttle data) changes nothing')
  const poeLots = [
    { name: 'Airport Only Lot', dailyRate: 6.25, sellable: true, cruiseShuttle: 'not-available', notes: 'AIRPORT PARKING ONLY. Never recommend to cruisers.' },
    { name: 'Port Lot', dailyRate: 21.7, sellable: true, cruiseShuttle: 'included' },
  ]
  assert.deepEqual(leadEligibleLots({ ...base, code: 'POE', parkingLots: poeLots }).map((l) => l.name), ['Port Lot'])
  assert.deepEqual(leadEligibleLots({ ...base, parkingLots: poeLots }).map((l) => l.name), ['Port Lot'], 'any file with cruiseShuttle data is a cruise page')
  assert.deepEqual(leadEligibleLots({ ...base, parkingLots: [{ name: 'Clarion', dailyRate: 8.35, sellable: true, notes: 'Shuttle 10 AM-2 PM only. Confirm the airport shuttle before recommending it for flights.' }] }), [], 'BWI-shaped caveat bars leading')
  const paid = [
    { name: 'Courtyard', dailyRate: 12.25, sellable: true, cruiseShuttle: 'paid-$20pp-one-way' },
    { name: 'Quality Inn', dailyRate: 4.13, sellable: true, shuttleInfo: '24/7 every 30 minutes — shuttle is NOT free: $10 each way.' },
    { name: 'Port Lot', dailyRate: 21.7, sellable: true, cruiseShuttle: 'included' },
  ]
  assert.deepEqual(leadEligibleLots({ ...base, parkingLots: paid }).map((l) => l.name), ['Port Lot'], 'a paid transfer never leads: the lot rate understates the trip')
  assert.equal(paidOrNoTransfer({ shuttleInfo: 'Every 30 minutes, C$8 fee.' }), true, 'a shuttle fee')
  assert.equal(paidOrNoTransfer({ shuttleInfo: 'Shuttle $10 round trip.' }), true)
  // Tom (Nov 2 2026): a lot with no shuttle may lead; the writer just never claims a shuttle.
  assert.equal(paidOrNoTransfer({ shuttleInfo: 'NO shuttle. The terminals are a quick 5-minute Uber/Lyft ride (rideshare cost not included).' }), false)
  assert.equal(paidOrNoTransfer({ shuttleInfo: 'No shuttle. Guests must arrange their own transportation.' }), false)
  assert.equal(paidOrNoTransfer({ shuttleInfo: 'Free for up to 4 passengers, every additional is $10.00 per person.' }), false, 'extra passengers on a free shuttle')
  assert.equal(paidOrNoTransfer({ notes: 'Oversized vehicles pay a $20 surcharge at the lot.' }), false)
  assert.equal(sellableLotRange(base), 'from $6.41/day to $28/day across 2 lots')
  assert.equal(sellableLotRange({ ...base, parkingLots: [poeLots[0]] }), 'none may lead a recommendation (every lot carries a caveat — read the lot notes)')
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
  assert.ok(!figures.includes(7.99), 'a stale per-day price inside lot notes is not a known figure')
  assert.ok(figures.includes(20), 'a surcharge in the notes is')
  assert.ok(!figures.includes(5.49), 'park-sleep-fly "via Triply from ~$5.49/day" is not a known figure')
  const psf = figureSource({ ...base, parkSleepFly: { description: 'Triply sells parking-only at the hotels below; room packages are booked with the hotel.', popularHotels: [{ name: 'Dear Lot Hotel', parkOnlyRate: '$7.95/day', shuttleHours: '24/7' }, { name: 'Red Roof Inn', parkOnlyRate: '$5.49/day' }], priceRange: 'Parking-only via Triply from ~$5.49/day.' }, savingsComparison: { scenario: '7-day trip. Off-site = live Triply checkout total incl. fees.', triplyFeeNote: 'service fee max of $4.95 or 6%' } }) as { parkSleepFly: Record<string, unknown>; savingsComparison: Record<string, unknown> }
  assert.deepEqual(psf.parkSleepFly.popularHotels, [{ name: 'Dear Lot Hotel', shuttleHours: '24/7' }], 'only hotels whose lot we sell, without price fields')
  const psf2 = figureSource({ ...base, parkSleepFly: { popularHotels: [{ name: 'Dear Lot Hotel', highlight: 'Triply parking from $8.39/day', parkingIncluded: 'Up to 14 days', distance: '1 mi' }], priceRange: 'From ~$69/night (1-night stay + up to 7 days parking). Ask the hotel for package pricing.' } }) as { parkSleepFly: Record<string, unknown> }
  assert.deepEqual(psf2.parkSleepFly.popularHotels, [{ name: 'Dear Lot Hotel', distance: '1 mi' }], 'highlight and package claims out')
  assert.equal(psf2.parkSleepFly.priceRange, 'Ask the hotel for package pricing.', 'hotel package prices out')
  const psf3 = figureSource({ ...base, parkSleepFly: { description: 'Several hotels within 2 miles offer park-sleep-fly deals with 7-14 days of free parking included with a one-night stay. Room packages are booked with the hotel.' } }) as { parkSleepFly: Record<string, unknown> }
  assert.equal(psf3.parkSleepFly.description, 'Room packages are booked with the hotel.', 'package claims out')
  const fig2 = collectFigures(figureSource({ ...base, parkingLots: [{ name: 'Q', dailyRate: 4.13, sellable: true, rateNote: 'Triply online rate before service fee; 7-day quote = $26.12' }] }))
  assert.ok(!fig2.includes(26.12), 'an unprinted rate-note quote is not a known figure')
  assert.equal(psf.parkSleepFly.description, 'Triply sells parking-only at the hotels below; room packages are booked with the hotel.', 'product truth kept')
  assert.equal(psf.parkSleepFly.priceRange, undefined)
  assert.equal(psf.savingsComparison.triplyFeeNote, undefined, 'stale fee note dropped')
  assert.equal(psf.savingsComparison.scenario, '7-day trip.')
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
  assert.ok(block.includes('Notes: Hotel lot, well lit.'))
  assert.ok(!block.includes('$7.99'), 'a stale per-day price inside lot notes is not printed')
  assert.ok(block.includes('$20 surcharge'), 'a surcharge in the notes is')
  assert.ok(block.includes('Price range (lots that may lead a recommendation): $6.41/day — $28/day across 2 lots; the others above carry a caveat.'), 'the lot-list footer spans eligible lots only')
  const allLead = getAirportDataBlock({ ...base, parkingLots: [base.parkingLots![0], base.parkingLots![2]] }, 'parking cost')
  assert.ok(allLead.includes('across 2 lots.') && !allLead.includes('the others above'), 'no "others" when every lot may lead')
  assert.ok(!block.includes('$7.5/day — '), 'the footer never starts at a barred lot')
  const poe = getAirportDataBlock({ ...base, code: 'POE', parkingLots: [{ name: 'Port Lot', dailyRate: 21.7, sellable: true, cruiseShuttle: 'included' }, { name: 'Airport Only Lot', dailyRate: 6.25, sellable: true, cruiseShuttle: 'not-available', notes: 'AIRPORT PARKING ONLY.' }] }, 'cruise parking full')
  assert.ok(poe.includes('Cruise-port shuttle: included') && poe.includes('Cruise-port shuttle: not-available'))
  assert.ok(poe.includes('Price range (lots that may lead a recommendation): $21.7/day — $21.7/day across 1 lot'))
  assert.ok(!poe.includes('from ~$5.49/day'), 'park-sleep-fly Triply price line filtered')
  assert.ok(!block.includes('Added 2026-11-01'), 'a provenance-only note is not printed')
  assert.ok(block.includes('On-airport shuttles every 10 minutes'), 'general shuttle sentence kept')
})
