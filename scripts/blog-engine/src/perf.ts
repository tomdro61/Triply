/**
 * `perf` — per-article performance review & improvement loop (CLI).
 *
 *   perf snapshot  --slug X            pull GSC + on-page state → reports/articles/{slug}.json
 *   perf recommend --slug X            research (GSC+SERP+history) → recommendations (no writes)
 *   perf run       --slug X [--apply]  snapshot → recommend → apply (autonomous, reversible)
 *   perf measure   --slug X | --all    after the window: verdict per change; auto-revert regressions
 *   perf revert    --slug X            undo the most recent applied change (restores pre-edit state)
 *
 * `run` without --apply is a full dry-run: it shows exactly what it would change.
 * See the plan at .claude/plans/ancient-scribbling-pearl.md.
 */

import { Command } from 'commander'
import { buildSnapshot } from './perf-snapshot.js'
import { recommend } from './perf-recommend.js'
import { applyRecommendations, revertLast, listAudits, clearAudits } from './perf-apply.js'
import { measureSlug, measureAll } from './perf-measure.js'

const program = new Command()
program.name('perf').description('Per-article performance review & improvement loop')

program
  .command('snapshot')
  .description("Pull a single article's GSC + on-page performance snapshot")
  .requiredOption('-s, --slug <slug>', 'Article slug (the part after /blog/)')
  .option('-d, --days <number>', 'GSC lookback window in days', '28')
  .action(async (o) => {
    try { await buildSnapshot(o.slug, parseInt(o.days, 10) || 28) }
    catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program
  .command('recommend')
  .description('Research (GSC + live SERP + history) and produce improvement recommendations (no writes)')
  .requiredOption('-s, --slug <slug>', 'Article slug')
  .option('-d, --days <number>', 'GSC lookback window in days', '28')
  .option('--no-serp', 'Skip the live SERP pull (saves a SerpAPI credit)')
  .option('--only <types>', 'Restrict to these recommendation type(s), comma-separated (e.g. quick-answer)')
  .action(async (o) => {
    try {
      await buildSnapshot(o.slug, parseInt(o.days, 10) || 28)
      const only = o.only ? String(o.only).split(',').map((t: string) => t.trim()).filter(Boolean) : undefined
      await recommend(o.slug, o.serp !== false, only)
    } catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program
  .command('run')
  .description('Full cycle: snapshot → recommend → apply. Dry-run unless --apply.')
  .requiredOption('-s, --slug <slug>', 'Article slug')
  .option('-d, --days <number>', 'GSC lookback window in days', '28')
  .option('--apply', 'Actually write the additive/reversible changes to the CMS')
  .option('--stamp', 'Accepted for a uniform CLI; perf edits never change a fact, so contentUpdatedAt never moves for them (W1.7)')
  .option('--no-serp', 'Skip the live SERP pull (saves a SerpAPI credit)')
  .option('--only <types>', 'Restrict to these recommendation type(s), comma-separated (e.g. quick-answer)')
  .action(async (o) => {
    try {
      await buildSnapshot(o.slug, parseInt(o.days, 10) || 28)
      const only = o.only ? String(o.only).split(',').map((t: string) => t.trim()).filter(Boolean) : undefined
      const recs = await recommend(o.slug, o.serp !== false, only)
      await applyRecommendations(o.slug, recs, !!o.apply)
    } catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program
  .command('measure')
  .description('Measure applied changes past their window; auto-revert regressions')
  .option('-s, --slug <slug>', 'Measure one article')
  .option('--all', 'Measure every article record')
  .option('-w, --window <days>', 'Attribution window before a change is measurable', '28')
  .option('-d, --days <number>', 'GSC lookback window for the "after" pull', '28')
  .option('--no-revert', 'Report verdicts but do NOT auto-revert regressions')
  .action(async (o) => {
    try {
      const w = parseInt(o.window, 10)
      const window = Number.isFinite(w) ? w : 28 // allow --window 0 (force measure now)
      const days = parseInt(o.days, 10) || 28
      if (o.all) await measureAll(window, o.revert !== false, days)
      else if (o.slug) await measureSlug(o.slug, window, o.revert !== false, days)
      else console.log('Usage: perf measure --slug <slug> | --all')
    } catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program
  .command('audit')
  .description('List edits flagged for after-the-fact spot-audit (review a sample)')
  .option('--clear', 'Mark all audit items reviewed')
  .action(async (o) => {
    try { if (o.clear) clearAudits(); else listAudits() }
    catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program
  .command('revert')
  .description('Undo the most recent applied change for a slug (restores pre-edit CMS state)')
  .requiredOption('-s, --slug <slug>', 'Article slug')
  .action(async (o) => {
    try { await revertLast(o.slug) }
    catch (e) { console.error('\n  Error:', e instanceof Error ? e.message : e, '\n'); process.exit(1) }
  })

program.parseAsync()
