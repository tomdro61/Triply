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
import { coverageDecision } from './refresh-rates.js'

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
