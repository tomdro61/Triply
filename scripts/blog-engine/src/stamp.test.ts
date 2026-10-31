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

// ── Review of #141: the fact-change half of the gate ──
import { factsDiff, factSentences, lexicalText } from './stamp.js'

test('env no longer turns stamping on; only --stamp does', () => {
  process.env.STAMP_CONTENT_UPDATED = '1'
  assert.equal(stampRequested(['node', 'x']), false)
  delete process.env.STAMP_CONTENT_UPDATED
})
test('factsDiff: identical bodies change no facts; a changed price does; a link swap does not', () => {
  const a = '<p>Economy costs $18/day as of October 2026.</p><p>Shuttles run every 10 minutes.</p><p>Book on <a href="/x">Triply</a>.</p>'
  assert.equal(factsDiff(a, a).changed, false)
  const b = a.replace('$18/day', '$20/day')
  const d = factsDiff(a, b)
  assert.equal(d.changed, true)
  assert.deepEqual(d.added, ['economy costs $20/day as of october 2026.'])
  assert.equal(factsDiff(a, a.replace('href="/x"', 'href="/y"')).changed, false)
  assert.equal(factsDiff(a, a.replace('every 10 minutes', 'every  10 minutes')).changed, false)
})
test('factSentences keeps only sentences with a figure', () => {
  assert.deepEqual(factSentences('<p>Welcome to Logan.</p><p>Parking is $46/day.</p>'), ['parking is $46/day.'])
})
test('lexicalText flattens a Lexical document and ends blocks as sentences', () => {
  const doc = { root: { type: 'root', children: [
    { type: 'heading', children: [{ type: 'text', text: 'Rates' }] },
    { type: 'paragraph', children: [{ type: 'text', text: 'Economy costs ' }, { type: 'text', text: '$18/day', format: 1 }] },
    { type: 'table', children: [{ type: 'tablerow', children: [{ type: 'tablecell', children: [{ type: 'text', text: 'Garage $46' }] }] }] },
  ] } }
  const text = lexicalText(doc)
  assert.ok(text.includes('Economy costs $18/day.'), text)
  assert.ok(text.includes('Garage $46.'), text)
  assert.deepEqual(factSentences(text), ['economy costs $18/day.', 'garage $46.'])
})
