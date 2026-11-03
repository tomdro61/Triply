/**
 * apply-edit.ts — the preview → apply path for edits to EXISTING posts (roadmap v3.4 B-4,
 * plan v3.2 W2/W3/W4: one apply step, person-approved, the only thing that moves the date).
 *
 *   npx tsx src/apply-edit.ts --slug <slug> --edit edit.json --preview
 *   npx tsx src/apply-edit.ts --slug <slug> --edit edit.json --apply [--stamp]
 *
 * edit.json (either part or both; unknown keys are refused):
 *   {
 *     "fields": { "title": "...", "excerpt": "...", "seo": { "metaTitle": "...", "metaDescription": "..." },
 *                 "faqItems": [{ "question": "...", "answer": "..." }] },
 *     "insert": { "underHeading": "Parking rates", "html": "<p>...</p>", "position": "end" }
 *   }
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
 * The body edit splices Lexical nodes in place: only the inserted section goes through
 * HTML → Lexical, the rest of the post is never round-tripped.
 *
 * Review fixes (PR #142, Nov 2026): strict edit schema; duplicate heading and already-present insert
 * refused; price allow-list = the figures the writer prompt sees (figureSource), not every number in the
 * airport file; only an EXTERNAL link sources a paragraph; inserted HTML checked once (not again as
 * plain text); apply bound to the previewed edit; thrown PATCH settled by re-read; pre-existing lint
 * errors in the live post are warnings, not blockers (this command cannot change old body text).
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { z } from 'zod'
import { htmlToLexical } from './html-to-lexical.js'
import { lexicalToHtml, countNodesOfType } from './lexical-to-html.js'
import { lintArticle, formatLint, stripTags, priceCheck, collectMoneyFigures, type LintFinding } from './lint.js'
// P3 price check + allow-list live in lint.ts (generate uses them too, W1.8 P3c); re-exported for callers and tests.
export { priceCheck, collectMoneyFigures } from './lint.js'
import { stampField, factsDiff, lexicalText, type FactsDiff } from './stamp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PREVIEW_DIR = path.resolve(__dirname, '..', 'reports', 'apply-preview')

// ── Types ───────────────────────────────────────────────────────────────────
type Node = { type: string; tag?: string; text?: string; children?: Node[]; [k: string]: unknown }
type Doc = { root: { children: Node[]; [k: string]: unknown } }

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
  })
  .strict()
  .refine((e) => e.fields !== undefined || e.insert !== undefined, { message: 'edit.json needs "fields" and/or "insert"' })
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
  if (edit.insert) {
    after.content = insertUnderHeading(post.content, edit.insert.underHeading, edit.insert.html, edit.insert.position)
    patch.content = after.content
  }
  return { patch, after, fieldText: fieldText.filter(Boolean).join('\n'), factsDiff: factsDiff(bodyFactsText(post), bodyFactsText(after)) }
}

export function guardLoss(before: Doc, after: Doc): string | null {
  const count = (d: Doc, t: string) => countNodesOfType(d as Parameters<typeof countNodesOfType>[0], t)
  const lb = count(before, 'link') + count(before, 'autolink'), la = count(after, 'link') + count(after, 'autolink')
  const ub = count(before, 'upload'), ua = count(after, 'upload')
  if (la < lb) return `links ${lb} → ${la}`
  if (ua < ub) return `images ${ub} → ${ua}`
  return null
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

export interface CheckResult { blockers: string[]; warnings: LintFinding[]; preexisting: LintFinding[] }

/**
 * Every gate in one place: the lint on the result (errors already present in the live post are
 * reported, not blocking — this command cannot change old body text), the price check, the link/image guard.
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
  const insertedHtml = edit.insert?.html || ''
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
  const loss = guardLoss(post.content, res.after.content)
  const blockers = [
    ...fresh.map((e) => `lint ${e.rule}: ${e.message}`),
    ...(badPrices.length ? [`price check: ${badPrices.join(', ')} not in the figures the writer may use for ${post.airportCode} and not in a paragraph with an external source link`] : []),
    ...(!known && hasPrice ? [`price check: no data file for ${post.airportCode ?? '(no airportCode)'}; prices can't be checked`] : []),
    ...(loss ? [`would lose ${loss}`] : []),
  ]
  return { blockers, warnings: after.warnings, preexisting }
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
  if (check.warnings.length) console.log(formatLint({ ok: true, errors: [], warnings: check.warnings }))
  if (check.preexisting.length) console.log(`  (already in the live post, not blocking — fix by hand in the CMS)\n${formatLint({ ok: true, errors: [], warnings: check.preexisting })}`)
  if (check.blockers.length) { console.log(`⛔ blocked:\n  ${check.blockers.join('\n  ')}`); process.exit(1) }

  fs.mkdirSync(PREVIEW_DIR, { recursive: true })
  const base = path.join(PREVIEW_DIR, slug)
  const now: PreviewMeta = { slug, id: post.id, updatedAt: post.updatedAt, editHash: sha256(editRaw), patchHash: sha256(JSON.stringify(res.patch)), at: new Date().toISOString() }
  if (preview) {
    fs.writeFileSync(`${base}.html`, `<h1>${res.after.title}</h1>\n${lexicalToHtml(res.after.content as Parameters<typeof lexicalToHtml>[0])}`)
    fs.writeFileSync(`${base}.diff.txt`, textDiff(postText(post), postText(res.after)))
    fs.writeFileSync(`${base}.meta.json`, JSON.stringify({ ...now, edit: path.resolve(editPath), factsDiff: res.factsDiff }, null, 1))
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
