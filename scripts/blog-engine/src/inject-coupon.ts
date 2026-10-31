/**
 * inject-coupon.ts — roll a REAL working promo code out to every coupon-intent page.
 *
 * Background (2026-07-28 Clarity finding): promo/coupon pages are the blog's most
 * commercial pages, yet they contained no actual codes — users dead-click on code
 * text expecting copy/reveal. This injects a standardized "working code" block at
 * the TOP of every coupon-intent post (slug matching coupon|promo|discount|deal|code),
 * using the same Lexical-prepend + lossless-revert ledger mechanics as perf-apply.
 *
 * SAFETY: run ONLY after checkout actually accepts the code — a published dead
 * code is worse than no code. Dry-run by default; idempotent (skips pages already
 * containing the code string); every edit is ledger-logged with preEdit for revert.
 *
 *   npx tsx src/inject-coupon.ts                          # dry-run, all matches
 *   npx tsx src/inject-coupon.ts --limit 3 --apply        # canary
 *   npx tsx src/inject-coupon.ts --apply                  # full rollout
 *   npx tsx src/inject-coupon.ts -a DFW --apply           # one airport
 *
 * Code/offer come from env: COUPON_CODE (required — no default; it must be a promo_codes row AND be listed in
 * src/config/approved-promo-codes.json, W1.4) and COUPON_PERCENT.
 */
import { Command } from 'commander'
import { getAllPublishedPosts, findPostBySlug, updatePost } from './payload.js'
import { htmlToLexical } from './html-to-lexical.js'
import { loadRecord, saveRecord } from './perf-snapshot.js'
import type { PerfChange } from './perf-snapshot.js'
import { stampField } from './stamp.js'
import { pingIndexNow, postUrlFor } from './indexnow.js'
import { lintArticle, formatLint, loadApprovedCodes, loadApprovedOffers } from './lint.js'

const CODE = (process.env.COUPON_CODE || '').trim().toUpperCase()
const PERCENT = Number(process.env.COUPON_PERCENT) || 10
// Human-readable expiry for the footnote, e.g. "November 30, 2026". Must match the
// row's expires_at in promo_codes. Unset = no expiry sentence.
const EXPIRES = process.env.COUPON_EXPIRES || ''
const SLUG_PATTERNS = /coupon|promo|discount|deal|code/i

// Copy is limited to what checkout actually enforces (api/checkout/lot/route.ts:
// active, expires_at, max_uses). There is NO per-customer limit in the code, so
// do not promise "one per customer"; the discount is taken off the parking
// subtotal, not the service fee, so say "parking rate".
function couponBlockHtml(): string {
  return [
    `<h2>Promo code ${CODE}: ${PERCENT}% off</h2>`,
    `<p><strong>${CODE}</strong> takes <strong>${PERCENT}% off the parking rate</strong> on any reservation booked through Triply. ` +
      `Enter it in the promo code field at checkout on triplypro.com — it works on every lot we list, with no signup required. ` +
      `Unlike the third-party codes that expire seasonally, this one is ours.</p>`,
    `<p><em>Applies to bookings made on triplypro.com.${EXPIRES ? ` Valid through ${EXPIRES}.` : ''}</em></p>`,
  ].join('')
}

async function fetchCouponIntentSlugs(airport?: string): Promise<string[]> {
  const all = await getAllPublishedPosts(airport)
  return all.filter((p) => SLUG_PATTERNS.test(p.slug)).map((p) => p.slug)
}

const program = new Command()
program
  .option('--apply', 'Write changes (default is dry-run)')
  .option('--limit <n>', 'Max posts to process this run', (v) => parseInt(v, 10))
  .option('-a, --airport <code>', 'Restrict to one airport')
  .option('-s, --slug <slugs...>', 'Target exact slug(s) only (canary mode)')
  .option('--stamp', 'Accepted for a uniform CLI; a coupon block is never a fact change, so the date never moves (W1.7)')
  .parse()
const opts = program.opts()

async function main() {
  const apply = !!opts.apply
  if (!CODE) {
    console.error('COUPON_CODE is not set. There is no default: the code must be a live promo_codes row AND be listed in src/config/approved-promo-codes.json.')
    process.exit(1)
  }
  const approved = loadApprovedCodes().map((c) => c.toUpperCase())
  if (!approved.includes(CODE)) {
    console.error(`COUPON_CODE "${CODE}" is not in src/config/approved-promo-codes.json (${approved.join(', ') || 'empty'}) — add it there with its source first (W1.4).`)
    process.exit(1)
  }
  const offers = loadApprovedOffers()
  if (offers[CODE] !== PERCENT) {
    console.error(`approved-promo-codes.json documents ${CODE} as ${offers[CODE] === undefined ? 'no percentOff' : `${offers[CODE]}% off`}; COUPON_PERCENT is ${PERCENT}. Fix one of them before rolling the code out.`)
    process.exit(1)
  }
  // W1.4: the block is linted once, like any other text that reaches a live post.
  const blockLint = lintArticle({ title: 'coupon block', html: couponBlockHtml(), keyword: 'promo code', isNew: false, approvedCodes: approved, approvedOffers: offers })
  if (!blockLint.ok) {
    console.error(`Coupon block fails the lint — nothing written:\n${formatLint(blockLint)}`)
    process.exit(1)
  }
  console.log(`\n🎟️  Coupon rollout — ${CODE} (${PERCENT}% off) ${apply ? '(APPLYING)' : '(dry-run)'}\n`)

  const targets: string[] = opts.slug?.length ? opts.slug : await fetchCouponIntentSlugs(opts.airport)
  const batch = opts.limit ? targets.slice(0, opts.limit) : targets
  console.log(`  ${targets.length} coupon-intent post(s) matched${opts.limit ? ` · processing ${batch.length}` : ''}\n`)

  let injected = 0
  let skippedHasCode = 0
  let failed = 0
  for (const slug of batch) {
    try {
      const post = await findPostBySlug(slug)
      if (!post) {
        console.log(`  ⚠ ${slug}: not found — skipping`)
        failed++
        continue
      }
      const content = post.content
      if (!content?.root?.children) {
        console.log(`  ⚠ ${slug}: no Lexical content — skipping`)
        failed++
        continue
      }
      if (JSON.stringify(content).includes(CODE)) {
        skippedHasCode++
        continue
      }
      const preEdit = { content: JSON.parse(JSON.stringify(content)) }
      const newNodes = htmlToLexical(couponBlockHtml()).root.children
      const now = new Date().toISOString()
      console.log(`  ✎ ${slug} (prepend ${newNodes.length} block(s))`)
      if (apply) {
        // No perf record = nowhere to keep the pre-edit snapshot = an edit nobody could revert. Skip it.
        const record = loadRecord(slug)
        if (!record) { console.log(`  ⚠ ${slug}: no perf record — no rollback snapshot would be kept; skipping (run perf measure first)`); failed++; continue }
        const change: PerfChange = {
          at: now,
          type: 'coupon-block',
          summary: `Injected promo code ${CODE} (${PERCENT}% off) — coupon-intent rollout`,
          baselineMetrics: (() => {
            const s = record.snapshots[record.snapshots.length - 1]?.gsc.totals
            return { clicks: s?.clicks ?? 0, impressions: s?.impressions ?? 0, position: s?.position ?? 0 }
          })(),
          preEdit,
        }
        // Rollback record BEFORE the live edit. If the PATCH fails: a 4xx committed nothing (entry out); otherwise the
        // post is re-read — block present = applied after all, absent = entry out, re-read failed = kept as
        // patchUnverified (skipped by measure/learn/tier until a person checks).
        record.changes.push(change); saveRecord(record)
        content.root.children.splice(0, 0, ...newNodes)
        try {
          // W1.7: a coupon block is not a fact about the airport — the date never moves for it.
          await updatePost(post.id, { content, ...stampField({ factsChanged: false, reason: 'coupon block prepended — not a fact change' }) })
        } catch (e) {
          const status = (e as { status?: unknown }).status
          const refused = typeof status === 'number' && status >= 400 && status < 500
          const live = refused ? null : await findPostBySlug(slug).catch(() => undefined)
          if (live === undefined) {
            change.patchUnverified = true
            change.summary = `[PATCH outcome unknown — check the CMS, then clear patchUnverified] ${change.summary}`
            saveRecord(record)
            throw e
          }
          if (live && JSON.stringify(live.content).includes(CODE)) {
            console.log(`  ⚠ ${slug}: the PATCH response was lost but the block IS live — recorded as applied`)
          } else {
            record.changes.pop(); saveRecord(record)
            throw e
          }
        }
        await pingIndexNow([postUrlFor(slug)])
      }
      injected++
    } catch (err) {
      failed++
      console.log(`  ✗ ${slug}: ${err instanceof Error ? err.message.slice(0, 120) : err}`)
    }
  }

  console.log(`\n✅ ${apply ? 'Injected' : 'Would inject'}: ${injected} · already has code: ${skippedHasCode} · failed/skipped: ${failed}`)
  if (apply && injected > 0) {
    console.log(`   Reminder: log this rollout → npm run changelog log "Coupon ${CODE} rolled out to ${injected} coupon-intent pages" -- --category content --impact high`)
  }
}

main()
