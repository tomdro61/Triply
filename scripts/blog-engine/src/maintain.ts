/**
 * `maintain` — tiered, performance-driven article maintenance (CLI).
 *
 * A router/scheduler on top of the existing perf loop. It polls every published
 * article's GSC performance, sorts each into a tier, and applies a tier-
 * appropriate treatment on a recurring cadence:
 *
 *   maintain plan    [-a X] [--refresh]          classify every article → triage table (read-only-ish)
 *   maintain run     [-a X] [--tier N] [--apply]  treat DUE items (highest demand first); dry-run w/o --apply
 *   maintain status  [-a X]                       tier distribution + what's due, from saved records (no GSC)
 *   maintain learn   [--no-policy]                measured verdicts → treatment ROI + auto-disable policy
 *   maintain holdout --assign|--list [-a X]       manage the never-touched control cohort
 *   maintain lift    [-a X]                       program-wide lift: treated vs holdout (from snapshots)
 *   maintain geo     capture|measure|report [-a X] AI-Overview citation track (GEO — parallel to Google)
 *
 * Treatments (all reuse existing code):
 *   Tier 1 full rewrite → re-queue slug + run the `generate` pipeline (human-gated: --rewrites)
 *   Tier 2 standard     → perf recommend/apply, filtered to quick-answer + faq-additions
 *   Tier 3 small        → perf recommend/apply, filtered to title-meta (CTR rescue)
 *   Tier 0 watch        → nothing (re-snapshot only)
 *
 * Learning loop: `perf measure` writes helped/hurt verdicts → `maintain learn` aggregates
 * them per (article-type × treatment) and disables proven losers → `maintain run` honors
 * that policy. Holdout cohort proves program lift. State lives in reports/articles/{slug}.json.
 * Idempotent + cadence/cooldown-aware → safe to run on a weekly schedule. Pair with
 * `perf measure --all` (validates + auto-reverts the prior cycle's edits).
 */

import { Command } from 'commander'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'
import { buildSnapshot, loadRecord, saveRecord } from './perf-snapshot.js'
import type { ArticlePerfRecord } from './perf-snapshot.js'
import { recommend } from './perf-recommend.js'
import { applyRecommendations } from './perf-apply.js'
import { getAllPublishedPosts, updateQueueItem } from './payload.js'
import type { PublishedPost } from './payload.js'
import { findQueueItemBySlug } from './queue.js'
import {
  classify, allowedRecTypes, nextDueAt, resolveTierConfig,
  DEFAULT_TIER_CONFIG,
} from './maintain-tier.js'
import type { Tier, TierDecision, TierConfig } from './maintain-tier.js'
import { runLearn, loadTreatmentPolicy } from './maintain-learn.js'
import type { TreatmentPolicy } from './maintain-learn.js'
import { assignHoldout, listHoldout, computeLift } from './maintain-holdout.js'
import { captureCitation, measureCitation, geoReport } from './maintain-geo.js'
import { SNAPSHOT_FRESH_HOURS } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_ROOT = path.resolve(__dirname, '..')
const PLAN_FILE = path.resolve(ENGINE_ROOT, 'reports', 'maintenance-plan.json')
const OVERRIDE_FILE = path.resolve(ENGINE_ROOT, 'reports', 'tier-config-override.json')

// Runtime state loaded once per command: the active (possibly operator-tuned) tier
// config and the learned treatment policy. Set by initRuntime() at command start.
let ACTIVE_CONFIG: TierConfig = DEFAULT_TIER_CONFIG
let ACTIVE_POLICY: TreatmentPolicy | null = null

function initRuntime(): void {
  ACTIVE_CONFIG = DEFAULT_TIER_CONFIG
  if (fs.existsSync(OVERRIDE_FILE)) {
    try {
      ACTIVE_CONFIG = resolveTierConfig(DEFAULT_TIER_CONFIG, JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf-8')))
      console.log(`  ⚙ using tuned tier config from ${path.basename(OVERRIDE_FILE)}`)
    } catch (e) {
      // Don't silently drop operator config — a malformed override that reverts to
      // defaults unnoticed would quietly change maintenance cadence/thresholds.
      console.warn(`  ⚠ ${path.basename(OVERRIDE_FILE)} is invalid (${e instanceof Error ? e.message : e}) — using default tier config`)
    }
  }
  ACTIVE_POLICY = loadTreatmentPolicy()
  if (ACTIVE_POLICY && Object.keys(ACTIVE_POLICY.disabled).length) {
    console.log(`  ⚙ learned policy active: ${Object.keys(ACTIVE_POLICY.disabled).length} treatment(s) disabled`)
  }
}

const TIER_LABEL: Record<Tier, string> = {
  0: 'watch',
  1: 'full-rewrite',
  2: 'standard',
  3: 'small',
}

interface Decision { post: PublishedPost; decision: TierDecision; holdout: boolean }

// ── Classification sweep ──────────────────────────────────────────────────────

/**
 * Classify every published article (optionally one airport). With refresh=true it
 * pulls a fresh GSC snapshot per article (accurate but slow); otherwise it uses the
 * latest saved snapshot (fast). Persists the maintenance block back to each record.
 */
async function gatherDecisions(airport: string | undefined, refresh: boolean): Promise<Decision[]> {
  const posts = await getAllPublishedPosts(airport)
  console.log(`  ${posts.length} published post(s)${airport ? ` for ${airport.toUpperCase()}` : ''}${refresh ? ' · refreshing GSC snapshots (slow)…' : ''}\n`)

  const now = new Date()
  const out: Decision[] = []
  let i = 0
  for (const post of posts) {
    i++
    let record = loadRecord(post.slug)
    const needsSnapshot = refresh || !record || record.snapshots.length === 0
    if (needsSnapshot) {
      try {
        record = await buildSnapshot(post.slug)
      } catch (e) {
        console.log(`  ⚠ [${i}/${posts.length}] ${post.slug}: snapshot failed — ${e instanceof Error ? e.message.slice(0, 80) : e}`)
        continue
      }
    }
    if (!record) continue

    const decision = classify(record, now, ACTIVE_CONFIG)

    // Persist the classification (keep any existing maintenance history fields).
    record.maintenance = {
      tier: decision.tier,
      action: decision.action,
      reason: decision.reason,
      classifiedAt: now.toISOString(),
      lastMaintainedAt: record.maintenance?.lastMaintainedAt ?? null,
      lastAction: record.maintenance?.lastAction ?? null,
      nextDueAt: record.maintenance?.nextDueAt ?? null,
    }
    saveRecord(record)
    out.push({ post, decision, holdout: record.holdout === true })
  }
  return out
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function printTriage(decisions: Decision[]): void {
  const byTier: Record<Tier, Decision[]> = { 0: [], 1: [], 2: [], 3: [] }
  for (const d of decisions) byTier[d.decision.tier].push(d)

  const cooldownCount = decisions.filter((d) => d.decision.action === 'cooldown').length
  const dueCount = decisions.filter((d) => d.decision.dueNow).length
  const projectedCost = decisions.filter((d) => d.decision.dueNow).reduce((s, d) => s + d.decision.estCost, 0)

  for (const tier of [1, 2, 3, 0] as Tier[]) {
    const group = byTier[tier].sort((a, b) => b.decision.impressions - a.decision.impressions)
    if (!group.length) continue
    const due = group.filter((d) => d.decision.dueNow).length
    console.log(`\n── Tier ${tier} · ${TIER_LABEL[tier]} — ${group.length} article(s), ${due} due now ──`)
    for (const d of group.slice(0, 25)) {
      const flag = d.decision.action === 'cooldown' ? '❄' : d.decision.dueNow ? '▶' : '·'
      console.log(`  ${flag} ${d.post.slug}`)
      console.log(`      ${d.decision.impressions} impr · ${d.decision.reason}`)
    }
    if (group.length > 25) console.log(`      … and ${group.length - 25} more`)
  }

  console.log(`\n📋 Triage summary`)
  console.log(`   Tier 1 rewrite: ${byTier[1].length} · Tier 2 standard: ${byTier[2].length} · Tier 3 small: ${byTier[3].length} · Tier 0 watch: ${byTier[0].length}`)
  console.log(`   Due this cycle: ${dueCount} · frozen (cooldown): ${cooldownCount}`)
  console.log(`   Projected cost if all due are run: ~$${projectedCost.toFixed(2)}\n`)
}

function savePlan(decisions: Decision[]): void {
  const dir = path.dirname(PLAN_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const plan = {
    generatedAt: new Date().toISOString(),
    total: decisions.length,
    byTier: { 0: 0, 1: 0, 2: 0, 3: 0 } as Record<string, number>,
    due: decisions.filter((d) => d.decision.dueNow).length,
    items: decisions.map((d) => ({
      slug: d.post.slug,
      airportCode: d.post.airportCode,
      tier: d.decision.tier,
      action: d.decision.action,
      reason: d.decision.reason,
      impressions: d.decision.impressions,
      dueNow: d.decision.dueNow,
    })),
  }
  for (const d of decisions) plan.byTier[String(d.decision.tier)]++
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2))
  console.log(`   Saved plan → ${PLAN_FILE}`)
}

// ── Treatment dispatch ────────────────────────────────────────────────────────

/** Stamp the record's maintenance block after a successful treatment. */
function stampMaintained(slug: string, tier: Tier, action: string): void {
  const record = loadRecord(slug)
  if (!record) return
  const now = new Date()
  record.maintenance = {
    tier,
    action,
    reason: record.maintenance?.reason ?? '',
    classifiedAt: record.maintenance?.classifiedAt ?? now.toISOString(),
    lastMaintainedAt: now.toISOString(),
    lastAction: action,
    nextDueAt: nextDueAt(tier, now, ACTIVE_CONFIG),
  }
  saveRecord(record)
}

const SNAPSHOT_FRESH_MS = SNAPSHOT_FRESH_HOURS * 60 * 60 * 1000 // reuse a snapshot taken this recently

/** Tier 2/3: recommend → filter to the tier's allowed types (minus learned-disabled) → apply. */
async function treatWithRecs(slug: string, tier: Tier, articleType: string, apply: boolean, withSerp: boolean, geoOverride = false): Promise<boolean> {
  const allowed = allowedRecTypes(tier, articleType, ACTIVE_POLICY, { geoOverride })
  if (!allowed.length) {
    console.log(`  · all tier-${tier} treatments disabled for ${articleType} by learned policy — skipping`)
    return false
  }
  // recommend requires a snapshot. Reuse a fresh one (e.g. from `run --refresh`)
  // instead of appending a second snapshot in the same cycle.
  const existing = loadRecord(slug)
  const latest = existing?.snapshots[existing.snapshots.length - 1]
  const fresh = latest && (Date.now() - new Date(latest.capturedAt).getTime()) < SNAPSHOT_FRESH_MS
  if (!fresh) await buildSnapshot(slug)
  const recs = await recommend(slug, withSerp)
  const filtered = recs.filter((r) => allowed.includes(r.type))
  if (!filtered.length) {
    console.log(`  · no ${allowed.join('/')} recommendation for ${slug} — skipping`)
    return false
  }
  const res = await applyRecommendations(slug, filtered, apply)
  if (apply && res.applied > 0) {
    stampMaintained(slug, tier, tier === 2 ? 'standard' : 'small')
    return true
  }
  return false
}

/** A CMS slug is lowercase kebab-case. Anything else is rejected before it reaches a subprocess. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,100}$/
// Spawn the node binary against tsx's CLI directly instead of going through
// npm.cmd: since the CVE-2024-27980 hardening, Node refuses to spawnSync a
// .cmd file without shell:true on Windows (EINVAL, surfaced as status null),
// and shell:true would reopen the injection surface the SLUG_RE guard closes.
const TSX_CLI = path.resolve(ENGINE_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

/** Tier 1: re-queue the slug and run the full generate pipeline as an isolated subprocess. */
async function treatRewrite(slug: string, apply: boolean): Promise<boolean> {
  // Defense-in-depth: the slug becomes a subprocess argv element, so validate it
  // against a strict allowlist even though it originates from our own CMS.
  if (!SLUG_RE.test(slug)) {
    console.log(`  ⚠ ${slug}: slug failed the allowlist (${SLUG_RE}) — refusing to spawn a rewrite`)
    return false
  }
  const qi = await findQueueItemBySlug(slug)
  if (!qi) {
    console.log(`  ⚠ ${slug}: no content-queue item found — cannot rewrite (generate reads from the queue)`)
    return false
  }
  if (!apply) {
    console.log(`  ▶ [dry-run] would re-queue "${slug}" (queue item ${qi.id}) and run: npm run generate -- -s ${slug}`)
    return false
  }
  // Capture the PRE-rewrite GSC baseline so `perf measure` can later judge whether
  // the rewrite helped — this is what brings Tier-1 into the learning loop. Reuse the
  // latest snapshot; only pull fresh if there's none.
  const preRec = loadRecord(slug)
  let baseline = preRec?.snapshots[preRec.snapshots.length - 1]?.gsc.totals
  if (!baseline) baseline = (await buildSnapshot(slug)).snapshots.slice(-1)[0]?.gsc.totals

  console.log(`  ✎ rewrite ${slug} — re-queueing + regenerating…`)
  await updateQueueItem(qi.id, { status: 'queued' })
  // No `shell: true` — each argv element is passed as a discrete token, so the slug
  // can never be interpreted by a shell (command-injection safe).
  const result = spawnSync(process.execPath, [TSX_CLI, 'src/index.ts', 'generate', '-s', slug, '-n', '1'], {
    cwd: ENGINE_ROOT,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    const why = result.error ? `spawn error: ${result.error.message}` : `exited ${result.status}`
    console.log(`  ✗ ${slug}: generate ${why} — left queue item as 'queued' for retry`)
    return false
  }

  // Log the rewrite as a measurable change (no preEdit → measured but NEVER
  // auto-reverted: a regeneration can't be losslessly undone). `perf measure`
  // will judge it after the window; `maintain learn` then aggregates rewrite ROI.
  const rec = loadRecord(slug)
  if (rec) {
    rec.changes.push({
      at: new Date().toISOString(),
      type: 'rewrite',
      summary: 'Tier-1 full regenerate (maintain)',
      baselineMetrics: {
        clicks: baseline?.clicks ?? 0,
        impressions: baseline?.impressions ?? 0,
        position: baseline?.position ?? 0,
      },
    })
    saveRecord(rec)
  }
  stampMaintained(slug, 1, 'rewrite')
  return true
}

// ── Commands ──────────────────────────────────────────────────────────────────

const program = new Command()
program.name('maintain').description('Tiered, performance-driven article maintenance')

program
  .command('plan')
  .description('Classify every published article into a maintenance tier (triage). Read-only treatments.')
  .option('-a, --airport <code>', 'Limit to one airport cluster (e.g. MSP)')
  .option('--refresh', 'Pull a fresh GSC snapshot per article (accurate but slow)')
  .action(async (o) => {
    try {
      console.log(`\n🗂  maintain plan${o.airport ? ` — ${o.airport.toUpperCase()}` : ''}\n`)
      initRuntime()
      const decisions = await gatherDecisions(o.airport, !!o.refresh)
      printTriage(decisions)
      savePlan(decisions)
    } catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program
  .command('run')
  .description('Treat DUE articles by tier (highest demand first). Dry-run unless --apply.')
  .option('-a, --airport <code>', 'Limit to one airport cluster')
  .option('-t, --tier <n>', 'Only process one tier (1, 2, or 3)')
  .option('-n, --limit <number>', 'Max articles to treat this run', '10')
  .option('--refresh', 'Refresh GSC snapshots during classification (recommended before a real run)')
  .option('--apply', 'Actually write changes (otherwise dry-run)')
  .option('--rewrites', 'Also run Tier-1 full rewrites (high-variance — off by default; they need approval)')
  .option('--no-serp', 'Skip the live SERP pull in recommendations (saves SerpAPI credits)')
  .action(async (o) => {
    try {
      const limit = parseInt(o.limit, 10) || 10
      const tierFilter = o.tier ? (parseInt(o.tier, 10) as Tier) : undefined
      console.log(`\n🔧 maintain run${o.airport ? ` — ${o.airport.toUpperCase()}` : ''} ${o.apply ? '(APPLYING)' : '(dry-run)'}\n`)
      initRuntime()

      const decisions = await gatherDecisions(o.airport, !!o.refresh)
      const heldOut = decisions.filter((d) => d.holdout && d.decision.dueNow && d.decision.action !== 'watch').length
      let candidates = decisions
        // Never treat the holdout cohort — it's the control for `maintain lift`.
        .filter((d) => !d.holdout && d.decision.dueNow && ['rewrite', 'standard', 'small'].includes(d.decision.action))
        .sort((a, b) => b.decision.impressions - a.decision.impressions)
      if (tierFilter) candidates = candidates.filter((d) => d.decision.tier === tierFilter)

      const batch = candidates.slice(0, limit)
      console.log(`\n  ${candidates.length} due · treating ${batch.length} this run (limit ${limit})${tierFilter ? ` · tier ${tierFilter} only` : ''}${heldOut ? ` · ${heldOut} held-out (control) skipped` : ''}\n`)

      let treated = 0
      let needsApproval = 0
      for (const { post, decision } of batch) {
        console.log(`\n━━━ ${post.slug}  [Tier ${decision.tier} · ${TIER_LABEL[decision.tier]}]`)
        console.log(`    ${decision.reason}`)
        try {
          let ok = false
          if (decision.tier === 1) {
            // Tier-1 rewrites are the highest-variance action (they discard the exact
            // content Google rewarded and reset the page's age). Human-gated by default.
            if (!o.rewrites) {
              console.log(`  ⚑ NEEDS APPROVAL — full rewrite held back. Re-run with --rewrites to execute, or fix by hand.`)
              needsApproval++
              continue
            }
            ok = await treatRewrite(post.slug, !!o.apply)
          } else if (decision.tier === 2 || decision.tier === 3) {
            ok = await treatWithRecs(post.slug, decision.tier, post.articleType || 'spoke', !!o.apply, o.serp !== false, !!decision.geoOverride)
          }
          if (ok) treated++
        } catch (e) {
          console.log(`  ✗ ${post.slug} failed: ${e instanceof Error ? e.message.slice(0, 140) : e}`)
        }
      }

      console.log(`\n✅ maintain run complete — ${treated}/${batch.length} treated${o.apply ? '' : ' (dry-run — nothing written)'}`)
      if (needsApproval > 0) console.log(`   ⚑ ${needsApproval} Tier-1 rewrite(s) held for approval — review, then re-run with --rewrites.`)
      if (o.apply && treated > 0) console.log(`   Reminder: run \`npm run perf measure --all\` after the 28-day window to validate + auto-revert.`)
      console.log('')
    } catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program
  .command('status')
  .description('Tier distribution + what is due, from saved records (no GSC calls)')
  .option('-a, --airport <code>', 'Limit to one airport cluster')
  .action(async (o) => {
    try {
      initRuntime()
      const posts = await getAllPublishedPosts(o.airport)
      const now = new Date()
      const counts: Record<Tier, number> = { 0: 0, 1: 0, 2: 0, 3: 0 }
      let classified = 0
      let due = 0
      let holdout = 0
      for (const post of posts) {
        const record = loadRecord(post.slug)
        if (!record || record.snapshots.length === 0) continue
        classified++
        if (record.holdout) holdout++
        const d = classify(record, now, ACTIVE_CONFIG)
        counts[d.tier]++
        if (d.dueNow) due++
      }
      console.log(`\n📊 maintain status${o.airport ? ` — ${o.airport.toUpperCase()}` : ''}`)
      console.log(`   ${classified}/${posts.length} classified (rest need \`maintain plan --refresh\`)`)
      console.log(`   Tier 1 rewrite: ${counts[1]} · Tier 2 standard: ${counts[2]} · Tier 3 small: ${counts[3]} · Tier 0 watch: ${counts[0]}`)
      console.log(`   Due this cycle: ${due} · holdout (control): ${holdout}\n`)
    } catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program
  .command('learn')
  .description('Aggregate measured treatment verdicts → ROI report + auto-disable policy for proven losers')
  .option('--min-samples <n>', 'Decisive samples required before a treatment can be disabled', '8')
  .option('--no-policy', 'Advisory only — write the ROI report but NOT treatment-policy.json')
  .action((o) => {
    try {
      runLearn({ writePolicy: o.policy !== false, minSamples: parseInt(o.minSamples, 10) || 8 })
    } catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program
  .command('holdout')
  .description('Manage the never-touched control cohort (for program-lift measurement)')
  .option('-a, --airport <code>', 'Limit to one airport cluster')
  .option('--assign', 'Assign ~pct%% of articles to the holdout (stratified, deterministic)')
  .option('--list', 'List the current holdout cohort')
  .option('--pct <n>', 'Holdout percentage', '5')
  .option('--dry-run', 'Preview assignment without writing records')
  .action(async (o) => {
    try {
      if (o.list) { await listHoldout(o.airport); return }
      if (o.assign) { await assignHoldout({ airport: o.airport, pct: parseInt(o.pct, 10) || 5, dryRun: !!o.dryRun }); return }
      console.log('Usage: maintain holdout --assign [--pct N] [--dry-run] | --list')
    } catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program
  .command('lift')
  .description('Measure program-wide lift: treated cohort vs holdout, from stored snapshots (no GSC calls)')
  .option('-a, --airport <code>', 'Limit to one airport cluster')
  .option('-w, --window <days>', 'Trailing window for first-vs-latest snapshot movement', '28')
  .action(async (o) => {
    try {
      await computeLift({ airport: o.airport, window: parseInt(o.window, 10) || 28 })
    } catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program
  .command('geo')
  .description('AI-Overview citation (GEO) track — capture | measure | report')
  .argument('<action>', 'capture (pull citation for ranking pages) | measure (citation delta) | report (KPIs)')
  .option('-a, --airport <code>', 'Limit to one airport cluster')
  .option('-n, --limit <number>', 'Max articles to capture (bounds SerpAPI spend)', '20')
  .option('-w, --window <days>', 'Attribution window before measuring citation', '28')
  .action(async (action, o) => {
    try {
      if (action === 'capture') await captureCitation({ airport: o.airport, limit: parseInt(o.limit, 10) || 20 })
      else if (action === 'measure') await measureCitation({ airport: o.airport, window: parseInt(o.window, 10) || 28 })
      else if (action === 'report') await geoReport({ airport: o.airport })
      else console.log('Usage: maintain geo capture|measure|report [-a X] [-n N] [-w days]')
    } catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program.parseAsync()
