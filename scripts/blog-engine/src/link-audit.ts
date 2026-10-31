/**
 * link-audit.ts — READ-ONLY audit of internal parent→child linking coverage.
 *
 * update-links.ts's findMissingChildLinks() only knows two parent/child shapes:
 *   hub → sub-pillar (hubSlug === hub.slug)
 *   sub-pillar → spoke (parentSlug === subpillar.slug)
 *
 * It misses spokes parented DIRECTLY to a hub (articleType: 'spoke',
 * parentSlug === <hub slug>). This script measures that gap — and a couple of
 * adjacent data-quality issues — across every airport, without writing
 * anything back to the CMS (GET only) and without importing or modifying
 * update-links.ts (a linking pass is running from that file live).
 *
 * fetchPublishedPosts() below is a deliberate copy of the identically-named
 * function in update-links.ts — see the comment there for why pagination has
 * to walk every page (a capped single pull silently drops the OLDEST rows,
 * i.e. hubs, since Payload returns newest-first).
 *
 * Usage:
 *   tsx src/link-audit.ts                    # all airports on disk, print + save report
 *   tsx src/link-audit.ts -a JFK              # single airport
 *   tsx src/link-audit.ts --out reports/foo.txt
 */

import { env, BLOG_BASE_URL } from './config.js'
import { lexicalToHtml } from './lexical-to-html.js'
import { airportCodesOnDisk, bookingPathFor, hasBookingLink } from './booking-links.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_ROOT = path.resolve(__dirname, '..')

// ── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const ONLY_AIRPORT = args.find((a) => a === '-a' || a === '--airport')
  ? args[args.findIndex((a) => a === '-a' || a === '--airport') + 1]?.toUpperCase()
  : undefined
const OUT_PATH = args.find((a) => a === '--out')
  ? args[args.findIndex((a) => a === '--out') + 1]
  : path.join(ENGINE_ROOT, 'reports', 'link-audit-2026-09-15.txt')

// ── Types ─────────────────────────────────────────────────────────────────

interface PublishedPostFull {
  id: string
  slug: string
  title: string
  articleType: string
  airportCode: string
  parentSlug?: string
  hubSlug?: string
  content: unknown
}

// ── Copy of update-links.ts's fetchPublishedPosts (do NOT import from that
// file — a linking pass is running from it right now). ────────────────────

async function fetchPublishedPosts(airportCode: string): Promise<PublishedPostFull[]> {
  const all: PublishedPostFull[] = []
  let page = 1
  while (true) {
    const params = new URLSearchParams({
      'where[status][equals]': 'published',
      'where[airportCode][equals]': airportCode.toUpperCase(),
      limit: '200',
      page: String(page),
    })

    const url = `${env.PAYLOAD_CMS_URL}/api/posts?${params.toString()}`
    const res = await fetch(url, {
      headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` },
    })

    if (!res.ok) {
      throw new Error(`Failed to fetch posts: ${res.status} ${await res.text()}`)
    }

    const data = await res.json()
    for (const doc of (data.docs || []) as Record<string, unknown>[]) {
      all.push({
        id: doc.id as string,
        slug: doc.slug as string,
        title: doc.title as string,
        articleType: (doc.articleType as string) || 'spoke',
        airportCode: (doc.airportCode as string) || '',
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

// ── Audit logic ──────────────────────────────────────────────────────────

interface MissingHubSpokeLink {
  hubSlug: string
  hubTitle: string
  spokeSlug: string
  spokeTitle: string
}

interface Orphan {
  slug: string
  title: string
  articleType: string
  field: 'parentSlug' | 'hubSlug'
  pointsAt: string
  reason: 'not-published' | 'does-not-exist'
}

interface EmptyParent {
  slug: string
  title: string
  articleType: string
  missing: ('parentSlug' | 'hubSlug')[]
}

interface AirportAudit {
  code: string
  totalPosts: number
  hubs: number
  subPillars: number
  spokes: number
  // (a) hub -> direct-child-spoke gap (the shape update-links.ts misses entirely)
  missingHubSpokeLinks: MissingHubSpokeLink[]
  // (a-continued) existing shapes, for context — hub->sub-pillar and sub-pillar->spoke gaps
  // that findMissingChildLinks() ALREADY covers, included here so the report shows the full
  // linking picture, not just the new gap.
  missingHubSubPillarLinks: MissingHubSpokeLink[]
  missingSubPillarSpokeLinks: MissingHubSpokeLink[]
  // (b)
  orphans: Orphan[]
  // (c)
  emptyParent: EmptyParent[]
}

function auditAirport(code: string, posts: PublishedPostFull[]): AirportAudit {
  const bySlug = new Map(posts.map((p) => [p.slug, p]))
  const hubs = posts.filter((p) => p.articleType === 'hub')
  const subPillars = posts.filter((p) => p.articleType === 'sub-pillar')
  const spokes = posts.filter((p) => p.articleType === 'spoke')

  const missingHubSpokeLinks: MissingHubSpokeLink[] = []
  const missingHubSubPillarLinks: MissingHubSpokeLink[] = []
  const missingSubPillarSpokeLinks: MissingHubSpokeLink[] = []

  for (const hub of hubs) {
    const html = hub.content ? lexicalToHtml(hub.content as Parameters<typeof lexicalToHtml>[0]) : ''
    if (!html) continue

    // (a) THE GAP: spokes parented directly to this hub.
    const directChildSpokes = spokes.filter((s) => s.parentSlug === hub.slug)
    for (const spoke of directChildSpokes) {
      const linkPattern = `${BLOG_BASE_URL}/${spoke.slug}`
      if (!html.includes(linkPattern)) {
        missingHubSpokeLinks.push({
          hubSlug: hub.slug,
          hubTitle: hub.title,
          spokeSlug: spoke.slug,
          spokeTitle: spoke.title,
        })
      }
    }

    // Existing shape (already handled by update-links.ts) — included for a complete picture.
    const childSubPillars = subPillars.filter((sp) => sp.hubSlug === hub.slug)
    for (const sp of childSubPillars) {
      const linkPattern = `${BLOG_BASE_URL}/${sp.slug}`
      if (!html.includes(linkPattern)) {
        missingHubSubPillarLinks.push({
          hubSlug: hub.slug,
          hubTitle: hub.title,
          spokeSlug: sp.slug,
          spokeTitle: sp.title,
        })
      }
    }
  }

  for (const sp of subPillars) {
    const html = sp.content ? lexicalToHtml(sp.content as Parameters<typeof lexicalToHtml>[0]) : ''
    if (!html) continue
    const childSpokes = spokes.filter((s) => s.parentSlug === sp.slug)
    for (const spoke of childSpokes) {
      const linkPattern = `${BLOG_BASE_URL}/${spoke.slug}`
      if (!html.includes(linkPattern)) {
        missingSubPillarSpokeLinks.push({
          hubSlug: sp.slug,
          hubTitle: sp.title,
          spokeSlug: spoke.slug,
          spokeTitle: spoke.title,
        })
      }
    }
  }

  // (b) orphans: parentSlug points at a slug that is not published / does not exist.
  // hubSlug is checked the same way for sub-pillars/spokes that carry one.
  const orphans: Orphan[] = []
  for (const post of posts) {
    if (post.articleType === 'hub') continue // hubs have no parent
    if (post.parentSlug) {
      const target = bySlug.get(post.parentSlug)
      if (!target) {
        orphans.push({
          slug: post.slug,
          title: post.title,
          articleType: post.articleType,
          field: 'parentSlug',
          pointsAt: post.parentSlug,
          reason: 'does-not-exist',
        })
      }
      // target exists in bySlug means it IS published (bySlug only contains
      // published posts, since fetchPublishedPosts only fetched published).
    }
    if (post.hubSlug) {
      const target = bySlug.get(post.hubSlug)
      if (!target) {
        orphans.push({
          slug: post.slug,
          title: post.title,
          articleType: post.articleType,
          field: 'hubSlug',
          pointsAt: post.hubSlug,
          reason: 'does-not-exist',
        })
      }
    }
  }

  // (c) posts whose parentSlug/hubSlug is empty (excluding hubs, which legitimately have neither).
  const emptyParent: EmptyParent[] = []
  for (const post of posts) {
    if (post.articleType === 'hub') continue
    const missing: ('parentSlug' | 'hubSlug')[] = []
    if (!post.parentSlug) missing.push('parentSlug')
    if (post.articleType === 'spoke' && !post.hubSlug) missing.push('hubSlug')
    // sub-pillars are keyed off hubSlug as their real parent pointer; parentSlug
    // being empty on a sub-pillar is expected (they don't use it), so only flag
    // a sub-pillar missing hubSlug.
    if (post.articleType === 'sub-pillar') {
      const idx = missing.indexOf('parentSlug')
      if (idx !== -1) missing.splice(idx, 1)
      if (!post.hubSlug && !missing.includes('hubSlug')) missing.push('hubSlug')
    }
    if (missing.length > 0) {
      emptyParent.push({ slug: post.slug, title: post.title, articleType: post.articleType, missing })
    }
  }

  return {
    code,
    totalPosts: posts.length,
    hubs: hubs.length,
    subPillars: subPillars.length,
    spokes: spokes.length,
    missingHubSpokeLinks,
    missingHubSubPillarLinks,
    missingSubPillarSpokeLinks,
    orphans,
    emptyParent,
  }
}

// ── The 31 special articles (26 rescue + 5 construction) ───────────────────

const RESCUE_SLUGS: { code: string; slug: string; hubSlug: string }[] = [
  { code: 'ATL', slug: 'atlanta-airport-parking-sold-out', hubSlug: 'atlanta-airport-parking' },
  { code: 'AUS', slug: 'austin-airport-parking-sold-out', hubSlug: 'aus-airport-parking' },
  { code: 'BNA', slug: 'bna-airport-parking-sold-out', hubSlug: 'bna-airport-parking' },
  { code: 'BOS', slug: 'logan-airport-parking-sold-out', hubSlug: 'boston-logan-airport-parking' },
  { code: 'BWI', slug: 'bwi-airport-parking-sold-out', hubSlug: 'bwi-airport-parking' },
  { code: 'CLT', slug: 'clt-airport-parking-sold-out', hubSlug: 'clt-airport-parking' },
  { code: 'DCA', slug: 'dca-airport-parking-sold-out', hubSlug: 'dca-airport-parking' },
  { code: 'DEN', slug: 'denver-airport-parking-sold-out', hubSlug: 'den-airport-parking' },
  { code: 'DFW', slug: 'dfw-airport-parking-sold-out', hubSlug: 'dfw-airport-parking' },
  { code: 'EWR', slug: 'newark-airport-parking-sold-out', hubSlug: 'newark-airport-parking' },
  { code: 'FLL', slug: 'fort-lauderdale-airport-parking-sold-out', hubSlug: 'fort-lauderdale-airport-parking' },
  { code: 'IAD', slug: 'dulles-airport-parking-sold-out', hubSlug: 'iad-airport-parking' },
  { code: 'IAH', slug: 'iah-airport-parking-sold-out', hubSlug: 'iah-airport-parking' },
  { code: 'JFK', slug: 'jfk-airport-parking-sold-out', hubSlug: 'jfk-airport-parking' },
  { code: 'LAS', slug: 'las-vegas-airport-parking-sold-out', hubSlug: 'las-airport-parking' },
  { code: 'LAX', slug: 'lax-airport-parking-sold-out', hubSlug: 'lax-airport-parking' },
  { code: 'LGA', slug: 'laguardia-airport-parking-sold-out', hubSlug: 'laguardia-airport-parking' },
  { code: 'MCO', slug: 'orlando-airport-parking-sold-out', hubSlug: 'orlando-airport-parking' },
  { code: 'MIA', slug: 'miami-airport-parking-sold-out', hubSlug: 'miami-airport-parking' },
  { code: 'MSP', slug: 'msp-airport-parking-sold-out', hubSlug: 'msp-airport-parking' },
  { code: 'ORD', slug: 'ohare-airport-parking-sold-out', hubSlug: 'ord-airport-parking' },
  { code: 'PHL', slug: 'philadelphia-airport-parking-sold-out', hubSlug: 'philadelphia-airport-parking' },
  { code: 'SAN', slug: 'san-diego-airport-parking-sold-out', hubSlug: 'san-diego-airport-parking' },
  { code: 'SEA', slug: 'seattle-airport-parking-sold-out', hubSlug: 'seattle-airport-parking' },
  { code: 'SFO', slug: 'sfo-airport-parking-sold-out', hubSlug: 'sfo-airport-parking' },
  { code: 'TPA', slug: 'tampa-airport-parking-sold-out', hubSlug: 'tpa-airport-parking' },
]

const CONSTRUCTION_SLUGS: { code: string; slug: string; hubSlug: string }[] = [
  { code: 'DCA', slug: 'dca-airport-parking-construction-2026', hubSlug: 'dca-airport-parking' },
  { code: 'AUS', slug: 'austin-airport-parking-construction-2026', hubSlug: 'aus-airport-parking' },
  { code: 'LGA', slug: 'laguardia-airport-parking-construction-2026', hubSlug: 'laguardia-airport-parking' },
  { code: 'LAS', slug: 'las-vegas-airport-parking-construction-2026', hubSlug: 'las-airport-parking' },
  { code: 'EWR', slug: 'newark-airport-parking-construction-2026', hubSlug: 'newark-airport-parking' },
]

const SPECIAL_SLUGS = [
  ...RESCUE_SLUGS.map((r) => ({ ...r, kind: 'rescue' as const })),
  ...CONSTRUCTION_SLUGS.map((c) => ({ ...c, kind: 'construction' as const })),
]

interface SpecialRow {
  kind: 'rescue' | 'construction'
  code: string
  slug: string
  hubSlug: string
  found: boolean
  hubFound: boolean
  hubLinksToIt: boolean
  hasCtaParagraph: boolean
}

/** (3) CTA check: a LAST root child containing an /airport-parking link, per the job spec. */
function hasTrailingBookingCta(content: unknown, bookingPath: string | null): boolean {
  if (!bookingPath) return false
  const doc = content as { root?: { children?: unknown[] } } | null
  const children = doc?.root?.children
  if (!Array.isArray(children) || children.length === 0) return false
  const last = children[children.length - 1]
  // Must specifically be the LAST root child (job spec), not merely present anywhere —
  // so check that node in isolation, not via booking-links.ts's whole-document hasBookingLink.
  return hasBookingLink({ root: { children: [last] } }, bookingPath)
}

// ── Report rendering ─────────────────────────────────────────────────────

function fmtList(items: string[], indent = '       '): string {
  if (items.length === 0) return `${indent}(none)\n`
  return items.map((s) => `${indent}${s}\n`).join('')
}

async function main() {
  const codes = ONLY_AIRPORT ? [ONLY_AIRPORT] : airportCodesOnDisk()
  const lines: string[] = []
  const log = (s = '') => {
    lines.push(s)
    console.log(s)
  }

  log(`Triply Blog Engine — Internal Link Audit (READ-ONLY)`)
  log(`Generated: ${new Date().toISOString()}`)
  log(`CMS: ${env.PAYLOAD_CMS_URL}`)
  log(`Airports: ${codes.length === 1 ? codes[0] : `ALL (${codes.length})`}`)
  log('')

  const audits: AirportAudit[] = []
  const postsByAirport = new Map<string, PublishedPostFull[]>()

  for (const code of codes) {
    let posts: PublishedPostFull[]
    try {
      posts = await fetchPublishedPosts(code)
    } catch (err) {
      log(`── ${code} ── FAILED to fetch: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    postsByAirport.set(code, posts)
    if (posts.length === 0) {
      log(`── ${code} ── 0 published posts — skipped`)
      continue
    }
    const audit = auditAirport(code, posts)
    audits.push(audit)

    log(`── ${code} ── ${audit.totalPosts} published (${audit.hubs} hub, ${audit.subPillars} sub-pillar, ${audit.spokes} spoke)`)
    log(`   (a) hub → direct-child-spoke links MISSING (the gap update-links.ts misses): ${audit.missingHubSpokeLinks.length}`)
    for (const m of audit.missingHubSpokeLinks) {
      log(`       ${m.hubSlug}  ✗→  ${m.spokeSlug}  ("${m.spokeTitle}")`)
    }
    log(`   (a-cont) hub → sub-pillar links missing (existing shape, already covered by update-links.ts): ${audit.missingHubSubPillarLinks.length}`)
    for (const m of audit.missingHubSubPillarLinks) {
      log(`       ${m.hubSlug}  ✗→  ${m.spokeSlug}  ("${m.spokeTitle}")`)
    }
    log(`   (a-cont) sub-pillar → spoke links missing (existing shape, already covered by update-links.ts): ${audit.missingSubPillarSpokeLinks.length}`)
    for (const m of audit.missingSubPillarSpokeLinks) {
      log(`       ${m.hubSlug}  ✗→  ${m.spokeSlug}  ("${m.spokeTitle}")`)
    }
    log(`   (b) orphans (parentSlug/hubSlug points at unpublished/nonexistent slug): ${audit.orphans.length}`)
    for (const o of audit.orphans) {
      log(`       ${o.slug} [${o.articleType}] ${o.field}="${o.pointsAt}" → ${o.reason}`)
    }
    log(`   (c) empty parentSlug/hubSlug: ${audit.emptyParent.length}`)
    for (const e of audit.emptyParent) {
      log(`       ${e.slug} [${e.articleType}] missing: ${e.missing.join(', ')}`)
    }
    log('')
  }

  // ── Summary table ──────────────────────────────────────────────────────
  log(`━━━ Summary table (per airport) ━━━`)
  const pad = (s: string | number, n: number) => String(s).padEnd(n)
  const lpad = (s: string | number, n: number) => String(s).padStart(n)
  log(
    `${pad('Airport', 8)}${lpad('Posts', 7)}${lpad('Hub', 5)}${lpad('SubP', 6)}${lpad('Spoke', 7)}` +
      `${lpad('(a)HubSpk', 11)}${lpad('(a)HubSubP', 12)}${lpad('(a)SubPSpk', 12)}${lpad('(b)Orphan', 11)}${lpad('(c)Empty', 10)}`
  )
  let tPosts = 0, tHub = 0, tSubP = 0, tSpoke = 0
  let tMissHubSpoke = 0, tMissHubSubP = 0, tMissSubPSpoke = 0, tOrphan = 0, tEmpty = 0
  for (const a of audits) {
    tPosts += a.totalPosts
    tHub += a.hubs
    tSubP += a.subPillars
    tSpoke += a.spokes
    tMissHubSpoke += a.missingHubSpokeLinks.length
    tMissHubSubP += a.missingHubSubPillarLinks.length
    tMissSubPSpoke += a.missingSubPillarSpokeLinks.length
    tOrphan += a.orphans.length
    tEmpty += a.emptyParent.length
    log(
      `${pad(a.code, 8)}${lpad(a.totalPosts, 7)}${lpad(a.hubs, 5)}${lpad(a.subPillars, 6)}${lpad(a.spokes, 7)}` +
        `${lpad(a.missingHubSpokeLinks.length, 11)}${lpad(a.missingHubSubPillarLinks.length, 12)}${lpad(a.missingSubPillarSpokeLinks.length, 12)}${lpad(a.orphans.length, 11)}${lpad(a.emptyParent.length, 10)}`
    )
  }
  log(
    `${pad('TOTAL', 8)}${lpad(tPosts, 7)}${lpad(tHub, 5)}${lpad(tSubP, 6)}${lpad(tSpoke, 7)}` +
      `${lpad(tMissHubSpoke, 11)}${lpad(tMissHubSubP, 12)}${lpad(tMissSubPSpoke, 12)}${lpad(tOrphan, 11)}${lpad(tEmpty, 10)}`
  )
  log('')

  // ── Part 3: the 31 special articles ─────────────────────────────────────
  log(`━━━ Part 3 — 26 rescue + 5 construction articles ━━━`)
  const specialRows: SpecialRow[] = []
  for (const s of SPECIAL_SLUGS) {
    const posts = postsByAirport.get(s.code) || (await fetchPublishedPosts(s.code))
    if (!postsByAirport.has(s.code)) postsByAirport.set(s.code, posts)
    const post = posts.find((p) => p.slug === s.slug)
    const hub = posts.find((p) => p.slug === s.hubSlug)
    const hubHtml = hub?.content ? lexicalToHtml(hub.content as Parameters<typeof lexicalToHtml>[0]) : ''
    const hubLinksToIt = hub ? hubHtml.includes(`${BLOG_BASE_URL}/${s.slug}`) : false
    const bookingPath = bookingPathFor(s.code)
    const hasCtaParagraph = post ? hasTrailingBookingCta(post.content, bookingPath) : false

    specialRows.push({
      kind: s.kind,
      code: s.code,
      slug: s.slug,
      hubSlug: s.hubSlug,
      found: Boolean(post),
      hubFound: Boolean(hub),
      hubLinksToIt,
      hasCtaParagraph,
    })
  }

  log(
    `${pad('Kind', 13)}${pad('Code', 6)}${pad('Slug', 48)}${pad('Found', 7)}${pad('Hub', 7)}${pad('HubLinks', 10)}${pad('CTA', 5)}`
  )
  for (const r of specialRows) {
    log(
      `${pad(r.kind, 13)}${pad(r.code, 6)}${pad(r.slug, 48)}${pad(r.found ? 'yes' : 'NO', 7)}${pad(
        r.hubFound ? 'yes' : 'NO',
        7
      )}${pad(r.hubLinksToIt ? 'YES' : 'no', 10)}${pad(r.hasCtaParagraph ? 'yes' : 'NO', 5)}`
    )
  }
  const foundCount = specialRows.filter((r) => r.found).length
  const hubLinksCount = specialRows.filter((r) => r.hubLinksToIt).length
  const ctaCount = specialRows.filter((r) => r.hasCtaParagraph).length
  log('')
  log(
    `Totals: ${specialRows.length} slugs checked, ${foundCount} found published, ${hubLinksCount} with hub already linking to them, ${ctaCount} with trailing booking CTA`
  )
  log('')

  const outDir = path.dirname(OUT_PATH!)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(OUT_PATH!, lines.join('\n') + '\n', 'utf8')
  console.log(`\nSaved report → ${OUT_PATH}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
