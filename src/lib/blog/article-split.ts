/**
 * Where to break the article body so a booking CTA lands around the point
 * most readers actually reach (~30% down) instead of at the very bottom.
 *
 * Works on the Lexical block array (`content.root.children`), never on
 * rendered HTML, so the CTA can only ever land *between* top-level blocks —
 * never inside a paragraph, list or table.
 */

type LexicalBlock = {
  type?: string
  tag?: string
}

type LexicalDoc = {
  root?: {
    children?: LexicalBlock[]
  }
} | null | undefined

/**
 * Returns the index of the top-level block the CTA should be rendered
 * *after*, or null when the article is too short to place one mid-body.
 *
 * - 3+ H2s  → after the 2nd H2 section, i.e. immediately before the 3rd H2.
 * - fewer   → after the 3rd paragraph, but only when that still lands in the
 *             first half of the article — a "3rd paragraph" fallback that
 *             lands past the midpoint (e.g. the rest of the body is a single
 *             list/table) is not a mid-article placement, so null instead.
 * - neither → null (caller keeps the full CTA at the end of the page).
 */
export function getMidArticleInsertIndex(content: LexicalDoc): number | null {
  const blocks = content?.root?.children
  if (!Array.isArray(blocks) || blocks.length === 0) return null

  const h2Indexes: number[] = []
  const paragraphIndexes: number[] = []

  blocks.forEach((block, i) => {
    if (block?.type === 'heading' && block?.tag === 'h2') h2Indexes.push(i)
    else if (block?.type === 'paragraph') paragraphIndexes.push(i)
  })

  const halfway = Math.floor(blocks.length / 2)

  // Before the 3rd H2 == after the last block of the 2nd H2 section. Same
  // first-half bound as the paragraph fallback below — a long intro before
  // the H2s can push this past the midpoint just as easily as it can the
  // 3rd-paragraph case, and a CTA that lands there is a bottom-of-page CTA
  // wearing a "mid-article" label.
  if (h2Indexes.length >= 3) {
    const i = h2Indexes[2] - 1
    return i < halfway ? i : null
  }

  if (paragraphIndexes.length >= 3) {
    const i = paragraphIndexes[2]
    return i < halfway ? i : null
  }

  return null
}
