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
 *     ]
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
 *   nearest candidates. Operations run in order on the result of the previous one and may not touch
 *   content an earlier operation wrote. Replace runs before insert.
 *   Links and images inside REMOVED content are expected to go: the guard allows exactly those
 *   (by URL / media id) and still fails on any other loss; the preview log and .diff.txt list them.
 *   The new HTML gets the full price check (blocking); the price check also runs on the whole
 *   resulting body and lists figures still in the post that are not in the allow-list (warning).
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
import { htmlToLexical } from './html-to-lexical.js'
import { lexicalToHtml, countNodesOfType, readUploadValue } from './lexical-to-html.js'
import { lintArticle, formatLint, stripTags, priceCheck, collectMoneyFigures, type LintFinding } from './lint.js'
// P3 price check + allow-list live in lint.ts (generate uses them too, W1.8 P3c); re-exported for callers and tests.
export { priceCheck, collectMoneyFigures } from './lint.js'
import { stampField, factsDiff, lexicalText, type FactsDiff } from './stamp.js'

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
}

// ── Pure core ───────────────────────────────────────────────────────────────
function nodeText(n: Node): string {
  return n.text ?? (n.children || []).map(nodeText).join('')
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
const LEVEL = (n: Node) => (n.type === 'heading' && n.tag ? Number(n.tag.slice(1)) : 99)

/**
 * Insert `html` inside the section that starts at the heading whose text matches `underHeading`.
 * Refuses a heading that is missing or appears more than once, and an insert whose text is already in
 * that section (a retry after a lost PATCH response would otherwise add the section twice).
 */
export function insertUnderHeading(content: Doc, underHeading: string, html: string, position: 'start' | 'end' = 'end'): Doc {
  const kids = content.root.children
  const want = norm(underHeading)
  const matches = kids.map((n, i) => (n.type === 'heading' && norm(nodeText(n)) === want ? i : -1)).filter((i) => i >= 0)
  if (matches.length === 0) throw new Error(`heading not found: "${underHeading}"`)
  if (matches.length > 1) throw new Error(`heading "${underHeading}" appears ${matches.length} times — make it unique first`)
  const at = matches[0]
  const lvl = LEVEL(kids[at])
  let end = at + 1
  while (end < kids.length && LEVEL(kids[end]) > lvl) end++
  // Round-trip only the new section through JSON so it carries the same plain-object shape as the stored post.
  const nodes: Node[] = JSON.parse(JSON.stringify(htmlToLexical(html).root.children))
  const sectionText = norm(kids.slice(at + 1, end).map(nodeText).join(' '))
  const newText = norm(nodes.map(nodeText).join(' '))
  if (newText && sectionText.includes(newText)) throw new Error(`the inserted text is already under "${underHeading}" (possibly inside a longer paragraph) — nothing to add`)
  const insertAt = position === 'start' ? at + 1 : end
  return { ...content, root: { ...content.root, children: [...kids.slice(0, insertAt), ...nodes, ...kids.slice(insertAt)] } }
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
function findSection(kids: Node[], text: string, fresh: WeakSet<object>, what: string): { at: number; end: number } {
  const want = norm(text)
  const matches = kids.map((n, i) => (n.type === 'heading' && norm(nodeText(n)) === want ? i : -1)).filter((i) => i >= 0)
  if (matches.length === 0) throw new Error(`${what}: heading not found: "${text}"${nearMsg(text, kids.filter((n) => n.type === 'heading').map(nodeText))}`)
  if (matches.length > 1) throw new Error(`${what}: heading "${text}" appears ${matches.length} times — make it unique first`)
  const at = matches[0]
  const lvl = LEVEL(kids[at])
  let end = at + 1
  while (end < kids.length && LEVEL(kids[end]) > lvl) end++
  if (kids.slice(at, end).some((n) => fresh.has(n))) throw new Error(`${what}: "${text}" holds content written by an earlier operation — combine the two operations`)
  return { at, end }
}

/**
 * Apply `replace` operations in order. Only the replacement HTML goes through HTML → Lexical; every other
 * node keeps its stored object. Returns the new document and, per operation, the ORIGINAL nodes removed
 * (the link/image guard allows exactly their links and images to disappear).
 */
export function applyReplace(content: Doc, ops: ReplaceOp[]): { content: Doc; steps: ReplaceStep[] } {
  let kids = [...content.root.children]
  const fresh = new WeakSet<object>() // nodes written by an earlier op — a later op may not target them
  const steps: ReplaceStep[] = []
  ops.forEach((op, idx) => {
    const what = `replace[${idx}]`
    let removed: Node[] = []
    let added: Node[] = []
    let label: string
    if ('remove' in op) {
      const { at, end } = findSection(kids, op.remove, fresh, what)
      removed = kids.slice(at, end)
      kids = [...kids.slice(0, at), ...kids.slice(end)]
      label = `remove section "${op.remove}" (${removed.length} block${removed.length === 1 ? '' : 's'})`
    } else if ('section' in op) {
      const { at, end } = findSection(kids, op.section, fresh, what)
      const head = kids[at]
      added = parseNodes(op.html)
      if (!added.length) throw new Error(`${what}: the html for "${op.section}" converts to nothing — use { "remove": … } to drop a section`)
      const sub = added.find((n) => n.type === 'heading' && LEVEL(n) <= LEVEL(head))
      if (sub) throw new Error(`${what}: the html for "${op.section}" has an <${sub.tag}>, the same or a higher level than the section's <${head.tag}> — it would split the section`)
      removed = kids.slice(at + 1, end)
      const rename = op.heading !== undefined && norm(op.heading) !== norm(nodeText(head))
      if (rename) {
        const tag = head.tag || 'h2'
        const renamed = parseNodes(`<${tag}>${op.heading!.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</${tag}>`)
        removed = [head, ...removed]
        added = [...renamed, ...added]
        kids = [...kids.slice(0, at), ...added, ...kids.slice(end)]
      } else {
        kids = [...kids.slice(0, at + 1), ...added, ...kids.slice(end)]
      }
      if (norm(toHtml(removed)) === norm(toHtml(added))) throw new Error(`${what}: section "${op.section}" already has exactly this content — nothing to replace`)
      label = `replace section "${op.section}"${rename ? ` (renamed "${op.heading}")` : ''}`
    } else {
      const want = norm(op.text)
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
        added = parseNodes(op.html)
        kids = [...kids.slice(0, top), ...added, ...kids.slice(top + 1)]
        label = `${added.length ? 'replace' : 'delete'} ${block.type} "${clip(blockText(block), 60)}"`
      } else {
        const items = block.children || []
        if (fresh.has(items[item])) throw new Error(`${what}: "${clip(op.text)}" was written by an earlier operation — combine the two operations`)
        removed = [items[item]]
        const html = op.html.trim()
        const tag = block.tag || 'ul'
        added = html ? ((parseNodes(`<${tag}>${/^<li[\s>]/i.test(html) ? html : `<li>${html}</li>`}</${tag}>`)[0]?.children as Node[] | undefined) || []) : []
        if (html && !added.length) throw new Error(`${what}: the replacement list item converts to nothing`)
        const nextItems = [...items.slice(0, item), ...added, ...items.slice(item + 1)]
          .map((li, k) => (li.type === 'listitem' && li.value !== k + 1 ? { ...li, value: k + 1 } : li))
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
    added.forEach((n) => fresh.add(n))
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
  let replaced: ReplaceStep[] = []
  if (edit.replace) {
    const r = applyReplace(post.content, edit.replace)
    after.content = r.content
    replaced = r.steps
    patch.content = after.content
  }
  if (edit.insert) {
    after.content = insertUnderHeading(after.content, edit.insert.underHeading, edit.insert.html, edit.insert.position)
    patch.content = after.content
  }
  return { patch, after, fieldText: fieldText.filter(Boolean).join('\n'), factsDiff: factsDiff(bodyFactsText(post), bodyFactsText(after)), replaced }
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
 * Is every field of `patch` live on `live`? Unlike perf-apply's editIsLive, this compares EVERYTHING this
 * command can send: title, excerpt, seo, full FAQ pairs, body text, and the stamp. A refused excerpt-only
 * PATCH had been reported "applied + verified" (pass-2 review of #142).
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
  if (patch.content !== undefined && lexicalText(live.content) !== lexicalText(patch.content)) return false
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
}

/**
 * Every gate in one place: the lint on the result (errors already present in the live post are
 * reported, not blocking), the price check on the new material (blocking) and on the whole resulting body
 * (reported: figures still in the post that the allow-list lacks), the link/image guard (links and images
 * inside content a replace removed may go; nothing else may).
 */
export function checkEdit(post: PostLike, res: EditResult, edit: EditSpec, known: ReadonlySet<number> | null): CheckResult {
  const lintOf = (p: PostLike) => lintArticle({
    title: p.title, metaTitle: p.seo?.metaTitle, metaDescription: p.seo?.metaDescription,
    html: lexicalToHtml(p.content as Parameters<typeof lexicalToHtml>[0]), excerpt: p.excerpt,
    faqItems: p.faqItems, keyword: post.slug.replace(/-/g, ' '), slug: post.slug, isNew: false,
    knownFigures: known ? [...known].map((c) => c / 100) : undefined,
  })
  const before = lintOf(post), after = lintOf(res.after)
  const key = (e: LintFinding) => `${e.rule}|${e.message}`
  const old = new Set(before.errors.map(key))
  const preexisting = after.errors.filter((e) => old.has(key(e)))
  // New material = the inserted section + everything a replace writes (renamed headings included).
  const insertedHtml = [edit.insert?.html || '', ...res.replaced.map((st) => st.addedHtml)].filter(Boolean).join('\n')
  // The NEW material is linted on its own too: the lint reports only the first match per rule, so a new
  // "save up to 70%" after an old "save up to 60%" reads as the same, pre-existing error (pass-2 review).
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
      keyword: post.slug.replace(/-/g, ' '), slug: post.slug, isNew: false,
      knownFigures: known ? [...known].map((c) => c / 100) : undefined,
    }).errors,
  ].filter((e, i, arr) => arr.findIndex((x) => key(x) === key(e)) === i)
  const hasPrice = /(?:C\$|CA\$|US\$|\$)\s?\d/.test(stripTags(insertedHtml) + res.fieldText)
  const badPrices = known ? priceCheck(insertedHtml, res.fieldText, known) : []
  const loss = guardLoss(post.content, res.after.content, removedNodes(res.replaced))
  // The whole resulting body, so a stale figure the edit did NOT remove is still caught (reported, not blocking:
  // old posts carry computed totals the allow-list never holds, and this edit may be fixing one block of many).
  const remainingPrices = known && res.patch.content !== undefined
    ? priceCheck(lexicalToHtml(res.after.content as Parameters<typeof lexicalToHtml>[0]), '', known).filter((x) => !badPrices.includes(x))
    : []
  const blockers = [
    ...fresh.map((e) => `lint ${e.rule}: ${e.message}`),
    ...(badPrices.length ? [`price check: ${badPrices.join(', ')} not in the figures the writer may use for ${post.airportCode} and not in a paragraph with an external source link`] : []),
    ...(!known && hasPrice ? [`price check: no data file for ${post.airportCode ?? '(no airportCode)'}; prices can't be checked`] : []),
    ...(loss ? [`would lose ${loss}`] : []),
  ]
  return { blockers, warnings: after.warnings, preexisting, remainingPrices, removedRefs: removedRefsReport(res.replaced) }
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
  const check = checkEdit(post, res, edit, known)

  console.log(`\n${post.slug} (#${post.id}, ${post.status})  fields: ${Object.keys(res.patch).join(', ')}`)
  console.log(`facts diff (body + FAQ): +${res.factsDiff.added.length} / -${res.factsDiff.removed.length}`)
  for (const st of res.replaced) console.log(`  ${st.label}`)
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
      res.replaced.length ? `REPLACE OPERATIONS\n\n${replaceDiff(res.replaced)}\n` : '',
      check.remainingPrices.length ? `PRICE CHECK ON THE RESULTING BODY — figures still in the post, not in the ${post.airportCode} allow-list (not blocking): ${check.remainingPrices.join(', ')}\n` : '',
    ].filter(Boolean)
    fs.writeFileSync(`${base}.diff.txt`, [...head, `${head.length ? 'FULL TEXT DIFF\n\n' : ''}${textDiff(postText(post), postText(res.after))}`].join('\n'))
    fs.writeFileSync(`${base}.meta.json`, JSON.stringify({
      ...now, edit: path.resolve(editPath), factsDiff: res.factsDiff,
      ...(res.replaced.length ? { replaced: res.replaced.map((st) => st.label), removedRefs: check.removedRefs } : {}),
      ...(check.remainingPrices.length ? { remainingPrices: check.remainingPrices } : {}),
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
  if (!editLive(back, patch)) { console.error(`POST-SAVE CHECK FAILED: the re-read post does not carry every field of the patch. Compare with ${backup}`); process.exit(1) }
  console.log(`✓ applied + verified (#${post.id})`)
  if (back.status === 'published') await pingIndexNow([postUrlFor(slug)])
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
