// Unit tests for refresh-rates' date rule (2026-09-28).
//
// Freshness is judged on lots we actually SELL. A lot absent from every live sample is
// marked sellable:false and no longer holds the file's lastVerified back. The file is
// re-dated only when every PRESENT lot is verified (fuzzy-skipped / implausible / unpriced
// count as present-but-unverified) and at least one lot is present.
//
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coverageDecision, findMatch, nonProductionReason, unusableReason, PRODUCTION_SITE, type LiveLot } from './refresh-rates.js'

type S = 'updated' | 'unchanged' | 'fuzzy-skipped' | 'implausible' | 'absent' | 'unpriced'
const o = (...statuses: S[]) => statuses.map((status) => ({ status }))

test('SAN-shaped: 2 verified + 4 absent + 1 fuzzy -> NOT re-dated (fuzzy is present, unverified)', () => {
  const d = coverageDecision(o('absent', 'updated', 'absent', 'updated', 'fuzzy-skipped', 'absent', 'absent'))
  assert.deepEqual(d, { present: 3, verified: 2, absent: 4, bump: false })
})

test('absent lots no longer hold the date: 2 verified + 4 absent -> re-dated', () => {
  const d = coverageDecision(o('updated', 'unchanged', 'absent', 'absent', 'absent', 'absent'))
  assert.deepEqual(d, { present: 2, verified: 2, absent: 4, bump: true })
})

test('SFO-shaped: zero lots present -> never re-dated', () => {
  const d = coverageDecision(o('absent', 'absent', 'absent', 'absent', 'absent', 'absent', 'absent', 'absent'))
  assert.equal(d.present, 0)
  assert.equal(d.bump, false)
})

test('no outcomes at all -> not re-dated', () => {
  assert.equal(coverageDecision([]).bump, false)
})

test('implausible and unpriced lots are present but unverified -> block', () => {
  assert.equal(coverageDecision(o('updated', 'implausible')).bump, false)
  assert.equal(coverageDecision(o('updated', 'unpriced')).bump, false)
})

test('--min-coverage is measured over PRESENT lots, not the catalogue', () => {
  // 8 verified of 9 present (one fuzzy), plus absent lots that must not dilute it.
  const outcomes = o(...(Array(8).fill('updated') as S[]), 'fuzzy-skipped', 'absent', 'absent', 'absent')
  assert.equal(coverageDecision(outcomes, 1).bump, false)
  assert.equal(coverageDecision(outcomes, 0.85).bump, true)
  assert.equal(coverageDecision(outcomes, 0.9).bump, false)
})

test('min-coverage 0 still needs at least one present lot', () => {
  assert.equal(coverageDecision(o('absent', 'absent'), 0).bump, false)
  assert.equal(coverageDecision(o('fuzzy-skipped'), 0).bump, true)
})

// ── response usability (2026-11-06 review) ───────────────────────────────────

test('ownAirportFallback responses are unusable, like degraded/stale/listIncomplete', () => {
  assert.equal(unusableReason({ results: [] }), null)
  assert.equal(unusableReason({ results: [], ownAirportFallback: false }), null)
  assert.match(unusableReason({ results: [], ownAirportFallback: true }) ?? '', /ownAirportFallback/)
  assert.match(unusableReason({ results: [], degraded: true }) ?? '', /degraded=true/)
  assert.match(unusableReason({ results: [], listIncomplete: true }) ?? '', /listIncomplete=true/)
})

test('one failed inventory source makes a response unusable (review of #160: a CMS outage would mark The Parking Point JFK gone)', () => {
  const resLabOnly = { results: [{ name: 'PARK AC' }], directUnavailable: true }
  assert.match(unusableReason(resLabOnly) ?? '', /directUnavailable=true/)
  assert.match(unusableReason({ results: [{ name: 'The Parking Point' }], reslabUnavailable: true }) ?? '', /reslabUnavailable=true/)
  assert.equal(unusableReason({ results: [{ name: 'PARK AC' }], directUnavailable: false, reslabUnavailable: false }), null)
})

test('a price in another currency than the file\'s is refused (CAD lots must never become a USD dailyRate, or the reverse)', () => {
  const cad = { results: [{ name: 'Car Park Pearson', pricing: { minPrice: 14.2, currencyCode: 'CAD' } }] }
  assert.match(unusableReason(cad) ?? '', /CAD, the file in USD/)
  assert.equal(unusableReason(cad, 'CAD'), null)
  assert.match(unusableReason({ results: [{ name: 'X', pricing: { minPrice: 10, currencyCode: 'USD' } }] }, 'CAD') ?? '', /USD, the file in CAD/)
  assert.equal(unusableReason({ results: [{ name: 'No code', pricing: { minPrice: 10 } }] }), null, 'no currencyCode = nothing to compare')
  assert.equal(unusableReason({ results: [{ name: 'Lower', pricing: { minPrice: 10, currencyCode: 'usd' } }] }), null, 'case does not matter')
})

test('--apply refuses any site but production (staging uses a separate ResLab account)', () => {
  assert.equal(nonProductionReason(PRODUCTION_SITE), null)
  assert.match(nonProductionReason('https://triply-abc123.vercel.app') ?? '', /dry run only/)
  assert.match(nonProductionReason('http://localhost:3000') ?? '', /dry run only/)
})

// ── matching: ResLab id first ────────────────────────────────────────────────

const L = (name: string, reslabLocationId?: number): LiveLot => ({ name, reslabLocationId, pricing: { minPrice: 10, numberOfDays: 7 } })

test('refresh-rates matches by ResLab id first, even when the name drifted', () => {
  const m = findMatch({ name: 'Apex EWR Airport Parking', reslabLocationId: 10 }, [L('Apex EWR Airport Parking', 11), L('Apex Airport Parking', 10)])
  assert.equal(m?.live.reslabLocationId, 10)
})

test('a lot whose id is absent from a sample is absent from it: no fallback to name or fuzzy', () => {
  // LAS-shaped: the file's Best Western McCarran Inn must not be stood in for by another listing with a similar name.
  assert.equal(findMatch({ name: 'Best Western McCarran Inn', reslabLocationId: 91 }, [L('Best Western McCarran Inn', 92), L('Best Western', 93)]), null)
  // Without an id the name tiers still apply.
  assert.equal(findMatch({ name: 'Best Western McCarran Inn' }, [L('Best Western McCarran Inn', 92)])?.live.reslabLocationId, 92)
  // A sample that carries no ids at all says nothing about ids: names still match.
  assert.equal(findMatch({ name: 'Hilton', reslabLocationId: 5 }, [L('Hilton')])?.live.name, 'Hilton')
})
