/**
 * perf-apply.ts — applies recommendations to the live article (autonomous).
 *
 * Only additive/reversible edits are auto-applied:
 *   - title-meta    : PATCH title + seo.{metaTitle,metaDescription}. Body untouched.
 *   - quick-answer  : splice a new Lexical block at the TOP of content (no round-trip
 *                     of existing body) + stamp contentUpdatedAt.
 *   - faq-additions : append to post.faqItems + stamp contentUpdatedAt.
 * 'flag' recommendations are never applied — just reported.
 *
 * Every applied change stores the exact pre-edit CMS values in the article
 * record's changes[] so `revertLast` can restore it losslessly. Dry-run by
 * default; pass apply=true to write.
 *
 * NOTE: title-meta never stamps contentUpdatedAt. Body/faq edits stamp ONLY when the run is
 * started with --stamp (W1.7: dates move by an explicit apply whose diff changed facts).
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { findPostBySlug, updatePost } from './payload.js'
import { lintArticle, formatLint } from './lint.js'
import { htmlToLexical } from './html-to-lexical.js'
import { loadRecord, saveRecord } from './perf-snapshot.js'
import type { PerfChange } from './perf-snapshot.js'
import type { Recommendation } from './perf-recommend.js'
import { AUDIT_SAMPLE_RATE } from './config.js'
import { stampField, lexicalText } from './stamp.js'
import type { ArticlePerfRecord } from './perf-snapshot.js'
import { pingIndexNow, postUrlFor } from './indexnow.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUDIT_QUEUE = path.resolve(__dirname, '..', 'reports', 'perf-audit-queue.json')

export interface ApplyResult { applied: number; skipped: number; changes: PerfChange[] }

/**
 * Spot-audit: since edits auto-apply, randomly flag ~1-in-3 into an audit queue
 * so a human eyeballs a sample after the fact. Catches off-brand/wrong edits the
 * ranking-only auto-revert can't see. `perf audit` lists these; revert any with
 * `perf revert --slug X`.
 */
interface AuditEntry { slug: string; type: string; at: string; rationale: string; reviewed?: boolean }

/**
 * Read the audit queue tolerantly. Format is append-only JSONL (one object per
 * line); a legacy single pretty-printed JSON array is still parsed for back-compat.
 * Corrupt lines are skipped rather than crashing `perf audit`.
 */
export function readAuditQueue(file: string = AUDIT_QUEUE): AuditEntry[] {
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf-8').trim()
  if (!raw) return []
  if (raw[0] === '[') {
    try { return JSON.parse(raw) as AuditEntry[] } catch { return [] }
  }
  const out: AuditEntry[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t) as AuditEntry) } catch { /* skip malformed line */ }
  }
  return out
}

export function queueForAudit(
  entry: { slug: string; type: string; at: string; rationale: string },
  file: string = AUDIT_QUEUE,
): void {
  // One-time migration: rewrite a legacy JSON-array file as JSONL so the append
  // below doesn't land after the closing ']'.
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf-8').trim()
    if (raw.startsWith('[')) {
      const migrated = readAuditQueue(file).map((e) => JSON.stringify(e)).join('\n')
      fs.writeFileSync(file, migrated ? migrated + '\n' : '')
    }
  }
  // Atomic append — no read-modify-write, so parallel `perf run` invocations can't
  // clobber each other's entries the way rewriting a whole JSON array did.
  fs.appendFileSync(file, JSON.stringify({ ...entry, reviewed: false }) + '\n')
}

/** True when the live post already carries every field this edit set (used to settle a PATCH whose response was lost). */
export function editIsLive(live: { content?: unknown; faqItems?: unknown; title?: unknown; seo?: unknown }, updateData: Record<string, unknown>): boolean {
  if (updateData.content !== undefined && lexicalText(live.content) !== lexicalText(updateData.content)) return false
  if (updateData.faqItems !== undefined) {
    const a = live.faqItems as { question: string }[] | undefined
    const b = updateData.faqItems as { question: string }[]
    if (!Array.isArray(a) || a.length !== b.length || a.some((f, i) => f.question !== b[i].question)) return false
  }
  if (updateData.title !== undefined && live.title !== updateData.title) return false
  if (updateData.seo !== undefined) {
    const a = (live.seo ?? {}) as Record<string, unknown>
    const b = updateData.seo as Record<string, unknown>
    if (a.metaTitle !== b.metaTitle || a.metaDescription !== b.metaDescription) return false
  }
  return true
}

/**
 * A PATCH threw. Decide what happened to the entry already in the record:
 *  - a 4xx: the CMS refused it, nothing committed → the entry comes out;
 *  - anything else (timeout, lost response, 5xx): re-read the post → edit present = applied after all (true),
 *    absent = entry out; re-read failed too = keep it flagged `patchUnverified` (skipped by measure/learn/tier).
 * Returns true only when the edit is confirmed live. Rethrows otherwise.
 */
async function settleFailedPatch(slug: string, record: ArticlePerfRecord, change: PerfChange, updateData: Record<string, unknown>, err: unknown): Promise<boolean> {
  const status = (err as { status?: unknown }).status
  const refused = typeof status === 'number' && status >= 400 && status < 500
  const live = refused ? null : await findPostBySlug(slug).catch(() => undefined)
  if (live === undefined) {
    change.patchUnverified = true
    change.summary = `[PATCH outcome unknown — check the CMS, then clear patchUnverified] ${change.summary}`
    saveRecord(record)
    throw err
  }
  if (live && editIsLive(live, updateData)) {
    console.log(`  ⚠ ${change.type}: the PATCH response was lost but the edit IS live — recorded as applied`)
    return true
  }
  record.changes.pop()
  saveRecord(record)
  throw err
}

/** Trim to a max length at a word boundary when possible (CMS enforces metaTitle<=60, metaDescription<=160). */
function clamp(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()
}

export async function applyRecommendations(
  slug: string,
  recs: Recommendation[],
  apply: boolean,
): Promise<ApplyResult> {
  const post = await findPostBySlug(slug)
  if (!post) throw new Error(`No CMS post found for slug "${slug}"`)

  const record = loadRecord(slug)
  const latestSnap = record?.snapshots[record.snapshots.length - 1]
  const baseline = latestSnap?.gsc.totals || { clicks: 0, impressions: 0, position: 0 }
  // AI-Overview citation at apply time. Only trustworthy when snap.geo was actually
  // captured (recommend() with a live SERP pull). If geo is absent, leave this
  // `undefined` rather than defaulting to false — a false baseline would let
  // `maintain geo measure` misreport a citation as "gained". measure filters on
  // `citationBaseline !== undefined`, so undefined correctly excludes the change.
  const citationBaseline = latestSnap?.geo ? latestSnap.geo.aioCitesUs : undefined

  console.log(`\n🔧 Apply — ${slug} ${apply ? '(APPLYING)' : '(dry-run — no changes written)'}`)

  let applied = 0
  let skipped = 0
  const madeChanges: PerfChange[] = []

  for (const r of recs) {
    if (!r.autoApply || r.type === 'flag') {
      console.log(`  ⚑ FLAG (manual): ${r.rationale}`)
      skipped++
      continue
    }

    const now = new Date().toISOString()
    let updateData: Record<string, unknown> | null = null
    let change: PerfChange | null = null

    try {
      if (r.type === 'title-meta') {
        const metaTitle = r.metaTitle ? clamp(r.metaTitle, 60) : undefined
        const metaDescription = r.metaDescription ? clamp(r.metaDescription, 160) : undefined
        // Store the WHOLE seo object (deep-cloned) so revert restores exact prior
        // state — cherry-picking two fields wrote `undefined`s that could clobber
        // other seo fields or leave stale values on revert.
        const preEdit = { title: post.title, seo: post.seo ? JSON.parse(JSON.stringify(post.seo)) : {} }
        updateData = {}
        if (r.title) updateData.title = clamp(r.title, 120)
        const seo: Record<string, string> = {}
        if (metaTitle) seo.metaTitle = metaTitle
        if (metaDescription) seo.metaDescription = metaDescription
        if (Object.keys(seo).length) updateData.seo = { ...post.seo, ...seo }
        console.log(`  ✎ title-meta`)
        if (r.title) console.log(`      title:    "${post.title}"  →  "${updateData.title}"`)
        if (metaTitle) console.log(`      metaTitle:"${post.seo?.metaTitle || ''}"  →  "${metaTitle}" (${metaTitle.length}c)`)
        if (metaDescription) console.log(`      metaDesc: → "${metaDescription.slice(0, 60)}..." (${metaDescription.length}c)`)
        change = { at: now, type: 'title-meta', summary: r.rationale, baselineMetrics: baseline, preEdit }
      } else if (r.type === 'quick-answer' && r.quickAnswerHtml) {
        if (!post.content?.root?.children) { console.log('  ⚠ quick-answer: post has no Lexical content, skipping'); skipped++; continue }
        // Work on a clone: the shared `post` follows the CMS only after a successful PATCH, so a recommendation the
        // lint rejects can never leak into the next one's body or rollback baseline.
        const content = JSON.parse(JSON.stringify(post.content)) // Lexical document { root: { children: [] } }
        const preEdit = { content: JSON.parse(JSON.stringify(post.content)) } // exact pre-edit copy for lossless revert
        const newNodes = htmlToLexical(r.quickAnswerHtml).root.children
        console.log(`  ✎ quick-answer (prepend ${newNodes.length} block(s) at top)`)
        console.log(`      ${r.quickAnswerHtml.replace(/<[^>]+>/g, ' ').trim().slice(0, 160)}`)
        if (apply) content.root.children.splice(0, 0, ...newNodes)
        // A quick-answer block restates facts already on the page; it is not a fact change (W1.7), so the date never moves for it.
        updateData = { content, ...stampField({ factsChanged: false, reason: 'quick-answer block added — not a fact change' }) }
        change = { at: now, type: 'quick-answer', summary: r.rationale, baselineMetrics: baseline, citationBaseline, preEdit }
      } else if (r.type === 'faq-additions' && r.faqItems?.length) {
        const existingFaq = Array.isArray(post.faqItems) ? post.faqItems : []
        const preEdit = { faqItems: JSON.parse(JSON.stringify(existingFaq)) }
        const merged = [...existingFaq, ...r.faqItems.map((f) => ({ question: f.question, answer: f.answer }))]
        console.log(`  ✎ faq-additions (+${r.faqItems.length} → ${merged.length} total)`)
        r.faqItems.forEach((f) => console.log(`      Q: ${f.question}`))
        updateData = { faqItems: merged, ...stampField({ factsChanged: false, reason: 'FAQ items added — not a fact change' }) }
        change = { at: now, type: 'faq-additions', summary: r.rationale, baselineMetrics: baseline, citationBaseline, preEdit }
      }

      if (!change || !updateData) { skipped++; continue }

      if (apply) {
        // No perf record = nowhere to keep the pre-edit snapshot = an autonomous edit nobody could revert. Skip it.
        if (!record) { console.log(`  ⚠ ${r.type}: no perf record for ${slug} — no rollback snapshot would be kept; skipping (run perf measure first)`); skipped++; continue }
        // W1.4: the new text goes through the same lint as a fresh article (title/meta, quick-answer HTML, FAQ answers).
        const seo = (updateData.seo ?? {}) as { metaTitle?: string; metaDescription?: string }
        const lint = lintArticle({
          title: String(updateData.title ?? post.title ?? ''), metaTitle: seo.metaTitle, metaDescription: seo.metaDescription,
          html: r.type === 'quick-answer' ? r.quickAnswerHtml || '' : '',
          // only the items this edit adds — an old live FAQ must not block every future addition
          faqItems: r.type === 'faq-additions' ? (r.faqItems || []).map((f) => ({ question: f.question, answer: f.answer })) : undefined,
          keyword: slug, slug, isNew: false,
        })
        if (!lint.ok) { console.log(`  ⛔ ${r.type}: lint failed — not applied\n${formatLint(lint)}`); skipped++; continue }
        // The rollback record is written BEFORE the live edit, so a crash or a hung IndexNow call can never leave an
        // edit without its pre-edit snapshot. If the PATCH then fails, settleFailedPatch decides whether the entry stays.
        record.changes.push(change); saveRecord(record)
        try {
          await updatePost(post.id, updateData)
        } catch (e) {
          await settleFailedPatch(slug, record, change, updateData, e) // returns only when the edit is confirmed live
        }
        // The local copy now follows the CMS, so a later recommendation in this run builds on what is live.
        if (updateData.content !== undefined) post.content = updateData.content
        if (updateData.faqItems !== undefined) post.faqItems = updateData.faqItems
        if (updateData.title !== undefined) post.title = updateData.title
        if (updateData.seo !== undefined) post.seo = updateData.seo
        madeChanges.push(change)
        applied++
        await pingIndexNow([postUrlFor(slug)])
        // Spot-audit: flag a random sample for after-the-fact human review.
        if (Math.random() < AUDIT_SAMPLE_RATE) {
          queueForAudit({ slug, type: change.type, at: change.at, rationale: change.summary })
          console.log(`      🔎 flagged for spot-audit (perf audit)`)
        }
      }
    } catch (err) {
      console.log(`  ✗ ${r.type} failed, skipping: ${err instanceof Error ? err.message.slice(0, 140) : err}`)
      skipped++
      continue
    }
  }

  if (apply && madeChanges.length) {
    console.log(`\n  ✓ Applied ${applied} change(s); logged with pre-edit snapshots (revert with: perf revert --slug ${slug})`)
  } else if (!apply) {
    console.log(`\n  (dry-run) ${recs.filter((r) => r.autoApply && r.type !== 'flag').length} change(s) would be applied. Re-run with --apply to commit.`)
  }

  return { applied, skipped, changes: madeChanges }
}

/** List edits flagged by the spot-audit sampler for after-the-fact human review. */
export function listAudits(): void {
  const queue = readAuditQueue()
  if (!queue.length) { console.log('\n  🔎 Spot-audit queue empty.\n'); return }
  const pending = queue.filter((q) => !q.reviewed)
  console.log(`\n🔎 Spot-audit queue — ${pending.length} unreviewed of ${queue.length} total`)
  pending.forEach((q, i) => {
    console.log(`\n  ${i + 1}. ${q.slug} [${q.type}] — ${String(q.at).slice(0, 10)}`)
    console.log(`     why: ${q.rationale}`)
    console.log(`     → review the live page; undo with:  perf revert --slug ${q.slug}`)
  })
  if (pending.length) console.log(`\n  Mark all reviewed:  perf audit --clear\n`)
  else console.log('')
}

/** Mark all audit entries reviewed (after you've eyeballed them). */
export function clearAudits(): void {
  const queue = readAuditQueue()
  if (!queue.length) { console.log('  Audit queue empty.'); return }
  queue.forEach((q) => { q.reviewed = true })
  // Rewrite as JSONL. This is a manual, single-invocation command (not run during
  // batches), so the brief rewrite window carries no concurrency risk.
  fs.writeFileSync(AUDIT_QUEUE, queue.map((e) => JSON.stringify(e)).join('\n') + '\n')
  console.log('  ✓ Marked all audit items reviewed.')
}

/** Revert the most recent non-reverted change for a slug, restoring pre-edit CMS values. */
export async function revertLast(slug: string): Promise<boolean> {
  const record = loadRecord(slug)
  if (!record) { console.log(`  No record for "${slug}".`); return false }
  const change = [...record.changes].reverse().find((c) => c.preEdit && !c.reverted)
  if (!change) { console.log(`  No revertible change for "${slug}".`); return false }

  const post = await findPostBySlug(slug)
  if (!post) throw new Error(`No CMS post found for slug "${slug}"`)

  await updatePost(post.id, change.preEdit as Record<string, unknown>)
  change.reverted = true
  saveRecord(record)
  console.log(`  ↩ Reverted "${change.type}" change from ${change.at.slice(0, 10)} for ${slug}.`)
  return true
}
