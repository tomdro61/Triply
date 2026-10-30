/**
 * stamp.ts — W1.7: `contentUpdatedAt` moves only when facts change, and only on purpose.
 *
 * Every writer in the engine that used to set `contentUpdatedAt` now asks this helper. The flag
 * `--stamp` (or STAMP_CONTENT_UPDATED=1) must be passed explicitly; the default is OFF and the
 * helper prints why the date was left alone. `reason` is what the apply step changed — the log
 * line is what a person reads to decide whether a stamp was right.
 *
 *   const patch = { content, ...stampField('--stamp passed; lot prices changed') }
 */

export function stampRequested(argv: string[] = process.argv): boolean {
  return argv.includes('--stamp') || process.env.STAMP_CONTENT_UPDATED === '1'
}

export interface StampOptions {
  /** True when the caller's diff changed facts (prices, hours, rules). Links, titles, CTAs and metadata are not facts. */
  factsChanged: boolean
  /** Human sentence for the log, e.g. "monthly price table rebuilt with 4 new rates". */
  reason: string
  /** Defaults to `stampRequested()`. Tests pass it in. */
  requested?: boolean
  now?: Date
  quiet?: boolean
}

/**
 * Returns `{ contentUpdatedAt }` when BOTH the flag was passed and the caller says facts changed;
 * otherwise `{}` and a log line saying why.
 */
export function stampField(opts: StampOptions): { contentUpdatedAt?: string } {
  const requested = opts.requested ?? stampRequested()
  if (requested && opts.factsChanged) {
    const iso = (opts.now || new Date()).toISOString()
    if (!opts.quiet) console.log(`  🗓 contentUpdatedAt → ${iso.slice(0, 10)} (${opts.reason})`)
    return { contentUpdatedAt: iso }
  }
  if (!opts.quiet) {
    const why = !requested
      ? 'no --stamp flag (dates move only by an explicit apply; W1.7)'
      : 'diff changed no facts'
    console.log(`  · contentUpdatedAt unchanged — ${why}${opts.reason ? `; ${opts.reason}` : ''}`)
  }
  return {}
}
