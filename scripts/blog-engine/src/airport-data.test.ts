// PR #96 (review): the writer only sees lots Triply can sell, and Canadian airports
// print C$ — with a code-list fallback so an unreadable data file never hands a
// Canadian airport US-only sources.
//
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterSellableLots, currencySymbol, isCanadianAirport } from './airport-data.js'
import { isOwnSiteUrl } from './external-links.js'

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
