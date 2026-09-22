// Regression test for the <li> inline-conversion bug (2026-09-18):
// links and bold that were DIRECT children of <li> were dropped on the way
// into Lexical, so update-links reported links "Saved" that never persisted.
//
//   npx tsx --test src/html-to-lexical.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { htmlToLexical } from './html-to-lexical.js'
import { lexicalToHtml } from './lexical-to-html.js'

const roundTrip = (html: string) => lexicalToHtml(htmlToLexical(html))

test('link that is a direct child of <li> survives the round trip', () => {
  const html = '<ul><li>See the <a href="https://www.triplypro.com/blog/x">guide</a>.</li></ul>'
  assert.match(roundTrip(html), /href="https:\/\/www\.triplypro\.com\/blog\/x"/)
})

test('bold that is a direct child of <li> survives the round trip', () => {
  const html = '<ul><li><strong>Under 3 days:</strong> use the garage.</li></ul>'
  assert.match(roundTrip(html), /<strong>Under 3 days:<\/strong>/)
})

test('link inside <p> still survives (unchanged path)', () => {
  const html = '<p>Read the <a href="https://www.triplypro.com/blog/y">rates guide</a>.</p>'
  assert.match(roundTrip(html), /href="https:\/\/www\.triplypro\.com\/blog\/y"/)
})

test('nested list inside <li> text survives but nesting is flattened', () => {
  const html = '<ul><li>Outer <a href="https://www.triplypro.com/blog/z">z</a><ul><li>Inner</li></ul></li></ul>'
  const out = roundTrip(html)
  assert.match(out, /href="https:\/\/www\.triplypro\.com\/blog\/z"/)
  assert.match(out, /Inner/)
  // Nesting is flattened: nested <ul> becomes a sibling <li>
  assert.doesNotMatch(out, /<ul>[\s\S]*?<ul>/)
})

// Upload (inline image / infographic) round trip. Before data-media-id was
// emitted by lexical-to-html.ts, every image was dropped on the way back in —
// so update-links deleted the infographics from every post it saved.
import { countNodesOfType, readUploadValue } from './lexical-to-html.js'

const uploadDoc = (value: unknown) => ({
  root: {
    type: 'root', format: '', indent: 0, version: 1, direction: 'ltr',
    children: [
      { type: 'paragraph', format: '', indent: 0, version: 1, direction: 'ltr', children: [{ type: 'text', text: 'Before', format: 0, detail: 0, mode: 'normal', style: '', version: 1 }] },
      { type: 'upload', relationTo: 'media', value, version: 2 },
      { type: 'paragraph', format: '', indent: 0, version: 1, direction: 'ltr', children: [{ type: 'text', text: 'After', format: 0, detail: 0, mode: 'normal', style: '', version: 1 }] },
    ],
  },
})

test('hydrated upload node keeps its media id through Lexical → HTML → Lexical', () => {
  const doc = uploadDoc({ id: 42, url: 'https://blob.example/infographic.png', alt: 'JFK rates' })
  const html = lexicalToHtml(doc as Parameters<typeof lexicalToHtml>[0])
  assert.match(html, /<img src="https:\/\/blob\.example\/infographic\.png" alt="JFK rates" data-media-id="42">/)
  const back = htmlToLexical(html)
  assert.equal(countNodesOfType(back as Parameters<typeof lexicalToHtml>[0], 'upload'), 1)
  const upload = back.root.children.find((n) => n.type === 'upload') as { value?: unknown } | undefined
  assert.equal(upload?.value, 42)
})

test('unhydrated (bare id) upload node also round-trips', () => {
  const doc = uploadDoc(7)
  const html = lexicalToHtml(doc as Parameters<typeof lexicalToHtml>[0])
  assert.match(html, /data-media-id="7"/)
  assert.equal(countNodesOfType(htmlToLexical(html) as Parameters<typeof lexicalToHtml>[0], 'upload'), 1)
})

test('upload node with no usable id renders nothing rather than an orphan <img>', () => {
  const html = lexicalToHtml(uploadDoc({ url: 'https://x/y.png' }) as Parameters<typeof lexicalToHtml>[0])
  assert.doesNotMatch(html, /<img/)
})

test('readUploadValue normalises every value shape', () => {
  assert.deepEqual(readUploadValue(5), { id: '5', url: '', alt: '' })
  assert.deepEqual(readUploadValue('12'), { id: '12', url: '', alt: '' })
  assert.deepEqual(readUploadValue({ id: '3', url: 'u', alt: 'a' }), { id: '3', url: 'u', alt: 'a' })
  assert.equal(readUploadValue('abc').id, null)
  assert.equal(readUploadValue(null).id, null)
  assert.equal(readUploadValue({ url: 'u' }).id, null)
})

test('countNodesOfType walks nested children', () => {
  const doc = uploadDoc(1)
  assert.equal(countNodesOfType(doc as Parameters<typeof lexicalToHtml>[0], 'upload'), 1)
  assert.equal(countNodesOfType(doc as Parameters<typeof lexicalToHtml>[0], 'paragraph'), 2)
  assert.equal(countNodesOfType(null, 'upload'), 0)
})
