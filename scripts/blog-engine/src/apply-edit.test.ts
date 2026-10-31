import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdit, insertUnderHeading, priceCheck, guardLoss, factSentences } from './apply-edit.js'
import type { PostLike } from './apply-edit.js'

const text = (t: string) => ({ type: 'text', text: t, format: 0, detail: 0, mode: 'normal', style: '', version: 1 })
const h = (tag: string, t: string) => ({ type: 'heading', tag, children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1 })
const p = (t: string) => ({ type: 'paragraph', children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1 })
const link = (t: string) => ({ type: 'paragraph', children: [{ type: 'link', fields: { url: '/blog/x', linkType: 'custom', newTab: false }, children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1 }], direction: 'ltr', format: '', indent: 0, version: 1 })

const post = (): PostLike => ({
  id: 7, slug: 'ewr-airport-parking-rates', status: 'published', title: 'EWR Parking Rates', airportCode: 'EWR', updatedAt: 't1',
  content: { root: { type: 'root', children: [p('Intro costs $18/day.'), h('h2', 'Rates'), p('Economy is $18/day.'), h('h3', 'Garages'), p('Garage is $40/day.'), h('h2', 'Shuttle'), link('See shuttle')] } } as PostLike['content'],
})

test('insertUnderHeading appends at the end of the section, after its sub-headings', () => {
  const out = insertUnderHeading(post().content, 'Rates', '<p>New line $18/day.</p>')
  const texts = out.root.children.map((n) => (n.children?.[0] as { text?: string })?.text)
  assert.equal(texts[5], 'New line $18/day.')
  assert.equal(texts[6], 'Shuttle')
})

test('insertUnderHeading throws on a missing heading', () => {
  assert.throws(() => insertUnderHeading(post().content, 'Nope', '<p>x</p>'), /heading not found/)
})

test('applyEdit patches only changed fields and reports the facts diff', () => {
  const r = applyEdit(post(), { fields: { title: 'EWR Parking Rates' }, insert: { underHeading: 'Shuttle', html: '<p>Shuttles run every 10 minutes.</p>' } })
  assert.deepEqual(Object.keys(r.patch), ['content'])
  assert.deepEqual(r.factsDiff.added, ['Shuttles run every 10 minutes.'])
  const none = applyEdit(post(), { insert: { underHeading: 'Shuttle', html: '<p>Ask the driver.</p>' } })
  assert.equal(none.factsDiff.added.length + none.factsDiff.removed.length, 0)
})

test('priceCheck denies figures not in the data file unless linked', () => {
  const data = { onAirportParking: { economy: { dailyMax: 18 } }, parkingLots: [{ name: 'A', dailyRate: 12.5 }] }
  assert.deepEqual(priceCheck('<p>Economy $18/day, Lot A $12.50.</p>', data), [])
  assert.deepEqual(priceCheck('<p>Lot B is $9/day.</p>', data), ['$9'])
  assert.deepEqual(priceCheck('<p>Lot B is $9/day per <a href="https://x.gov">the airport</a>.</p>', data), [])
})

test('guardLoss catches a lost link', () => {
  const before = post().content
  const after = { root: { ...before.root, children: before.root.children.slice(0, -1) } }
  assert.match(guardLoss(before, after) || '', /links 1 → 0/)
  assert.equal(guardLoss(before, before), null)
})

test('factSentences keeps only number-bearing sentences', () => {
  assert.deepEqual([...factSentences('Book early. Economy is $18/day. Ask staff.')], ['Economy is $18/day.'])
})
