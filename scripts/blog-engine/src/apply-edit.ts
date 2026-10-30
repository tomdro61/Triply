/**
 * apply-edit.ts — the preview → apply path for edits to EXISTING posts (roadmap v3.4 B-4,
 * plan v3.2 W2/W3/W4: one apply step, person-approved, the only thing that moves the date).
 *
 *   npx tsx src/apply-edit.ts --slug <slug> --edit edit.json --preview
 *   npx tsx src/apply-edit.ts --slug <slug> --edit edit.json --apply [--stamp]
 *
 * edit.json (either part or both):
 *   {
 *     "fields": { "title": "...", "excerpt": "...", "seo": { "metaTitle": "...", "metaDescription": "..." },
 *                 "faqItems": [{ "question": "...", "answer": "..." }] },
 *     "insert": { "underHeading": "Parking rates", "html": "<p>...</p>", "position": "end" }
 *   }
 *
 * --preview reads the post by slug (any status), applies the edit in memory, runs the lint and the
 * price check, and writes reports/apply-preview/<slug>.html (+ .diff.txt + .meta.json). Nothing is
 * written to the CMS.
 * --apply re-reads the post, refuses if it changed since the preview, re-runs every check, backs up
 * the live post, PATCHes by id, re-reads to verify links and images survived, stamps
 * contentUpdatedAt only with --stamp AND a non-empty facts diff, and pings IndexNow.
 *
 * The body edit splices Lexical nodes in place: only the inserted section goes through
 * HTML → Lexical, the rest of the post is never round-tripped.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { htmlToLexical } from './html-to-lexical.js'
import { lexicalToHtml, countNodesOfType } from './lexical-to-html.js'
import { lintArticle, formatLint, collectFigures, stripTags } from './lint.js'
import { stampField } from './stamp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PREVIEW_DIR = path.resolve(__dirname, '..', 'reports', 'apply-preview')

// ── Types ───────────────────────────────────────────────────────────────────
type Node = { type: string; tag?: string; text?: string; children?: Node[]; [k: string]: unknown }
type Doc = { root: { children: Node[]; [k: string]: unknown } }

export interface EditSpec {
  fields?: {
    title?: string
    excerpt?: string
    seo?: { metaTitle?: string; metaDescription?: string }
    faqItems?: { question: string; answer: string }[]
  }
  insert?: { underHeading: string; html: string; position?: 'start' | 'end' }
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
  addedText: string
  factsDiff: { added: string[]; removed: string[] }
}

// ── Pure core ───────────────────────────────────────────────────────────────
function nodeText(n: Node): string {
  return n.text ?? (n.children || []).map(nodeText).join('')
}

const LEVEL = (n: Node) => (n.type === 'heading' && n.tag ? Number(n.tag.slice(1)) : 99)

/** Insert `html` inside the section that starts at the heading whose text matches `underHeading`. */
export function insertUnderHeading(content: Doc, underHeading: string, html: string, position: 'start' | 'end' = 'end'): Doc {
  const kids = content.root.children
  const want = underHeading.trim().toLowerCase()
  const at = kids.findIndex((n) => n.type === 'heading' && nodeText(n).trim().toLowerCase() === want)
  if (at < 0) throw new Error(`heading not found: "${underHeading}"`)
  const lvl = LEVEL(kids[at])
  let end = at + 1
  while (end < kids.length && LEVEL(kids[end]) > lvl) end++
  const insertAt = position === 'start' ? at + 1 : end
  // Round-trip only the new section through JSON so it carries the same plain-object shape as the stored post.
  const nodes: Node[] = JSON.parse(JSON.stringify(htmlToLexical(html).root.children))
  return { ...content, root: { ...content.root, children: [...kids.slice(0, insertAt), ...nodes, ...kids.slice(insertAt)] } }
}

/** Sentences that carry a number (prices, hours, distances). The facts of a post, for the stamp rule. */
export function factSentences(text: string): Set<string> {
  return new Set(
    text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim().replace(/\s+/g, ' ')).filter((s) => /\d/.test(s)),
  )
}

function postText(p: PostLike): string {
  return [p.title, p.excerpt, p.seo?.metaTitle, p.seo?.metaDescription,
    // One line per block so sentence splitting never glues a heading to the next paragraph.
    ...lexicalToHtml(p.content as Parameters<typeof lexicalToHtml>[0]).split(/<\/(?:p|h[1-6]|li|td|th|tr)>/i).map(stripTags).filter(Boolean),
    ...(p.faqItems || []).map((f) => `${f.question} ${f.answer}`)].filter(Boolean).join('\n')
}

export function applyEdit(post: PostLike, edit: EditSpec): EditResult {
  const patch: Record<string, unknown> = {}
  const after: PostLike = JSON.parse(JSON.stringify(post))
  let addedText = ''
  const f = edit.fields || {}
  if (f.title !== undefined && f.title !== post.title) { patch.title = after.title = f.title; addedText += ` ${f.title}` }
  if (f.excerpt !== undefined && f.excerpt !== post.excerpt) { patch.excerpt = after.excerpt = f.excerpt; addedText += ` ${f.excerpt}` }
  if (f.seo) {
    after.seo = { ...(post.seo || {}), ...f.seo }
    patch.seo = after.seo
    addedText += ` ${f.seo.metaTitle || ''} ${f.seo.metaDescription || ''}`
  }
  if (f.faqItems) {
    after.faqItems = f.faqItems.map(({ question, answer }) => ({ question, answer }))
    patch.faqItems = after.faqItems
    addedText += ' ' + f.faqItems.map((x) => `${x.question} ${x.answer}`).join(' ')
  }
  if (edit.insert) {
    after.content = insertUnderHeading(post.content, edit.insert.underHeading, edit.insert.html, edit.insert.position)
    patch.content = after.content
    addedText += ` ${stripTags(edit.insert.html)}`
  }
  const before = factSentences(postText(post)), now = factSentences(postText(after))
  return {
    patch,
    after,
    addedText: addedText.trim(),
    factsDiff: { added: [...now].filter((s) => !before.has(s)), removed: [...before].filter((s) => !now.has(s)) },
  }
}

/**
 * P3 price check (deny by default): every $ / C$ figure in the text this edit ADDS must be a figure
 * in the airport's data file (lots already filtered to sellable by loadAirportData) or sit in an
 * inserted paragraph that links its source. Returns the figures that fail.
 */
export function priceCheck(addedHtmlOrText: string, airportData: unknown): string[] {
  const known = new Set(collectFigures(airportData).map((n) => Math.round(n * 100)))
  const bad: string[] = []
  const chunks = addedHtmlOrText.split(/<\/p>|<\/li>|<\/td>|\n/i)
  for (const chunk of chunks) {
    if (/<a\s[^>]*href=/i.test(chunk)) continue
    for (const m of stripTags(chunk).matchAll(/(?:C\$|CA\$|US\$|\$)\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) {
      const n = Number(m[1].replace(/,/g, ''))
      if (!known.has(Math.round(n * 100)) && !bad.includes(m[0])) bad.push(m[0])
    }
  }
  return bad
}

/** Link/image guard: the edit may add links and images, never lose one. */
export function guardLoss(before: Doc, after: Doc): string | null {
  const count = (d: Doc, t: string) => countNodesOfType(d as Parameters<typeof countNodesOfType>[0], t)
  const lb = count(before, 'link') + count(before, 'autolink'), la = count(after, 'link') + count(after, 'autolink')
  const ub = count(before, 'upload'), ua = count(after, 'upload')
  if (la < lb) return `links ${lb} → ${la}`
  if (ua < ub) return `images ${ub} → ${ua}`
  return null
}

/** Minimal line diff of the plain text, for the preview file. */
export function textDiff(a: string, b: string): string {
  const A = a.split('\n'), B = b.split('\n')
  const setA = new Set(A), setB = new Set(B)
  return [...A.filter((l) => !setB.has(l)).map((l) => `- ${l}`), ...B.filter((l) => !setA.has(l)).map((l) => `+ ${l}`)].join('\n')
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
  const { env } = await import('./config.js')
  const { updatePost } = await import('./payload.js')
  const { loadAirportData } = await import('./airport-data.js')
  const { pingIndexNow, postUrlFor } = await import('./indexnow.js')
  const cms = async (p: string) => {
    const r = await fetch(`${env.PAYLOAD_CMS_URL}/api${p}`, { headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` } })
    if (!r.ok) throw new Error(`GET ${p} ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return r.json()
  }
  const read = async (): Promise<PostLike> => {
    const post = (await cms(`/posts?where[slug][equals]=${encodeURIComponent(slug)}&limit=1&depth=0`)).docs?.[0]
    if (!post) throw new Error(`no post with slug ${slug} (any status)`)
    return post
  }

  const edit: EditSpec = JSON.parse(fs.readFileSync(editPath, 'utf-8'))
  const post = await read()
  const res = applyEdit(post, edit)
  if (Object.keys(res.patch).length === 0) { console.log('Edit changes nothing.'); return }

  // Checks: lint on the whole result (existing post → no year / answer-first rule), price check on what was added, link/image guard.
  const airportData = post.airportCode ? loadAirportData(post.airportCode) : null
  const lint = lintArticle({
    title: res.after.title, metaTitle: res.after.seo?.metaTitle, metaDescription: res.after.seo?.metaDescription,
    html: lexicalToHtml(res.after.content as Parameters<typeof lexicalToHtml>[0]), excerpt: res.after.excerpt,
    faqItems: res.after.faqItems, keyword: slug.replace(/-/g, ' '), slug, isNew: false,
    knownFigures: airportData ? collectFigures(airportData) : undefined,
  })
  const added = [edit.insert?.html || '', res.addedText].join('\n')
  const badPrices = airportData ? priceCheck(added, airportData) : []
  const loss = guardLoss(post.content, res.after.content)
  const blockers = [
    ...lint.errors.map((e) => `lint ${e.rule}: ${e.message}`),
    ...(badPrices.length ? [`price check: ${badPrices.join(', ')} not in data/airports/${post.airportCode}.json and not next to a source link`] : []),
    ...(airportData || !/\$\s?\d/.test(added) ? [] : [`price check: no data file for ${post.airportCode}; prices can't be checked`]),
    ...(loss ? [`would lose ${loss}`] : []),
  ]

  console.log(`\n${post.slug} (#${post.id}, ${post.status})  fields: ${Object.keys(res.patch).join(', ')}`)
  console.log(`facts diff: +${res.factsDiff.added.length} / -${res.factsDiff.removed.length}`)
  if (lint.warnings.length) console.log(formatLint({ ok: true, errors: [], warnings: lint.warnings }))
  if (blockers.length) { console.log(`⛔ blocked:\n  ${blockers.join('\n  ')}`); process.exit(1) }

  fs.mkdirSync(PREVIEW_DIR, { recursive: true })
  const base = path.join(PREVIEW_DIR, slug)
  if (preview) {
    fs.writeFileSync(`${base}.html`, `<h1>${res.after.title}</h1>\n${lexicalToHtml(res.after.content as Parameters<typeof lexicalToHtml>[0])}`)
    fs.writeFileSync(`${base}.diff.txt`, textDiff(postText(post), postText(res.after)))
    fs.writeFileSync(`${base}.meta.json`, JSON.stringify({ slug, id: post.id, updatedAt: post.updatedAt, edit: path.resolve(editPath), factsDiff: res.factsDiff }, null, 1))
    console.log(`✓ preview written: ${base}.html, .diff.txt — nothing sent to the CMS. Re-run with --apply.`)
    return
  }

  // --apply
  const metaPath = `${base}.meta.json`
  if (!fs.existsSync(metaPath)) { console.error('No preview for this slug. Run --preview first.'); process.exit(1) }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
  if (meta.updatedAt !== post.updatedAt) { console.error(`Live post changed since the preview (${meta.updatedAt} → ${post.updatedAt}). Re-run --preview.`); process.exit(1) }
  fs.writeFileSync(`${base}.live-backup-${Date.now()}.json`, JSON.stringify(post))
  const factsChanged = res.factsDiff.added.length + res.factsDiff.removed.length > 0
  const patch = { ...res.patch, ...stampField({ factsChanged, reason: `${res.factsDiff.added.length} fact sentence(s) added, ${res.factsDiff.removed.length} removed` }) }
  await updatePost(String(post.id), patch)
  const back = await read()
  const lost = guardLoss(res.after.content, back.content)
  if (lost) { console.error(`POST-SAVE CHECK FAILED: ${lost}. Restore from ${base}.live-backup-*.json`); process.exit(1) }
  console.log(`✓ applied + verified (#${post.id})`)
  if (back.status === 'published') await pingIndexNow([postUrlFor(slug)])
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
