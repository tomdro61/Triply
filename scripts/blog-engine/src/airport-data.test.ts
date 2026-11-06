// PR #96 (review): the writer only sees lots Triply can sell, and Canadian airports
// print C$ — with a code-list fallback so an unreadable data file never hands a
// Canadian airport US-only sources.
//
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterSellableLots, currencySymbol, isCanadianAirport, airportPageLots, NOT_AIRPORT_NOTE } from './airport-data.js'
import { isOwnSiteUrl } from './external-links.js'

test('airportPageLots (review of #160): an airport page drops lot-sync\'s cruise/downtown lots and names them; a cruise-port file keeps them', () => {
  const mia = {
    code: 'MIA',
    parkingLots: [
      { name: 'Holiday Inn Miami Airport', sellable: true, dailyRate: 10.18 },
      { name: 'Bayfront Garage Miami', sellable: true, dailyRate: 8.4, notes: NOT_AIRPORT_NOTE },
      { name: 'Closed Lot', sellable: false },
    ],
  }
  const r = airportPageLots(mia)
  assert.deepEqual(r.lots.map((l) => l.name), ['Holiday Inn Miami Airport'])
  assert.deepEqual(r.hiddenNames, ['Bayfront Garage Miami', 'Closed Lot'])
  // A human who confirms the lot serves the airport removes the note, and it comes back.
  const cleared = { ...mia, parkingLots: mia.parkingLots.map((l) => ({ ...l, notes: undefined })) }
  assert.equal(airportPageLots(cleared).lots.length, 2)
  // POE (and any file with cruiseShuttle data) is a cruise-port page: the note doesn't hide anything there.
  assert.equal(airportPageLots({ ...mia, code: 'POE' }).lots.length, 2)
})

test('filterSellableLots drops only lots explicitly marked sellable: false', () => {
  const lots = [
    { name: 'Sold on Triply', sellable: true },
    { name: 'Not sold', sellable: false },
    { name: 'Older data file, no flag' },
  ]
  assert.deepEqual(filterSellableLots(lots).map((l) => l.name), ['Sold on Triply', 'Older data file, no flag'])
})

test('currencySymbol is C$ for a CAD data file and for a Canadian code without one', () => {
  assert.equal(currencySymbol({ code: 'YYZ', currency: 'CAD' }), 'C$')
  assert.equal(currencySymbol({ code: 'YUL' }), 'C$')
  assert.equal(currencySymbol({ code: 'PHX' }), '$')
  assert.equal(currencySymbol({ code: 'PHX', currency: 'USD' }), '$')
})

test('isCanadianAirport never fails open on a missing or unreadable file', () => {
  assert.equal(isCanadianAirport('YYC', null), true)
  assert.equal(isCanadianAirport('yow', undefined), true)
  assert.equal(isCanadianAirport('BOS', null), false)
  assert.equal(isCanadianAirport('BOS', { currency: 'CAD' }), true)
})

test('isOwnSiteUrl keeps only triplypro.com links from competitor categories', () => {
  assert.equal(isOwnSiteUrl('https://www.triplypro.com/search?airport=PHX'), true)
  assert.equal(isOwnSiteUrl('https://staging.triplypro.com/'), true)
  assert.equal(isOwnSiteUrl('https://spothero.com/airport/phoenix/phx-parking'), false)
  assert.equal(isOwnSiteUrl('not a url'), false)
})
