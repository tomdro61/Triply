import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdit, applyReplace, parseEdit, checkEdit, guardLoss, removedNodes, replaceDiff, previewMismatch, sha256, blockText, applyWithSettle, editLive, refsNotRemoved, mediaRefs, isTablePatternList, priceCheck, lotNamesFor, isBookingUrl } from './apply-edit.js'
import type { PostLike, EditSpec } from './apply-edit.js'
import { buildCta, makeCtaParagraph } from './booking-links.js'

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
  const sub = applyEdit(post(), { replace: [{ section: 'Tips', html: '<h3>Sub</h3><p>x</p>' }] })
  const subKids = sub.after.content.root.children
  const tipsAt = subKids.findIndex((n) => blockText(n as Parameters<typeof blockText>[0]) === 'Tips')
  assert.deepEqual(subKids.slice(tipsAt, tipsAt + 4).map((n) => [n.type, n.tag ?? '', blockText(n as Parameters<typeof blockText>[0])]),
    [['heading', 'h2', 'Tips'], ['heading', 'h3', 'Sub'], ['paragraph', '', 'x'], ['heading', 'h2', 'Summary']], 'a lower-level sub-heading stays inside the section')
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
  const loose = applyEdit(post(), { replace: [{ text: '  economy IS   $20/day. ', html: '<p>x</p>' }] })
  assert.equal(texts(loose.after).at(-1), 'x')
  assert.equal(texts(loose.after).length, texts(post()).length)
  const item = applyEdit(post(), { replace: [{ text: 'Old Lot X costs $26/day.', html: '' }] })
  const list = item.after.content.root.children.find((n) => n.type === 'list')!
  assert.deepEqual(list.children!.map((x) => [blockText(x as Parameters<typeof blockText>[0]), x.value]), [['Book early.', 1], ['Use the Economy Lot.', 2]], 'renumbered')
  const itemNew = applyEdit(post(), { replace: [{ text: 'Old Lot X costs $26/day.', html: 'Hyatt Regency costs about $15/day.' }] })
  const list2 = itemNew.after.content.root.children.find((n) => n.type === 'list')!
  assert.equal(blockText(list2.children![1] as Parameters<typeof blockText>[0]), 'Hyatt Regency costs about $15/day.')
  assert.equal(list2.children![1].type, 'listitem')
  const tbl = applyEdit(post(), { replace: [{ text: 'Lot Rate Old Lot X $26/day', html: '' }] })
  assert.ok(!tbl.after.content.root.children.some((n) => n.type === 'table'))
  assert.deepEqual(tbl.after.content.root.children.slice(1, 4).map((n) => n.type), ['heading', 'paragraph', 'upload'], 'only the table goes; its neighbours stay')
  assert.equal(tbl.replaced[0].removed.length, 1)
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

// ── Review round (Nov 2026): regressions + behaviour locked in ──────────────
const doc = (...children: unknown[]): PostLike => ({ id: 1, slug: 'x-airport-parking', status: 'published', title: 'X', airportCode: 'IAD', updatedAt: 't', content: { root: { type: 'root', children } } as PostLike['content'] })
const kidsOf = (pst: PostLike) => pst.content.root.children.map((n) => `${n.type === 'heading' ? `${n.tag}:` : ''}${blockText(n as Parameters<typeof blockText>[0])}`)

test('fix 1: a list item an earlier op wrote is protected even after renumbering copies it', () => {
  const three = () => doc(h('h2', 'L'), ul('one', 'two', 'three'))
  assert.throws(() => applyEdit(three(), { replace: [{ text: 'two', html: 'NEW' }, { text: 'NEW', html: 'NEWER' }] }), /earlier operation/)
  const ab = () => doc(h('h2', 'L'), ul('A one.', 'B two.', 'C three.'))
  assert.throws(() => applyEdit(ab(), { replace: [{ text: 'B two.', html: '<li>New item.</li>' }, { text: 'New item.', html: '' }] }), /earlier operation/)
  // the step records the node actually in the tree (renumbered)
  const r = applyEdit(ab(), { replace: [{ text: 'B two.', html: '<li>New item.</li>' }] })
  const list = r.after.content.root.children[1]
  assert.equal(r.replaced[0].added[0], list.children![1], 'added = the node in the tree, not the pre-copy object')
  assert.equal(list.children![1].value, 2)
  // a whole-list text op after an item edit in that list is refused too
  assert.throws(() => applyEdit(ab(), { replace: [{ text: 'B two.', html: 'Bee.' }, { text: 'A one. Bee. C three.', html: '' }] }), /earlier operation/)
})

test('fix 2: an untouched old lint error in another block is pre-existing, not new; a genuinely new one blocks', () => {
  const base = () => doc(h('h2', 'Deals'), p('Book ahead and save up to 60% on parking.'), h('h2', 'More'), p('Members save up to 70% at some lots.'))
  const fixA: EditSpec = { replace: [{ text: 'Book ahead and save up to 60% on parking.', html: '<p>Book ahead for the lowest rates.</p>' }] }
  const c = checkEdit(base(), applyEdit(base(), fixA), fixA, known)
  assert.deepEqual(c.blockers, [], c.blockers.join(' | '))
  assert.ok(c.preexisting.some((e) => e.message.includes('70%')), 'the old 70% claim is reported as pre-existing')
  const worse: EditSpec = { replace: [{ text: 'Book ahead and save up to 60% on parking.', html: '<p>Book ahead and save up to 80% on parking.</p>' }] }
  const cw = checkEdit(base(), applyEdit(base(), worse), worse, known)
  assert.ok(cw.blockers.some((b) => b.includes('80%')), cw.blockers.join(' | '))
})

test('fix 3: a case-only heading rename is applied (matching stays case-insensitive)', () => {
  const r = applyEdit(doc(h('h2', 'parking rates'), p('Old.')), { replace: [{ section: 'PARKING RATES', html: '<p>New.</p>', heading: 'Parking Rates' }] })
  assert.deepEqual(kidsOf(r.after), ['h2:Parking Rates', 'New.'])
  assert.match(r.replaced[0].label, /renamed "Parking Rates"/)
  // only the case changes, content identical: still a real change
  const only = applyEdit(doc(h('h2', 'parking rates'), p('Old.')), { replace: [{ section: 'parking rates', html: '<p>Old.</p>', heading: 'Parking Rates' }] })
  assert.deepEqual(kidsOf(only.after), ['h2:Parking Rates', 'Old.'])
})

test('overlapping ops: a later op may not reach into or around what an earlier op changed', () => {
  assert.throws(() => applyEdit(post(), { replace: [{ text: 'Shuttles run every 30 minutes.', html: '<p>Shuttles run hourly.</p>' }, { remove: 'Shuttles' }] }), /holds content written by an earlier operation/)
  assert.throws(() => applyEdit(post(), { replace: [{ remove: 'Shuttles' }, { text: 'Shuttles run every 30 minutes.', html: '' }] }), /no block has exactly this text/)
  assert.throws(() => applyEdit(post(), { replace: [{ section: 'Off-site lots', html: '<p>x</p>' }, { remove: 'Shuttles' }] }), /heading not found/)
})

test('op order: a target made unique by op 1 is found by op 2', () => {
  const dup = post()
  dup.content.root.children.push(p('Book early.'))
  assert.throws(() => applyEdit(dup, { replace: [{ text: 'Book early.', html: '' }] }), /2 blocks have exactly this text/)
  const r = applyEdit(dup, { replace: [{ remove: 'Tips' }, { text: 'Book early.', html: '' }] })
  assert.ok(!texts(r.after).includes('Book early.'))
  assert.equal(texts(r.after).at(-1), 'Economy is $20/day.')
})

test('nested headings: section stops at the next same-level heading; h4 inside ok; h3 inside an h3 refused; remove h3 keeps siblings', () => {
  const nest = () => doc(h('h2', 'A'), p('a'), h('h3', 'B'), p('b'), h('h4', 'C'), p('c'), h('h3', 'D'), p('d'), h('h2', 'E'), p('e'))
  assert.deepEqual(kidsOf(applyEdit(nest(), { replace: [{ section: 'A', html: '<p>new</p>' }] }).after), ['h2:A', 'new', 'h2:E', 'e'])
  assert.deepEqual(kidsOf(applyEdit(nest(), { replace: [{ section: 'B', html: '<h4>C2</h4><p>c2</p>' }] }).after), ['h2:A', 'a', 'h3:B', 'h4:C2', 'c2', 'h3:D', 'd', 'h2:E', 'e'])
  assert.throws(() => applyEdit(nest(), { replace: [{ section: 'B', html: '<h3>X</h3><p>x</p>' }] }), /would split/)
  assert.deepEqual(kidsOf(applyEdit(nest(), { replace: [{ remove: 'B' }] }).after), ['h2:A', 'a', 'h3:D', 'd', 'h2:E', 'e'])
})

test('a heading at the end of the document: empty section can be filled, last section removed', () => {
  const end = () => doc(h('h2', 'A'), p('a'), h('h2', 'End'))
  assert.deepEqual(kidsOf(applyEdit(end(), { replace: [{ section: 'End', html: '<p>filled</p>' }] }).after), ['h2:A', 'a', 'h2:End', 'filled'])
  assert.deepEqual(kidsOf(applyEdit(end(), { replace: [{ remove: 'End' }] }).after), ['h2:A', 'a'])
  assert.equal(texts(applyEdit(post(), { replace: [{ remove: 'Summary' }] }).after).at(-1), 'See the Economy Lot guide')
})

test('whitespace-only html: a text op deletes the block, a section op is refused', () => {
  const r = applyEdit(post(), { replace: [{ text: 'Economy is $20/day.', html: '   ' }] })
  assert.equal(texts(r.after).at(-1), 'Summary')
  assert.match(r.replaced[0].label, /delete paragraph/)
  assert.throws(() => applyEdit(post(), { replace: [{ section: 'Summary', html: '  \n ' }] }), /converts to nothing/)
})

test('a table cell is not a block of its own; a one-item list counts once', () => {
  assert.throws(() => applyEdit(post(), { replace: [{ text: 'Old Lot X', html: '' }] }), /no block has exactly this text/)
  const one = applyEdit(doc(h('h2', 'L'), ul('Only item.')), { replace: [{ text: 'Only item.', html: '<p>Para.</p>' }] })
  assert.deepEqual(kidsOf(one.after), ['h2:L', 'Para.'])
  assert.match(one.replaced[0].label, /replace list/)
})

test('guard counts links per occurrence', () => {
  const before = doc(h('h2', 'A'), pl('First ', '/blog/x', 'x'), pl('Second ', '/blog/x', 'x'))
  const r = applyEdit(before, { replace: [{ text: 'First x', html: '' }] })
  assert.equal(guardLoss(before.content, r.after.content, removedNodes(r.replaced)), null, 'one of two copies removed on purpose')
  const tampered = JSON.parse(JSON.stringify(r.after.content))
  tampered.root.children = tampered.root.children.slice(0, 1)
  assert.match(guardLoss(before.content, tampered, removedNodes(r.replaced)) || '', /lost: \/blog\/x/)
})

test('a section op that changes nothing is refused', () => {
  assert.throws(() => applyEdit(post(), { replace: [{ section: 'Summary', html: '<p>Economy is $20/day.</p>' }] }), /already has exactly this content/)
})

test('a renamed heading is written as text, not html', () => {
  const r = applyEdit(post(), { replace: [{ section: 'Tips', html: '<p>x</p>', heading: 'A & B <x>' }] })
  assert.ok(kidsOf(r.after).includes('h2:A & B <x>'), kidsOf(r.after).join(' | '))
})

test('insert-only edit: remainingPrices still lists stale figures in the resulting body (intended)', () => {
  const ins: EditSpec = { insert: { underHeading: 'Summary', html: '<p>Shuttles run 24/7.</p>', position: 'end' } }
  const c = checkEdit(post(), applyEdit(post(), ins), ins, known)
  assert.deepEqual(c.blockers, [], c.blockers.join(' | '))
  assert.deepEqual(c.remainingPrices, ['$26'])
})

// ── Review round 2 (Nov 2026): one test per fix, each fails with its fix removed ──
const CTA = buildCta('IAD')!
const withCta = () => doc(h('h2', 'A'), p('a'), h('h2', 'Last'), p('last'), makeCtaParagraph(CTA))

test('R1: the booking CTA after the last heading is not part of that section (remove, section, insert)', () => {
  assert.deepEqual(kidsOf(applyEdit(withCta(), { replace: [{ remove: 'Last' }] }).after), ['h2:A', 'a', CTA.fullText])
  assert.deepEqual(kidsOf(applyEdit(withCta(), { replace: [{ section: 'Last', html: '<p>new</p>' }] }).after), ['h2:A', 'a', 'h2:Last', 'new', CTA.fullText])
  assert.deepEqual(kidsOf(applyEdit(withCta(), { insert: { underHeading: 'Last', html: '<p>more</p>', position: 'end' } }).after), ['h2:A', 'a', 'h2:Last', 'last', 'more', CTA.fullText])
  // a last heading with nothing but the CTA under it: an empty section, filled above the CTA
  const bare = () => doc(h('h2', 'A'), p('a'), h('h2', 'End'), makeCtaParagraph(CTA))
  assert.deepEqual(kidsOf(applyEdit(bare(), { replace: [{ section: 'End', html: '<p>filled</p>' }] }).after), ['h2:A', 'a', 'h2:End', 'filled', CTA.fullText])
  const rm: EditSpec = { replace: [{ remove: 'Last' }] }
  const c = checkEdit(withCta(), applyEdit(withCta(), rm), rm, known)
  assert.deepEqual(c.blockers, [], c.blockers.join(' | '))
  assert.equal(c.bookingLinkRemoved, false)
})

test('R1 backstop: an edit that leaves no booking-page link is refused unless edit.json allows it', () => {
  const del = parseEdit({ replace: [{ text: CTA.fullText, html: '' }] })
  const c = checkEdit(withCta(), applyEdit(withCta(), del), del, known)
  assert.ok(c.blockers.some((b) => b.includes('would remove the link to the booking page (/washington-iad/airport-parking)')), c.blockers.join(' | '))
  const meant = parseEdit({ replace: [{ text: CTA.fullText, html: '' }], allowBookingLinkRemoval: true })
  const cm = checkEdit(withCta(), applyEdit(withCta(), meant), meant, known)
  assert.deepEqual(cm.blockers, [], cm.blockers.join(' | '))
  assert.equal(cm.bookingLinkRemoved, true, 'reported, so the preview says so')
  // the opt-in is strict like every other key, and is no edit on its own
  assert.throws(() => parseEdit({ allowBookingLinkRemoval: true }), /needs "fields", "insert" and\/or "replace"/)
  assert.throws(() => parseEdit({ replace: [{ remove: 'A' }], allowBookingLink: true }), /Unrecognized key/)
  // a post that never linked the booking page has nothing to protect
  const none: EditSpec = { replace: [{ remove: 'Summary' }] }
  assert.deepEqual(checkEdit(post(), applyEdit(post(), none), none, known).blockers, [])
})

test('R2: a rival code in new html blocks even when the new html names no promo word', () => {
  // The live post already prints SPOT10; the edit meant to strip it rewrites the sentence instead.
  const base = () => doc(h('h2', 'Deals'), p('Looking for a promo code? Triply shows the lowest rate first.'), h('h2', 'Rivals'), p('Use promo code SPOT10 at SpotHero.'))
  const e: EditSpec = { replace: [{ text: 'Use promo code SPOT10 at SpotHero.', html: "<p>SpotHero's SPOT10 offer is for first-time users.</p>" }] }
  const c = checkEdit(base(), applyEdit(base(), e), e, known)
  assert.ok(c.blockers.some((b) => b.startsWith('lint unapproved-code') && b.includes('SPOT10')), c.blockers.join(' | '))
  const strip: EditSpec = { replace: [{ text: 'Use promo code SPOT10 at SpotHero.', html: '<p>SpotHero runs its own offers.</p>' }] }
  assert.deepEqual(checkEdit(base(), applyEdit(base(), strip), strip, known).blockers, [])
})

test('R3: a link or image the HTML → Lexical conversion would drop refuses the edit', () => {
  assert.throws(() => applyEdit(post(), { replace: [{ section: 'Off-site lots', html: '<p>Updated.<img data-media-id="42"></p>' }] }), /replace\[0\]: the html would lose image 42 in conversion/)
  assert.throws(() => applyEdit(post(), { replace: [{ text: 'Book early.', html: 'See <img data-media-id="7">' }] }), /would lose image 7/, 'inside a list item')
  assert.throws(() => applyEdit(post(), { replace: [{ text: 'Economy is $20/day.', html: '<p><a href="/blog/x"></a>Economy.</p>' }] }), /would lose link \/blog\/x/, 'a link with no text')
  assert.throws(() => applyEdit(post(), { insert: { underHeading: 'Summary', html: '<p>Map: <img data-media-id="9"></p>', position: 'end' } }), /insert: the html would lose image 9/)
  // the same image as its own block survives, so the edit goes through
  const ok = applyEdit(post(), { replace: [{ section: 'Off-site lots', html: '<p>Updated.</p><img data-media-id="42">' }] })
  assert.equal(mediaRefs(ok.after.content.root.children).get('image:42'), 1)
})

test('R4: prices are checked block by block — no figure borrows another block\'s source link', () => {
  // (a) conversion merges the <p>s of a quote: the raw html is checked too, split at every block tag
  const merged: EditSpec = { replace: [{ section: 'Summary', html: '<blockquote><p><a href="https://www.flydulles.com">Airport source</a></p><p>Parking costs $999/day.</p></blockquote>' }] }
  assert.ok(checkEdit(post(), applyEdit(post(), merged), merged, known).blockers.some((b) => b.startsWith('price check: $999')))
  const sourced: EditSpec = { replace: [{ section: 'Summary', html: '<p>Parking costs $999/day per <a href="https://www.flydulles.com">the airport</a>.</p>' }] }
  assert.deepEqual(checkEdit(post(), applyEdit(post(), sourced), sourced, known).blockers, [], 'a figure in its own sourced paragraph still passes')
  // (b) a quote followed by a sourced paragraph, in one op and across two ops
  const borrow: EditSpec = { replace: [{ section: 'Summary', html: '<blockquote>Lot Y is $9/day.</blockquote><p>Source: <a href="https://example.com">x</a></p>' }] }
  assert.ok(checkEdit(post(), applyEdit(post(), borrow), borrow, known).blockers.some((b) => b.startsWith('price check: $9')))
  const twoOps: EditSpec = { replace: [{ text: 'Economy is $20/day.', html: '<blockquote>Lot Y is $9/day.</blockquote>' }, { text: 'Shuttles run every 30 minutes.', html: '<p>Source: <a href="https://example.com">x</a></p>' }] }
  assert.ok(checkEdit(post(), applyEdit(post(), twoOps), twoOps, known).blockers.some((b) => b.startsWith('price check: $9')))
  assert.deepEqual(priceCheck('<blockquote>Lot Y is $9/day.</blockquote><p>Source: <a href="https://example.com">x</a></p>', '', known), ['$9'], 'lint.ts splits at </blockquote>')
  // (c) the whole-body warning list chunks the same way
  const quote = (t: string) => ({ type: 'quote', children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1 })
  const qp = () => doc(h('h2', 'A'), quote('Lot Z is $77/day.'), pl('Source ', 'https://example.com/rates', 'x'), h('h2', 'B'), p('b'))
  const ins: EditSpec = { insert: { underHeading: 'B', html: '<p>Shuttles run 24/7.</p>', position: 'end' } }
  assert.deepEqual(checkEdit(qp(), applyEdit(qp(), ins), ins, known).remainingPrices, ['$77'])
  // a stored legacy table renders its raw html (lexical-to-html), which no closing-tag split can bound: only
  // chunking by root node keeps its figure away from the next paragraph's link
  const legacy = () => doc(h('h2', 'A'), { type: 'table', html: '<table><caption>Lot Z is $77/day.</caption></table>', children: [] }, pl('Source ', 'https://example.com/rates', 'x'), h('h2', 'B'), p('b'))
  assert.deepEqual(checkEdit(legacy(), applyEdit(legacy(), ins), ins, known).remainingPrices, ['$77'])
})

test('R5: settle and the post-save check compare structure, links and images, not just text', async () => {
  const base = () => doc(h('h2', 'A'), p('Same text.'), img(42), h('h2', 'B'), p('b'))
  const r = applyEdit(base(), { replace: [{ section: 'A', html: '<p>Same text.</p>' }] })
  const boom = async () => { throw new Error('Payload API error 502') }
  assert.equal(await applyWithSettle('1', r.patch, { updatePost: boom, readPost: async () => base(), log: () => {} }), 'not-live', 'the unchanged post is not the edit')
  assert.equal(editLive(base(), r.patch), false)
  // what the CMS hands back for the edit we sent (JSONB key order, a hydrated upload) still counts as live
  const reorder = (x: unknown): unknown => Array.isArray(x) ? x.map(reorder) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, reorder(v)])) : x
  const stored = reorder(r.after) as PostLike
  assert.equal(editLive(stored, r.patch), true)
  const kept = applyEdit(base(), { replace: [{ text: 'b', html: '<p>c</p>' }] })
  const hydrated = JSON.parse(JSON.stringify(kept.after)) as PostLike
  hydrated.content.root.children[2].value = { id: 42, url: '/media/x.png', alt: 'x' }
  assert.equal(editLive(hydrated, kept.patch), true)
  // the post-save check's other direction: a link the edit removed that is still live
  const before = post()
  const rr = applyEdit(before, { replace: [{ section: 'Off-site lots', html: '<p>New.</p>' }] })
  assert.match(refsNotRemoved(rr.after.content, before.content) || '', /link \/blog\/old-lot-x/)
  assert.match(refsNotRemoved(rr.after.content, before.content) || '', /image 42/)
  assert.equal(refsNotRemoved(rr.after.content, rr.after.content), null)
})

test('R6: list items an earlier op wrote are protected, not just the list', () => {
  assert.throws(() => applyEdit(post(), { replace: [
    { section: 'Summary', html: '<ul><li>Economy is $20/day.</li><li>Book early online.</li></ul>' },
    { text: 'Book early online.', html: '' },
  ] }), /earlier operation/)
})

test('R7: an item edit may not turn a table-pattern list (a table on the site) back into bullets', () => {
  const bt = (t: string) => ({ ...text(t), format: 1 })
  const row = (lot: string, rate: string, v: number) => ({ type: 'listitem', value: v, checked: false, children: [bt('Lot: '), text(`${lot} | `), bt('Rate: '), text(rate)], direction: 'ltr', format: '', indent: 0, version: 1 })
  const tlist = (...rows: [string, string][]) => ({ type: 'list', listType: 'bullet', tag: 'ul', start: 1, children: rows.map(([l, r], i) => row(l, r, i + 1)), direction: 'ltr', format: '', indent: 0, version: 1 })
  const three = () => doc(h('h2', 'Lots'), tlist(['A', '$20/day'], ['B', '$15/day'], ['C', '$25/day']))
  assert.ok(isTablePatternList(three().content.root.children[1]))
  assert.throws(() => applyEdit(three(), { replace: [{ text: 'Lot: B | Rate: $15/day', html: 'Lot: B2 | Rate: $15/day' }] }),
    (e: Error) => /shows on the site as a table/.test(e.message) && e.message.includes('<li><strong>Lot:</strong> … | <strong>Rate:</strong> …</li>'))
  const ok = applyEdit(three(), { replace: [{ text: 'Lot: B | Rate: $15/day', html: '<strong>Lot:</strong> B2 | <strong>Rate:</strong> $15/day' }] })
  assert.ok(isTablePatternList(ok.after.content.root.children[1]), 'same bold labels: still a table')
  assert.ok(isTablePatternList(applyEdit(three(), { replace: [{ text: 'Lot: C | Rate: $25/day', html: '' }] }).after.content.root.children[1]), 'two rows left: still a table')
  const two = () => doc(h('h2', 'Lots'), tlist(['A', '$20/day'], ['B', '$15/day']))
  assert.throws(() => applyEdit(two(), { replace: [{ text: 'Lot: B | Rate: $15/day', html: '' }] }), /shows on the site as a table/, 'one row is no table')
  // an ordinary list is not a table, and item edits stay free
  assert.ok(!isTablePatternList(post().content.root.children[8]))
})

test('R8: a whole-body price check that cannot run says so', () => {
  const e: EditSpec = { replace: [{ text: 'Economy is $20/day.', html: '<p>Economy is the cheapest on-airport lot.</p>' }] }
  assert.ok(checkEdit(post(), applyEdit(post(), e), e, null).notRun.includes('whole-body price check NOT RUN: no data/airports/IAD.json'))
  const noCode: PostLike = { ...post(), airportCode: undefined }
  assert.ok(checkEdit(noCode, applyEdit(noCode, e), e, null).notRun.includes('whole-body price check NOT RUN: the post has no airportCode'))
  assert.deepEqual(checkEdit(post(), applyEdit(post(), e), e, known).notRun, [])
  const fieldsOnly: EditSpec = { fields: { excerpt: 'A plain new excerpt.' } }
  assert.ok(!checkEdit(post(), applyEdit(post(), fieldsOnly), fieldsOnly, null).notRun.some((n) => n.startsWith('whole-body')), 'no body edit, no whole-body check owed')
})

test('R9: a whitespace-only match text is refused (it matched empty blocks and images)', () => {
  assert.throws(() => applyEdit(post(), { replace: [{ text: '   ', html: '' }] }), /empty once whitespace is ignored/)
  assert.throws(() => applyEdit(post(), { replace: [{ remove: ' \n ' }] }), /empty once whitespace is ignored/)
  assert.throws(() => applyEdit(post(), { insert: { underHeading: '  ', html: '<p>x</p>', position: 'end' } }), /empty once whitespace is ignored/)
})

test('R10: new html and new field text may not name a lot we do not sell', () => {
  const lots = { unsellable: [{ name: 'Gone Lot Airport Parking (IAD)' }], sellable: ['Economy Lot'], airportWords: ['IAD'] }
  const e: EditSpec = { replace: [{ text: 'Economy is $20/day.', html: '<p>Gone Lot Airport Parking runs a shuttle too.</p>' }] }
  const c = checkEdit(post(), applyEdit(post(), e), e, known, lots)
  assert.ok(c.blockers.some((b) => b.includes(`names a lot we don't sell at IAD: "Gone Lot Airport Parking (IAD)"`)), c.blockers.join(' | '))
  const title: EditSpec = { fields: { title: 'Gone Lot Airport Parking vs the Dulles garage' } }
  assert.ok(checkEdit(post(), applyEdit(post(), title), title, known, lots).blockers.some((b) => b.includes('Gone Lot Airport Parking')))
  // a name inside a lot we DO sell names that lot
  assert.deepEqual(checkEdit(post(), applyEdit(post(), e), e, known, { ...lots, sellable: ['Gone Lot Airport Parking Premium'] }).blockers, [])
  assert.deepEqual(checkEdit(post(), applyEdit(post(), e), e, known).blockers, [], 'an empty list finds nothing (main() passes lotNamesFor)')
})

// ── Review round 2 on e6d0bd1 (Codex + Opus, Nov 2026) ──────────────────────
const boom = async () => { throw new Error('Payload API error 502') }
const quiet = () => {}

test('round 2 · 1: an unsold lot is named only by its whole name (real DTW / MIA / EWR / JFK data)', () => {
  const at = (code: string, html: string, lots = lotNamesFor(code)) => {
    const pst: PostLike = { ...doc(h('h2', 'A'), p('Old line.')), airportCode: code }
    const e: EditSpec = { replace: [{ text: 'Old line.', html }] }
    return checkEdit(pst, applyEdit(pst, e), e, known, lots)
  }
  const blocked = (c: ReturnType<typeof checkEdit>, name: string) => c.blockers.some((b) => b.startsWith("names a lot we don't sell") && b.includes(`"${name}"`))
  // ordinary words that the brand key ("airlines", "deal", "parking 4") used to catch
  assert.deepEqual(at('DTW', '<p>Shuttles serve all other airlines too.</p>').blockers, [])
  assert.deepEqual(at('DTW', '<p>Airlines at the McNamara Terminal use the same garage.</p>').blockers, [])
  assert.deepEqual(at('DTW', '<p>Let us park your car for you.</p>').blockers, [], '"US Park" is all caps in the name')
  assert.deepEqual(at('MIA', '<p>Booking early is a good deal.</p>').blockers, [])
  assert.deepEqual(at('JFK', '<p>For parking 4 days or more, book ahead.</p>').blockers, [])
  // the lot's whole name still blocks
  assert.ok(blocked(at('DTW', '<p>Airlines Parking runs a shuttle.</p>'), 'Airlines Parking (DTW)'))
  assert.ok(blocked(at('DTW', '<p>US Park is next to the airport.</p>'), 'US Park (DTW)'))
  assert.ok(blocked(at('MIA', '<p>Deal Airport Parking is close by.</p>'), 'Deal Airport Parking (MIA)'))
  assert.ok(blocked(at('JFK', '<p>Parking 4 Airport closed in 2026.</p>'), 'Parking 4 Airport (JFK)'))
  // a generic name ("Newark Airport Long Term Parking", also the EWR hub's title) warns, never blocks
  const ewr = at('EWR', '<p><a href="/blog/newark-airport-long-term-parking">Back to Newark Airport Long Term Parking Guide</a></p>')
  assert.deepEqual(ewr.blockers, [])
  assert.ok(ewr.warnings.some((w) => w.rule === 'unsold-lot-name' && w.message.includes('"Newark Airport Long Term Parking (NALTP)"')))
  // a human-added alias blocks, even for a generic name
  const naltp = { ...lotNamesFor('EWR')!, unsellable: [{ name: 'Newark Airport Long Term Parking (NALTP)', aliases: ['NALTP'] }] }
  assert.ok(blocked(at('EWR', '<p>NALTP runs a shuttle.</p>', naltp), 'Newark Airport Long Term Parking (NALTP)" (as "NALTP'))
  // hyphen or space, on both sides of the sold-name protection
  const westin = (unsold: string, sold: string) => at('DFW', '<p>The Westin Dallas Fort Worth Airport has a garage.</p>', { unsellable: [{ name: unsold }], sellable: [sold], airportWords: ['DFW'] }).blockers
  assert.deepEqual(westin('Westin Dallas-Fort Worth', 'Westin Dallas Fort Worth Airport'), [])
  assert.deepEqual(westin('Westin Dallas Fort Worth', 'Westin Dallas-Fort Worth Airport'), [])
  // no data file: said, not silent
  assert.ok(at('DTW', '<p>Shuttles run all day.</p>', null).notRun.includes('unsold lot-name check NOT RUN: no data/airports/DTW.json'))
})

test('round 2 · 2: only the generated CTA ends a section; an ordinary booking-linked paragraph is section content', () => {
  const rates = (...tail: unknown[]) => doc(h('h2', 'A'), p('a'), h('h2', 'Rates'), p('Rates vary.'), pl('Book from $26/day on ', CTA.url, 'our Dulles page'), ...tail)
  const e: EditSpec = { replace: [{ section: 'Rates', html: '<p>Rates change daily.</p>' }] }
  assert.deepEqual(kidsOf(applyEdit(rates(), e).after), ['h2:A', 'a', 'h2:Rates', 'Rates change daily.'], 'the stale $26 line goes with its section')
  assert.deepEqual(kidsOf(applyEdit(rates(makeCtaParagraph(CTA)), e).after), ['h2:A', 'a', 'h2:Rates', 'Rates change daily.', CTA.fullText])
  // a paragraph that starts with a booking link but is not the CTA's "Compare IAD parking rates" anchor
  const linkFirst = { type: 'paragraph', children: [a(CTA.url, 'Book IAD parking'), text(' from $26/day.')], direction: 'ltr', format: '', indent: 0, version: 1 }
  assert.deepEqual(kidsOf(applyEdit(doc(h('h2', 'Rates'), p('x'), linkFirst), e).after), ['h2:Rates', 'Rates change daily.'])
})

test('round 2 · 3: a booking link is our host and the exact path, not a URL that contains the path', () => {
  const path = '/washington-iad/airport-parking'
  assert.equal(isBookingUrl('https://example.com/?next=/washington-iad/airport-parking', path), false)
  assert.equal(isBookingUrl('https://evil-triplypro.com/washington-iad/airport-parking', path), false)
  assert.equal(isBookingUrl('https://www.triplypro.com/washington-iad/airport-parking-guide', path), false)
  assert.equal(isBookingUrl('https://www.triplypro.com/washington-iad/airport-parking/', path), true)
  assert.equal(isBookingUrl('https://triplypro.com/washington-iad/airport-parking?ref=blog', path), true)
  assert.equal(isBookingUrl('/washington-iad/airport-parking', path), true)
  const swap: EditSpec = { replace: [{ text: CTA.fullText, html: '<p><a href="https://example.com/?next=/washington-iad/airport-parking">Compare IAD parking rates</a> elsewhere.</p>' }] }
  assert.ok(checkEdit(withCta(), applyEdit(withCta(), swap), swap, known).blockers.some((b) => b.includes('would remove the link to the booking page')))
  const relative: EditSpec = { replace: [{ text: CTA.fullText, html: '<p><a href="/washington-iad/airport-parking/">Compare IAD parking rates</a> on Triply.</p>' }] }
  assert.deepEqual(checkEdit(withCta(), applyEdit(withCta(), relative), relative, known).blockers, [])
})

test('round 2 · 4: a list turned from bullets into a table (same text runs once joined) is not settled as applied', async () => {
  const bt = (t: string) => ({ ...text(t), format: 1 })
  const item = (...runs: unknown[]) => ({ type: 'listitem', value: 1, checked: false, children: runs, direction: 'ltr', format: '', indent: 0, version: 1 })
  const bullets = () => doc(h('h2', 'Lots'), { type: 'list', listType: 'bullet', tag: 'ul', start: 1, children: [item(bt('Lot: A'), text(' | '), bt('Rate: $20/day')), item(bt('Lot: B'), text(' | '), bt('Rate: $15/day'))], direction: 'ltr', format: '', indent: 0, version: 1 })
  assert.ok(!isTablePatternList(bullets().content.root.children[1]))
  const row = (lot: string, rate: string) => `<li><strong>Lot: </strong><strong>${lot}</strong> | <strong>Rate: </strong><strong>${rate}</strong></li>`
  const r = applyEdit(bullets(), { replace: [{ text: 'Lot: A | Rate: $20/day Lot: B | Rate: $15/day', html: `<ul>${row('A', '$20/day')}${row('B', '$15/day')}</ul>` }] })
  assert.ok(isTablePatternList(r.after.content.root.children[1]), 'the edit makes it a table on the site')
  assert.equal(await applyWithSettle('1', r.patch, { updatePost: boom, readPost: async () => bullets(), log: quiet }), 'not-live')
  assert.equal(editLive(r.after, r.patch), true)
})

test('round 2 · 5: top-level inline html becomes one paragraph, spaces, bold and links intact', () => {
  const r = applyEdit(post(), { replace: [{ text: 'Economy is $20/day.', html: 'Economy is <strong>$20/day</strong> now.' }] })
  const last = r.after.content.root.children.at(-1)!
  assert.equal(last.type, 'paragraph')
  assert.equal(blockText(last), 'Economy is $20/day now.')
  assert.ok(last.children!.some((c) => c.format === 1 && c.text === '$20/day'), 'bold kept')
  const l = applyEdit(post(), { replace: [{ text: 'Economy is $20/day.', html: 'See <a href="/blog/iad-summary">the summary</a>.' }] })
  assert.equal(mediaRefs(l.after.content.root.children).get('link:/blog/iad-summary'), 1, 'a top-level link is kept, not refused as lost')
  assert.equal(blockText(l.after.content.root.children.at(-1)!), 'See the summary.')
  assert.throws(() => applyEdit(post(), { replace: [{ section: 'Summary', html: 'Intro <p>Para.</p>' }] }), /mixes inline text with blocks/)
  assert.throws(() => applyEdit(post(), { replace: [{ section: 'Summary', html: '<li>a</li><li>b</li>' }] }), /<li> at the top level/)
})

test('round 2 · 6: list-item html that leaves the list is refused, not cut short', () => {
  assert.throws(() => applyEdit(post(), { replace: [{ text: 'Book early.', html: '<li>New lot</li></ul><p>Note about the lot.</p><ul><li>Other</li>' }] }), /leaves the list \(it converts to 3 blocks\)/)
  // several <li> items stay one list
  const two = applyEdit(post(), { replace: [{ text: 'Book early.', html: '<li>Book early.</li><li>Book online.</li>' }] })
  assert.equal(two.after.content.root.children.find((n) => n.type === 'list')!.children!.length, 4)
})

test('round 2: a body edit on a post with no airportCode says the booking-link check did not run', () => {
  const noCode: PostLike = { ...post(), airportCode: undefined }
  const e: EditSpec = { replace: [{ text: 'Economy is $20/day.', html: '<p>Economy is the cheapest on-airport lot.</p>' }] }
  assert.ok(checkEdit(noCode, applyEdit(noCode, e), e, known).notRun.includes('booking-link check NOT RUN: the post has no airportCode'))
  assert.ok(!checkEdit(post(), applyEdit(post(), e), e, known).notRun.some((n) => n.startsWith('booking-link')))
})
