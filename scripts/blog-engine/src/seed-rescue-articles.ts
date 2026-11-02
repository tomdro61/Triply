// Seed the "parking sold out" rescue article for every airport cluster.
//
// One spoke per airport, articleStyle 'rescue', parented to that airport's published hub.
// Idempotent: existing queue items are patched back to queued rather than duplicated, so the
// script is safe to re-run after a partial failure.
//
// Usage:
//   tsx src/seed-rescue-articles.ts --dry-run     # preview, no writes
//   tsx src/seed-rescue-articles.ts               # seed all eligible airports
//   tsx src/seed-rescue-articles.ts -a BOS        # single airport
//   tsx src/seed-rescue-articles.ts --omit-style  # omit articleStyle (before the CMS enum ships)

import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const headers = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
/**
 * Transitional: seed without articleStyle so items can be queued before the CMS `rescue`
 * enum value ships. Payload rejects an unknown select value outright ("This field has an
 * invalid selection"), so the field has to be omitted rather than sent and ignored.
 * Generate with `--style rescue` in the meantime, then re-run this script without the flag
 * once the enum is live to patch the stored style onto the items.
 */
const OMIT_STYLE = args.includes('--omit-style')
const ONLY_AIRPORT = args.find((a) => a === '-a' || a === '--airport')
  ? args[args.findIndex((a) => a === '-a' || a === '--airport') + 1]?.toUpperCase()
  : undefined

/** Target word count — the reference article that proved this format runs ~2,300 words. */
const TARGET_WORDS = 2300

interface RescueTarget {
  airportCode: string
  /** Focus keyword. Drives slug, AI title, and which airport-JSON sections reach the prompt. */
  keyword: string
  /** That airport's hub slug — must already be PUBLISHED for the spoke prerequisite to pass. */
  hubSlug: string
}

/**
 * Fixed keyword pattern: "<common name> airport parking sold out".
 *
 * The common name follows each cluster's established naming (the same one its hub slug and
 * existing spokes use) rather than always using the IATA code — "logan" and "dulles" outrank
 * "bos" and "iad" for their markets.
 */
const TARGETS: RescueTarget[] = [
  { airportCode: 'ATL', keyword: 'atlanta airport parking sold out', hubSlug: 'atlanta-airport-parking' },
  { airportCode: 'AUS', keyword: 'austin airport parking sold out', hubSlug: 'aus-airport-parking' },
  { airportCode: 'BNA', keyword: 'bna airport parking sold out', hubSlug: 'bna-airport-parking' },
  { airportCode: 'BOS', keyword: 'logan airport parking sold out', hubSlug: 'boston-logan-airport-parking' },
  { airportCode: 'BWI', keyword: 'bwi airport parking sold out', hubSlug: 'bwi-airport-parking' },
  { airportCode: 'CLT', keyword: 'clt airport parking sold out', hubSlug: 'clt-airport-parking' },
  { airportCode: 'DCA', keyword: 'dca airport parking sold out', hubSlug: 'dca-airport-parking' },
  { airportCode: 'DEN', keyword: 'denver airport parking sold out', hubSlug: 'den-airport-parking' },
  { airportCode: 'DFW', keyword: 'dfw airport parking sold out', hubSlug: 'dfw-airport-parking' },
  { airportCode: 'EWR', keyword: 'newark airport parking sold out', hubSlug: 'newark-airport-parking' },
  { airportCode: 'FLL', keyword: 'fort lauderdale airport parking sold out', hubSlug: 'fort-lauderdale-airport-parking' },
  { airportCode: 'IAD', keyword: 'dulles airport parking sold out', hubSlug: 'iad-airport-parking' },
  { airportCode: 'IAH', keyword: 'iah airport parking sold out', hubSlug: 'iah-airport-parking' },
  { airportCode: 'JFK', keyword: 'jfk airport parking sold out', hubSlug: 'jfk-airport-parking' },
  { airportCode: 'LAS', keyword: 'las vegas airport parking sold out', hubSlug: 'las-airport-parking' },
  { airportCode: 'LAX', keyword: 'lax airport parking sold out', hubSlug: 'lax-airport-parking' },
  { airportCode: 'LGA', keyword: 'laguardia airport parking sold out', hubSlug: 'laguardia-airport-parking' },
  { airportCode: 'MCO', keyword: 'orlando airport parking sold out', hubSlug: 'orlando-airport-parking' },
  { airportCode: 'MIA', keyword: 'miami airport parking sold out', hubSlug: 'miami-airport-parking' },
  { airportCode: 'MSP', keyword: 'msp airport parking sold out', hubSlug: 'msp-airport-parking' },
  // "ohare" deliberately without an apostrophe: keywordToSlug strips it, but the keyword string
  // is also injected verbatim into the prompt and must be reproducible in the body copy.
  { airportCode: 'ORD', keyword: 'ohare airport parking sold out', hubSlug: 'ord-airport-parking' },
  { airportCode: 'PHL', keyword: 'philadelphia airport parking sold out', hubSlug: 'philadelphia-airport-parking' },
  { airportCode: 'SAN', keyword: 'san diego airport parking sold out', hubSlug: 'san-diego-airport-parking' },
  { airportCode: 'SEA', keyword: 'seattle airport parking sold out', hubSlug: 'seattle-airport-parking' },
  { airportCode: 'SFO', keyword: 'sfo airport parking sold out', hubSlug: 'sfo-airport-parking' },
  // TPA already has tampa-airport-parking-sold-out published; the upsert path below re-queues
  // it with articleStyle 'rescue' instead of creating a duplicate (slug is globally unique).
  { airportCode: 'TPA', keyword: 'tampa airport parking sold out', hubSlug: 'tpa-airport-parking' },
]

/** Airports with data JSON but no hub/cluster — a spoke cannot generate without a published parent. */
const BLOCKED_NO_HUB = ['DTW', 'PDX', 'PHX', 'SLC']

/** Identical to the rule used by every importer (see upsert-queue.ts). */
function keywordToSlug(keyword: string): string {
  return keyword
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

async function isHubPublished(hubSlug: string): Promise<boolean> {
  const url = `${CMS}/api/posts?where[slug][equals]=${encodeURIComponent(hubSlug)}&where[status][equals]=published&limit=1&depth=0`
  const r = await fetch(url, { headers })
  if (!r.ok) throw new Error(`Hub lookup failed: ${r.status} ${await r.text()}`)
  const d = await r.json()
  return Boolean(d.docs?.length)
}

async function findQueueItem(slug: string, airportCode: string): Promise<{ id: number; status: string } | null> {
  const url = `${CMS}/api/content-queue?where[slug][equals]=${encodeURIComponent(slug)}&where[airportCode][equals]=${airportCode}&limit=1&depth=0`
  const r = await fetch(url, { headers })
  if (!r.ok) throw new Error(`Queue lookup failed: ${r.status} ${await r.text()}`)
  const d = await r.json()
  if (d.docs?.length) return { id: d.docs[0].id, status: d.docs[0].status }
  return null
}

async function main() {
  if (!CMS || !KEY) {
    console.error('Missing PAYLOAD_CMS_URL or PAYLOAD_API_KEY in .env')
    process.exit(1)
  }

  const targets = ONLY_AIRPORT ? TARGETS.filter((t) => t.airportCode === ONLY_AIRPORT) : TARGETS
  if (ONLY_AIRPORT && targets.length === 0) {
    console.error(`No rescue target defined for "${ONLY_AIRPORT}".`)
    if (BLOCKED_NO_HUB.includes(ONLY_AIRPORT)) {
      console.error(`${ONLY_AIRPORT} has airport data but no hub cluster — seed and publish its hub first.`)
    }
    process.exit(1)
  }

  console.log(`\nSeeding "parking sold out" rescue articles`)
  console.log(`CMS: ${CMS}`)
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`)
  if (OMIT_STYLE) {
    console.log(`articleStyle: OMITTED — generate with "--style rescue", and re-run without`)
    console.log(`              --omit-style once the CMS enum ships to persist the style.`)
  }
  console.log(`Targets: ${targets.length}\n`)

  let created = 0
  let requeued = 0
  let skippedHub = 0
  let skippedActive = 0
  let errors = 0

  for (const t of targets) {
    const slug = keywordToSlug(t.keyword)
    const label = `${t.airportCode.padEnd(3)} ${slug}`

    try {
      // The spoke prerequisite checks that parentSlug names a PUBLISHED post. Verifying here
      // turns a silent "⏭ Skipping" at generate time into an actionable message now.
      if (!(await isHubPublished(t.hubSlug))) {
        console.log(`  ⊘ ${label} — hub "${t.hubSlug}" is not published; spoke would be skipped at generate time`)
        skippedHub++
        continue
      }

      const data: Record<string, unknown> = {
        keyword: t.keyword,
        airportCode: t.airportCode,
        slug,
        articleType: 'spoke',
        parentSlug: t.hubSlug,
        hubSlug: t.hubSlug,
        priority: 'S1',
        targetWords: TARGET_WORDS,
        notes: 'Rescue article — high-intent "parking sold out" contingency guide.',
      }
      if (!OMIT_STYLE) data.articleStyle = 'rescue'

      const existing = await findQueueItem(slug, t.airportCode)

      if (existing) {
        // Don't yank an item out from under an in-flight run.
        if (existing.status === 'generating') {
          console.log(`  ⊘ ${label} — currently generating, left alone`)
          skippedActive++
          continue
        }
        if (DRY_RUN) {
          console.log(`  ↻ ${label} — would re-queue (status=${existing.status}) → id ${existing.id}`)
          requeued++
          continue
        }
        const res = await fetch(`${CMS}/api/content-queue/${existing.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ ...data, status: 'queued' }),
        })
        if (!res.ok) throw new Error(`PATCH ${res.status}: ${await res.text()}`)
        console.log(`  ↻ ${label} — re-queued (was ${existing.status}) → id ${existing.id}`)
        requeued++
        continue
      }

      if (DRY_RUN) {
        console.log(`  + ${label} — would create (parent: ${t.hubSlug})`)
        created++
        continue
      }

      const res = await fetch(`${CMS}/api/content-queue`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...data, status: 'queued' }),
      })
      if (!res.ok) {
        const body = await res.text()
        // Slug is globally unique — a collision means the same slug exists under another airport.
        if (body.includes('duplicate') || body.includes('unique')) {
          console.log(`  ⊘ ${label} — slug already taken by another cluster; skipped`)
          skippedActive++
          continue
        }
        throw new Error(`POST ${res.status}: ${body}`)
      }
      const d = await res.json()
      console.log(`  + ${label} — created → id ${d.doc?.id}`)
      created++
    } catch (err) {
      errors++
      console.error(`  ✗ ${label} FAILED: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`\n${'━'.repeat(60)}`)
  console.log(
    `Created: ${created} | Re-queued: ${requeued} | No published hub: ${skippedHub} | Skipped: ${skippedActive} | Errors: ${errors}`,
  )
  if (!ONLY_AIRPORT) {
    console.log(`\nNot seeded — no hub cluster exists yet: ${BLOCKED_NO_HUB.join(', ')}`)
    console.log(`  Seed and publish each hub first, then re-run this script.`)
  }
  if (DRY_RUN) console.log(`\nDRY RUN — nothing was written.`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
