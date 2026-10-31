/**
 * stamp.ts — W1.7: `contentUpdatedAt` moves only when facts change, and only on purpose.
 *
 * Every writer in the engine that used to set `contentUpdatedAt` now asks this helper. The flag
 * `--stamp` must be passed explicitly on the command line; the default is OFF and the helper prints
 * why the date was left alone. (An env override was removed in the #141 review: a line in .env made
 * every writer stamp every edit with nothing visible on the command.) `reason` is what the apply
 * step changed — the log line is what a person reads to decide whether a stamp was right.
 *
 * `factsChanged` is the second half of the gate. Callers compute it with `factsDiff()` below —
 * sentences that carry a figure — never pass a constant.
 *
 *   const facts = factsDiff(lexicalText(livePost.content), newHtml)
 *   const patch = { content, ...stampField({ factsChanged: facts.changed, reason: '…' }) }
 */

export function stampRequested(argv: string[] = process.argv): boolean {
  return argv.includes('--stamp')
}

/** Sentences that carry a figure ($, C$, a number, a time) — the "facts" W1.7 compares. Tag-stripped, whitespace-normalised, lower-cased. */
export function factSentences(text: string): string[] {
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  return clean.split(/(?<=[.!?])\s+/).map((s) => s.trim().toLowerCase()).filter((s) => /\d/.test(s))
}

export interface FactsDiff { added: string[]; removed: string[]; changed: boolean }

/** Which figure-bearing sentences differ between two bodies (HTML or plain text). `changed === false` means no fact moved. */
export function factsDiff(before: string, after: string): FactsDiff {
  const b = new Set(factSentences(before))
  const a = new Set(factSentences(after))
  const added = [...a].filter((s) => !b.has(s))
  const removed = [...b].filter((s) => !a.has(s))
  return { added, removed, changed: added.length > 0 || removed.length > 0 }
}

/** Plain text of a Lexical document or node (every `text` leaf in order), for comparing a live post with its replacement. */
export function lexicalText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const n = node as { text?: unknown; children?: unknown[]; root?: unknown; type?: unknown }
  if (n.root) return lexicalText(n.root)
  const own = typeof n.text === 'string' ? n.text : ''
  // Inline text leaves concatenate as written (a leaf usually carries its own trailing space); blocks end with '. ' below.
  const kids = Array.isArray(n.children) ? n.children.map(lexicalText).join('') : ''
  const joined = own + kids
  // A block boundary ends a sentence so "…$18/day" + next heading don't fuse into one fact sentence.
  return n.type === 'paragraph' || n.type === 'heading' || n.type === 'listitem' || n.type === 'tablecell' ? `${joined}. ` : joined
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
