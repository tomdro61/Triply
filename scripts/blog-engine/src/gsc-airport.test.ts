// detectAirportCode must match whole slug tokens, not substrings (2026-10-07 review of
// the GSC report PR): the substring version filed "dallas-…" and "last-minute-…" under
// LAS, "affordable-…" under ORD, "hidden-fees" under DEN — wrong airport clusters.
//
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectAirportCode } from './gsc.js'

test('matches airport codes and names as whole tokens', () => {
  assert.equal(detectAirportCode('jfk-airport-parking-guide'), 'JFK')
  assert.equal(detectAirportCode('cheap-parking-near-laguardia'), 'LGA')
  assert.equal(detectAirportCode('san-francisco-long-term-parking'), 'SFO')
  assert.equal(detectAirportCode('dallas-love-field-parking'), 'DFW')
  assert.equal(detectAirportCode('las-vegas-airport-parking'), 'LAS')
  assert.equal(detectAirportCode('ord-parking-rates'), 'ORD')
  assert.equal(detectAirportCode('boston-logan-economy-lot'), 'BOS')
})

test('never matches an airport code inside an ordinary word', () => {
  assert.equal(detectAirportCode('last-minute-airport-parking-tips'), null)
  assert.equal(detectAirportCode('affordable-airport-parking-guide'), null)
  assert.equal(detectAirportCode('hidden-fees-airport-parking'), null)
  assert.equal(detectAirportCode('overseas-travel-checklist'), null)
  assert.equal(detectAirportCode('because-you-asked-airport-faq'), null)
  assert.equal(detectAirportCode('golden-rules-of-airport-parking'), null)
})

test('a multi-token pattern needs its tokens consecutive', () => {
  assert.equal(detectAirportCode('salt-lake-city-airport-parking'), 'SLC')
  assert.equal(detectAirportCode('salt-and-lake-trip'), null)
})
