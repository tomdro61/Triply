import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizedKey, findDuplicate } from './duplicate-guard.js'

test('normalise folds cost/price/rates/fee/per day and drops airport words', () => {
  const a = normalizedKey('jfk airport parking cost', 'JFK')
  assert.equal(a, normalizedKey('kennedy airport parking rates', 'JFK'))
  assert.equal(a, normalizedKey('how much is parking at jfk per day', 'JFK'))
  assert.equal(a, normalizedKey('jfk-parking-fees-2026', 'JFK'))
  assert.equal(a, 'cost')
})

test('shuttle = bus, pick-up = visitor = waiting', () => {
  assert.equal(normalizedKey('bwi airport parking shuttle', 'BWI'), normalizedKey('bwi parking bus', 'BWI'))
  assert.equal(normalizedKey('iad pick up parking', 'IAD'), normalizedKey('dulles visitor parking', 'IAD'))
  assert.equal(normalizedKey('iad cell phone waiting lot', 'IAD'), normalizedKey('iad pick-up lot', 'IAD'))
})

test('intent words stay distinct', () => {
  const generic = normalizedKey('bos airport parking rates', 'BOS')
  assert.notEqual(generic, normalizedKey('bos long term parking rates', 'BOS'))
  assert.notEqual(generic, normalizedKey('bos hourly parking rates', 'BOS'))
  assert.notEqual(normalizedKey('bos long-term parking', 'BOS'), normalizedKey('bos hourly parking', 'BOS'))
  assert.notEqual(normalizedKey('logan terminal b parking', 'BOS'), normalizedKey('logan terminal e parking', 'BOS'))
  assert.notEqual(normalizedKey('logan terminal b parking', 'BOS'), normalizedKey('logan central garage parking', 'BOS'))
})

test('findDuplicate matches an existing slug of any status and follows the redirect map', () => {
  const existing = ['newark-airport-parking', 'newark-airport-parking-rates-p6', 'ewr-long-term-parking']
  const hit = findDuplicate('newark airport parking cost', 'EWR', existing, {})
  assert.ok(hit)
  assert.equal(hit.slug, 'newark-airport-parking-rates-p6')
  assert.equal(hit.via, 'existing-post')
  const redirected = findDuplicate('newark airport parking cost', 'EWR', existing, { 'newark-airport-parking-rates-p6': 'newark-airport-parking-rates' })
  assert.equal(redirected?.slug, 'newark-airport-parking-rates')
  const viaMap = findDuplicate('ewr parking fees', 'EWR', [], { 'ewr-parking-prices': 'newark-airport-parking-rates' })
  assert.equal(viaMap?.via, 'redirect-map')
  assert.equal(viaMap?.slug, 'newark-airport-parking-rates')
})

test('findDuplicate ignores the own slug (regenerate) and new intents', () => {
  const existing = ['ewr-airport-parking-rates']
  assert.equal(findDuplicate('ewr airport parking rates', 'EWR', existing, {}, 'ewr-airport-parking-rates'), null)
  assert.equal(findDuplicate('ewr airport parking shuttle', 'EWR', existing, {}), null)
})

// ── Review of #141 ──
test('terminal designators survive the filler filter ("terminal a" is not the terminal page)', () => {
  assert.notEqual(normalizedKey('newark terminal a parking', 'EWR'), normalizedKey('newark terminal parking', 'EWR'))
  assert.equal(normalizedKey('newark terminal a parking', 'EWR'), normalizedKey('ewr-terminal-a-parking', 'EWR'))
  assert.equal(findDuplicate('newark terminal a parking', 'EWR', ['newark-airport-terminal-parking'], {}, 'newark-terminal-a-parking'), null)
})
test('economy stays distinct from long-term', () => {
  assert.notEqual(normalizedKey('ORD economy parking', 'ORD'), normalizedKey('ORD long term parking', 'ORD'))
  assert.equal(findDuplicate('ORD economy parking', 'ORD', ['ord-long-term-parking'], {}, 'ord-economy-parking'), null)
  assert.equal(normalizedKey('ord economy parking', 'ORD'), normalizedKey('ohare remote parking', 'ORD'))
})
test('the redirect map only answers for this airport', () => {
  const map = { 'lga-long-term-parking-2025': 'lga-long-term-parking' }
  assert.equal(findDuplicate('JFK long term parking', 'JFK', ['jfk-airport-parking'], map, 'jfk-long-term-parking'), null)
  assert.equal(findDuplicate('LGA long term parking', 'LGA', ['lga-airport-parking'], map, 'lga-long-term-parking-guide')?.slug, 'lga-long-term-parking')
  // a destination that IS one of this airport's pages counts even when neither slug carries the code
  const viaOwnPage = findDuplicate('kennedy long term parking', 'JFK', ['kennedy-airport-parking-guide'], { 'kennedy-extended-parking': 'kennedy-airport-parking-guide' }, 'kennedy-long-term-parking')
  assert.equal(viaOwnPage?.via, 'redirect-map')
  assert.equal(viaOwnPage?.slug, 'kennedy-airport-parking-guide')
})
