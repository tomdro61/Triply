import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stampField, stampRequested } from './stamp.js'

test('no flag: no stamp', () => { assert.deepEqual(stampField({ factsChanged: true, reason: 'prices', requested: false, quiet: true }), {}) })
test('flag but no fact change: no stamp', () => { assert.deepEqual(stampField({ factsChanged: false, reason: 'links', requested: true, quiet: true }), {}) })
test('flag and facts changed: ISO stamp', () => {
  const now = new Date('2026-10-30T00:00:00Z')
  assert.deepEqual(stampField({ factsChanged: true, reason: 'rates', requested: true, now, quiet: true }), { contentUpdatedAt: now.toISOString() })
})
test('stampRequested reads --stamp', () => { assert.equal(stampRequested(['node', 'x']), false); assert.equal(stampRequested(['node', 'x', '--stamp']), true) })
