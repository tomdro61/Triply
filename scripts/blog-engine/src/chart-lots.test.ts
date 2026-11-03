import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cruisePortLot, paidTransfer, transferOf } from './chart-lots.js'

// Real summaries / details from the Nov 2, 2026 searches.
const lot = (name: string, summary: string, details = '') => ({ name, summary, details })

test('labels: a shuttle that stops overnight is still a shuttle; an outright "No shuttle" is none', () => {
  assert.equal(transferOf(lot('Routes', '7:00 AM - 11:00 PM: Shuttle runs every 15 minutes.  11:00 PM - 7:00 AM: No shuttle.'), undefined, false), 'shuttle')
  assert.equal(transferOf(lot('Chandni Victoria', 'No shuttle'), undefined, false), 'none')
  assert.equal(transferOf(lot('Hearthstone', 'No Shuttle. Please arrange alternative transportation (Uber/Lyft)'), undefined, true), 'none')
})
test('labels: valet from the summary, or from the data file when the summary only says "on demand"', () => {
  assert.equal(transferOf(lot('Drop N Park Valet', '24/7 VALET to your terminal.'), undefined, false), 'valet')
  assert.equal(transferOf(lot('Simply Park', '24/7 on demand'), { shuttleInfo: 'No shuttle: a driver meets you AT the terminal in your own car.' }, false), 'valet')
})
test('labels: shuttle words incl. "every 20-30 Minutes" and "runs continuously"; a hotel Lyft is "—"', () => {
  assert.equal(transferOf(lot('South Bay', 'every 20-30 Minutes'), undefined, false), 'shuttle')
  assert.equal(transferOf(lot('Spot 3', 'Shuttle runs continuously'), undefined, false), 'shuttle')
  assert.equal(transferOf(lot('Hampton Hobby', '24/7 complimentary Lyft'), undefined, false), 'unknown')
})
test('paid: per-adult fee, collected shuttle payment, engine fee rule; extra-passenger fees are not', () => {
  assert.equal(paidTransfer(lot('BW Carlingview', '24/7', 'Added fee of CAD $5 per adult (children ride free)'), undefined), true)
  assert.equal(paidTransfer(lot('Quality Inn Ybor', '10 AM - 2 PM', 'Shuttle payment will be collected at that time.'), undefined), true)
  assert.equal(paidTransfer(lot('Quality Inn MCI', '24/7 every 30 minutes'), { shuttleInfo: 'shuttle is NOT free: $10 each way.' }), true)
  assert.equal(paidTransfer(lot('Free', 'Free shuttle', 'Additional passengers beyond 4: $10 per person'), undefined), false)
})
test('cruise-port lots are found by name, by their own shuttle text, or by an exact data-file note', () => {
  assert.notEqual(cruisePortLot(lot('Park By The Ports Cruise Parking', '7 AM to 2 PM'), undefined, false), '')
  assert.notEqual(cruisePortLot(lot('241 Car Services', '7:00 AM - 3:00 PM on demand', 'Transfer Shuttle runs from 7:00 AM to 3:00 PM on demand to and from the Port.'), undefined, false), '')
  const note = { notes: 'The operator describes it for Port of Baltimore cruise travelers; shuttle 10 AM-2 PM only.' }
  assert.notEqual(cruisePortLot(lot('Clarion', '10 AM - 2 PM'), note, true), '')
  assert.equal(cruisePortLot(lot('Clarion', '4:00 AM - 10:00 AM: Shuttle runs every 30 minutes.'), note, false), '', 'a shared data-file entry does not exclude the other listing')
  assert.equal(cruisePortLot(lot('Courtyard FLL', '5 AM - midnight', 'This reservation includes complimentary AIRPORT shuttle. Cruise port shuttle available for a fee.'), undefined, false), '')
})
