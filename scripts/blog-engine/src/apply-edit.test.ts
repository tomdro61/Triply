import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdit, insertUnderHeading, priceCheck, guardLoss, textDiff, parseEdit, checkEdit, previewMismatch, applyWithSettle, sha256 } from './apply-edit.js'
import type { PostLike } from './apply-edit.js'
import { editIsLive } from './perf-apply.js'

const text = (t: string) => ({ type: 'text', text: t, format: 0, detail: 0, mode: 'normal', style: '', version: 1 })
const h = (tag: string, t: string) => ({ type: 'heading', tag, children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1 })
const p = (t: string) => ({ type: 'paragraph', children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1 })
const link = (t: string) => ({ type: 'paragraph', children: [{ type: 'link', fields: { url: '/blog/x', linkType: 'custom', newTab: false }, children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1 }], direction: 'ltr', format: '', indent: 0, version: 1 })

const post = (): PostLike => ({
  id: 7, slug: 'ewr-airport-parking-rates', status: 'published', title: 'EWR Parking Rates', airportCode: 'EWR', updatedAt: 't1',
  seo: { metaTitle: 'MT', metaDescription: 'MD' },
  content: { root: { type: 'root', children: [p('Intro costs $18/day.'), h('h2', 'Rates'), p('Economy is $18/day.'), h('h3', 'Garages'), p('Garage is $40/day.'), h('h2', 'Shuttle'), link('See shuttle')] } } as PostLike['content'],
})
const ins = (underHeading: string, html: string, position: 'start' | 'end' = 'end') => ({ underHeading, html, position })

test('parseEdit is strict: unknown keys, a bad position, an empty FAQ and an empty edit are refused', () => {
  assert.throws(() => parseEdit({ fields: { metaDescription: 'x' } }), /fields: Unrecognized key/)
  assert.throws(() => parseEdit({ insert: { underHeading: 'Rates', html: '<p>x</p>', position: 'after' } }), /position/)
  assert.throws(() => parseEdit({ fields: { faqItems: [] } }), /faqItems/)
  assert.throws(() => parseEdit({}), /needs "fields" and\/or "insert"/)
  assert.throws(() => parseEdit({ insert: { underHeading: 'Rates', html: 42 } }), /html/)
  assert.equal(parseEdit({ insert: { underHeading: 'Rates', html: '<p>x</p>' } }).insert?.position, 'end')
})

test('insertUnderHeading appends at the end of the section, after its sub-headings', () => {
  const out = insertUnderHeading(post().content, 'Rates', '<p>New line $18/day.</p>')
  const texts = out.root.children.map((n) => (n.children?.[0] as { text?: string })?.text)
  assert.equal(texts[5], 'New line $18/day.')
  assert.equal(texts[6], 'Shuttle')
})

test('insertUnderHeading refuses a missing heading, a duplicate heading, and text already under the heading', () => {
  assert.throws(() => insertUnderHeading(post().content, 'Nope', '<p>x</p>'), /heading not found/)
  const twice = post().content
  twice.root.children.push(h('h2', 'Rates'), p('Second rates.'))
  assert.throws(() => insertUnderHeading(twice, 'Rates', '<p>x</p>'), /appears 2 times/)
  assert.throws(() => insertUnderHeading(post().content, 'Rates', '<p>Economy is $18/day.</p>'), /already under "Rates"/)
})

test('applyEdit patches only changed fields; unchanged seo is not patched; facts come from the body and FAQ only', () => {
  const r = applyEdit(post(), { fields: { title: 'EWR Parking Rates', seo: { metaTitle: 'MT' } }, insert: ins('Shuttle', '<p>Shuttles run every 10 minutes.</p>') })
  assert.deepEqual(Object.keys(r.patch), ['content'])
  assert.deepEqual(r.factsDiff.added, ['shuttles run every 10 minutes']) // stamp.ts normalises fact sentences
  const none = applyEdit(post(), { insert: ins('Shuttle', '<p>Ask the driver.</p>') })
  assert.equal(none.factsDiff.changed, false)
  // a title with a number is not a fact (stamp.ts rule) — the date must not move for it
  const titleOnly = applyEdit(post(), { fields: { title: 'EWR Parking Rates 2026' } })
  assert.deepEqual(Object.keys(titleOnly.patch), ['title'])
  assert.equal(titleOnly.factsDiff.changed, false)
  assert.equal(titleOnly.fieldText, 'EWR Parking Rates 2026')
})

test('priceCheck: only the writer figures pass; an external link exempts its paragraph, a Triply link does not; both ends of a range; field text has no exemption', () => {
  const known = new Set([1800, 1250])
  assert.deepEqual(priceCheck('<p>Economy $18/day, Lot A $12.50.</p>', '', known), [])
  assert.deepEqual(priceCheck('<p>Lot B is $9/day.</p>', '', known), ['$9'])
  assert.deepEqual(priceCheck('<p>Lot B is $9/day per <a href="https://www.panynj.gov/x">the airport</a>.</p>', '', known), [])
  assert.deepEqual(priceCheck('<p>Lot B is $9/day, <a href="/blog/ewr-x">see more</a>.</p>', '', known), ['$9'])
  assert.deepEqual(priceCheck('<p>Lot B is $9/day, <a href="https://www.triplypro.com/search?airport=EWR">book</a>.</p>', '', known), ['$9'])
  assert.deepEqual(priceCheck('<p>Rates run $18–77/day.</p>', '', known), ['$77'])
  assert.deepEqual(priceCheck('', 'From $9/day near EWR', known), ['$9'])
})

test('checkEdit: a lint error already in the live post is reported, not blocking; a new one blocks; a lost link blocks', () => {
  const dirty = post()
  dirty.content.root.children.push(p('Code TRIPLY10 is verified for 2026.')) // pre-existing lint error (verified-code)
  const r = applyEdit(dirty, { insert: ins('Shuttle', '<p>Shuttles run every 10 minutes.</p>') })
  const c = checkEdit(dirty, r, { insert: ins('Shuttle', '<p>Shuttles run every 10 minutes.</p>') }, new Set([1800]))
  assert.deepEqual(c.blockers, [])
  assert.ok(c.preexisting.some((e) => e.rule === 'verified-code'))
  const bad = applyEdit(post(), { insert: ins('Shuttle', '<p>Lot B is $9/day.</p>') })
  const cb = checkEdit(post(), bad, { insert: ins('Shuttle', '<p>Lot B is $9/day.</p>') }, new Set([1800]))
  assert.ok(cb.blockers.some((b) => b.startsWith('price check: $9')))
  const noData = checkEdit(post(), bad, { insert: ins('Shuttle', '<p>Lot B is $9/day.</p>') }, null)
  assert.ok(noData.blockers.some((b) => b.includes("prices can't be checked")))
})

test('guardLoss catches a lost link', () => {
  const before = post().content
  const after = { root: { ...before.root, children: before.root.children.slice(0, -1) } }
  assert.match(guardLoss(before, after) || '', /links 1 → 0/)
  assert.equal(guardLoss(before, before), null)
})

test('textDiff counts occurrences, so a repeated line shows as added', () => {
  assert.equal(textDiff('a\nb', 'a\nb\nb'), '+ b')
  assert.equal(textDiff('a\nb', 'a'), '- b')
})

test('previewMismatch binds --apply to the same post, unchanged, same edit file, same patch', () => {
  const now = { slug: 's', id: 7, updatedAt: 't1', editHash: sha256('e'), patchHash: sha256('p'), at: 'x' }
  assert.equal(previewMismatch(now, now), '')
  assert.match(previewMismatch(null, now), /run --preview first/)
  assert.match(previewMismatch({ ...now, id: 8 }, now), /not s \(#7\)/)
  assert.match(previewMismatch({ ...now, updatedAt: 't0' }, now), /changed since the preview/)
  assert.match(previewMismatch({ ...now, editHash: sha256('other') }, now), /edit.json changed/)
  assert.match(previewMismatch({ ...now, patchHash: sha256('other') }, now), /different patch/)
})

test('applyWithSettle: a thrown PATCH is settled by re-reading — live = applied, absent = not-live, unreadable = unknown', async () => {
  const patch = { title: 'New' }
  const log = () => {}
  const boom = async () => { throw new Error('Payload API error 502') }
  assert.equal(await applyWithSettle('7', patch, { updatePost: async () => ({}), readPost: async () => null, editIsLive, log }), 'applied')
  assert.equal(await applyWithSettle('7', patch, { updatePost: boom, readPost: async () => ({ ...post(), title: 'New' }), editIsLive, log }), 'applied')
  assert.equal(await applyWithSettle('7', patch, { updatePost: boom, readPost: async () => post(), editIsLive, log }), 'not-live')
  assert.equal(await applyWithSettle('7', patch, { updatePost: boom, readPost: async () => { throw new Error('ECONNRESET') }, editIsLive, log }), 'unknown')
})
