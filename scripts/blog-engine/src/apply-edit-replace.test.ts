import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdit, applyReplace, parseEdit, checkEdit, guardLoss, removedNodes, replaceDiff, previewMismatch, sha256, blockText } from './apply-edit.js'
import type { PostLike, EditSpec } from './apply-edit.js'

// replace mode (Nov 2026): section / remove / text operations on an existing post.
const text = (t: string) => ({ type: 'text', text: t, format: 0, detail: 0, mode: 'normal', style: '', version: 1 })
const h = (tag: string, t: string) => ({ type: 'heading', tag, children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1 })
const p = (t: string) => ({ type: 'paragraph', children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1 })
const a = (url: string, t: string) => ({ type: 'link', fields: { url, linkType: 'custom', newTab: false }, children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1 })
const pl = (before: string, url: string, t: string) => ({ type: 'paragraph', children: [text(before), a(url, t)], direction: 'ltr', format: '', indent: 0, version: 1 })
const li = (t: string, value: number) => ({ type: 'listitem', value, checked: false, children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1 })
const ul = (...items: string[]) => ({ type: 'list', listType: 'bullet', tag: 'ul', start: 1, children: items.map((t, i) => li(t, i + 1)), direction: 'ltr', format: '', indent: 0, version: 1 })
const img = (id: number) => ({ type: 'upload', relationTo: 'media', value: id, version: 2 })
const cell = (t: string) => ({ type: 'tablecell', headerState: 0, children: [p(t)], direction: 'ltr', format: '', indent: 0, version: 1 })
const table = (...rows: string[][]) => ({ type: 'table', children: rows.map((r) => ({ type: 'tablerow', children: r.map(cell), direction: 'ltr', format: '', indent: 0, version: 1 })), direction: 'ltr', format: '', indent: 0, version: 1 })

const post = (): PostLike => ({
  id: 9, slug: 'iad-airport-parking-rates', status: 'published', title: 'IAD Parking Rates', airportCode: 'IAD', updatedAt: 't1',
  content: { root: { type: 'root', children: [
    p('Dulles parking starts at $20/day.'),
    h('h2', 'Off-site lots'),
    pl('Old Lot X is $26/day, ', '/blog/old-lot-x', 'read the review'),
    table(['Lot', 'Rate'], ['Old Lot X', '$26/day']),
    img(42),
    h('h3', 'Shuttles'),
    p('Shuttles run every 30 minutes.'),
    h('h2', 'Tips'),
    ul('Book early.', 'Old Lot X costs $26/day.', 'Use the Economy Lot.'),
    pl('See ', '/blog/iad-economy', 'the Economy Lot guide'),
    h('h2', 'Summary'),
    p('Economy is $20/day.'),
  ] } } as PostLike['content'],
})
const texts = (pst: PostLike) => pst.content.root.children.map((n) => blockText(n as Parameters<typeof blockText>[0]))
const known = new Set([2000, 1500, 2500])

test('parseEdit accepts the three replace shapes and refuses anything else', () => {
  const e = parseEdit({ replace: [{ section: 'Tips', html: '<p>x</p>', heading: 'New tips' }, { remove: 'Summary' }, { text: 'Book early.', html: '' }] })
  assert.equal(e.replace?.length, 3)
  assert.throws(() => parseEdit({ replace: [] }), /replace/)
  assert.throws(() => parseEdit({ replace: [{ section: 'Tips' }] }), /replace/, 'a section needs html')
  assert.throws(() => parseEdit({ replace: [{ section: 'Tips', html: '' }] }), /replace/, 'an empty section is a remove')
  assert.throws(() => parseEdit({ replace: [{ remove: 'Tips', html: '<p>x</p>' }] }), /replace/, 'unknown key on remove')
  assert.throws(() => parseEdit({ replace: [{ text: 'x', html: '', extra: 1 }] }), /replace/)
})

test('section replace swaps everything up to the next same-or-higher heading (sub-headings included) and keeps the heading', () => {
  const r = applyEdit(post(), { replace: [{ section: 'Off-site lots', html: '<p>Hyatt Regency is about $15/day.</p>' }] })
  assert.deepEqual(texts(r.after).slice(0, 4), ['Dulles parking starts at $20/day.', 'Off-site lots', 'Hyatt Regency is about $15/day.', 'Tips'])
  assert.equal(r.replaced.length, 1)
  assert.equal(r.replaced[0].removed.length, 5, 'paragraph, table, image, h3 and its paragraph')
  // untouched nodes keep their stored object (no HTML round trip)
  const orig = post()
  const r2 = applyReplace(orig.content, [{ section: 'Off-site lots', html: '<p>New.</p>' }])
  assert.equal(r2.content.root.children[0], orig.content.root.children[0], 'same object, not a copy')
  assert.equal(r2.content.root.children.at(-1), orig.content.root.children.at(-1))
})

test('section replace can rename the heading, keeps its level, and refuses html that would split the section', () => {
  const r = applyEdit(post(), { replace: [{ section: 'Tips', html: '<p>Book early.</p>', heading: 'Money-saving tips' }] })
  const kids = r.after.content.root.children
  const at = kids.findIndex((n) => n.type === 'heading' && blockText(n as Parameters<typeof blockText>[0]) === 'Money-saving tips')
  assert.ok(at > 0)
  assert.equal(kids[at].tag, 'h2')
  assert.throws(() => applyEdit(post(), { replace: [{ section: 'Tips', html: '<h2>Other</h2><p>x</p>' }] }), /would split the section/)
  assert.doesNotThrow(() => applyEdit(post(), { replace: [{ section: 'Tips', html: '<h3>Sub</h3><p>x</p>' }] }))
})

test('remove drops the heading and its whole section', () => {
  const r = applyEdit(post(), { replace: [{ remove: 'Off-site lots' }] })
  assert.deepEqual(texts(r.after).slice(0, 2), ['Dulles parking starts at $20/day.', 'Tips'])
  assert.ok(!texts(r.after).some((t) => t.includes('Shuttles')), 'the h3 sub-section goes with it')
})

test('text replace swaps one paragraph, deletes a list item, and replaces a whole table', () => {
  const para = applyEdit(post(), { replace: [{ text: 'Economy is $20/day.', html: '<p>Economy is $20/day at the drive-up rate.</p>' }] })
  assert.equal(texts(para.after).at(-1), 'Economy is $20/day at the drive-up rate.')
  // whitespace and case are ignored
  assert.doesNotThrow(() => applyEdit(post(), { replace: [{ text: '  economy IS   $20/day. ', html: '<p>x</p>' }] }))
  const item = applyEdit(post(), { replace: [{ text: 'Old Lot X costs $26/day.', html: '' }] })
  const list = item.after.content.root.children.find((n) => n.type === 'list')!
  assert.deepEqual(list.children!.map((x) => [blockText(x as Parameters<typeof blockText>[0]), x.value]), [['Book early.', 1], ['Use the Economy Lot.', 2]], 'renumbered')
  const itemNew = applyEdit(post(), { replace: [{ text: 'Old Lot X costs $26/day.', html: 'Hyatt Regency costs about $15/day.' }] })
  const list2 = itemNew.after.content.root.children.find((n) => n.type === 'list')!
  assert.equal(blockText(list2.children![1] as Parameters<typeof blockText>[0]), 'Hyatt Regency costs about $15/day.')
  assert.equal(list2.children![1].type, 'listitem')
  const tbl = applyEdit(post(), { replace: [{ text: 'Lot Rate Old Lot X $26/day', html: '' }] })
  assert.ok(!tbl.after.content.root.children.some((n) => n.type === 'table'))
})

test('missing and non-unique matches are refused, with the nearest candidates named', () => {
  assert.throws(() => applyEdit(post(), { replace: [{ section: 'Off site lots', html: '<p>x</p>' }] }), (e: Error) => /heading not found: "Off site lots"/.test(e.message) && /nearest: "Off-site lots"/.test(e.message))
  assert.throws(() => applyEdit(post(), { replace: [{ remove: 'Nope' }] }), /heading not found/)
  const twice = post()
  twice.content.root.children.push(h('h2', 'Tips'), p('More tips.'))
  assert.throws(() => applyEdit(twice, { replace: [{ remove: 'Tips' }] }), /appears 2 times/)
  assert.throws(() => applyEdit(post(), { replace: [{ text: 'Old Lot X is $26/day', html: '' }] }), (e: Error) => /no block has exactly this text/.test(e.message) && /nearest: "Old Lot X is \$26\/day, read the review"/.test(e.message))
  const dup = post()
  dup.content.root.children.push(p('Economy is $20/day.'))
  assert.throws(() => applyEdit(dup, { replace: [{ text: 'Economy is $20/day.', html: '' }] }), /2 blocks have exactly this text/)
  // a later op may not target content an earlier op wrote
  assert.throws(() => applyEdit(post(), { replace: [{ section: 'Summary', html: '<p>Fresh line.</p>' }, { text: 'Fresh line.', html: '' }] }), /earlier operation/)
})

test('guard: links and images inside removed content may go — only those; any other loss still fails', () => {
  const before = post()
  const r = applyEdit(before, { replace: [{ section: 'Off-site lots', html: '<p>Hyatt Regency is about $15/day.</p>' }] })
  assert.equal(guardLoss(before.content, r.after.content, removedNodes(r.replaced)), null, 'the removed /blog/old-lot-x link and image 42 are allowed')
  assert.match(guardLoss(before.content, r.after.content) || '', /lost: \/blog\/old-lot-x/, 'without the allowance it is a loss')
  // a loss OUTSIDE the removed content still fails, even when the edit adds a different link
  const tampered = JSON.parse(JSON.stringify(r.after.content))
  tampered.root.children = tampered.root.children.filter((n: { children?: { fields?: { url?: string } }[] }) => !n.children?.some((c) => c.fields?.url === '/blog/iad-economy'))
  tampered.root.children.push(pl('New ', '/blog/new', 'link'))
  assert.match(guardLoss(before.content, tampered, removedNodes(r.replaced)) || '', /beyond the removed content \(lost: \/blog\/iad-economy\)/)
  // checkEdit lists the removed refs so a human sees them, and does not block
  const c = checkEdit(before, r, { replace: [{ section: 'Off-site lots', html: '<p>Hyatt Regency is about $15/day.</p>' }] }, known)
  assert.deepEqual(c.blockers, [], c.blockers.join(' | '))
  assert.deepEqual(c.removedRefs.map((x) => x.split('  ')[0]), ['link /blog/old-lot-x', 'image 42'])
  // a link the new html puts back is not reported as removed
  const keep = { replace: [{ text: 'Old Lot X is $26/day, read the review', html: '<p>Lot X closed, <a href="/blog/old-lot-x">read the review</a>.</p>' }] }
  const ck = checkEdit(before, applyEdit(before, keep), keep, known)
  assert.deepEqual(ck.removedRefs, [])
})

test('price check: new html is checked (blocking); stale figures left in the resulting body are reported', () => {
  const ok: EditSpec = { replace: [{ text: 'Old Lot X costs $26/day.', html: 'Hyatt Regency costs about $15/day.' }] }
  const c = checkEdit(post(), applyEdit(post(), ok), ok, known)
  assert.deepEqual(c.blockers, [], c.blockers.join(' | '))
  assert.deepEqual(c.remainingPrices, ['$26'], 'the $26 in the paragraph and table the edit did not touch is still caught')
  const bad: EditSpec = { replace: [{ text: 'Old Lot X costs $26/day.', html: 'Lot Y costs $9/day.' }] }
  const cb = checkEdit(post(), applyEdit(post(), bad), bad, known)
  assert.ok(cb.blockers.some((b) => b.startsWith('price check: $9')), cb.blockers.join(' | '))
  // removing every stale block leaves nothing to report
  const clean: EditSpec = { replace: [{ remove: 'Off-site lots' }, { text: 'Old Lot X costs $26/day.', html: '' }] }
  assert.deepEqual(checkEdit(post(), applyEdit(post(), clean), clean, known).remainingPrices, [])
  // a renamed heading is new material too
  const head: EditSpec = { replace: [{ section: 'Tips', html: '<p>Book early.</p>', heading: 'Tips from $9/day' }] }
  assert.ok(checkEdit(post(), applyEdit(post(), head), head, known).blockers.some((b) => b.includes('$9')))
})

test('facts diff and the text diff show what a replace removed', () => {
  const r = applyEdit(post(), { replace: [{ text: 'Old Lot X costs $26/day.', html: '' }] })
  assert.deepEqual(r.factsDiff.removed, ['old lot x costs $26/day'])
  assert.equal(r.factsDiff.changed, true)
  const d = replaceDiff(r.replaced)
  assert.match(d, /=== replace\[0\] delete list item "Old Lot X costs \$26\/day\."/)
  assert.match(d, /- REMOVED  Old Lot X costs \$26\/day\./)
  const s = applyEdit(post(), { replace: [{ section: 'Off-site lots', html: '<p>New.</p>' }] })
  assert.match(replaceDiff(s.replaced), /✂ removes link \/blog\/old-lot-x/)
  assert.match(replaceDiff(s.replaced), /\+ ADDED    New\./)
})

test('hash binding: a changed replace edit refuses --apply; the same edit gives the same patch', () => {
  const e1 = JSON.stringify({ replace: [{ text: 'Old Lot X costs $26/day.', html: '' }] })
  const e2 = JSON.stringify({ replace: [{ text: 'Old Lot X costs $26/day.', html: 'Hyatt Regency costs about $15/day.' }] })
  const meta = (raw: string) => ({ slug: 's', id: 9, updatedAt: 't1', editHash: sha256(raw), patchHash: sha256(JSON.stringify(applyEdit(post(), parseEdit(JSON.parse(raw))).patch)), at: 'x' })
  assert.equal(previewMismatch(meta(e1), meta(e1)), '', 'deterministic: same edit, same post → same patch hash')
  assert.match(previewMismatch(meta(e1), meta(e2)), /edit.json changed/)
  assert.match(previewMismatch({ ...meta(e1), patchHash: sha256('x') }, meta(e1)), /different patch/)
})

test('replace runs before insert; both together produce one content patch', () => {
  const r = applyEdit(post(), { replace: [{ remove: 'Off-site lots' }], insert: { underHeading: 'Summary', html: '<p>Shuttles run 24/7.</p>', position: 'end' } })
  assert.deepEqual(Object.keys(r.patch), ['content'])
  assert.equal(texts(r.after).at(-1), 'Shuttles run 24/7.')
  assert.ok(!texts(r.after).includes('Off-site lots'))
})
