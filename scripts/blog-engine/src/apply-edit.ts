/**
 * apply-edit.ts — the preview → apply path for edits to EXISTING posts (roadmap v3.4 B-4,
 * plan v3.2 W2/W3/W4: one apply step, person-approved, the only thing that moves the date).
 *
 *   npx tsx src/apply-edit.ts --slug <slug> --edit edit.json --preview
 *   npx tsx src/apply-edit.ts --slug <slug> --edit edit.json --apply [--stamp]
 *
 * edit.json (any of the three parts; unknown keys are refused):
 *   {
 *     "fields": { "title": "...", "excerpt": "...", "seo": { "metaTitle": "...", "metaDescription": "..." },
 *                 "faqItems": [{ "question": "...", "answer": "..." }] },
 *     "insert": { "underHeading": "Parking rates", "html": "<p>...</p>", "position": "end" },
 *     "replace": [
 *       { "section": "Parking rates", "html": "<p>...</p>", "heading": "optional new heading text" },
 *       { "remove": "Old lot table" },
 *       { "text": "exact plain text of one block", "html": "<p>...</p>" }
 *     ],
 *     "allowBookingLinkRemoval": true   // only when the edit is MEANT to leave no link to the booking page
 *   }
 *
 * replace (Nov 2026) — REMOVE or REWRITE stale body text instead of inserting a correction above it:
 *   - section: everything between that heading and the next heading of the same or higher level
 *     (sub-headings included) is replaced by `html`; the heading stays unless `heading` renames it.
 *   - remove: the heading and its whole section (sub-headings included) are dropped.
 *   - text: ONE block whose whole plain text equals `text` (a paragraph, quote, list, list item or
 *     table; whitespace and case ignored) is replaced by `html`; "" deletes it. A list item is
 *     replaced inside its list (html may be "<li>…</li>" or inline HTML).
 *   Headings and texts must match exactly once; 0 or 2+ matches are refused and the error lists the
 *   nearest candidates (headings are found ignoring case; a rename is decided case-sensitively).
 *   Operations run in order on the result of the previous one and may not touch content an earlier
 *   operation wrote: section/remove refuse any range holding earlier output, and a whole-list text op
 *   is refused after an item edit in that list. Replace runs before insert.
 *   Links and images inside REMOVED content are expected to go: the guard allows exactly those
 *   (by URL / media id) and still fails on any other loss; the preview log and .diff.txt list them.
 *   The new HTML gets the full price check (blocking); for EVERY body edit (insert included) the price
 *   check also runs on the whole resulting body and lists figures still in the post that are not in the
 *   allow-list (warning).
 *
 * Review round 2 (Nov 2026):
 *   - A section never runs into the booking CTA (the "Compare <CODE> parking rates" paragraph booking-links appends as
 *     the LAST root node; recognised by that generated shape, not by any link to the booking page): it ends before it.
 *     And an edit whose result has no link to the airport's booking page (our host, that exact path), when the live
 *     post had one, is refused unless edit.json sets "allowBookingLinkRemoval": true.
 *   - A link or image in the new html that HTML → Lexical would drop (an inline <img>, a link with no text) refuses the
 *     edit before any removal allowance is granted. Inline-only html is wrapped in <p> (the converter's top level
 *     fused its words and dropped its bold); inline text mixed with blocks, and list-item html that leaves its list,
 *     are refused.
 *   - Prices are checked block by block (each converted node, and the raw html split at every block tag), never on one
 *     joined string where a figure could borrow another block's source link.
 *   - Promo codes in new html are checked whenever the post talks about codes, even if the new html doesn't.
 *   - New html (and new field text) may not name a lot we don't sell at the airport: its whole name (or an `aliases`
 *     entry in the data file) as a proper noun; a name of only generic words warns instead.
 *   - An item edit may not turn a table-pattern list (the site draws it as a table) back into bullets.
 *   - Settle and the post-save check compare the body's structure (types, text, link URLs, media ids, a list's table
 *     form), not its text; the post-save check also fails when a link or image the edit removed is still live.
 *   - A check that could not run (no airportCode / no data file) is printed and recorded as NOT RUN.
 *
 * --preview reads the post by slug (any status), applies the edit in memory, runs the lint, the
 * price check and the link/image guard, and writes reports/apply-preview/<slug>.html (+ .diff.txt +
 * .meta.json). Nothing is written to the CMS.
 * --apply re-reads the post and refuses unless it is the SAME post, unchanged since the preview, with
 * the SAME edit file producing the SAME patch (hashes in .meta.json). It re-runs every check, backs up
 * the live post, PATCHes by id, settles a thrown PATCH by re-reading (the edit may have committed before
 * the response was lost), re-reads to verify links and images survived, stamps contentUpdatedAt only
 * with --stamp AND a body/FAQ facts change (stamp.ts rules: titles and metadata are not facts), and
 * pings IndexNow when the post is published.
 *
 * The body edit splices Lexical nodes in place: only the inserted / replacement HTML goes through
 * HTML → Lexical, the rest of the post is never round-tripped.
 *
 * Review fixes (PR #142, Nov 2026): strict edit schema; duplicate heading and already-present insert
 * refused; price allow-list = the figures the writer prompt sees (figureSource), not every number in the
 * airport file; only an EXTERNAL link sources a paragraph; inserted HTML checked once (not again as
 * plain text); apply bound to the previewed edit; thrown PATCH settled by re-read; pre-existing lint
 * errors in the live post are warnings, not blockers (an edit that leaves old body text alone is not blamed for it).
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { z } from 'zod'
import { parse as parseHtml, NodeType, type HTMLElement, type TextNode } from 'node-html-parser'
import { htmlToLexical } from './html-to-lexical.js'
import { lexicalToHtml, countNodesOfType, readUploadValue } from './lexical-to-html.js'
import { lintArticle, formatLint, stripTags, loadApprovedCodes, loadApprovedOffers, loadApprovedOfferFigures, priceCheck, collectMoneyFigures, PROMO_WORD, type LintFinding } from './lint.js'
// P3 price check + allow-list live in lint.ts (generate uses them too, W1.8 P3c); re-exported for callers and tests.
export { priceCheck, collectMoneyFigures } from './lint.js'
import { stampField, factsDiff, lexicalText, type FactsDiff } from './stamp.js'
import { bookingPathFor, airportFullName, SITE_BASE_URL } from './booking-links.js'
import { loadParkingLots, airportPageLots } from './airport-data.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PREVIEW_DIR = path.resolve(__dirname, '..', 'reports', 'apply-preview')

// ── Types ───────────────────────────────────────────────────────────────────
type Node = { type: string; tag?: string; text?: string; children?: Node[]; [k: string]: unknown }
type Doc = { root: { children: Node[]; [k: string]: unknown } }

// One replace operation. A section needs html (use "remove" to drop it); a text block may be replaced by "" (deleted).
const ReplaceOpSchema = z.union([
  z.object({ section: z.string().min(1), html: z.string().min(1), heading: z.string().min(1).optional() }).strict(),
  z.object({ remove: z.string().min(1) }).strict(),
  z.object({ text: z.string().min(1), html: z.string() }).strict(),
])
export type ReplaceOp = z.infer<typeof ReplaceOpSchema>

const FaqItem = z.object({ question: z.string().min(1), answer: z.string().min(1) }).strict()
export const EditSchema = z
  .object({
    fields: z
      .object({
        // Limits are the CMS's own (triply-cms Posts.ts maxLength): Payload would refuse the PATCH with a 400 otherwise.
        title: z.string().min(1).max(100).optional(),
        excerpt: z.string().min(1).max(300).optional(),
        seo: z.object({ metaTitle: z.string().min(1).max(60).optional(), metaDescription: z.string().min(1).max(160).optional() }).strict().optional(),
        // An empty array would wipe the FAQ schema; send the full list or leave the key out.
        faqItems: z.array(FaqItem).min(1).optional(),
      })
      .strict()
      .optional(),
    insert: z
      .object({ underHeading: z.string().min(1), html: z.string().min(1), position: z.enum(['start', 'end']).default('end') })
      .strict()
      .optional(),
    replace: z.array(ReplaceOpSchema).min(1).optional(),
    // The booking CTA sits on ~3,700 posts: an edit that leaves no link to the airport's booking page is refused
    // unless edit.json says it is meant (review, Nov 2026). Part of edit.json, so the preview hash binds it.
    allowBookingLinkRemoval: z.boolean().optional(),
  })
  .strict()
  .refine((e) => e.fields !== undefined || e.insert !== undefined || e.replace !== undefined, { message: 'edit.json needs "fields", "insert" and/or "replace"' })
export type EditSpec = z.infer<typeof EditSchema>

/** Parse edit.json strictly: an unknown key or a wrong shape is an error, never a silent no-op. */
export function parseEdit(raw: unknown): EditSpec {
  const r = EditSchema.safeParse(raw)
  if (r.success) return r.data
  throw new Error(`edit.json is not valid:\n  ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n  ')}`)
}

export interface PostLike {
  id: string | number
  slug: string
  status?: string
  title: string
  excerpt?: string
  airportCode?: string
  updatedAt?: string
  seo?: { metaTitle?: string; metaDescription?: string; [k: string]: unknown }
  faqItems?: { question: string; answer: string }[]
  content: Doc
}

export interface EditResult {
  patch: Record<string, unknown>
  after: PostLike
  /** Text added through `fields` (title, excerpt, seo, FAQ) — checked for prices WITHOUT a link exemption. */
  fieldText: string
  /** Body + FAQ facts, by the shared stamp.ts rule (titles and metadata are not facts). */
  factsDiff: FactsDiff
  /** What `replace` took out and put in, op by op (empty without `replace`). */
  replaced: ReplaceStep[]
  /** The nodes `insert` added (its html converted), for the per-block price check (empty without `insert`). */
  inserted: Node[]
}

// ── Pure core ───────────────────────────────────────────────────────────────
function nodeText(n: Node): string {
  return n.text ?? (n.children || []).map(nodeText).join('')
}
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
const norm = (s: string) => collapse(s).toLowerCase()
const LEVEL = (n: Node) => (n.type === 'heading' && n.tag ? Number(n.tag.slice(1)) : 99)

/** A target (heading or block text) as matched; refused when whitespace-only, since '' matches empty blocks and every image. */
function target(s: string, what: string, kind: string): string {
  const want = norm(s)
  if (!want) throw new Error(`${what}: the ${kind} to match is empty once whitespace is ignored — it would match empty blocks and images`)
  return want
}

/** The airport's booking page as booking-links links it: `/<site slug>/airport-parking`, and the code its CTA names. */
export interface BookingTarget { code: string; path: string }
export function bookingTargetFor(code: string | undefined): BookingTarget | null {
  const path = code ? bookingPathFor(code) : null
  return code && path ? { code: code.toUpperCase(), path } : null
}

/**
 * Is `url` the booking page itself: relative, or on triplypro.com / www.triplypro.com, with exactly that path (a
 * trailing slash is fine)? Containing the path is not enough: "https://example.com/?next=/washington-iad/airport-parking"
 * passed the backstop (review round 2, Nov 2026).
 */
export function isBookingUrl(url: string, path: string): boolean {
  let u: URL
  try {
    u = new URL(url, SITE_BASE_URL)
  } catch {
    return false
  }
  return /^(?:www\.)?triplypro\.com$/i.test(u.hostname) && u.pathname.replace(/\/+$/, '') === path.replace(/\/+$/, '')
}

/**
 * The CTA booking-links generates (makeCtaParagraph; the same shape findExistingCta looks for): a paragraph whose FIRST
 * child links the booking page with the anchor "Compare <CODE> parking rates". Any other paragraph that links the
 * booking page (a Rates section's last line with an old price) is ordinary section content (review round 2).
 */
function isBookingCta(n: Node, t: BookingTarget): boolean {
  if (n.type !== 'paragraph') return false
  // Empty text runs before the link render nothing, and the anchor is read across all its runs: an editor bolding
  // "IAD" splits it into three, which findExistingCta (first run only) no longer recognises (round-3 Codex).
  const first = (n.children ?? []).find((c) => !(c.type === 'text' && !(c.text ?? '').trim()))
  const url = (first?.fields as { url?: string } | undefined)?.url
  if (first?.type !== 'link' || typeof url !== 'string' || !isBookingUrl(url, t.path)) return false
  return new RegExp(`^Compare\\s+${t.code}\\s+parking rates$`, 'i').test(nodeText(first).replace(/\s+/g, ' ').trim())
}

/**
 * End of the section whose heading is at `at`: the next heading of the same or higher level, or the end of the
 * document, but never past the booking CTA that ends the post. booking-links appends it as the LAST root paragraph
 * (625 of 626 CTA'd posts in the Nov 2 backups), so without this a remove / section op on the last heading deleted
 * it, and the removed-content allowance let the link go (review, Nov 2026).
 */
function sectionEnd(kids: Node[], at: number, booking: BookingTarget | null): number {
  const lvl = LEVEL(kids[at])
  let end = at + 1
  while (end < kids.length && LEVEL(kids[end]) > lvl) end++
  if (end === kids.length && booking) while (end > at + 1 && isBookingCta(kids[end - 1], booking)) end--
  return end
}

/**
 * Insert `html` inside the section that starts at the heading whose text matches `underHeading`.
 * Refuses a heading that is missing or appears more than once, and an insert whose text is already in
 * that section (a retry after a lost PATCH response would otherwise add the section twice).
 * `booking`: the post's booking page, so "end" of the last section lands before the booking CTA.
 */
export function insertUnderHeading(content: Doc, underHeading: string, html: string, position: 'start' | 'end' = 'end', booking: BookingTarget | null = null): Doc {
  return insertSection(content, underHeading, html, position, booking).content
}

function insertSection(content: Doc, underHeading: string, html: string, position: 'start' | 'end', booking: BookingTarget | null): { content: Doc; nodes: Node[] } {
  const kids = content.root.children
  const want = target(underHeading, 'insert', 'heading')
  const matches = kids.map((n, i) => (n.type === 'heading' && norm(nodeText(n)) === want ? i : -1)).filter((i) => i >= 0)
  if (matches.length === 0) throw new Error(`heading not found: "${underHeading}"`)
  if (matches.length > 1) throw new Error(`heading "${underHeading}" appears ${matches.length} times — make it unique first`)
  const at = matches[0]
  const end = sectionEnd(kids, at, booking)
  const nodes = convertNew(html, 'insert')
  if (!nodes.length) throw new Error('insert: the html converts to nothing')
  const sectionText = norm(kids.slice(at + 1, end).map(nodeText).join(' '))
  const newText = norm(nodes.map(nodeText).join(' '))
  if (newText && sectionText.includes(newText)) throw new Error(`the inserted text is already under "${underHeading}" (possibly inside a longer paragraph) — nothing to add`)
  const insertAt = position === 'start' ? at + 1 : end
  return { content: { ...content, root: { ...content.root, children: [...kids.slice(0, insertAt), ...nodes, ...kids.slice(insertAt)] } }, nodes }
}

// ── Replace mode ────────────────────────────────────────────────────────────
/** One replace operation's outcome: the ORIGINAL nodes it took out, the nodes it put in, and a label for the log. */
export interface ReplaceStep { label: string; removed: Node[]; added: Node[]; removedHtml: string; addedHtml: string }

const BLOCK_TYPES = new Set(['list', 'listitem', 'table', 'tablerow', 'tablecell', 'quote', 'paragraph', 'heading'])
/** Plain text of a block, with a space between block-level children (table cells, list items) so they never fuse. */
export function blockText(n: Node): string {
  if (n.type === 'linebreak') return ' '
  if (typeof n.text === 'string') return n.text
  const kids = n.children || []
  return kids.map(blockText).join(kids.some((k) => BLOCK_TYPES.has(k.type)) ? ' ' : '')
}
const clip = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const toHtml = (nodes: Node[]) => lexicalToHtml({ root: { type: 'root', children: nodes } } as Parameters<typeof lexicalToHtml>[0])
// Round-trip only the new nodes through JSON so they carry the same plain-object shape as the stored post.
const parseNodes = (html: string): Node[] => (html.trim() ? JSON.parse(JSON.stringify(htmlToLexical(html).root.children)) : [])

/** Links (by href) and images (by data-media-id) as written in `html`, keyed like mediaRefs. */
function htmlRefs(html: string): Map<string, number> {
  const out = new Map<string, number>()
  const add = (k: string) => out.set(k, (out.get(k) ?? 0) + 1)
  const root = parseHtml(html, { lowerCaseTagName: true, comment: false })
  for (const a of root.querySelectorAll('a')) add(`link:${a.getAttribute('href') || ''}`)
  for (const img of root.querySelectorAll('img')) {
    const raw = (img.getAttribute('data-media-id') || '').trim()
    const id = parseInt(raw, 10) // html-to-lexical stores parseInt(id), so "042" is image 42
    add(`image:${Number.isNaN(id) ? raw || '(no data-media-id)' : String(id)}`)
  }
  return out
}

/**
 * Refuse new html whose links or images do not all survive HTML → Lexical. The converter silently drops an <img>
 * inside a <p>, <li>, table cell or <a>, an <img> with no numeric data-media-id, and a link with no text. A section
 * replaced by "<p>Updated.<img data-media-id="42"></p>" lost image 42, and the removed-content allowance then covered
 * the loss, so nothing blocked (review, Nov 2026). Runs at conversion, before any allowance exists.
 */
function refuseLostRefs(html: string, nodes: Node[], what: string): void {
  const have = mediaRefs(nodes)
  const lost = [...htmlRefs(html)].filter(([k, n]) => (have.get(k) ?? 0) < n)
    .map(([k]) => (k.startsWith('link:') ? `link ${k.slice(5) || '(no href)'}` : `image ${k.slice(6)}`))
  if (lost.length) throw new Error(`${what}: the html would lose ${lost.join(', ')} in conversion — put each image in its own block (<img data-media-id="…"> or <figure>, not inside <p>/<li>/<td>/<a>) and give every link text`)
}

// What html-to-lexical's top level (convertChildBlocks) converts as a block; any other top-level tag is inline.
const TOP_BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'blockquote', 'div', 'section', 'article', 'main', 'header', 'footer', 'table', 'figure', 'img', 'pre'])
// Parts of a list or table: at the top level they are no block, and their text would fuse into one paragraph.
const NESTED_ONLY_TAGS = new Set(['li', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'caption', 'dt', 'dd', 'figcaption'])

/**
 * The html as html-to-lexical can take it. Its top level trims every text node and unwraps inline tags, so
 * "Economy is <strong>$18/day</strong> now." became "Economy is$18/daynow." with the bold gone, and a top-level link
 * was dropped (review round 2, Nov 2026). Inline-only html is wrapped in <p>; html that mixes inline text with blocks,
 * or puts a list/table part at the top level, is refused rather than guessed at.
 */
function topLevelHtml(html: string, what: string): string {
  let inline = false, block = false
  for (const c of parseHtml(html, { lowerCaseTagName: true, comment: false }).childNodes) {
    if (c.nodeType === NodeType.TEXT_NODE) { if ((c as TextNode).text.trim()) inline = true; continue }
    if (c.nodeType !== NodeType.ELEMENT_NODE) continue
    const tag = (c as HTMLElement).tagName.toLowerCase()
    if (tag === 'br') continue // dropped at the top level either way
    if (NESTED_ONLY_TAGS.has(tag)) throw new Error(`${what}: <${tag}> at the top level of the html — put it inside its <ul>/<ol> or <table>`)
    if (TOP_BLOCK_TAGS.has(tag)) block = true
    else inline = true
  }
  if (inline && block) throw new Error(`${what}: the html mixes inline text with blocks at the top level — wrap the inline part in <p>…</p>`)
  return inline ? `<p>${html}</p>` : html
}

/** New html → Lexical nodes, refused if any link or image would be lost on the way. */
function convertNew(html: string, what: string): Node[] {
  const nodes = parseNodes(topLevelHtml(html, what))
  refuseLostRefs(html, nodes, what)
  return nodes
}

// ── Table-pattern lists ─────────────────────────────────────────────────────
// migrate-tables.ts turned tables into bullet lists whose items read "**Lot: **X | **Rate: **$26/day". The site's
// RichText.tsx (isTablePattern) draws such a list as a comparison table only while it has 2+ items and every item
// carries the same bold "Header:" labels. Re-implemented here: the engine never imports app code.
const textLeaves = (n: Node): Node[] => (n.type === 'text' ? [n] : (n.children || []).flatMap(textLeaves))
const isLabel = (t: Node) => typeof t.format === 'number' && (t.format & 1) !== 0 && (t.text ?? '').trim().endsWith(':')
function tableLabels(item: Node): string[] {
  return textLeaves(item).filter(isLabel).map((t) => (t.text ?? '').trim().slice(0, -1).trim())
}
/** The headers and cells the site draws for a table-pattern list (RichText.tsx parseTableData). */
function tableData(list: Node): { headers: string[]; rows: string[][] } {
  const items = (list.children || []).filter((c) => c.type === 'listitem')
  const cell = (s: string) => s.replace(/^[\s|]+/, '').replace(/[\s|]+$/, '').trim()
  const rows = items.map((item) => {
    const values: string[] = []
    let cur = '', collecting = false
    for (const t of textLeaves(item)) {
      if (isLabel(t)) { if (collecting) values.push(cell(cur)); cur = ''; collecting = true }
      else if (collecting) cur += t.text ?? ''
    }
    if (collecting) values.push(cell(cur))
    return values
  })
  return { headers: tableLabels(items[0]), rows }
}
/** Does the site render this list as a table (RichText.tsx isTablePattern)? */
export function isTablePatternList(list: Node): boolean {
  if (list.listType !== 'bullet') return false
  const items = (list.children || []).filter((c) => c.type === 'listitem')
  if (items.length < 2) return false
  const first = tableLabels(items[0])
  if (first.length < 2) return false
  return items.every((it) => tableLabels(it).join('\u0000') === first.join('\u0000'))
}

/** Closest candidates for a refusal message: shared-word overlap with what was asked for, best first. */
function nearest(want: string, candidates: string[], max = 5): string[] {
  const words = (s: string) => new Set(norm(s).split(/[^a-z0-9$.%]+/).filter((w) => w.length > 2))
  const w = words(want)
  return [...new Set(candidates)]
    .map((c) => {
      const cw = words(c)
      let shared = 0
      for (const x of w) if (cw.has(x)) shared++
      return { c, score: shared / Math.max(1, Math.min(w.size, cw.size)) }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => `"${clip(x.c)}"`)
}
const nearMsg = (want: string, cands: string[]) => {
  const n = nearest(want, cands)
  return n.length ? `\n    nearest: ${n.join('\n             ')}` : ''
}

/** The section [at, end) of the unique heading `text`, or a refusal naming the nearest headings. */
function findSection(kids: Node[], text: string, fresh: WeakSet<object>, what: string, booking: BookingTarget | null): { at: number; end: number } {
  const want = target(text, what, 'heading')
  const matches = kids.map((n, i) => (n.type === 'heading' && norm(nodeText(n)) === want ? i : -1)).filter((i) => i >= 0)
  if (matches.length === 0) throw new Error(`${what}: heading not found: "${text}"${nearMsg(text, kids.filter((n) => n.type === 'heading').map(nodeText))}`)
  if (matches.length > 1) throw new Error(`${what}: heading "${text}" appears ${matches.length} times — make it unique first`)
  const at = matches[0]
  const end = sectionEnd(kids, at, booking)
  if (kids.slice(at, end).some((n) => fresh.has(n))) throw new Error(`${what}: "${text}" holds content written by an earlier operation — combine the two operations`)
  return { at, end }
}

/**
 * Apply `replace` operations in order. Only the replacement HTML goes through HTML → Lexical; every other
 * node keeps its stored object. Returns the new document and, per operation, the ORIGINAL nodes removed
 * (the link/image guard allows exactly their links and images to disappear).
 * `booking`: the post's booking page (bookingTargetFor), so no section runs into the trailing booking CTA.
 */
export function applyReplace(content: Doc, ops: ReplaceOp[], booking: BookingTarget | null = null): { content: Doc; steps: ReplaceStep[] } {
  let kids = [...content.root.children]
  const fresh = new WeakSet<object>() // nodes written by an earlier op — a later op may not target them
  // Every descendant too: a later text op can target a list item inside a list an earlier op wrote, and the diff would
  // then show "REMOVED" text that was never live (review, Nov 2026).
  const markFresh = (n: Node) => { fresh.add(n); (n.children || []).forEach(markFresh) }
  const steps: ReplaceStep[] = []
  ops.forEach((op, idx) => {
    const what = `replace[${idx}]`
    let removed: Node[] = []
    let added: Node[] = []
    let label: string
    if ('remove' in op) {
      const { at, end } = findSection(kids, op.remove, fresh, what, booking)
      removed = kids.slice(at, end)
      kids = [...kids.slice(0, at), ...kids.slice(end)]
      label = `remove section "${op.remove}" (${removed.length} block${removed.length === 1 ? '' : 's'})`
    } else if ('section' in op) {
      const { at, end } = findSection(kids, op.section, fresh, what, booking)
      const head = kids[at]
      added = convertNew(op.html, what)
      if (!added.length) throw new Error(`${what}: the html for "${op.section}" converts to nothing — use { "remove": … } to drop a section`)
      const sub = added.find((n) => n.type === 'heading' && LEVEL(n) <= LEVEL(head))
      if (sub) throw new Error(`${what}: the html for "${op.section}" has an <${sub.tag}>, the same or a higher level than the section's <${head.tag}> — it would split the section`)
      removed = kids.slice(at + 1, end)
      // Case-insensitive to FIND the heading, case-sensitive to decide a rename ("parking rates" → "Parking Rates" renames).
      const rename = op.heading !== undefined && collapse(op.heading) !== collapse(nodeText(head))
      if (rename) {
        const tag = head.tag || 'h2'
        const renamed = parseNodes(`<${tag}>${op.heading!.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</${tag}>`)
        removed = [head, ...removed]
        added = [...renamed, ...added]
        kids = [...kids.slice(0, at), ...added, ...kids.slice(end)]
      } else {
        kids = [...kids.slice(0, at + 1), ...added, ...kids.slice(end)]
      }
      if (collapse(toHtml(removed)) === collapse(toHtml(added))) throw new Error(`${what}: section "${op.section}" already has exactly this content — nothing to replace`)
      label = `replace section "${op.section}"${rename ? ` (renamed "${op.heading}")` : ''}`
    } else {
      const want = target(op.text, what, 'text')
      const hits: { top: number; item?: number }[] = []
      const cands: string[] = []
      kids.forEach((n, i) => {
        if (n.type === 'heading') return
        cands.push(blockText(n))
        if (norm(blockText(n)) === want) hits.push({ top: i })
        // A one-item list is the same block as its item: it counts once, as the list.
        if (n.type === 'list' && (n.children || []).length > 1) (n.children || []).forEach((li, j) => {
          cands.push(blockText(li))
          if (li.type === 'listitem' && norm(blockText(li)) === want) hits.push({ top: i, item: j })
        })
      })
      if (hits.length === 0) throw new Error(`${what}: no block has exactly this text: "${clip(op.text)}"${nearMsg(op.text, cands)}`)
      if (hits.length > 1) throw new Error(`${what}: ${hits.length} blocks have exactly this text: "${clip(op.text)}" — replace its section instead, or make it unique first`)
      const { top, item } = hits[0]
      const block = kids[top]
      if (fresh.has(block) && item === undefined) throw new Error(`${what}: "${clip(op.text)}" was written by an earlier operation — combine the two operations`)
      if (item === undefined) {
        removed = [block]
        added = convertNew(op.html, what)
        kids = [...kids.slice(0, top), ...added, ...kids.slice(top + 1)]
        label = `${added.length ? 'replace' : 'delete'} ${block.type} "${clip(blockText(block), 60)}"`
      } else {
        const items = block.children || []
        if (fresh.has(items[item])) throw new Error(`${what}: "${clip(op.text)}" was written by an earlier operation — combine the two operations`)
        removed = [items[item]]
        const html = op.html.trim()
        const tag = block.tag || 'ul'
        const conv = html ? parseNodes(`<${tag}>${/^<li[\s>]/i.test(html) ? html : `<li>${html}</li>`}</${tag}>`) : []
        // Html that closes the list ("<li>New</li></ul><p>Note</p><ul><li>Other</li>") converts to several blocks, and
        // all but the first list were dropped without a word (review round 2, Nov 2026).
        if (conv.length > 1 || (conv.length === 1 && conv[0].type !== 'list')) throw new Error(`${what}: the replacement list item's html leaves the list (it converts to ${conv.length} blocks) — give only <li>…</li> items or inline html, or replace the whole list or section`)
        const parsed = (conv[0]?.children as Node[] | undefined) || []
        if (html && !parsed.length) throw new Error(`${what}: the replacement list item converts to nothing`)
        // Only the items kept count: html that escapes the list would otherwise carry its links in nodes we drop.
        refuseLostRefs(html, parsed, what)
        // Renumber FIRST, then protect the nodes actually in the tree: renumbering copies an item, so
        // protecting the pre-copy objects would let a later op target what this one wrote (review, Nov 2026).
        const nextItems = [...items.slice(0, item), ...parsed, ...items.slice(item + 1)]
          .map((li, k) => (li.type === 'listitem' && li.value !== k + 1 ? { ...li, value: k + 1 } : li))
        // A table-pattern list must stay one: an item without the same bold labels (or a table left with one row)
        // turns the comparison table on the site back into bullets (review, Nov 2026).
        if (isTablePatternList(block) && !isTablePatternList({ ...block, children: nextItems })) {
          const labels = tableLabels(items[0])
          throw new Error(`${what}: this list shows on the site as a table (columns ${labels.map((l) => `"${l}"`).join(', ')}); the edit would turn it back into bullets. Every item needs the same bold labels, e.g. <li>${labels.map((l) => `<strong>${l}:</strong> …`).join(' | ')}</li>, and the list at least two items — or replace the whole list or section`)
        }
        added = nextItems.slice(item, item + parsed.length)
        if (nextItems.length === 0) {
          kids = [...kids.slice(0, top), ...kids.slice(top + 1)]
        } else {
          const nextList = { ...block, children: nextItems }
          fresh.add(nextList)
          kids = [...kids.slice(0, top), nextList, ...kids.slice(top + 1)]
        }
        label = `${added.length ? 'replace' : 'delete'} list item "${clip(blockText(removed[0]), 60)}"`
      }
    }
    if (removed.length === 0 && added.length === 0) throw new Error(`${what}: changes nothing`)
    added.forEach(markFresh)
    steps.push({ label: `${what} ${label}`, removed, added, removedHtml: toHtml(removed), addedHtml: toHtml(added) })
  })
  return { content: { ...content, root: { ...content.root, children: kids } }, steps }
}

/** Link URLs and media ids anywhere below `nodes`, as "link:<url>" / "image:<id>" keys with counts. */
export function mediaRefs(nodes: Node[]): Map<string, number> {
  const out = new Map<string, number>()
  const add = (k: string) => out.set(k, (out.get(k) ?? 0) + 1)
  const walk = (n: Node) => {
    if (n.type === 'link' || n.type === 'autolink') add(`link:${(n.fields as { url?: string } | undefined)?.url ?? (n as { url?: string }).url ?? ''}`)
    if (n.type === 'upload') add(`image:${readUploadValue(n.value).id ?? JSON.stringify(n.value)}`)
    for (const c of n.children || []) walk(c)
  }
  nodes.forEach(walk)
  return out
}

/** Body + FAQ text for the stamp rule (stamp.ts: links, titles, CTAs and metadata are not facts). */
export function bodyFactsText(p: PostLike): string {
  return [lexicalText(p.content), ...(p.faqItems || []).map((f) => `${f.question} ${f.answer}`)].join('\n')
}

function sameSeo(a: PostLike['seo'], b: { metaTitle?: string; metaDescription?: string }): boolean {
  return (a?.metaTitle ?? undefined) === (b.metaTitle ?? a?.metaTitle ?? undefined) && (a?.metaDescription ?? undefined) === (b.metaDescription ?? a?.metaDescription ?? undefined)
}

export function applyEdit(post: PostLike, edit: EditSpec): EditResult {
  const patch: Record<string, unknown> = {}
  const after: PostLike = JSON.parse(JSON.stringify(post))
  const fieldText: string[] = []
  const f = edit.fields || {}
  if (f.title !== undefined && f.title !== post.title) { patch.title = after.title = f.title; fieldText.push(f.title) }
  if (f.excerpt !== undefined && f.excerpt !== post.excerpt) { patch.excerpt = after.excerpt = f.excerpt; fieldText.push(f.excerpt) }
  if (f.seo && !sameSeo(post.seo, f.seo)) {
    after.seo = { ...(post.seo || {}), ...f.seo }
    patch.seo = after.seo
    fieldText.push(f.seo.metaTitle || '', f.seo.metaDescription || '')
  }
  if (f.faqItems) {
    const next = f.faqItems.map(({ question, answer }) => ({ question, answer }))
    const same = JSON.stringify(next) === JSON.stringify((post.faqItems || []).map(({ question, answer }) => ({ question, answer })))
    if (!same) {
      after.faqItems = next
      patch.faqItems = next
      const had = new Set((post.faqItems || []).map((x) => `${x.question}\u0000${x.answer}`))
      fieldText.push(...next.filter((x) => !had.has(`${x.question}\u0000${x.answer}`)).map((x) => `${x.question} ${x.answer}`))
    }
  }
  // The airport's booking page, so no section (and no insert at "end") runs into the trailing booking CTA.
  const booking = bookingTargetFor(post.airportCode)
  let replaced: ReplaceStep[] = []
  let inserted: Node[] = []
  if (edit.replace) {
    const r = applyReplace(post.content, edit.replace, booking)
    after.content = r.content
    replaced = r.steps
    patch.content = after.content
  }
  if (edit.insert) {
    const ins = insertSection(after.content, edit.insert.underHeading, edit.insert.html, edit.insert.position, booking)
    after.content = ins.content
    inserted = ins.nodes
    patch.content = after.content
  }
  return { patch, after, fieldText: fieldText.filter(Boolean).join('\n'), factsDiff: factsDiff(bodyFactsText(post), bodyFactsText(after)), replaced, inserted }
}

/**
 * Link/image guard: the edit may add links and images, never lose one — except the links and images inside
 * `removed` (content a replace operation took out on purpose), which may go, and only those. Compared by
 * URL / media id, so a new link never masks the loss of a different one.
 */
export function guardLoss(before: Doc, after: Doc, removed: Node[] = []): string | null {
  const want = mediaRefs(before.root.children)
  for (const [k, n] of mediaRefs(removed)) want.set(k, (want.get(k) ?? 0) - n)
  const have = mediaRefs(after.root.children)
  const lost = [...want].filter(([k, n]) => (have.get(k) ?? 0) < n).map(([k]) => k)
  if (!lost.length) return null
  const count = (d: Doc, t: string) => countNodesOfType(d as Parameters<typeof countNodesOfType>[0], t)
  const lb = count(before, 'link') + count(before, 'autolink'), la = count(after, 'link') + count(after, 'autolink')
  const ub = count(before, 'upload'), ua = count(after, 'upload')
  const links = lost.filter((k) => k.startsWith('link:')), images = lost.filter((k) => k.startsWith('image:'))
  const beyond = removed.length ? ' beyond the removed content' : ''
  return [
    links.length ? `links ${lb} → ${la}${beyond} (lost: ${links.map((k) => k.slice(5)).join(', ')})` : '',
    images.length ? `images ${ub} → ${ua}${beyond} (lost media: ${images.map((k) => k.slice(6)).join(', ')})` : '',
  ].filter(Boolean).join('; ')
}

/**
 * The other direction of guardLoss, for the post-save check: links and images live on the post beyond what the edit
 * meant to leave (a link or image it removed that is still there). null = none.
 */
export function refsNotRemoved(intended: Doc, live: Doc): string | null {
  const want = mediaRefs(intended.root.children)
  const extra = [...mediaRefs(live.root.children)].filter(([k, n]) => n > (want.get(k) ?? 0))
    .map(([k]) => (k.startsWith('link:') ? `link ${k.slice(5)}` : `image ${k.slice(6)}`))
  return extra.length ? extra.join(', ') : null
}

/**
 * Does a link NODE in `content` point at the booking page `path` (isBookingUrl: our host, that exact path)? Link nodes
 * only: hasBookingLink also counts the path written as plain text, which is right for not appending a second CTA but
 * would hide a lost one here.
 */
const linksTo = (content: Doc, path: string) => [...mediaRefs(content.root.children).keys()].some((k) => k.startsWith('link:') && isBookingUrl(k.slice(5), path))

/** Every original node a replace took out (the guard's allowance). */
export const removedNodes = (steps: ReplaceStep[]): Node[] => steps.flatMap((st) => st.removed)

/** Human lines for the links and images a replace removes on purpose (preview log + .diff.txt). */
export function removedRefsReport(steps: ReplaceStep[]): string[] {
  const out: string[] = []
  for (const st of steps) {
    const back = mediaRefs(st.added) // a link the new html puts back is not removed
    for (const [k, n] of mediaRefs(st.removed)) {
      for (let i = back.get(k) ?? 0; i < n; i++) out.push(`${k.startsWith('link:') ? 'link' : 'image'} ${k.slice(k.indexOf(':') + 1)}  (${st.label})`)
    }
  }
  return out
}

/** The removed and added text of every replace step, for the top of .diff.txt. */
export function replaceDiff(steps: ReplaceStep[]): string {
  const lines = (html: string) => html.split(/<\/(?:p|h[1-6]|li|td|th|tr)>/i).map(stripTags).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return steps.map((st) => [
    `=== ${st.label}`,
    ...lines(st.removedHtml).map((l) => `- REMOVED  ${l}`),
    ...lines(st.addedHtml).map((l) => `+ ADDED    ${l}`),
    ...removedRefsReport([st]).map((r) => `  ✂ removes ${r.replace(/\s+\(.*\)$/, '')}`),
  ].join('\n')).join('\n\n')
}

/** Line diff of the plain text for the preview file — counts occurrences, so a repeated line shows up. */
export function textDiff(a: string, b: string): string {
  const tally = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>())
  const A = tally(a.split('\n')), B = tally(b.split('\n'))
  const out: string[] = []
  for (const [l, n] of A) for (let i = (B.get(l) ?? 0); i < n; i++) out.push(`- ${l}`)
  for (const [l, n] of B) for (let i = (A.get(l) ?? 0); i < n; i++) out.push(`+ ${l}`)
  return out.join('\n')
}

function postText(p: PostLike): string {
  return [p.title, p.excerpt, p.seo?.metaTitle, p.seo?.metaDescription,
    // One line per block so sentence splitting never glues a heading to the next paragraph.
    ...lexicalToHtml(p.content as Parameters<typeof lexicalToHtml>[0]).split(/<\/(?:p|h[1-6]|li|td|th|tr)>/i).map(stripTags).filter(Boolean),
    ...(p.faqItems || []).map((f) => `${f.question} ${f.answer}`)].filter(Boolean).join('\n')
}

/**
 * A body reduced to what a reader sees, for comparing a stored post with the content we sent: block structure, node
 * types, heading/list tags, table header cells, text with its bold/italic format, link URLs, media ids, and the
 * headers and cells of a list the site draws as a table (isTablePatternList). Engine
 * defaults (version, direction, indent, textStyle, list numbering…), JSONB key order and the depth of an upload's
 * `value` are ignored, and adjacent text runs with one format are joined and empty runs dropped, in case the CMS
 * normalises them. Plain text alone (lexicalText) let "paragraph + image" and "paragraph" compare equal, so a
 * settle after a thrown PATCH reported the unchanged post as applied (review, Nov 2026).
 */
export function canonicalContent(content: unknown): string {
  const nodes = (content as { root?: { children?: unknown } } | null)?.root?.children
  return JSON.stringify(Array.isArray(nodes) ? canonNodes(nodes as Node[]) : null)
}
type Canon = { t: string; f?: number; x?: string; tag?: string; list?: string; url?: string; media?: string; header?: unknown; table?: { headers: string[]; rows: string[][] }; c?: Canon[] }
function canonNodes(nodes: Node[]): Canon[] {
  const out: Canon[] = []
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    if (n.type === 'text') {
      const x = n.text ?? ''
      const f = typeof n.format === 'number' ? n.format : 0
      const prev = out[out.length - 1]
      if (!x) continue
      if (prev && prev.t === 'text' && prev.f === f) prev.x = (prev.x ?? '') + x
      else out.push({ t: 'text', f, x })
      continue
    }
    const c: Canon = { t: n.type }
    if (n.tag) c.tag = n.tag
    if (typeof n.listType === 'string') c.list = n.listType
    // Joining text runs erases the run boundary the site's table detection reads ("Lot:" + "A" as two bold runs is a
    // table label, "Lot: A" as one is not), so a list's table form is taken from the unjoined runs (review round 2).
    if (n.type === 'list' && isTablePatternList(n)) c.table = tableData(n)
    if (n.type === 'link' || n.type === 'autolink') c.url = (n.fields as { url?: string } | undefined)?.url ?? (n as { url?: string }).url ?? ''
    if (n.type === 'upload') c.media = readUploadValue(n.value).id ?? JSON.stringify(n.value)
    if (n.type === 'tablecell') c.header = n.headerState ?? 0
    if (Array.isArray(n.children)) c.c = canonNodes(n.children)
    out.push(c)
  }
  return out
}

/**
 * Is every field of `patch` live on `live`? Unlike perf-apply's editIsLive, this compares EVERYTHING this
 * command can send: title, excerpt, seo, full FAQ pairs, the body (canonicalContent: structure, links and images,
 * not just text), and the stamp. A refused excerpt-only PATCH had been reported "applied + verified" (pass-2 review of #142).
 */
export function editLive(live: PostLike & { contentUpdatedAt?: string }, patch: Record<string, unknown>): boolean {
  if (patch.title !== undefined && live.title !== patch.title) return false
  if (patch.excerpt !== undefined && (live.excerpt ?? '') !== patch.excerpt) return false
  if (patch.seo !== undefined) {
    const want = patch.seo as { metaTitle?: string; metaDescription?: string }
    if ((live.seo?.metaTitle ?? '') !== (want.metaTitle ?? '') || (live.seo?.metaDescription ?? '') !== (want.metaDescription ?? '')) return false
  }
  if (patch.faqItems !== undefined) {
    const a = (live.faqItems || []).map((f) => `${f.question}\u0000${f.answer}`)
    const b = (patch.faqItems as { question: string; answer: string }[]).map((f) => `${f.question}\u0000${f.answer}`)
    if (JSON.stringify(a) !== JSON.stringify(b)) return false
  }
  if (patch.content !== undefined && canonicalContent(live.content) !== canonicalContent(patch.content)) return false
  if (patch.contentUpdatedAt !== undefined && live.contentUpdatedAt !== patch.contentUpdatedAt) return false
  return true
}

export interface CheckResult {
  blockers: string[]
  warnings: LintFinding[]
  preexisting: LintFinding[]
  /** Figures in the RESULTING body (outside the new html) that the allow-list does not hold — stale prices the edit left in. */
  remainingPrices: string[]
  /** Links and images a replace removes on purpose (the guard allows exactly these). */
  removedRefs: string[]
  /** The result has no link to the airport's booking page though the live post had one, and edit.json allowed it. */
  bookingLinkRemoved: boolean
  /** Checks that could not run, each "<check> NOT RUN: <reason>" — printed, and written to .diff.txt and .meta.json. */
  notRun: string[]
}

// ── Unsold lot names ────────────────────────────────────────────────────────
/** A lot we don't sell at the airport, as its data file names it, plus any human-added `aliases` ("NALTP"). */
export interface UnsoldLot { name: string; aliases?: readonly string[] }
/** The airport file's lots, as checkEdit needs them (lotNamesFor builds it from the data file). */
export interface LotNames {
  unsellable: readonly UnsoldLot[]
  sellable: readonly string[]
  /** The airport's code and full-name words ("EWR", "Newark", "Liberty"…): with parking words, they make a name generic. */
  airportWords: readonly string[]
}

/**
 * The airport file's lots for the unsold-name check, or null when there is no data file (the check then says NOT RUN).
 * Read raw, because loadAirportData drops the unsold lots' other fields (`aliases`); the sold/unsold split is
 * loadAirportData's own (airportPageLots).
 */
export function lotNamesFor(code: string): LotNames | null {
  const raw = loadParkingLots(code)
  if (!raw) return null
  const { lots } = airportPageLots({ code: code.toUpperCase(), parkingLots: raw })
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return {
    unsellable: raw.filter((l) => !lots.includes(l) && typeof l.name === 'string').map((l) => ({ name: l.name as string, aliases: strings(l.aliases) })),
    sellable: lots.map((l) => String(l.name ?? '')),
    airportWords: [code, ...airportFullName(code).split(/[^A-Za-z0-9]+/)].filter(Boolean),
  }
}

// Words any parking name is made of. A name of only these and the airport's own words ("Newark Airport Long Term
// Parking", "SDF Valet Parking") is how a guide or the airport describes parking, not only a lot's brand.
const GENERIC_LOT_WORDS = new Set(['airport', 'airports', 'parking', 'park', 'long', 'short', 'term', 'economy', 'daily', 'hourly', 'garage', 'garages', 'lot', 'lots', 'terminal', 'terminals', 'international', 'valet', 'self', 'covered', 'uncovered', 'cell', 'phone', 'waiting', 'remote', 'satellite', 'north', 'south', 'east', 'west', 'the', 'and', 'of', 'at', 'a'])

/** A lot name with its parenthetical ("(DTW)", "(Park Sleep Fly)") removed: the phrase prose uses for it. */
const lotPhrase = (name: string) => name.replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()

function isGenericLotName(phrase: string, airportWords: readonly string[]): boolean {
  const own = new Set(airportWords.map((w) => w.toLowerCase()).filter((w) => !GENERIC_LOT_WORDS.has(w)))
  const words = phrase.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  // A number is generic in the airport's own numbered lots ("SJC Daily Lot 4"), not in a brand ("Parking 4 Airport").
  const official = words.some((w) => own.has(w))
  return words.every((w) => GENERIC_LOT_WORDS.has(w) || own.has(w) || (official && /^\d+$/.test(w)))
}

/**
 * A lot name matched as a proper noun: every word in order, a hyphen or spaces between them, each capital where the
 * name has one (an all-caps word stays all caps) and a leading "The", "the" or "THE". So "Deal Airport Parking" never
 * matches "a good deal", "US Park" never "let us park", "The Parking Spot" never "the parking spot you booked".
 */
export function lotNameRe(name: string): RegExp {
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const loose = (c: string) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : esc(c))
  const word = (w: string, i: number) => {
    if (/^[A-Z]{2,}$/.test(w)) return w
    if (i === 0 && /^the$/i.test(w)) return '(?:[Tt]he|THE)'
    return [...w].map((c, k) => (k === 0 && /[A-Z]/.test(c) ? c : loose(c))).join('')
  }
  return new RegExp(`(?<![A-Za-z0-9])${name.trim().split(/[\s-]+/).filter(Boolean).map(word).join('[\\s-]+')}(?![A-Za-z0-9])`)
}

/**
 * The unsold lots `text` names. block: the lot's name without its parenthetical, or an alias, as a proper noun. warn:
 * a name made only of generic words (an EWR guide is titled "Newark Airport Long Term Parking" too). A name that is part
 * of a lot we DO sell names that lot, not this one; both sides are matched hyphen-or-space alike ("Dallas-Fort Worth").
 * Deliberately narrower than the writer prompt's brand-key rule (dropOffSiteSentences, unchanged): that key is
 * "airlines" for "Airlines Parking (DTW)" and "deal" for "Deal Airport Parking (MIA)", fine for dropping a sentence
 * from a prompt but not for blocking an edit over "all other airlines" (review round 2, Nov 2026).
 */
export function unsoldLotsNamed(text: string, lots: LotNames): { block: string[]; warn: string[] } {
  const block: string[] = [], warn: string[] = []
  const names = (form: string) => {
    const re = lotNameRe(form)
    return form.length >= 3 && !lots.sellable.some((s) => re.test(s)) && re.test(text)
  }
  for (const lot of lots.unsellable) {
    const phrase = lotPhrase(lot.name)
    const alias = (lot.aliases ?? []).map((a) => a.trim()).find(names)
    if (alias) block.push(`"${lot.name}" (as "${alias}")`)
    else if (names(phrase)) (isGenericLotName(phrase, lots.airportWords) ? warn : block).push(`"${lot.name}"`)
  }
  return { block, warn }
}

/** Split raw html at every block-level tag, open or close, so each piece is one block's own text (and links). */
const BLOCK_TAG = /<\/?(?:p|li|td|th|tr|h[1-6]|blockquote|div|section|article|header|footer|main|aside|nav|figure|figcaption|table|thead|tbody|tfoot|caption|ul|ol|dl|dt|dd|pre)\b[^>]*>/i
const rawBlocks = (html: string): string[] => html.split(new RegExp(BLOCK_TAG.source, 'gi'))

/**
 * Every gate in one place: the lint on the result (errors already present in the live post are
 * reported, not blocking), the price check on the new material (blocking) and on the whole resulting body
 * (reported: figures still in the post that the allow-list lacks), the link/image guard (links and images
 * inside content a replace removed may go; nothing else may), the booking-link backstop, and the unsold-lot names.
 * `lots`: lotNamesFor(post.airportCode); null = no data file, and the unsold-name check reports NOT RUN.
 */
export function checkEdit(post: PostLike, res: EditResult, edit: EditSpec, known: ReadonlySet<number> | null, lots: LotNames | null = { unsellable: [], sellable: [], airportWords: [] }, codeFigures: Record<string, number[]> = loadApprovedOfferFigures()): CheckResult {
  const lintOf = (p: PostLike) => lintArticle({
    title: p.title, metaTitle: p.seo?.metaTitle, metaDescription: p.seo?.metaDescription,
    html: lexicalToHtml(p.content as Parameters<typeof lexicalToHtml>[0]), excerpt: p.excerpt,
    faqItems: p.faqItems, keyword: post.slug.replace(/-/g, ' '), slug: post.slug, isNew: false,
    knownFigures: known ? [...known].map((c) => c / 100) : undefined,
  })
  const before = lintOf(post), after = lintOf(res.after)
  const key = (e: LintFinding) => `${e.rule}|${e.message}`
  // Baseline = EVERY error in the live post, not just the first match per rule: the lint reports one match
  // per rule (with the matched text in the message), so fixing block A would surface an untouched old claim
  // in block B as "new" and block the edit. Linting each block on its own collects all of them.
  const old = new Set([...before.errors, ...baselineErrors(post, known)].map(key))
  const preexisting = after.errors.filter((e) => old.has(key(e)))
  // New material = the inserted section + everything a replace writes (renamed headings included): each converted
  // node on its own, and the html as written, split at every block tag. Conversion merges the <p>s of a <blockquote>,
  // so a converted node can hold a source link the author put in a different paragraph; and one joined string let a
  // block borrow another block's link (review, Nov 2026).
  const newNodes = [...res.inserted, ...res.replaced.flatMap((st) => st.added)]
  const rawHtml = [edit.insert?.html ?? '', ...(edit.replace ?? []).map((op) => ('html' in op ? op.html : ''))].filter((h) => h.trim())
  const blocks = [...newNodes.map((n) => toHtml([n])), ...rawHtml.flatMap(rawBlocks)]
  const insertedHtml = [...rawHtml, ...newNodes.map((n) => toHtml([n]))].join('\n')
  const newText = stripTags(blocks.join('\n'))
  // The NEW material is linted on its own too: the lint reports only the first match per rule, so a new
  // "save up to 70%" after an old "save up to 60%" reads as the same, pre-existing error (pass-2 review).
  // Its promo-code gate comes from the whole post: "SpotHero's SPOT10 offer…" names no promo word itself, and the
  // whole-post lint called it pre-existing when the live post already printed SPOT10 (review, Nov 2026).
  const promoContext = PROMO_WORD.test(postText(post)) || PROMO_WORD.test(postText(res.after))
  const f = edit.fields || {}
  const seo = res.patch.seo as { metaTitle?: string; metaDescription?: string } | undefined
  const faqNew = res.patch.faqItems
    ? (res.patch.faqItems as { question: string; answer: string }[]).filter((x) => !(post.faqItems || []).some((o) => o.question === x.question && o.answer === x.answer))
    : undefined
  const fresh = [
    ...after.errors.filter((e) => !old.has(key(e))),
    // Only what the edit CHANGES: an error in the old title or old meta is pre-existing, never a blocker (pass-3 review).
    ...lintArticle({
      title: (res.patch.title as string | undefined) ?? '',
      metaTitle: seo && f.seo?.metaTitle !== undefined && f.seo.metaTitle !== post.seo?.metaTitle ? seo.metaTitle : undefined,
      metaDescription: seo && f.seo?.metaDescription !== undefined && f.seo.metaDescription !== post.seo?.metaDescription ? seo.metaDescription : undefined,
      html: insertedHtml, excerpt: res.patch.excerpt as string | undefined, faqItems: faqNew,
      keyword: post.slug.replace(/-/g, ' '), slug: post.slug, isNew: false, promoContext,
      knownFigures: known ? [...known].map((c) => c / 100) : undefined,
    }).errors,
  ].filter((e, i, arr) => arr.findIndex((x) => key(x) === key(e)) === i)
  const hasPrice = /(?:C\$|CA\$|US\$|\$)\s?\d/.test(`${newText}\n${res.fieldText}`)
  const unique = (xs: string[]) => [...new Set(xs)]
  // A flat-amount code's own terms ("DFW5: $5 off, $25 minimum") are sourced by the code, but only in the block that
  // names it: one allowance for the whole edit let a "$25/day" lot price in another paragraph pass (review, Nov 2026).
  const allowFor = (html: string, k: ReadonlySet<number>): ReadonlySet<number> => {
    const text = stripTags(html)
    const figs = Object.keys(codeFigures).filter((c) => new RegExp(`\\b${c.replace(/[^A-Z0-9]/gi, '')}\\b`, 'i').test(text))
      .flatMap((c) => codeFigures[c].map((n) => Math.round(n * 100)))
    return figs.length ? new Set([...k, ...figs]) : k
  }
  const badPrices = known ? unique([...blocks.flatMap((b) => priceCheck(b, '', allowFor(b, known))), ...priceCheck('', res.fieldText, allowFor(res.fieldText, known))]) : []
  const loss = guardLoss(post.content, res.after.content, removedNodes(res.replaced))
  // The whole resulting body, so a stale figure the edit did NOT remove is still caught (reported, not blocking:
  // old posts carry computed totals the allow-list never holds, and this edit may be fixing one block of many).
  // Block by block (each root node), like the new material: one joined body let a quote borrow the next paragraph's link.
  // Same code allowance, so a code's own terms aren't reported as stale on every later edit of the post.
  const remainingPrices = known && res.patch.content !== undefined
    ? unique(res.after.content.root.children.flatMap((n) => { const html = toHtml([n]); return priceCheck(html, '', allowFor(html, known)) })).filter((x) => !badPrices.includes(x))
    : []
  // Backstop for the booking CTA (sectionEnd keeps sections off it; a text op can still target it): the result must
  // still link the airport's booking page if the live post did, unless edit.json says the removal is meant.
  const booking = bookingTargetFor(post.airportCode)
  const bookingLinkGone = !!booking && linksTo(post.content, booking.path) && !linksTo(res.after.content, booking.path)
  // Never name a lot we don't sell (review lesson 2): new html, new headings and new field text.
  const unsold = lots ? unsoldLotsNamed(`${newText}\n${res.fieldText}`, lots) : { block: [], warn: [] }
  const unsoldWarnings: LintFinding[] = unsold.warn.map((n) => ({ level: 'warn', rule: 'unsold-lot-name', message: `names ${n}, a lot we don't sell at ${post.airportCode} — the name is also generic wording, so it is not blocked: check the new text is not about that lot` }))
  // A check that could not run is said out loud, never left as an empty list that reads as "nothing found".
  const why = post.airportCode ? `no data/airports/${post.airportCode}.json` : 'the post has no airportCode'
  const notRun = [
    ...(!known && res.patch.content !== undefined ? [`whole-body price check NOT RUN: ${why}`] : []),
    ...(!lots && (newText.trim() || res.fieldText) ? [`unsold lot-name check NOT RUN: ${why}`] : []),
    // With an airportCode but no booking page there is no link to protect; with no airportCode we can't tell.
    ...(!post.airportCode && res.patch.content !== undefined ? ['booking-link check NOT RUN: the post has no airportCode'] : []),
  ]
  const blockers = [
    ...fresh.map((e) => `lint ${e.rule}: ${e.message}`),
    ...(badPrices.length ? [`price check: ${badPrices.join(', ')} not in the figures the writer may use for ${post.airportCode} and not in a paragraph with an external source link`] : []),
    ...(!known && hasPrice ? [`price check: no data file for ${post.airportCode ?? '(no airportCode)'}; prices can't be checked`] : []),
    ...(loss ? [`would lose ${loss}`] : []),
    ...(unsold.block.length ? [`names a lot we don't sell at ${post.airportCode}: ${unsold.block.join(', ')} — never name or price an unsold lot`] : []),
    ...(bookingLinkGone && !edit.allowBookingLinkRemoval ? [`would remove the link to the booking page (${booking?.path}) — keep the "Compare … parking rates" paragraph, or set "allowBookingLinkRemoval": true in edit.json if that is meant`] : []),
  ]
  return { blockers, warnings: [...after.warnings, ...unsoldWarnings], preexisting, remainingPrices, removedRefs: removedRefsReport(res.replaced), bookingLinkRemoved: bookingLinkGone && !!edit.allowBookingLinkRemoval, notRun }
}

/** Lint every block of the live post on its own (list items and table cells too), so each block's errors are known. */
function baselineErrors(post: PostLike, known: ReadonlySet<number> | null): LintFinding[] {
  const approvedCodes = loadApprovedCodes(), approvedOffers = loadApprovedOffers()
  const units: Node[] = []
  const walk = (n: Node) => {
    units.push(n)
    if (['list', 'listitem', 'table', 'tablerow', 'tablecell', 'quote'].includes(n.type)) for (const c of n.children || []) if (c.children) walk(c)
  }
  post.content.root.children.forEach(walk)
  return units.flatMap((n) => lintArticle({
    title: '', html: toHtml([n]), keyword: post.slug.replace(/-/g, ' '), slug: post.slug, isNew: false,
    approvedCodes, approvedOffers, knownFigures: known ? [...known].map((c) => c / 100) : undefined,
  }).errors)
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

export interface PreviewMeta { slug: string; id: string | number; updatedAt?: string; editHash: string; patchHash: string; at: string }

/** Why an --apply may not proceed on this preview ('' = it may): same post, unchanged, same edit, same patch. */
export function previewMismatch(meta: Partial<PreviewMeta> | null, now: PreviewMeta): string {
  if (!meta) return 'no preview for this slug — run --preview first'
  if (meta.slug !== now.slug || String(meta.id) !== String(now.id)) return `the preview is for ${meta.slug} (#${meta.id}), not ${now.slug} (#${now.id})`
  if (meta.updatedAt !== now.updatedAt) return `the live post changed since the preview (${meta.updatedAt} → ${now.updatedAt}) — re-run --preview`
  if (meta.editHash !== now.editHash) return 'edit.json changed since the preview — re-run --preview'
  if (meta.patchHash !== now.patchHash) return 'the edit now produces a different patch than the preview — re-run --preview'
  return ''
}

export interface ApplyDeps {
  updatePost: (id: string, data: Record<string, unknown>) => Promise<unknown>
  readPost: () => Promise<PostLike | null>
  editIsLive?: (live: PostLike, patch: Record<string, unknown>) => boolean
  log: (m: string) => void
}

/**
 * PATCH, and settle a throw by re-reading: withRetry means an earlier attempt may have committed before
 * its response was lost (same model as settle-patch.ts). 'applied' = the edit is live (directly or
 * after a throw); 'not-live' = nothing committed; 'unknown' = the re-read failed too.
 */
export async function applyWithSettle(id: string, patch: Record<string, unknown>, deps: ApplyDeps): Promise<'applied' | 'not-live' | 'unknown'> {
  try {
    await deps.updatePost(id, patch)
    return 'applied'
  } catch (e) {
    deps.log(`  ⚠ PATCH threw (${e instanceof Error ? e.message : String(e)}) — re-reading the post to settle`)
    let live: PostLike | null
    try {
      live = await deps.readPost()
    } catch {
      return 'unknown'
    }
    return live && (deps.editIsLive ?? editLive)(live, patch) ? 'applied' : 'not-live'
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
  const slug = val('--slug'), editPath = val('--edit')
  const preview = args.includes('--preview'), apply = args.includes('--apply')
  if (!slug || !editPath || preview === apply) {
    console.error('Usage: tsx src/apply-edit.ts --slug <slug> --edit <edit.json> (--preview | --apply [--stamp])')
    process.exit(1)
  }
  const { updatePost, findPostBySlug } = await import('./payload.js')
  const { loadAirportData } = await import('./airport-data.js')
  const { pingIndexNow, postUrlFor } = await import('./indexnow.js')
  const { figureSource } = await import('./prompts/write.js')

  // Reads go through payloadFetch (30 s timeout + retry), any status, depth 0: at the default depth every
  // upload node carries the populated media doc, and the PATCH would write that copy back into the body.
  const read = async (): Promise<PostLike> => {
    const post = (await findPostBySlug(slug, { depth: 0 })) as PostLike | null
    if (!post) throw new Error(`no post with slug ${slug} (any status)`)
    return post
  }

  const editRaw = fs.readFileSync(editPath, 'utf-8')
  const edit = parseEdit(JSON.parse(editRaw))
  const post = await read()
  const res = applyEdit(post, edit)
  if (Object.keys(res.patch).length === 0) { console.log('Edit changes nothing.'); return }

  // The price allow-list is what the writer prompt sees for this airport, not every number in the file.
  const airportData = post.airportCode ? loadAirportData(post.airportCode) : null
  const known = airportData ? new Set(collectMoneyFigures(figureSource(airportData, slug.replace(/-/g, ' '))).map((n) => Math.round(n * 100))) : null
  const check = checkEdit(post, res, edit, known, post.airportCode ? lotNamesFor(post.airportCode) : null)
  const bookingNote = check.bookingLinkRemoved ? 'the edit removes the link to the booking page (allowed by "allowBookingLinkRemoval": true)' : ''

  console.log(`\n${post.slug} (#${post.id}, ${post.status})  fields: ${Object.keys(res.patch).join(', ')}`)
  console.log(`facts diff (body + FAQ): +${res.factsDiff.added.length} / -${res.factsDiff.removed.length}`)
  for (const st of res.replaced) console.log(`  ${st.label}`)
  for (const n of check.notRun) console.log(`  ⚠ ${n}`)
  if (bookingNote) console.log(`  ⚠ ${bookingNote}`)
  if (check.removedRefs.length) console.log(`  ✂ removed with the replaced content (allowed by the guard — check you meant it):\n    ${check.removedRefs.join('\n    ')}`)
  if (check.remainingPrices.length) console.log(`  ⚠ figures still in the post that are not in the ${post.airportCode} allow-list (stale or computed — check them): ${check.remainingPrices.join(', ')}`)
  if (check.warnings.length) console.log(formatLint({ ok: true, errors: [], warnings: check.warnings }))
  if (check.preexisting.length) console.log(`  (already in the live post, not blocking — fix with a replace edit or by hand in the CMS)\n${formatLint({ ok: true, errors: [], warnings: check.preexisting })}`)
  if (check.blockers.length) { console.log(`⛔ blocked:\n  ${check.blockers.join('\n  ')}`); process.exit(1) }

  fs.mkdirSync(PREVIEW_DIR, { recursive: true })
  const base = path.join(PREVIEW_DIR, slug)
  const now: PreviewMeta = { slug, id: post.id, updatedAt: post.updatedAt, editHash: sha256(editRaw), patchHash: sha256(JSON.stringify(res.patch)), at: new Date().toISOString() }
  if (preview) {
    fs.writeFileSync(`${base}.html`, `<h1>${res.after.title}</h1>\n${lexicalToHtml(res.after.content as Parameters<typeof lexicalToHtml>[0])}`)
    const head = [
      check.notRun.length ? `${check.notRun.join('\n')}\n` : '',
      bookingNote ? `BOOKING LINK: ${bookingNote}\n` : '',
      res.replaced.length ? `REPLACE OPERATIONS\n\n${replaceDiff(res.replaced)}\n` : '',
      check.remainingPrices.length ? `PRICE CHECK ON THE RESULTING BODY — figures still in the post, not in the ${post.airportCode} allow-list (not blocking): ${check.remainingPrices.join(', ')}\n` : '',
    ].filter(Boolean)
    fs.writeFileSync(`${base}.diff.txt`, [...head, `${head.length ? 'FULL TEXT DIFF\n\n' : ''}${textDiff(postText(post), postText(res.after))}`].join('\n'))
    fs.writeFileSync(`${base}.meta.json`, JSON.stringify({
      ...now, edit: path.resolve(editPath), factsDiff: res.factsDiff,
      ...(res.replaced.length ? { replaced: res.replaced.map((st) => st.label), removedRefs: check.removedRefs } : {}),
      ...(check.remainingPrices.length ? { remainingPrices: check.remainingPrices } : {}),
      ...(check.notRun.length ? { notRun: check.notRun } : {}),
      ...(check.bookingLinkRemoved ? { bookingLinkRemoved: true } : {}),
    }, null, 1))
    console.log(`✓ preview written: ${base}.html, .diff.txt — nothing sent to the CMS. Re-run with --apply.`)
    return
  }

  // --apply: the same post, unchanged, the same edit, the same patch as the preview a person looked at.
  const metaPath = `${base}.meta.json`
  const meta = fs.existsSync(metaPath) ? (JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Partial<PreviewMeta>) : null
  const why = previewMismatch(meta, now)
  if (why) { console.error(`⛔ ${why}`); process.exit(1) }

  const backup = `${base}.live-backup-${Date.now()}.json`
  fs.writeFileSync(backup, JSON.stringify(post))
  const patch = { ...res.patch, ...stampField({ factsChanged: res.factsDiff.changed, reason: `${res.factsDiff.added.length} fact sentence(s) added, ${res.factsDiff.removed.length} removed (body + FAQ)` }) }
  const outcome = await applyWithSettle(String(post.id), patch, {
    updatePost,
    readPost: async () => (await findPostBySlug(slug, { depth: 0 })) as PostLike | null,
    log: (m) => console.log(m),
  })
  if (outcome === 'not-live') { console.error(`⛔ the PATCH threw and the edit is not live at re-read (a late commit is still possible) — re-run --preview before retrying. Backup: ${backup}`); process.exit(1) }
  if (outcome === 'unknown') { console.error(`⛔ the PATCH threw AND the post could not be re-read — the edit may or may not be live. Check the CMS before retrying. Backup: ${backup}`); process.exit(1) }

  const back = await read()
  const lost = guardLoss(res.after.content, back.content)
  if (lost) { console.error(`POST-SAVE CHECK FAILED: ${lost}. Restore from ${backup}`); process.exit(1) }
  // Both directions: a link or image the edit removed that is still live means the body is not what was previewed.
  const kept = refsNotRemoved(res.after.content, back.content)
  if (kept) { console.error(`POST-SAVE CHECK FAILED: still live though the edit removed it: ${kept}. Compare with ${backup}`); process.exit(1) }
  if (!editLive(back, patch)) { console.error(`POST-SAVE CHECK FAILED: the re-read post does not carry every field of the patch (body compared by structure, links and images). Compare with ${backup}`); process.exit(1) }
  console.log(`✓ applied + verified (#${post.id})`)
  if (back.status === 'published') await pingIndexNow([postUrlFor(slug)])
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
