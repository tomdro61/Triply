/**
 * booking-links.ts — Deterministic blog → booking-page CTA linking.
 *
 * The other half of `update-links.ts`. That command links parents to children
 * (Lexical → HTML → Claude → HTML → Lexical). This one does the thing the
 * marketing task actually asks for: point every published article at the
 * booking page for its own airport.
 *
 * Deliberately NOT an LLM job:
 *   - zero cost per article (3,700+ articles),
 *   - cannot hallucinate a price claim or an anchor,
 *   - the article body is untouched: we append ONE paragraph node built
 *     directly as Lexical JSON. No HTML round trip, so no reformatting of the
 *     other nodes.
 *
 * Invoked through `update-links.ts --booking-links` (see that file).
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Command } from 'commander'
import { env, BLOG_BASE_URL } from './config.js'
import { updatePost } from './payload.js'
import { pingIndexNow, postUrlFor } from './indexnow.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(ENGINE_ROOT, '..', '..')

/** The site root is the blog base minus the trailing `/blog` segment. */
export const SITE_BASE_URL = BLOG_BASE_URL.replace(/\/blog\/?$/, '')

// ── Airport code → booking page URL ──────────────────────────────────────────
//
// Route: src/app/(main)/[slug]/airport-parking/page.tsx, whose
// generateStaticParams() maps productionAirports → airport.slug. So [slug] is
// the SITE slug from src/config/airports.ts (e.g. "new-york-jfk"), NOT the IATA
// code and NOT a pure city slug — EWR is "new-york-ewr", IAD is
// "washington-iad". It is "<city-slug>-<lowercase code>" in practice but that
// is a convention, not a rule, so read the real values out of airports.ts
// rather than deriving them.

export interface SiteAirport {
  code: string
  slug: string
  enabled: boolean
  isTest: boolean
}

let siteAirportCache: Record<string, SiteAirport> | null = null

export function loadSiteAirports(): Record<string, SiteAirport> {
  if (siteAirportCache) return siteAirportCache
  const file = path.join(REPO_ROOT, 'src', 'config', 'airports.ts')
  const src = fs.readFileSync(file, 'utf8')
  const out: Record<string, SiteAirport> = {}
  // Each entry is a flat object literal; slug/enabled always follow code.
  const re = /\{\s*code:\s*"([^"]+)",[\s\S]*?slug:\s*"([^"]+)",\s*enabled:\s*(true|false),(\s*isTest:\s*true,)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    out[m[1].toUpperCase()] = {
      code: m[1].toUpperCase(),
      slug: m[2],
      enabled: m[3] === 'true',
      isTest: Boolean(m[4]),
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`Parsed 0 airports out of ${file} — the config shape changed`)
  }
  siteAirportCache = out
  return out
}

/** Path that identifies the booking page, e.g. `/new-york-jfk/airport-parking`. */
export function bookingPathFor(code: string): string | null {
  const a = loadSiteAirports()[code.toUpperCase()]
  if (!a || !a.enabled || a.isTest) return null
  return `/${a.slug}/airport-parking`
}

/** Absolute booking-page URL on the live site, or null if the airport has no page. */
export function bookingUrlFor(code: string): string | null {
  const p = bookingPathFor(code)
  return p ? `${SITE_BASE_URL}${p}` : null
}

// ── Price claim ("vs garage") ────────────────────────────────────────────────
//
// reports/airport-price-claim.json holds the raw inputs (cheapest lot, garage,
// economy) but NOT the percentage — the published "vs garage" figure is
// computed against the TYPICAL (median) lot, and only the .md table carries it.
// So the .md is the source of truth for the number and the .json is read first
// for the garage/verified context. We never recompute a claim from the cheapest
// lot: that would overstate it.

export interface PriceClaim {
  code: string
  vsGaragePct: number | null
  garage: number | null
  verified: string | null
}

let priceClaimCache: Record<string, PriceClaim> | null = null

export function loadPriceClaims(): Record<string, PriceClaim> {
  if (priceClaimCache) return priceClaimCache
  const out: Record<string, PriceClaim> = {}

  const jsonPath = path.join(ENGINE_ROOT, 'reports', 'airport-price-claim.json')
  if (fs.existsSync(jsonPath)) {
    const rows = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Record<string, unknown>[]
    for (const r of rows) {
      const code = String(r.code || '').toUpperCase()
      if (!code) continue
      out[code] = {
        code,
        vsGaragePct: null, // absent from the json — filled from the md below
        garage: typeof r.garage === 'number' ? r.garage : null,
        verified: typeof r.verified === 'string' ? r.verified : null,
      }
    }
  }

  const mdPath = path.join(ENGINE_ROOT, 'reports', 'price-claim-by-airport.md')
  if (fs.existsSync(mdPath)) {
    for (const line of fs.readFileSync(mdPath, 'utf8').split(/\r?\n/)) {
      if (!line.startsWith('|')) continue
      const cells = line.split('|').map((c) => c.trim())
      // | code | lots | cheapest | typical | garage | vs garage | economy | vs economy | verified |
      if (cells.length < 10) continue
      const code = cells[1].toUpperCase()
      if (!/^[A-Z]{3}$/.test(code)) continue
      const pctRaw = cells[6].replace('%', '')
      const pct = Number(pctRaw)
      const row = out[code] || { code, vsGaragePct: null, garage: null, verified: null }
      row.vsGaragePct = pctRaw !== '' && pctRaw !== '—' && Number.isFinite(pct) ? pct : null
      if (row.garage === null) {
        const g = Number(cells[5])
        row.garage = Number.isFinite(g) ? g : null
      }
      if (!row.verified && cells[9]) row.verified = cells[9]
      out[code] = row
    }
  }

  priceClaimCache = out
  return out
}

// ── Airport display name ─────────────────────────────────────────────────────

let nameCache: Record<string, string> | null = null

export function airportFullName(code: string): string {
  if (!nameCache) {
    const cache: Record<string, string> = {}
    const dir = path.join(ENGINE_ROOT, 'data', 'airports')
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        if (d.code && d.fullName) cache[String(d.code).toUpperCase()] = String(d.fullName)
      } catch {
        /* one malformed airport file must not take the whole pass down */
      }
    }
    nameCache = cache
  }
  return nameCache[code.toUpperCase()] || `${code.toUpperCase()} Airport`
}

export function airportCodesOnDisk(): string[] {
  const dir = path.join(ENGINE_ROOT, 'data', 'airports')
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, '').toUpperCase())
    .sort()
}

// ── CTA copy ─────────────────────────────────────────────────────────────────

export interface Cta {
  anchorText: string
  tailText: string
  url: string
  /** Plain-text rendering, for the dry-run log. */
  fullText: string
  claimPct: number | null
}

/**
 * One factual sentence. The percentage comes verbatim (rounded to a whole
 * number) from reports/price-claim-by-airport.md — never computed here, never
 * invented. Airports with no garage figure on record get the figure-free
 * variant.
 */
export function buildCta(code: string): Cta | null {
  const url = bookingUrlFor(code)
  if (!url) return null
  const CODE = code.toUpperCase()
  const name = airportFullName(CODE)
  const claim = loadPriceClaims()[CODE]
  const pct = claim && claim.vsGaragePct !== null ? Math.round(claim.vsGaragePct) : null

  const anchorText = `Compare ${CODE} parking rates`
  const tailText =
    pct !== null
      ? ` — a typical off-airport lot near ${name} costs about ${pct}% less per day than the airport's own terminal garage.`
      : ` — see every off-airport lot near ${name}, with free cancellation and a space confirmed before you drive.`

  return { anchorText, tailText, url, fullText: anchorText + tailText, claimPct: pct }
}

// ── Lexical node construction ────────────────────────────────────────────────
//
// Shape confirmed against live CMS content (GET /api/posts, JFK spoke
// "jfk-airport-parking-sold-out"): a paragraph carries
// format/indent/version/direction/textStyle/textFormat, and a link is an
// ELEMENT node of type "link" with fields {linkType:"custom", url, newTab} —
// no id, no rel unless set. Identical to makeLinkNode()/makeParagraphNode() in
// html-to-lexical.ts, which is what every existing article was built with.

export interface LexicalTextNodeShape {
  type: 'text'
  text: string
  format: number
  detail: number
  mode: 'normal'
  style: string
  version: 1
}

export function makeTextNode(text: string): LexicalTextNodeShape {
  return { type: 'text', text, format: 0, detail: 0, mode: 'normal', style: '', version: 1 }
}

export function makeCtaParagraph(cta: Cta): Record<string, unknown> {
  return {
    type: 'paragraph',
    children: [
      {
        type: 'link',
        fields: { linkType: 'custom', url: cta.url, newTab: false },
        children: [makeTextNode(cta.anchorText)],
        direction: 'ltr',
        format: '',
        indent: 0,
        version: 1,
      },
      makeTextNode(cta.tailText),
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
    textFormat: 0,
    textStyle: '',
  }
}

// ── Detection ────────────────────────────────────────────────────────────────

interface AnyNode {
  type?: string
  fields?: { url?: string }
  children?: AnyNode[]
}

/** True if any link node in the document points at this airport's booking path. */
export function hasBookingLink(content: unknown, bookingPath: string): boolean {
  const doc = content as { root?: AnyNode } | null
  if (!doc || !doc.root) return false
  let found = false
  const walk = (n: AnyNode) => {
    if (found || !n) return
    if (n.type === 'link' && typeof n.fields?.url === 'string' && n.fields.url.includes(bookingPath)) {
      found = true
      return
    }
    for (const c of n.children || []) walk(c)
  }
  walk(doc.root)
  if (found) return true
  // Conservative fallback: the path appearing anywhere in the document (a raw
  // href inside text, a caption, a block field) counts as already linked.
  // Over-skipping is safe; a duplicate CTA is not.
  return JSON.stringify(content).includes(bookingPath)
}

/** Append the CTA to the END of root.children. Every other node is left as-is. */
export function appendCta(content: unknown, cta: Cta): unknown {
  const doc = content as { root: Record<string, unknown> & { children: unknown[] } }
  return {
    ...(content as Record<string, unknown>),
    root: { ...doc.root, children: [...doc.root.children, makeCtaParagraph(cta)] },
  }
}

// ── CMS read ─────────────────────────────────────────────────────────────────

export interface BookingPost {
  id: string
  slug: string
  title: string
  articleType: string
  content: unknown
}

async function fetchPublishedPosts(airportCode: string): Promise<BookingPost[]> {
  const all: BookingPost[] = []
  let page = 1
  // Same pagination guard as update-links.ts: a single capped pull silently
  // drops the OLDEST rows (Payload returns newest-first) — i.e. the hubs.
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
        content: doc.content,
      })
    }
    if (!data.hasNextPage) break
    page++
  }
  return all
}

// ── Runner ───────────────────────────────────────────────────────────────────

export interface BookingLinksOptions {
  airport: string
  apply: boolean
  verbose: boolean
  limit?: number
}

interface AirportResult {
  code: string
  url: string | null
  scanned: number
  alreadyLinked: number
  wouldAppend: number
  applied: number
  failed: number
  noContent: number
  claimPct: number | null
}

export async function runBookingLinks(options: BookingLinksOptions): Promise<void> {
  const codes =
    options.airport.toUpperCase() === 'ALL' ? airportCodesOnDisk() : [options.airport.toUpperCase()]

  const mode = options.apply ? 'APPLY — will PATCH content' : 'DRY RUN — no writes'
  console.log(`\n🅿️  Triply Blog Engine — Booking-page CTA links (deterministic, no LLM)\n`)
  console.log(`Airports: ${codes.length === 1 ? codes[0] : `ALL (${codes.length})`}   Mode: ${mode}\n`)

  const results: AirportResult[] = []
  const missingPage: string[] = []

  for (const code of codes) {
    const bookingPath = bookingPathFor(code)
    const cta = buildCta(code)
    if (!bookingPath || !cta) {
      missingPage.push(code)
      console.log(`\n── ${code} ──  ✗ no booking page on the site (absent from src/config/airports.ts, or disabled) — skipped`)
      results.push({
        code, url: null, scanned: 0, alreadyLinked: 0, wouldAppend: 0,
        applied: 0, failed: 0, noContent: 0, claimPct: null,
      })
      continue
    }

    const posts = await fetchPublishedPosts(code)
    const r: AirportResult = {
      code,
      url: cta.url,
      scanned: posts.length,
      alreadyLinked: 0,
      wouldAppend: 0,
      applied: 0,
      failed: 0,
      noContent: 0,
      claimPct: cta.claimPct,
    }

    console.log(`\n── ${code} ──  ${posts.length} published post(s)`)
    console.log(`   Booking URL : ${cta.url}`)
    console.log(`   CTA         : ${cta.fullText}`)
    console.log(
      `   Price claim : ${
        cta.claimPct !== null
          ? `${cta.claimPct}% vs terminal garage (reports/price-claim-by-airport.md)`
          : 'none on record — figure-free sentence'
      }`
    )

    let processed = 0
    for (const post of posts) {
      if (options.limit && processed >= options.limit) break
      const doc = post.content as { root?: { children?: unknown[] } } | null
      if (!doc || !doc.root || !Array.isArray(doc.root.children)) {
        r.noContent++
        if (options.verbose) console.log(`   ⏭  ${post.slug} — no Lexical content, skipped`)
        continue
      }

      if (hasBookingLink(post.content, bookingPath)) {
        r.alreadyLinked++
        if (options.verbose) console.log(`   ✓  ${post.slug} — already links to the booking page`)
        continue
      }

      r.wouldAppend++
      processed++

      if (options.apply) {
        try {
          await updatePost(post.id, { content: appendCta(post.content, cta) })
          await pingIndexNow([postUrlFor(post.slug)])
          r.applied++
          console.log(`   ✚  ${post.slug} — CTA appended`)
        } catch (err) {
          r.failed++
          const msg = err instanceof Error ? err.message : String(err)
          console.log(`   ✗  ${post.slug} — PATCH failed: ${msg.slice(0, 160)}`)
        }
      } else {
        console.log(`   +  ${post.slug} [${post.articleType}] — no booking link; would append:`)
        console.log(`        text: ${cta.fullText}`)
        console.log(`        href: ${cta.url}`)
      }
    }

    console.log(
      `   ${code} summary: scanned ${r.scanned}, already linked ${r.alreadyLinked}, ` +
        `${options.apply ? `appended ${r.applied}, failed ${r.failed}` : `would append ${r.wouldAppend}`}` +
        `${r.noContent ? `, no content ${r.noContent}` : ''}`
    )
    results.push(r)
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const pad = (s: string | number, n: number) => String(s).padEnd(n)
  const lpad = (s: string | number, n: number) => String(s).padStart(n)

  console.log(`\n━━━ Totals ━━━`)
  console.log(
    `${pad('Airport', 8)}${lpad('Scanned', 8)}${lpad('Linked', 8)}${lpad(
      options.apply ? 'Applied' : 'ToAdd',
      8
    )}${lpad('Claim', 7)}  Booking URL`
  )
  let tScanned = 0
  let tLinked = 0
  let tAdd = 0
  let tApplied = 0
  let tFailed = 0
  for (const r of results) {
    tScanned += r.scanned
    tLinked += r.alreadyLinked
    tAdd += r.wouldAppend
    tApplied += r.applied
    tFailed += r.failed
    console.log(
      `${pad(r.code, 8)}${lpad(r.scanned, 8)}${lpad(r.alreadyLinked, 8)}${lpad(
        options.apply ? r.applied : r.wouldAppend,
        8
      )}${lpad(r.claimPct !== null ? r.claimPct + '%' : '—', 7)}  ${r.url || '(no booking page)'}`
    )
  }
  console.log(
    `${pad('TOTAL', 8)}${lpad(tScanned, 8)}${lpad(tLinked, 8)}${lpad(options.apply ? tApplied : tAdd, 8)}`
  )
  if (options.apply && tFailed) console.log(`  PATCH failures: ${tFailed}`)
  if (missingPage.length) console.log(`  No booking page: ${missingPage.join(', ')}`)
  if (!options.apply) {
    console.log(`\n  Nothing was written. Re-run with --booking-links --apply to PATCH content.`)
  }
  console.log('')
}

// ── Refresh mode ─────────────────────────────────────────────────────────────
//
// The append pass above writes the CTA once. This pass finds that same
// paragraph on an already-CTA'd post, recomputes the sentence from the
// CURRENT claim table (whatever reports/price-claim-by-airport.md and
// reports/airport-price-claim.json currently say — loadPriceClaims() reads
// them fresh, no caching across a garage-rate JSON edit + builder re-run),
// and — only if the text actually changed — replaces ONLY that paragraph's
// `children` in place. Every other node, and every other property of the
// CTA paragraph itself (direction/format/indent/version/textFormat/
// textStyle), is left byte-identical.

export interface ExistingCta {
  /** Index of the CTA paragraph within root.children. */
  index: number
  oldTailText: string
  oldPct: number | null
}

/**
 * Locate the CTA paragraph the append mode above would have written: the
 * LAST root child that is a paragraph whose first child is a link node
 * pointing at this airport's booking page, with anchor text matching
 * `Compare <CODE> parking rates` (the exact, fixed anchorText buildCta()
 * always produces). If the last href-matching link's anchor text does NOT
 * match that pattern, we stop and return null rather than keep searching
 * further back in the document — the append pass only ever added one such
 * paragraph, at the very end, so a mismatch means something unexpected is
 * there and it should be left alone, not guessed at.
 */
export function findExistingCta(content: unknown, bookingPath: string, code: string): ExistingCta | null {
  const doc = content as { root?: { children?: unknown[] } } | null
  if (!doc?.root || !Array.isArray(doc.root.children)) return null
  const children = doc.root.children as Record<string, unknown>[]
  const anchorRe = new RegExp(`^Compare\\s+${code.toUpperCase()}\\s+parking rates$`, 'i')

  for (let i = children.length - 1; i >= 0; i--) {
    const node = children[i]
    if (!node || node.type !== 'paragraph' || !Array.isArray(node.children)) continue
    const kids = node.children as Record<string, unknown>[]
    const link = kids[0] as
      | { type?: string; fields?: { url?: string }; children?: { text?: string }[] }
      | undefined
    if (!link || link.type !== 'link') continue
    const url = link.fields?.url
    if (typeof url !== 'string' || !url.includes(bookingPath)) continue

    // Last href-matching link in the document — must be our CTA shape.
    const linkText = link.children?.[0]?.text ?? ''
    if (!anchorRe.test(linkText.trim())) return null

    const tailNode = kids[1] as { text?: string } | undefined
    const oldTailText = typeof tailNode?.text === 'string' ? tailNode.text : ''
    const pctMatch = oldTailText.match(/costs about (\d+)% less/i)
    return { index: i, oldTailText, oldPct: pctMatch ? Number(pctMatch[1]) : null }
  }
  return null
}

/**
 * Replace only the CTA paragraph's `children` at `index`, leaving every
 * other root child — and every other property of the paragraph node itself
 * — untouched.
 */
export function replaceCtaChildren(content: unknown, index: number, cta: Cta): unknown {
  const doc = content as { root: Record<string, unknown> & { children: Record<string, unknown>[] } }
  const children = doc.root.children.slice()
  const oldNode = children[index]
  children[index] = { ...oldNode, children: makeCtaParagraph(cta).children }
  return { ...(content as Record<string, unknown>), root: { ...doc.root, children } }
}

interface RefreshResult {
  code: string
  scanned: number
  noCta: number
  unchanged: number
  wouldChange: number
  changed: number
  failed: number
}

export async function runBookingLinksRefresh(options: BookingLinksOptions): Promise<void> {
  const codes =
    options.airport.toUpperCase() === 'ALL' ? airportCodesOnDisk() : [options.airport.toUpperCase()]

  const mode = options.apply ? 'APPLY — will PATCH content' : 'DRY RUN — no writes'
  console.log(`\n🅿️  Triply Blog Engine — Booking-page CTA REFRESH (deterministic, no LLM)\n`)
  console.log(`Airports: ${codes.length === 1 ? codes[0] : `ALL (${codes.length})`}   Mode: ${mode}\n`)

  const results: RefreshResult[] = []

  for (const code of codes) {
    const bookingPath = bookingPathFor(code)
    const cta = buildCta(code)
    if (!bookingPath || !cta) {
      console.log(`\n── ${code} ──  ✗ no booking page on the site — skipped`)
      results.push({ code, scanned: 0, noCta: 0, unchanged: 0, wouldChange: 0, changed: 0, failed: 0 })
      continue
    }

    const posts = await fetchPublishedPosts(code)
    const r: RefreshResult = {
      code,
      scanned: posts.length,
      noCta: 0,
      unchanged: 0,
      wouldChange: 0,
      changed: 0,
      failed: 0,
    }

    console.log(`\n── ${code} ──  ${posts.length} published post(s)`)
    console.log(
      `   Current claim: ${
        cta.claimPct !== null ? `${cta.claimPct}% vs terminal garage (current claim table)` : 'none on record'
      }`
    )

    let processed = 0
    for (const post of posts) {
      if (options.limit && processed >= options.limit) break

      const existing = findExistingCta(post.content, bookingPath, code)
      if (!existing) {
        r.noCta++
        if (options.verbose) console.log(`   ⏭  ${post.slug} — no existing CTA paragraph found, skipped`)
        continue
      }

      const oldPctStr = existing.oldPct !== null ? `${existing.oldPct}%` : '—'
      const newPctStr = cta.claimPct !== null ? `${cta.claimPct}%` : '—'
      const changed = existing.oldTailText !== cta.tailText

      if (!changed) {
        r.unchanged++
        if (options.verbose) console.log(`   =  ${post.slug} — ${oldPctStr} -> ${newPctStr} (unchanged)`)
        continue
      }

      processed++
      r.wouldChange++
      console.log(`   ${options.apply ? '~' : '+'}  ${post.slug} — ${oldPctStr} -> ${newPctStr} (changed)`)

      if (options.apply) {
        try {
          const newContent = replaceCtaChildren(post.content, existing.index, cta)
          await updatePost(post.id, { content: newContent })
          await pingIndexNow([postUrlFor(post.slug)])
          r.changed++
        } catch (err) {
          r.failed++
          const msg = err instanceof Error ? err.message : String(err)
          console.log(`      ✗ PATCH failed: ${msg.slice(0, 160)}`)
        }
      }
    }

    console.log(
      `   ${code} summary: scanned ${r.scanned}, no CTA ${r.noCta}, unchanged ${r.unchanged}, ` +
        `${options.apply ? `changed ${r.changed}, failed ${r.failed}` : `would change ${r.wouldChange}`}`
    )
    results.push(r)
  }

  console.log(`\n━━━ Totals ━━━`)
  let tScanned = 0
  let tNoCta = 0
  let tUnchanged = 0
  let tWould = 0
  let tChanged = 0
  let tFailed = 0
  for (const r of results) {
    tScanned += r.scanned
    tNoCta += r.noCta
    tUnchanged += r.unchanged
    tWould += r.wouldChange
    tChanged += r.changed
    tFailed += r.failed
  }
  console.log(
    `  Scanned: ${tScanned}  No CTA: ${tNoCta}  Unchanged: ${tUnchanged}  ` +
      `${options.apply ? `Changed: ${tChanged}  Failed: ${tFailed}` : `Would change: ${tWould}`}`
  )
  if (!options.apply) {
    console.log(`\n  Nothing was written. Re-run with --refresh --apply to PATCH content.`)
  }
  console.log('')
}

// ── Standalone CLI ───────────────────────────────────────────────────────────
//
// update-links.ts is mid-edit by another pass right now, so --refresh is not
// wired through it (yet). It runs directly instead:
//
//   npx tsx src/booking-links.ts --refresh -a BNA --dry-run
//   npx tsx src/booking-links.ts --refresh -a ALL --dry-run
//   npx tsx src/booking-links.ts --refresh -a ALL --apply
//
// Guarded so importing this module (as update-links.ts does, for the
// original append mode) never triggers a second `program.parse()`.

function isMainModule(): boolean {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : ''
  const thisFile = fileURLToPath(import.meta.url)
  return invoked === thisFile
}

if (isMainModule()) {
  const program = new Command()
    .name('booking-links')
    .description('Booking-page CTA refresh — recompute the vs-garage % on already-CTA\'d posts and update in place')
    .requiredOption('-a, --airport <code>', 'Airport code (e.g., JFK), or ALL')
    .option('--refresh', 'Refresh mode (currently the only standalone mode here)')
    .option('--apply', 'Actually PATCH content (default is dry run)')
    .option('--dry-run', 'Preview only — wins over --apply')
    .option('--limit <n>', 'Cap posts changed per airport', (v: string) => parseInt(v, 10))
    .option('--verbose', 'Also log unchanged / skipped posts')
    .action(async (options) => {
      if (!options.refresh) {
        console.error(
          'Only --refresh is implemented as a standalone CLI mode here. ' +
            'For the original append mode use: npm run update-links -- --booking-links'
        )
        process.exit(1)
      }
      await runBookingLinksRefresh({
        airport: options.airport,
        apply: Boolean(options.apply) && !options.dryRun,
        verbose: Boolean(options.verbose),
        limit: options.limit,
      })
    })

  program.parseAsync(process.argv).catch((err) => {
    console.error('Error:', err)
    process.exit(1)
  })
}
