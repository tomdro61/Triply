import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdit, insertUnderHeading, priceCheck, guardLoss, textDiff, parseEdit, checkEdit, previewMismatch, applyWithSettle, sha256, editLive, collectMoneyFigures } from './apply-edit.js'
import type { PostLike } from './apply-edit.js'
import { loadAirportData } from './airport-data.js'
import { figureSource } from './prompts/write.js'

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
  assert.throws(() => parseEdit({}), /needs "fields", "insert" and\/or "replace"/)
  assert.throws(() => parseEdit({ insert: { underHeading: 'Rates', html: 42 } }), /html/)
  assert.throws(() => parseEdit({ fields: { excerpt: 'x'.repeat(301) } }), /excerpt/, 'the CMS limit (300) is checked at preview')
  assert.throws(() => parseEdit({ fields: { seo: { metaDescription: 'x'.repeat(161) } } }), /metaDescription/)
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
  // FAQ: only new or changed items are field text (untouched answers are not re-checked for prices)
  const withFaq = { ...post(), faqItems: [{ question: 'Q1', answer: 'Old $99 answer' }] }
  const faq = applyEdit(withFaq, { fields: { faqItems: [{ question: 'Q1', answer: 'Old $99 answer' }, { question: 'Q2', answer: 'New' }] } })
  assert.equal(faq.fieldText, 'Q2 New')
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

test('checkEdit: a new violation of a rule the old post already breaks still blocks (the new material is linted alone)', () => {
  const old = post()
  old.content.root.children.push(p('Save up to 60% when you book early.'))
  const e = { insert: ins('Shuttle', '<p>You can save up to 70% off with our partners.</p>') }
  const c = checkEdit(old, applyEdit(old, e), e, new Set([1800]))
  assert.ok(c.blockers.some((b) => b.includes('save up to 70%')), c.blockers.join(' | '))
  assert.ok(c.preexisting.some((x) => x.message.includes('60%')))
})

test('collectMoneyFigures: only money, so "Terminal 5" and "2026-11-01" never make $5 or $2026 a known price', () => {
  const data = { lastVerified: '2026-11-01', terminals: [{ name: 'Terminal 5', totalGates: 192 }], parkingRates: 'Garage $24/day, C$12/day', parkingLots: [{ name: 'A', dailyRate: 12.5, reslabLocationId: 422, dailyMax: 40 }], transit: { fare10Trip: 26.5, mtaStateTax: 0.5, chargers: 8, maxHourlySlots: 67 } }
  assert.deepEqual([...new Set(collectMoneyFigures(data))].sort((a, b) => a - b), [0.5, 12, 12.5, 24, 26.5, 40], 'counts (totalGates, chargers, maxHourlySlots) are not prices; fares, taxes and daily maxima are')
  const jfk = loadAirportData('JFK')!
  const known = new Set(collectMoneyFigures(figureSource(jfk, 'jfk parking')).map((n) => Math.round(n * 100)))
  assert.deepEqual(priceCheck('<p>Only $2026, $5 or $10 — but $0.</p>', '', known), ['$2026', '$5', '$10', '$0'].filter((x) => !known.has(Math.round(Number(x.slice(1)) * 100))))
  assert.ok(!known.has(202600), '$2026 is not a known price at JFK ($5 legitimately is: "$5 first hour")')
})

test('editLive compares every field the command can send, including excerpt, FAQ answers and the stamp', () => {
  const live = { ...post(), excerpt: 'old', faqItems: [{ question: 'Q', answer: 'A' }], contentUpdatedAt: '2026-10-01T00:00:00.000Z' }
  assert.equal(editLive(live, { excerpt: 'old' }), true)
  assert.equal(editLive(live, { excerpt: 'new' }), false)
  assert.equal(editLive(live, { faqItems: [{ question: 'Q', answer: 'B' }] }), false)
  assert.equal(editLive(live, { faqItems: [{ question: 'Q', answer: 'A' }] }), true)
  assert.equal(editLive(live, { contentUpdatedAt: '2026-11-02T00:00:00.000Z' }), false)
  assert.equal(editLive(live, { title: 'EWR Parking Rates', content: post().content }), true)
})

test('checkEdit: an error in the OLD title or meta never blocks an edit that leaves them alone', () => {
  const old = { ...post(), title: 'Cheap JFK Parking From 15 a Day', seo: { metaTitle: 'MT', metaDescription: 'Wait, is it cheaper?' } }
  const e = { fields: { excerpt: 'A plain new excerpt about parking.' } }
  const c = checkEdit(old, applyEdit(old, e), e, new Set([1800]))
  assert.deepEqual(c.blockers, [], c.blockers.join(' | '))
  assert.ok(c.preexisting.some((x) => x.rule === 'bare-money'))
  const titleEdit = { fields: { title: 'Cheap JFK Parking From 15 a Day Still' } }
  const ct = checkEdit(old, applyEdit(old, titleEdit), titleEdit, new Set([1800]))
  assert.ok(ct.blockers.some((b) => b.includes('bare-money')), 'a NEW title that repeats the error blocks')
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
  assert.equal(await applyWithSettle('7', patch, { updatePost: async () => ({}), readPost: async () => null, log }), 'applied')
  assert.equal(await applyWithSettle('7', patch, { updatePost: boom, readPost: async () => ({ ...post(), title: 'New' }), log }), 'applied')
  assert.equal(await applyWithSettle('7', patch, { updatePost: boom, readPost: async () => post(), log }), 'not-live')
  assert.equal(await applyWithSettle('7', patch, { updatePost: boom, readPost: async () => { throw new Error('ECONNRESET') }, log }), 'unknown')
  // a refused excerpt-only PATCH is NOT "applied" (perf-apply's editIsLive ignored excerpt)
  assert.equal(await applyWithSettle('7', { excerpt: 'x'.repeat(10) }, { updatePost: boom, readPost: async () => ({ ...post(), excerpt: 'old' }), log }), 'not-live')
})

test('checkEdit: a flat-amount code sources its own $ terms, only where the edit names the code', () => {
  const figs = { DFW5: [5, 25] }
  const named = '<p>Use DFW5 at checkout for $5 off a parking subtotal of $25 or more.</p>'
  const rn = applyEdit(post(), { insert: ins('Shuttle', named) })
  const cn = checkEdit(post(), rn, { insert: ins('Shuttle', named) }, new Set([1800]), undefined, figs)
  assert.ok(!cn.blockers.some((b) => b.startsWith('price check')), cn.blockers.join(' | '))
  const unnamed = '<p>Save $5 on a parking subtotal of $25 or more.</p>'
  const ru = applyEdit(post(), { insert: ins('Shuttle', unnamed) })
  const cu = checkEdit(post(), ru, { insert: ins('Shuttle', unnamed) }, new Set([1800]), undefined, figs)
  assert.ok(cu.blockers.some((b) => b.startsWith('price check: $5')))
  const none = checkEdit(post(), rn, { insert: ins('Shuttle', named) }, new Set([1800]), undefined, {})
  assert.ok(none.blockers.some((b) => b.startsWith('price check: $5')))
})
