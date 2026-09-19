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

test('nested list inside <li> is still preserved', () => {
  const html = '<ul><li>Outer <a href="https://www.triplypro.com/blog/z">z</a><ul><li>Inner</li></ul></li></ul>'
  const out = roundTrip(html)
  assert.match(out, /href="https:\/\/www\.triplypro\.com\/blog\/z"/)
  assert.match(out, /Inner/)
})
