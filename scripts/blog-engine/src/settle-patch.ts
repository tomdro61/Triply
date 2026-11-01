/**
 * settle-patch.ts — what happens to a rollback entry after a CMS PATCH threw.
 *
 * The writers (perf-apply, inject-coupon) record the pre-edit snapshot BEFORE the PATCH. When the PATCH then
 * throws, the entry cannot simply be dropped: the final error describes only the LAST attempt of withRetry, and an
 * earlier attempt may have committed before its response was lost (timeout, 5xx after commit, a 429 on the retry).
 * So the post is always re-read, and the entry is settled by what is actually live:
 *   - the edit is present  → it was applied after all: keep the entry as a normal change, caller continues (true);
 *   - the edit is absent   → nothing committed: the entry comes out, the error is rethrown;
 *   - the re-read failed   → unknown: the entry stays, flagged `patchUnverified` (skipped by perf measure, maintain
 *                            learn and GEO measure; still counts toward the edit cooldown and as "treated"), with a
 *                            warning that says how to clear it; the error is rethrown.
 * `deps` exist for tests; production callers pass nothing.
 */
import { findPostBySlug } from './payload.js'
import { saveRecord, type ArticlePerfRecord, type PerfChange } from './perf-snapshot.js'

export interface SettleDeps {
  readPost?: (slug: string) => Promise<unknown>
  save?: (rec: ArticlePerfRecord) => void
  warn?: (msg: string) => void
  log?: (msg: string) => void
}

export async function settleFailedPatch(
  slug: string,
  record: ArticlePerfRecord,
  change: PerfChange,
  isLive: (live: Record<string, unknown>) => boolean,
  err: unknown,
  deps: SettleDeps = {},
): Promise<boolean> {
  const readPost = deps.readPost ?? findPostBySlug
  const save = deps.save ?? saveRecord
  const warn = deps.warn ?? ((m: string) => console.warn(m))
  const log = deps.log ?? ((m: string) => console.log(m))

  let live: unknown
  try {
    live = await readPost(slug)
  } catch {
    live = undefined
  }

  if (live === undefined) {
    change.patchUnverified = true
    change.summary = `[PATCH outcome unknown — check the CMS, then clear patchUnverified] ${change.summary}`
    save(record)
    warn(
      `  ⚠ ${slug}: the ${change.type} PATCH failed AND the post could not be re-read — the edit may or may not be live. ` +
        `The rollback entry is kept, flagged patchUnverified (perf measure / maintain learn / GEO measure skip it). ` +
        `Check the page in the CMS, then either delete the flag from the article's perf record or run: perf revert --slug ${slug}`,
    )
    throw err
  }

  if (live && typeof live === 'object' && isLive(live as Record<string, unknown>)) {
    log(`  ⚠ ${slug}: the ${change.type} PATCH threw but the edit IS live — recorded as applied`)
    return true
  }

  const i = record.changes.lastIndexOf(change)
  if (i >= 0) record.changes.splice(i, 1)
  save(record)
  throw err
}
