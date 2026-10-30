/**
 * generate-batch.ts — phased, cost-halved article generation via the Batches API.
 *
 * The sync `generateArticle` runs analyze→write→edit as a dependent chain PER
 * article, one at a time. Batch mode instead runs each STEP across ALL items at
 * once (every step is independent across articles), submitting each phase as one
 * Anthropic Message Batch billed at 50% of the sync rate:
 *
 *   Phase 1: batch ANALYZE  (all items)      → per-item AnalysisResult
 *   Phase 2: batch WRITE    (all items)      → per-item WriteResult
 *   Phase 3: score + decide  (local, no API)
 *   Phase 4: batch EDIT     (only items below threshold, SINGLE pass)
 *   Phase 5: assemble each item's final result (shared finalize)
 *
 * Reuses the exact prompt/system builders + scoring/finalize helpers from claude.ts
 * so batched articles are constructed identically to sync ones — the only
 * differences are (a) latency (async: minutes–hours) and (b) the batch discount.
 *
 * Tradeoff vs sync: EDIT is a single pass here (no multi-pass hub revision loop) to
 * keep the pipeline phase-parallel. Everything downstream (infographics, CMS upload,
 * report) is unchanged and handled per-item by the caller in index.ts.
 *
 * EXPERIMENTAL: validate with a small `--batch` run before trusting it on a full
 * cluster (the async Batches API can only be exercised live).
 */

import type { QueueItem } from './queue.js'
import type { ScrapedArticle } from './scraper.js'
import type { AirportData } from './airport-data.js'
import type { PublishedPost } from './payload.js'
import { getClusterContext } from './payload.js'
import { buildAnalyzePrompt } from './prompts/analyze.js'
import { buildWritePrompt } from './prompts/write-switch.js'
import { buildEditPrompt } from './prompts/edit.js'
import { runBatch } from './batch.js'
import type { BatchRequest } from './batch.js'
import { MAX_TOKENS, modelForStep } from './config.js'
import {
  buildAnalyzeSystem, parseAnalyze,
  buildWriteSystem, parseWrite,
  buildEditSystem, parseEdit,
  scoreAndDecide, finalizeArticleResult,
  type GenerateArticleResult, type WriteDecision,
} from './claude.js'
import type { AnalysisResult, WriteResult } from './claude.js'

export interface BatchItemInput {
  item: QueueItem
  competitors: ScrapedArticle[]
  airportData?: AirportData
}

export interface BatchArticleOutcome {
  itemId: string
  slug: string
  result?: GenerateArticleResult
  error?: string
}

/** system blocks from claude.ts builders are Anthropic message system params — pass through. */
type Sys = BatchRequest['system']

/**
 * Generate many articles through the Batches API. Returns one outcome per input
 * item (success carries the same GenerateArticleResult the sync path produces).
 * `publishedPosts` feeds internal-linking + cluster context, same as sync.
 */
export async function generateArticlesBatch(
  inputs: BatchItemInput[],
  publishedPosts: PublishedPost[],
): Promise<{ outcomes: BatchArticleOutcome[]; totalCost: number }> {
  const outcomes = new Map<string, BatchArticleOutcome>()
  for (const { item } of inputs) outcomes.set(item.id, { itemId: item.id, slug: item.slug })

  const fail = (id: string, error: string) => {
    const o = outcomes.get(id)!
    o.error = error
  }
  const alive = () => inputs.filter((i) => !outcomes.get(i.item.id)!.error)

  let totalCost = 0

  // ── Phase 1: ANALYZE ─────────────────────────────────────────────────────────
  console.log(`\n📦 Batch phase 1/3 — analyze (${inputs.length} item(s))`)
  const analyzeReqs: BatchRequest[] = inputs.map(({ item, competitors }) => ({
    customId: item.id,
    prompt: buildAnalyzePrompt(item.keyword, competitors),
    system: buildAnalyzeSystem(),
    model: modelForStep('analyze'),
    maxTokens: MAX_TOKENS,
  }))
  const analyzeRun = await runBatch(analyzeReqs, { maxTokens: MAX_TOKENS })
  totalCost += analyzeRun.cost
  const analysisById = new Map<string, AnalysisResult>()
  for (const { item } of inputs) {
    const r = analyzeRun.results.get(item.id)
    if (!r || r.text === null) { fail(item.id, `analyze ${r?.status || 'missing'}: ${r?.error || 'no result'}`); continue }
    try { analysisById.set(item.id, parseAnalyze(r.text)) }
    catch (e) { fail(item.id, `analyze parse failed: ${e instanceof Error ? e.message : e}`) }
  }

  // ── Phase 2: WRITE ───────────────────────────────────────────────────────────
  const writeInputs = alive().filter((i) => analysisById.has(i.item.id))
  console.log(`\n📦 Batch phase 2/3 — write (${writeInputs.length} item(s))`)
  const writeReqs: BatchRequest[] = []
  for (const { item, airportData } of writeInputs) {
    const analysis = analysisById.get(item.id)!
    // Filter published posts to the same airport, exactly as the sync loop does.
    const airportPosts = publishedPosts.filter((p) => p.airportCode === item.airportCode || !p.airportCode)
    // Cluster context per item (cross-article internal linking), same as sync.
    let clusterArticles: Awaited<ReturnType<typeof getClusterContext>> = []
    if (airportPosts.length > 0) {
      try { clusterArticles = await getClusterContext(item) }
      catch (e) { console.log(`    ⚠ cluster context skipped for ${item.slug}: ${e instanceof Error ? e.message : e}`) }
    }
    writeReqs.push({
      customId: item.id,
      prompt: buildWritePrompt(item, analysis, airportData, airportPosts, clusterArticles),
      system: buildWriteSystem(item, airportData) as Sys,
      model: modelForStep('write'),
      maxTokens: MAX_TOKENS,
    })
  }
  const writeRun = await runBatch(writeReqs, { maxTokens: MAX_TOKENS })
  totalCost += writeRun.cost
  const writeById = new Map<string, WriteResult>()
  for (const { item } of writeInputs) {
    const r = writeRun.results.get(item.id)
    if (!r || r.text === null) { fail(item.id, `write ${r?.status || 'missing'}: ${r?.error || 'no result'}`); continue }
    try { writeById.set(item.id, parseWrite(r.text)) }
    catch (e) { fail(item.id, `write parse failed: ${e instanceof Error ? e.message : e}`) }
  }

  // ── Phase 3: score + decide (local) ─────────────────────────────────────────
  const decisions = new Map<string, WriteDecision>()
  for (const { item } of alive()) {
    const w = writeById.get(item.id)
    if (!w) continue
    decisions.set(item.id, scoreAndDecide(item, analysisById.get(item.id)!, w))
  }

  // ── Phase 4: EDIT (single pass, only sub-threshold items) ────────────────────
  const editInputs = alive().filter((i) => writeById.has(i.item.id) && decisions.get(i.item.id)!.needsEdit)
  const editById = new Map<string, { html: string; changes: string[]; qualityScore: number }>()
  if (editInputs.length) {
    console.log(`\n📦 Batch phase 3/3 — edit (${editInputs.length} of ${writeById.size} below threshold; single pass)`)
    const editReqs: BatchRequest[] = editInputs.map(({ item, airportData }) => {
      const decision = decisions.get(item.id)!
      const w = writeById.get(item.id)!
      const airportPosts = publishedPosts.filter((p) => p.airportCode === item.airportCode || !p.airportCode)
      return {
        customId: item.id,
        prompt: buildEditPrompt(w.html, item.keyword, item.articleType, item.articleStyle as any, item.airportCode, airportPosts, decision.failedChecks, decision.analysisContext, airportData),
        system: buildEditSystem() as Sys,
        model: modelForStep('edit'),
        maxTokens: MAX_TOKENS,
      }
    })
    const editRun = await runBatch(editReqs, { maxTokens: MAX_TOKENS })
    totalCost += editRun.cost
    for (const { item } of editInputs) {
      const r = editRun.results.get(item.id)
      // An edit failure is non-fatal — fall back to the write output (still publishable).
      if (!r || r.text === null) { console.log(`    ⚠ edit failed for ${item.slug} — keeping write output`); continue }
      try { editById.set(item.id, parseEdit(r.text)) }
      catch (e) { console.log(`    ⚠ edit parse failed for ${item.slug} (${e instanceof Error ? e.message : e}) — keeping write output`) }
    }
  } else {
    console.log(`\n📦 Batch phase 3/3 — edit: 0 items below threshold, skipping`)
  }

  // ── Phase 5: assemble final results ─────────────────────────────────────────
  for (const { item } of alive()) {
    const w = writeById.get(item.id)
    if (!w) continue
    const analysis = analysisById.get(item.id)!
    const decision = decisions.get(item.id)!
    const edit = editById.get(item.id)
    let currentScore = decision.writeScore
    let editSkipped = true
    let revisionMeta: { triggered: boolean; scoreBefore: number; scoreAfter: number; failedChecks: string[] } | undefined
    let editable = { html: w.html, changes: [] as string[], qualityScore: decision.writeScore.total }
    if (edit) {
      editSkipped = false
      editable = edit
      const editScore = decision.scoreHtml(edit.html)
      revisionMeta = { triggered: true, scoreBefore: decision.writeScore.total, scoreAfter: editScore.total, failedChecks: [...decision.failedChecks] }
      currentScore = editScore
      console.log(`  ✓ ${item.slug}: edited ${decision.writeScore.total}→${editScore.total}`)
    }
    outcomes.get(item.id)!.result = finalizeArticleResult(item, analysis, w, editable, currentScore, editSkipped, revisionMeta)
  }

  console.log(`\n✅ Batch generation done — ${alive().length}/${inputs.length} succeeded | text cost $${totalCost.toFixed(4)} (50% batch rate)`)
  return { outcomes: [...outcomes.values()], totalCost }
}
