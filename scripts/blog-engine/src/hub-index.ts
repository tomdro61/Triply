/**
 * hub-index.ts — deterministic "More <Airport> parking guides" index block for hubs.
 *
 * WHY THIS EXISTS
 * ---------------
 * reports/link-audit-2026-09-15.txt found 1,089 spokes across the 26 hubs that
 * are parented DIRECTLY to their hub (articleType 'spoke', parentSlug === hub.slug)
 * and that the hub does not link to. update-links.ts fixes missing links by
 * round-tripping the whole article through an LLM (Lexical → HTML → Claude →
 * HTML → Lexical). That is the wrong instrument for 100+ links into one page:
 * it is expensive, non-deterministic, rewrites nodes it was not asked to touch,
 * and it will not reliably place 129 anchors (FLL) in one pass.
 *
 * This file follows booking-links.ts instead:
 *   - nodes are built directly as Lexical JSON — no HTML round trip, so every
 *     pre-existing node in the document stays byte-identical,
 *   - zero model cost, zero hallucination surface (anchor text IS the child's
 *     own title, href IS its own slug),
 *   - idempotent: the block's h2 is its own marker, so a re-run replaces it.
 *
 * NODE SHAPES — confirmed against live content, not guessed
 * --------------------------------------------------------
 * Pulled 2026-09-15 from GET {PAYLOAD_CMS_URL}/api/posts (published, JFK):
 *
 *   heading  — jfk-airport-parking-sold-out, root child 0:
 *              { tag:'h2', type:'heading', format:'', indent:0, version:1,
 *                children:[…], direction:'ltr', textStyle:'', textFormat:0 }
 *   list     — jfk-airport-parking-sold-out, a root-level <ul>:
 *              { tag:'ul', type:'list', start:1, format:'', indent:0, version:1,
 *                children:[…], listType:'bullet', direction:'ltr' }
 *   listitem — a child of that list (NOTE: `checked` IS present, and `value` is
 *              1-based and increments per item):
 *              { type:'listitem', value:1, format:'', indent:0, checked:false,
 *                version:1, children:[…], direction:'ltr' }
 *   link     — a link inside a listitem, jfk-airport-parking-promo-code-reddit:
 *              { type:'link', fields:{ url, newTab:false, linkType:'custom' },
 *                format:'', indent:0, version:1, children:[…], direction:'ltr' }
 *              (`rel` appears ONLY on external links — we omit it; these are
 *              internal and must stay followable.)
 *   text     — { mode:'normal', text, type:'text', style:'', detail:0,
 *                format:0, version:1 }; bold is format:1 on the TEXT node while
 *              the paragraph keeps textFormat:0 (confirmed on an all-bold
 *              paragraph in jfk-airport-parking-sold-out).
 *
 * These are identical to makeHeadingNode/makeListNode/makeListItemNode/
 * makeLinkNode in html-to-lexical.ts — which is what every existing article was
 * built with — so the block is indistinguishable from hand-authored content.
 *
 * Usage:
 *   npx tsx src/hub-index.ts -a JFK --dry-run
 *   npx tsx src/hub-index.ts -a JFK --prove          # round-trip proof, no writes
 *   npx tsx src/hub-index.ts -a ALL --dry-run --out reports/hub-index-dryrun-2026-09-15.txt
 *   npx tsx src/hub-index.ts -a ALL --apply
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Command } from 'commander'
import { env, BLOG_BASE_URL } from './config.js'
import { lexicalToHtml } from './lexical-to-html.js'
import { airportCodesOnDisk, airportFullName, bookingPathFor } from './booking-links.js'
import { updatePost } from './payload.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_ROOT = path.resolve(__dirname, '..')

// ── Lexical node builders (shapes above) ─────────────────────────────────────

export interface AnyNode {
  type?: string
  tag?: string
  text?: string
  format?: number | string
  listType?: string
  fields?: { url?: string; linkType?: string; newTab?: boolean; rel?: string }
  children?: AnyNode[]
  [k: string]: unknown
}

export function makeTextNode(text: string, format = 0): AnyNode {
  return { mode: 'normal', text, type: 'text', style: '', detail: 0, format, version: 1 }
}

export function makeLinkNode(url: string, children: AnyNode[]): AnyNode {
  return {
    type: 'link',
    fields: { url, newTab: false, linkType: 'custom' },
    format: '',
    indent: 0,
    version: 1,
    children,
    direction: 'ltr',
  }
}

export function makeListItemNode(children: AnyNode[], value: number): AnyNode {
  return {
    type: 'listitem',
    value,
    format: '',
    indent: 0,
    checked: false,
    version: 1,
    children,
    direction: 'ltr',
  }
}

export function makeListNode(children: AnyNode[]): AnyNode {
  return {
    tag: 'ul',
    type: 'list',
    start: 1,
    format: '',
    indent: 0,
    version: 1,
    children,
    listType: 'bullet',
    direction: 'ltr',
  }
}

export function makeHeadingNode(tag: 'h2' | 'h3', children: AnyNode[]): AnyNode {
  return {
    tag,
    type: 'heading',
    format: '',
    indent: 0,
    version: 1,
    children,
    direction: 'ltr',
    textStyle: '',
    textFormat: 0,
  }
}

export function makeParagraphNode(children: AnyNode[]): AnyNode {
  return {
    type: 'paragraph',
    format: '',
    indent: 0,
    version: 1,
    children,
    direction: 'ltr',
    textStyle: '',
    textFormat: 0,
  }
}

// ── Intent grouping ──────────────────────────────────────────────────────────
//
// Two separate orders, deliberately:
//
//   MATCH_ORDER   — most specific intent wins. "sold out" and "coupon" are
//                   narrow, unambiguous signals; "terminal"/"garage" is broad
//                   and would otherwise swallow half the corpus (every ATL rate
//                   page mentions a deck). So the narrow buckets are tested first.
//   DISPLAY_ORDER — what a reader wants to see first on an index page: what it
//                   costs, how to pay less, long stays, where the lots are, what
//                   to do when it is all full.
//
// Matching runs against the SLUG first (the slug IS the target keyword — the
// cleanest intent signal we have), and only falls back to the title when the
// slug says nothing. Both are normalised to hyphen-separated lowercase so one
// keyword list serves both.

export const GROUP_RATES = 'Rates & prices'
export const GROUP_COUPONS = 'Coupons & deals'
export const GROUP_LONG_TERM = 'Long-term parking'
export const GROUP_TERMINAL = 'Terminals, garages & lots'
export const GROUP_SOLD_OUT = 'Sold out & construction'
export const GROUP_OTHER = 'Everything else'

/** Tested in this order — narrowest intent first. */
const MATCH_ORDER: { group: string; keywords: string[] }[] = [
  {
    group: GROUP_SOLD_OUT,
    keywords: [
      'sold-out', 'parking-full', 'is-full', 'lot-full', 'no-parking', 'construction',
      'closed', 'closure', 'closing', 'capacity', 'availability', 'open-now',
      'parking-open', 'parking-status', 'parking-today', 'waitlist', 'outage',
      'what-to-do',
    ],
  },
  {
    group: GROUP_COUPONS,
    keywords: [
      'coupon', 'promo', 'discount', 'deal', '-code', 'reddit', 'aaa', 'senior',
      'military', 'veteran', 'employee', 'groupon', 'free-parking', 'parking-free',
      'park-free', 'validation',
    ],
  },
  {
    group: GROUP_LONG_TERM,
    keywords: [
      'long-term', 'longterm', 'long-stay', 'extended', 'week', 'month',
      'overnight', '-days', 'two-day', 'multi-day', 'park-sleep-fly', 'psf',
    ],
  },
  {
    group: GROUP_RATES,
    keywords: [
      'rate', 'price', 'cost', 'how-much', 'pricing', 'cheap', 'daily', 'per-day',
      'hourly', '-fee', 'fees', 'prepaid', 'prepay', 'payment', 'pay-', 'charges',
      'toll', 'sunpass', 'ez-pass', 'ezpass', 'economy', 'budget', 'save',
    ],
  },
  {
    group: GROUP_TERMINAL,
    keywords: [
      'terminal', 'garage', 'deck', '-lot', 'lots', 'valet', 'covered', 'shuttle',
      'map', 'address', 'direction', 'gate', 'level', 'zone', 'curbside',
      'concourse', 'remote', 'on-site', 'off-site', 'onsite', 'offsite',
      'on-airport', 'off-airport', 'north', 'south', 'east', 'west', 'central',
      'cell-phone', 'cellphone', 'near-', 'closest', 'walking-distance', 'distance',
    ],
  },
]

/** The order the groups appear in the rendered block. */
export const DISPLAY_ORDER = [
  GROUP_RATES,
  GROUP_COUPONS,
  GROUP_LONG_TERM,
  GROUP_TERMINAL,
  GROUP_SOLD_OUT,
  GROUP_OTHER,
]

/** Lowercase, hyphen-separated — so one keyword list matches slugs and titles alike. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function groupFor(slug: string, title: string): string {
  const s = `-${normalise(slug)}-`
  for (const { group, keywords } of MATCH_ORDER) {
    for (const k of keywords) if (s.includes(k)) return group
  }
  const t = `-${normalise(title)}-`
  for (const { group, keywords } of MATCH_ORDER) {
    for (const k of keywords) if (t.includes(k)) return group
  }
  return GROUP_OTHER
}

// ── "Is this spoke already linked from the hub?" ─────────────────────────────
//
// Two readings of the same question, both reported:
//
//   loose  — the audit's test, and the one this job specifies: does the hub HTML
//            contain the substring `${BLOG_BASE_URL}/${slug}` anywhere. This is
//            the GATE, because it can only ever over-skip (a hub that links
//            .../foo-bar counts .../foo as linked too), and over-skipping is
//            safe while a duplicate link is not.
//   strict — does any <a href> resolve to exactly that slug (trailing slash,
//            ?query and #hash tolerated). This is the true answer. It is
//            reported per hub as `loose-only` so the gap against the audit's
//            1,089 is visible rather than silent.

export function hrefsIn(html: string): string[] {
  const out: string[] = []
  const re = /<a\s+href="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m[1])
  return out
}

export function linkedLoose(html: string, slug: string): boolean {
  return html.includes(`${BLOG_BASE_URL}/${slug}`)
}

export function linkedStrict(hrefs: string[], slug: string): boolean {
  const absolute = `${BLOG_BASE_URL}/${slug}`
  const relative = `/blog/${slug}`
  for (const raw of hrefs) {
    const href = raw.replace(/&amp;/g, '&').split('#')[0].split('?')[0].replace(/\/+$/, '')
    if (href === absolute || href === relative) return true
  }
  return false
}

// ── Block construction ───────────────────────────────────────────────────────

export interface Spoke {
  slug: string
  title: string
}

export function headingTextFor(code: string): string {
  return `More ${airportFullName(code)} parking guides`
}

/** Concatenated plain text of an element node's descendants. */
export function nodeText(node: AnyNode | undefined): string {
  if (!node) return ''
  if (typeof node.text === 'string') return node.text
  return (node.children || []).map(nodeText).join('')
}

export interface BuiltGroup {
  name: string
  spokes: Spoke[]
}

/**
 * Group + order the spokes for a reader: display order above, alphabetical by
 * title inside each group. Groups with no members disappear.
 */
export function groupSpokes(spokes: Spoke[]): BuiltGroup[] {
  const buckets = new Map<string, Spoke[]>()
  for (const s of spokes) {
    const g = groupFor(s.slug, s.title)
    const arr = buckets.get(g)
    if (arr) arr.push(s)
    else buckets.set(g, [s])
  }
  const out: BuiltGroup[] = []
  for (const name of DISPLAY_ORDER) {
    const arr = buckets.get(name)
    if (!arr || arr.length === 0) continue
    arr.sort((a, b) => a.title.localeCompare(b.title, 'en'))
    out.push({ name, spokes: arr })
  }
  return out
}

/**
 * The block: one h2 (the idempotence marker), then per group an optional bold
 * label paragraph and one bullet list.
 *
 * Labels are emitted when there is more than one group OR the hub has more than
 * LABEL_THRESHOLD spokes — a single short list does not need a sub-heading, a
 * 129-link index absolutely does.
 */
export const LABEL_THRESHOLD = 60

export function buildBlock(code: string, groups: BuiltGroup[]): AnyNode[] {
  const total = groups.reduce((n, g) => n + g.spokes.length, 0)
  const withLabels = groups.length > 1 || total > LABEL_THRESHOLD
  const nodes: AnyNode[] = [makeHeadingNode('h2', [makeTextNode(headingTextFor(code))])]

  for (const g of groups) {
    if (withLabels) nodes.push(makeParagraphNode([makeTextNode(g.name, 1)]))
    nodes.push(
      makeListNode(
        g.spokes.map((s, i) =>
          makeListItemNode([makeLinkNode(`${BLOG_BASE_URL}/${s.slug}`, [makeTextNode(s.title)])], i + 1)
        )
      )
    )
  }
  return nodes
}

// ── Idempotence: find and strip a previous block ─────────────────────────────

export interface ExistingBlock {
  start: number
  /** Exclusive. */
  end: number
}

/** True if this node is one of our bold group-label paragraphs. */
function isGroupLabel(node: AnyNode | undefined): boolean {
  if (!node || node.type !== 'paragraph') return false
  const kids = node.children || []
  if (kids.length !== 1) return false
  const k = kids[0]
  return k.type === 'text' && k.format === 1 && DISPLAY_ORDER.includes(String(k.text))
}

/**
 * Locate a block written by a previous run: the h2 whose text is exactly the
 * marker, plus every following list / group-label node, stopping at the first
 * node that is neither. Returns null when there is none.
 */
export function findExistingBlock(children: AnyNode[], marker: string): ExistingBlock | null {
  for (let i = 0; i < children.length; i++) {
    const n = children[i]
    if (!n || n.type !== 'heading' || n.tag !== 'h2') continue
    if (nodeText(n).trim() !== marker) continue
    let end = i + 1
    while (end < children.length) {
      const next = children[end]
      if (next && (next.type === 'list' || isGroupLabel(next))) end++
      else break
    }
    return { start: i, end }
  }
  return null
}

// ── Insert point: before the booking CTA, so the CTA stays last ──────────────

/**
 * Index to splice the block in at. The booking CTA written by booking-links.ts
 * is the LAST root child and contains a link to `/<city>/airport-parking`; when
 * it is there we go in front of it, otherwise we go on the end. Detected exactly
 * as link-audit.ts's hasTrailingBookingCta does: the last root child, in isolation.
 */
export function insertIndexFor(children: AnyNode[], bookingPath: string | null): number {
  if (children.length === 0) return 0
  const last = children[children.length - 1]
  let hasCtaLink = false
  const walk = (n: AnyNode | undefined) => {
    if (!n || hasCtaLink) return
    const url = n.fields?.url
    if (n.type === 'link' && typeof url === 'string') {
      if ((bookingPath && url.includes(bookingPath)) || url.includes('/airport-parking')) hasCtaLink = true
    }
    for (const c of n.children || []) walk(c)
  }
  walk(last)
  return hasCtaLink ? children.length - 1 : children.length
}

/** Strip any previous block, then splice the new one in. Nothing else is touched. */
export function applyBlock(
  content: unknown,
  code: string,
  blockNodes: AnyNode[],
  bookingPath: string | null
): { content: unknown; replaced: boolean; beforeCount: number; afterCount: number } {
  const doc = content as { root: Record<string, unknown> & { children: AnyNode[] } }
  const beforeCount = doc.root.children.length
  let children = doc.root.children.slice()

  const existing = findExistingBlock(children, headingTextFor(code))
  const replaced = existing !== null
  if (existing) children.splice(existing.start, existing.end - existing.start)

  const at = insertIndexFor(children, bookingPath)
  children = [...children.slice(0, at), ...blockNodes, ...children.slice(at)]

  return {
    content: { ...(content as Record<string, unknown>), root: { ...doc.root, children } },
    replaced,
    beforeCount,
    afterCount: children.length,
  }
}

// ── CMS read (paginated copy of update-links.ts's fetchPublishedPosts) ───────
//
// Do NOT import from update-links.ts — a linking pass is running out of that
// file. Pagination has to walk every page: a single capped pull silently drops
// the OLDEST rows (Payload returns newest-first), i.e. the hubs.

export interface HubIndexPost {
  id: string
  slug: string
  title: string
  articleType: string
  parentSlug?: string
  hubSlug?: string
  content: unknown
}

async function fetchPublishedPosts(airportCode: string): Promise<HubIndexPost[]> {
  const all: HubIndexPost[] = []
  let page = 1
  for (;;) {
    const params = new URLSearchParams({
      'where[status][equals]': 'published',
      'where[airportCode][equals]': airportCode.toUpperCase(),
      limit: '200',
      page: String(page),
    })
    const res = await fetch(`${env.PAYLOAD_CMS_URL}/api/posts?${params.toString()}`, {
      headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` },
    })
    if (!res.ok) throw new Error(`Failed to fetch posts: ${res.status} ${await res.text()}`)
    const data = await res.json()
    for (const doc of (data.docs || []) as Record<string, unknown>[]) {
      all.push({
        id: String(doc.id),
        slug: String(doc.slug),
        title: String(doc.title || ''),
        articleType: (doc.articleType as string) || 'spoke',
        parentSlug: (doc.parentSlug as string) || undefined,
        hubSlug: (doc.hubSlug as string) || undefined,
        content: doc.content,
      })
    }
    if (!data.hasNextPage) break
    page++
  }
  return all
}

// ── Per-hub planning ─────────────────────────────────────────────────────────

export interface HubPlan {
  code: string
  hubId: string
  hubSlug: string
  hubTitle: string
  content: unknown
  /** Direct-child spokes (parentSlug === hub.slug). */
  spokesTotal: number
  /** Already linked under the loose (audit) test — these are skipped. */
  alreadyLinked: number
  /** Linked under loose but NOT under strict href matching — i.e. a prefix collision. */
  looseOnly: number
  /** Sub-pillars (hubSlug === hub.slug) — linked inline by update-links.ts, not by us. */
  subPillars: number
  subPillarsLinked: number
  toAdd: Spoke[]
  groups: BuiltGroup[]
  blockNodes: AnyNode[]
  replaced: boolean
  beforeCount: number
  afterCount: number
  newContent: unknown
}

export function planHub(code: string, hub: HubIndexPost, posts: HubIndexPost[]): HubPlan | null {
  const doc = hub.content as { root?: { children?: unknown[] } } | null
  if (!doc || !doc.root || !Array.isArray(doc.root.children)) return null

  const html = lexicalToHtml(hub.content as Parameters<typeof lexicalToHtml>[0])
  const hrefs = hrefsIn(html)

  const spokes = posts.filter((p) => p.articleType === 'spoke' && p.parentSlug === hub.slug)
  const subPillars = posts.filter((p) => p.articleType === 'sub-pillar' && p.hubSlug === hub.slug)

  let alreadyLinked = 0
  let looseOnly = 0
  const toAdd: Spoke[] = []
  for (const s of spokes) {
    if (linkedLoose(html, s.slug)) {
      alreadyLinked++
      if (!linkedStrict(hrefs, s.slug)) looseOnly++
      continue
    }
    toAdd.push({ slug: s.slug, title: s.title })
  }

  const groups = groupSpokes(toAdd)
  const blockNodes = toAdd.length > 0 ? buildBlock(code, groups) : []
  const bookingPath = bookingPathFor(code)

  const applied =
    toAdd.length > 0
      ? applyBlock(hub.content, code, blockNodes, bookingPath)
      : {
          content: hub.content,
          replaced: false,
          beforeCount: doc.root.children.length,
          afterCount: doc.root.children.length,
        }

  return {
    code,
    hubId: hub.id,
    hubSlug: hub.slug,
    hubTitle: hub.title,
    content: hub.content,
    spokesTotal: spokes.length,
    alreadyLinked,
    looseOnly,
    subPillars: subPillars.length,
    subPillarsLinked: subPillars.filter((sp) => linkedLoose(html, sp.slug)).length,
    toAdd,
    groups,
    blockNodes,
    replaced: applied.replaced,
    beforeCount: applied.beforeCount,
    afterCount: applied.afterCount,
    newContent: applied.content,
  }
}

// ── Proof mode ───────────────────────────────────────────────────────────────
//
// Writes nothing. Renders the NEW document through lexicalToHtml, prints the
// first 30 lines of the block's HTML, shows the root-children delta, and asserts
// that every pre-existing node is byte-identical (JSON.stringify comparison of
// the old children array against the new one with the block's nodes removed).

export function proveHub(plan: HubPlan, log: (s?: string) => void): boolean {
  const oldChildren = (plan.content as { root: { children: AnyNode[] } }).root.children
  const newChildren = (plan.newContent as { root: { children: AnyNode[] } }).root.children

  log(``)
  log(`━━━ PROOF — ${plan.hubSlug} (${plan.code}) ━━━`)
  log(`Root children: ${plan.beforeCount} → ${plan.afterCount}  (+${plan.afterCount - plan.beforeCount})`)
  log(
    `Block nodes added: ${plan.blockNodes.length}  ` +
      `(1 heading + ${plan.groups.length} label(s) + ${plan.groups.length} list(s))`
  )
  log(`Previous block replaced: ${plan.replaced ? 'yes' : 'no (first run)'}`)

  // Remove exactly the nodes we inserted, by identity, and compare the remainder.
  const inserted = new Set<AnyNode>(plan.blockNodes)
  const remainder = newChildren.filter((n) => !inserted.has(n))
  const ok = JSON.stringify(remainder) === JSON.stringify(oldChildren)
  log(
    `Pre-existing nodes byte-identical: ${ok ? 'YES' : 'NO'}  ` +
      `(${remainder.length} retained vs ${oldChildren.length} original)`
  )
  if (!ok) {
    for (let i = 0; i < Math.max(remainder.length, oldChildren.length); i++) {
      if (JSON.stringify(remainder[i]) !== JSON.stringify(oldChildren[i])) {
        log(`   first divergence at index ${i}: ${JSON.stringify(oldChildren[i]).slice(0, 200)}`)
        log(`                              vs ${JSON.stringify(remainder[i]).slice(0, 200)}`)
        break
      }
    }
  }

  const blockHtml = lexicalToHtml({ root: { children: plan.blockNodes } } as Parameters<typeof lexicalToHtml>[0])
  // lexicalToHtml joins root children with \n; split <li>/<ul> onto their own
  // lines so "first 30 lines" shows real content rather than one giant line.
  const pretty = blockHtml
    .replace(/<\/li>/g, '</li>\n')
    .replace(/<ul>/g, '<ul>\n')
    .replace(/<\/ul>/g, '</ul>\n')
    .split('\n')
    .filter((l) => l.trim() !== '')

  log(``)
  log(`Block rendered through lexicalToHtml — first 30 of ${pretty.length} lines:`)
  for (const line of pretty.slice(0, 30)) log(`   ${line}`)
  if (pretty.length > 30) log(`   … ${pretty.length - 30} more line(s)`)

  // Round-trip the WHOLE new document too, so the block is proved in context.
  const fullHtml = lexicalToHtml(plan.newContent as Parameters<typeof lexicalToHtml>[0])
  const marker = headingTextFor(plan.code)
  log(``)
  log(
    `Whole-document round trip: ${fullHtml.length} chars, ` +
      `block heading present: ${fullHtml.includes(marker) ? 'yes' : 'NO'}`
  )
  const anchorsAdded = plan.toAdd.filter((s) => fullHtml.includes(`href="${BLOG_BASE_URL}/${s.slug}"`)).length
  log(`Anchors resolving in rendered HTML: ${anchorsAdded}/${plan.toAdd.length}`)

  // The CTA must still be the last root child when it was there to begin with.
  const lastBefore = oldChildren[oldChildren.length - 1]
  const lastAfter = newChildren[newChildren.length - 1]
  log(`Last root child unchanged (CTA stays last): ${lastBefore === lastAfter ? 'YES' : 'NO'}`)
  log(``)

  return ok && anchorsAdded === plan.toAdd.length && lastBefore === lastAfter
}

// ── Runner ───────────────────────────────────────────────────────────────────

export interface HubIndexOptions {
  airport: string
  apply: boolean
  prove: boolean
  verbose: boolean
  limit?: number
  out?: string
}

export async function runHubIndex(options: HubIndexOptions): Promise<void> {
  const codes =
    options.airport.toUpperCase() === 'ALL' ? airportCodesOnDisk() : [options.airport.toUpperCase()]

  const lines: string[] = []
  const log = (s = '') => {
    lines.push(s)
    console.log(s)
  }

  const mode = options.apply ? 'APPLY — will PATCH content' : 'DRY RUN — no writes'
  log(``)
  log(`Triply Blog Engine — Hub index block ("More <Airport> parking guides")`)
  log(`Generated: ${new Date().toISOString()}`)
  log(`CMS: ${env.PAYLOAD_CMS_URL}`)
  log(`Airports: ${codes.length === 1 ? codes[0] : `ALL (${codes.length})`}   Mode: ${mode}`)
  if (options.limit) log(`Limit: ${options.limit} hub(s)`)
  log(``)

  const plans: HubPlan[] = []
  let hubsProcessed = 0
  let proved = false
  let proofOk = true
  let applied = 0
  let failed = 0

  for (const code of codes) {
    if (options.limit && hubsProcessed >= options.limit) break

    let posts: HubIndexPost[]
    try {
      posts = await fetchPublishedPosts(code)
    } catch (err) {
      log(`── ${code} ── FAILED to fetch: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const hubs = posts.filter((p) => p.articleType === 'hub')
    if (hubs.length === 0) {
      log(`── ${code} ── no published hub — skipped`)
      continue
    }

    for (const hub of hubs) {
      if (options.limit && hubsProcessed >= options.limit) break
      const plan = planHub(code, hub, posts)
      if (!plan) {
        log(`── ${code} ── ${hub.slug}: no Lexical content — skipped`)
        continue
      }
      hubsProcessed++
      plans.push(plan)

      log(
        `── ${code} ── ${plan.hubSlug}  |  direct-child spokes ${plan.spokesTotal}, ` +
          `already linked ${plan.alreadyLinked}, to add ${plan.toAdd.length}` +
          `${plan.looseOnly ? `  (! ${plan.looseOnly} counted linked by substring only)` : ''}`
      )
      log(
        `   sub-pillars ${plan.subPillars} (${plan.subPillarsLinked} already linked inline — left to update-links.ts)`
      )
      if (plan.toAdd.length === 0) {
        log(`   nothing to add — no block written`)
        log(``)
        continue
      }
      log(
        `   groups: ${plan.groups.map((g) => `${g.name} ${g.spokes.length}`).join(' · ')}` +
          `${plan.replaced ? '   [replacing an existing block]' : ''}`
      )
      log(`   root children ${plan.beforeCount} → ${plan.afterCount}   heading: "${headingTextFor(code)}"`)
      if (options.verbose) {
        for (const g of plan.groups) {
          log(`     ${g.name}`)
          for (const s of g.spokes) log(`       - ${s.title}  ->  ${BLOG_BASE_URL}/${s.slug}`)
        }
      }

      if (options.prove && !proved) {
        proved = true
        proofOk = proveHub(plan, log)
      }

      if (options.apply) {
        try {
          await updatePost(plan.hubId, { content: plan.newContent })
          applied++
          log(`   + PATCHed ${plan.toAdd.length} link(s) into ${plan.hubSlug}`)
        } catch (err) {
          failed++
          log(`   x PATCH failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
        }
      }
      log(``)
    }
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const pad = (s: string | number, n: number) => String(s).padEnd(n)
  const lpad = (s: string | number, n: number) => String(s).padStart(n)

  log(`━━━ Totals (per hub) ━━━`)
  log(
    `${pad('Code', 6)}${pad('Hub slug', 34)}${lpad('Spokes', 8)}${lpad('Linked', 8)}${lpad('ToAdd', 7)}` +
      `${lpad('Rates', 7)}${lpad('Deals', 7)}${lpad('Long', 6)}${lpad('Term', 6)}${lpad('Sold', 6)}${lpad('Other', 7)}${lpad('Other%', 8)}`
  )
  const totals: Record<string, number> = {}
  for (const g of DISPLAY_ORDER) totals[g] = 0
  let tSpokes = 0
  let tLinked = 0
  let tAdd = 0
  let tLooseOnly = 0
  const mostlyOther: string[] = []

  for (const p of plans) {
    const byGroup: Record<string, number> = {}
    for (const g of p.groups) {
      byGroup[g.name] = g.spokes.length
      totals[g.name] += g.spokes.length
    }
    tSpokes += p.spokesTotal
    tLinked += p.alreadyLinked
    tAdd += p.toAdd.length
    tLooseOnly += p.looseOnly
    const otherPct = p.toAdd.length ? Math.round(((byGroup[GROUP_OTHER] || 0) / p.toAdd.length) * 100) : 0
    if (p.toAdd.length > 0 && otherPct > 50) mostlyOther.push(`${p.code} ${otherPct}%`)
    log(
      `${pad(p.code, 6)}${pad(p.hubSlug.slice(0, 33), 34)}${lpad(p.spokesTotal, 8)}${lpad(p.alreadyLinked, 8)}${lpad(p.toAdd.length, 7)}` +
        `${lpad(byGroup[GROUP_RATES] || 0, 7)}${lpad(byGroup[GROUP_COUPONS] || 0, 7)}${lpad(byGroup[GROUP_LONG_TERM] || 0, 6)}` +
        `${lpad(byGroup[GROUP_TERMINAL] || 0, 6)}${lpad(byGroup[GROUP_SOLD_OUT] || 0, 6)}${lpad(byGroup[GROUP_OTHER] || 0, 7)}` +
        `${lpad(p.toAdd.length ? otherPct + '%' : '-', 8)}`
    )
  }
  log(
    `${pad('TOTAL', 6)}${pad(`${plans.length} hub(s)`, 34)}${lpad(tSpokes, 8)}${lpad(tLinked, 8)}${lpad(tAdd, 7)}` +
      `${lpad(totals[GROUP_RATES], 7)}${lpad(totals[GROUP_COUPONS], 7)}${lpad(totals[GROUP_LONG_TERM], 6)}` +
      `${lpad(totals[GROUP_TERMINAL], 6)}${lpad(totals[GROUP_SOLD_OUT], 6)}${lpad(totals[GROUP_OTHER], 7)}` +
      `${lpad(tAdd ? Math.round((totals[GROUP_OTHER] / tAdd) * 100) + '%' : '-', 8)}`
  )
  log(``)
  if (mostlyOther.length) {
    log(`Hubs where >50% of links fell into "${GROUP_OTHER}": ${mostlyOther.join(', ')}`)
  } else {
    log(`No hub has a majority of its links in "${GROUP_OTHER}".`)
  }
  if (tLooseOnly) {
    log(
      `! ${tLooseOnly} spoke(s) were skipped on the substring test only — no <a href> resolves to them ` +
        `exactly. These are real missing links the audit also counted as present; a stricter pass would add them.`
    )
  }
  if (options.prove) log(`Proof: ${proofOk ? 'PASSED' : 'FAILED'}`)
  if (options.apply) {
    log(`Applied: ${applied} hub(s), failed: ${failed}`)
  } else {
    log(`Nothing was written. Re-run with --apply to PATCH content.`)
  }
  log(``)

  if (options.out) {
    const outPath = path.isAbsolute(options.out) ? options.out : path.join(ENGINE_ROOT, options.out)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
    console.log(`Saved report -> ${outPath}`)
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function isMainModule(): boolean {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
  return invoked === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  const program = new Command()
    .name('hub-index')
    .description('Append a deterministic "More <Airport> parking guides" index block to each hub')
    .requiredOption('-a, --airport <code>', 'Airport code (e.g. JFK), or ALL')
    .option('--apply', 'Actually PATCH content (default is dry run)')
    .option('--dry-run', 'Preview only — wins over --apply')
    .option('--prove', 'Round-trip the first hub through lexicalToHtml and assert nothing else changed (never writes)')
    .option('--limit <n>', 'Cap the number of HUBS processed (testing)', (v: string) => parseInt(v, 10))
    .option('--out <path>', 'Also write the log to this file (relative to the engine root)')
    .option('--verbose', 'List every link that would be added')
    .action(async (options) => {
      const prove = Boolean(options.prove)
      await runHubIndex({
        airport: options.airport,
        apply: Boolean(options.apply) && !options.dryRun && !prove,
        prove,
        verbose: Boolean(options.verbose),
        limit: options.limit,
        out: options.out,
      })
    })

  program.parseAsync(process.argv).catch((err) => {
    console.error('Error:', err)
    process.exit(1)
  })
}
