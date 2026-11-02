// Seed "parking construction chaos" articles — task 62 of the marketing plan.
//
// Same shape as seed-rescue-articles.ts's "parking sold out" spokes, except the disruption is
// dated and knowable in advance from the construction record instead of live at generation time:
// when an airport's own parking closes/shrinks/relocates on a published date, our cheapest
// competitor leaves the market on that date, and the article can be written before it happens.
//
// Mining source: reports/construction-parking-impact.md + .json (generated 2026-09-14 from the
// construction2026 block of data/airports/*.json). Of the 17 airports carrying an actual
// closure/capacity-cut/relocation, only 5 name a real disruption dated 2026 or early 2027 that
// affects travelers — see the TARGETS comment below for the full accept/reject reasoning on all 17.
//
// One spoke per warranted airport, articleStyle 'rescue' (no dedicated 'construction' style exists
// in the CMS enum or in prompts/write.ts's getStyleInstructions — adding one would mean editing
// existing files, which this job is not allowed to do). 'rescue' is the closest fit: its scorer
// requirement (prompts/write.ts + seo-scorer.ts "rescue" case) is a live-status-check section
// within the first 2 H2s, which a construction status-check satisfies; the "name real off-site
// lots, one comparison table, prevention section" structure also carries over cleanly. The one
// mismatch is the style's hard-coded copy ("they are flying soon and just found out parking is
// unavailable") which is written for a live sold-out event, not a scheduled/ongoing construction
// cut — that will read oddly verbatim and likely wants a light prompt tweak before a real run.
// Flagged here rather than silently patched, since prompts/write.ts is an existing file.
//
// Per-item facts travel through the CMS `outline` field (ContentQueue.outline: order/heading/
// summary/linksTo), the same field prompts/write.ts already injects verbatim as "Follow this
// outline: N. heading — summary" (src/prompts/write.ts:441-462) ahead of the style instructions.
// Every summary below quotes the source construction2026 record directly so the writer cannot
// invent a date, space count, or lot name. Note the airport JSON's own construction2026 block is
// ALSO already injected into every prompt unconditionally, labeled "Active Construction (mention
// for freshness)" (src/prompts/write.ts:359-371, formatConstruction) — the outline is what forces
// it from a passing mention into the article's actual spine.
//
// Idempotent: existing queue items are patched back to queued rather than duplicated, so the
// script is safe to re-run after a partial failure. Read-only CMS lookups (hub-published check,
// existing-item lookup) run even in --dry-run; nothing is created/patched/enqueued in that mode.
//
// Usage:
//   tsx src/seed-construction-articles.ts --dry-run     # preview, no writes
//   tsx src/seed-construction-articles.ts               # seed all warranted airports
//   tsx src/seed-construction-articles.ts -a DCA         # single airport
//   tsx src/seed-construction-articles.ts --omit-style  # omit articleStyle (only if the CMS
//                                                        # enum rejects 'rescue' at write time —
//                                                        # triply-cms-main/src/collections/
//                                                        # ContentQueue.ts already lists it, so
//                                                        # this should not be needed against a
//                                                        # deployment built from current main)

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
/** Transitional flag mirroring seed-rescue-articles.ts — see usage note above. */
const OMIT_STYLE = args.includes('--omit-style')
const ONLY_AIRPORT = args.find((a) => a === '-a' || a === '--airport')
  ? args[args.findIndex((a) => a === '-a' || a === '--airport') + 1]?.toUpperCase()
  : undefined

/**
 * Inherited unchanged from seed-rescue-articles.ts's TARGET_WORDS. That figure is measured —
 * "the reference article that proved this format runs ~2,300 words" — for the SOLD-OUT shape.
 * No construction-style article has been generated yet, so this is carried over as the closest
 * available anchor, not independently validated for this content.
 */
const TARGET_WORDS = 2300

interface OutlineItem {
  order: number
  heading: string
  summary: string
}

interface ConstructionTarget {
  airportCode: string
  /** Focus keyword: "<common name> airport parking construction 2026". Common name matches the
   *  rescue TARGETS' naming for the same airport (see seed-rescue-articles.ts). */
  keyword: string
  /** Same hub map as seed-rescue-articles.ts — must already be PUBLISHED. */
  hubSlug: string
  /** One-line disruption summary, for the dry-run preview and the queue-item notes field only —
   *  NOT sent to the writer prompt (prompts/write.ts does not read QueueItem.notes). */
  disruption: string
  /** Date(s) on record, as cited in reports/construction-parking-impact.json / the airport JSON. */
  date: string
  /** Structured brief carrying the exact quoted facts — see file header for how this reaches the prompt. */
  outline: OutlineItem[]
}

/**
 * WARRANTED / NOT-WARRANTED determination — all 17 airports with a disruptive
 * (closure/capacity-cut/relocation) entry in reports/construction-parking-impact.json, reviewed
 * against their data/airports/<code>.json construction2026 block on 2026-09-15.
 *
 * Bar: the record must name a parking/shuttle closure, capacity cut, or relocation with a date in
 * 2026 or early 2027 that affects travelers. "No parking closures expected" and completion dates
 * of 2028+ are NOT warranted, even when other construction is real and heavily documented.
 *
 * WARRANTED (5) — in TARGETS below:
 *   - DCA — Economy Lot Parking Deck: ~40% of Economy Lot (1,100 of 2,680 spaces) unavailable
 *     during construction; Phase 1 adds 939 spaces Feb 2026, Phase 2 adds 1,230 more May 2026;
 *     Cell Phone Lot temporarily closed.
 *   - AUS — Blue Garage Exit Ramp Modifications: overnight closures during Yellow Garage ramp
 *     construction, through 2026.
 *   - LGA — LaGuardia Marriott parking: CLOSED INDEFINITELY as of January 31, 2026.
 *   - LAS — Airport's own travel-impact advisory: parking lots "may have reduced capacity during
 *     major construction phases — pre-book during peak travel periods," tied to the dated
 *     2025-2026 Terminal 3 Ticketing Reconfiguration / Baggage Processing Expansion window. This
 *     is the weakest of the five: no specific space count or closure date is published, only the
 *     airport's own generic advisory — the outline below is written to use ONLY that language,
 *     not invent specifics.
 *   - EWR — AirTrain Newark weekday/full-closure schedule runs through 2026 into Jan 2027 (exact
 *     dates below), replaced by free shuttle buses.
 *
 * NOT WARRANTED (12) — one line each, per the airport's own travelImpact/disruptive text:
 *   - ATL  — "No major parking closures expected in 2026"; Concourse D disruption is gate-side.
 *   - BNA  — Concourse A closed but through July 2028 (excluded date range); "terminal garages
 *     and economy lots remain fully operational."
 *   - BOS  — Terminal E surface lot is closed now, but the only date on record is the ~2028
 *     garage-replacement completion — no 2026-specific date to anchor the article on.
 *   - CLT  — "No parking closures expected in 2026"; runway/gate work only.
 *   - DEN  — "No parking lot closures expected in 2026"; only item is a 2-month RENTAL-CAR
 *     shuttle pickup shift (Mar-Apr 2026, Level 5 West->East), not airport parking.
 *   - DFW  — "No parking closures expected"; roadway detours only, no date.
 *   - DTW  — "No parking facility closures expected"; also has no published hub (blocked
 *     separately, same as the rescue seeder's BLOCKED_NO_HUB).
 *   - FLL  — "No major parking closures expected in 2026"; Terminal 5 build is gate-side.
 *   - IAH  — "No parking closures expected in 2026"; Terminal B ticketing-lobby closure only.
 *   - PHX  — "No parking closures expected"; the only dated item is a 2027 pedestrian-bridge
 *     convenience addition, not a closure; also no published hub.
 *   - SEA  — Only dated item is the Second Terminal targeting 2032 capacity; travel-impact text
 *     explicitly says "Parking garage remains fully operational."
 *   - TPA  — "No parking closures expected in 2026"; Airside D/E work is perimeter/airside only.
 *
 * Out of scope for this pass (not in the 17): BWI, JFK, MCO, SAN carry construction but zero
 * disruptive entries; IAD, LAX, MIA, MSP, ORD, PHL, PDX, SFO, SLC have no construction2026 record
 * mined at all.
 */
const TARGETS: ConstructionTarget[] = [
  {
    airportCode: 'DCA',
    keyword: 'dca airport parking construction 2026',
    hubSlug: 'dca-airport-parking',
    disruption: 'Economy Lot Parking Deck construction cuts ~40% of Economy Lot capacity (1,100 of 2,680 spaces); Cell Phone Lot temporarily closed',
    date: 'Phase 1 Feb 2026, Phase 2 May 2026',
    outline: [
      {
        order: 1,
        heading: 'Check DCA Economy Lot Availability Before You Book',
        summary:
          'Live-status framing: DCA’s Economy Lot Parking Deck ($40M, contractor Kiwi Newton) is under construction. Verify current Economy Lot capacity on the official Reagan National parking page before assuming a space is available.',
      },
      {
        order: 2,
        heading: 'What’s Under Construction at DCA in 2026',
        summary:
          'Quote exactly: new 3-story parking deck on top of the Economy Lot. Phase 1 adds 939 spaces (February 2026). Phase 2 adds 1,230 additional spaces (May 2026). Up to 1,100 of the Economy Lot’s 2,680 spaces (~40%) are unavailable during peak construction. The Cell Phone Lot is TEMPORARILY CLOSED during construction — use the Parking 1/2 garages (first 60 minutes free) for pickups instead.',
      },
      {
        order: 3,
        heading: 'Off-Site Alternatives While Economy Lot Capacity Is Cut',
        summary:
          'Name real off-site DCA lots by name, daily rate, and drive time from the verified airport data — never generalize into categories — positioned as the reliable choice while Economy Lot capacity is reduced.',
      },
      {
        order: 4,
        heading: 'DCA Economy Lot vs Off-Site vs Park-and-Ride',
        summary:
          'One comparison table: on-airport Economy Lot (reduced capacity through May 2026) vs off-site lots vs park-and-ride — daily rate, shuttle, who each suits.',
      },
      {
        order: 5,
        heading: 'When DCA Parking Capacity Returns to Normal',
        summary:
          'Phase 2 completes May 2026, adding roughly 2,169 new structured spaces total across both phases. Until then, reserve ahead, especially during peak travel weeks.',
      },
    ],
  },
  {
    airportCode: 'AUS',
    keyword: 'austin airport parking construction 2026',
    hubSlug: 'aus-airport-parking',
    disruption: 'Blue Garage exit ramp overnight closures during Yellow Garage construction; Yellow Garage Phase 1 (3,000 spaces) opens 2026',
    date: 'through 2026 (Yellow Garage Phase 1 opening 2026)',
    outline: [
      {
        order: 1,
        heading: 'Check Austin Airport Garage Access Before You Drive In',
        summary:
          'Live-status framing: verify current Blue Garage ramp status on the official AUS parking page before your trip — exit ramps see overnight closures during Yellow Garage construction.',
      },
      {
        order: 2,
        heading: 'What’s Under Construction at AUS in 2026',
        summary:
          'Quote exactly: Blue Garage Exit Ramp Modifications — overnight closures during Yellow Garage ramp construction, through 2026. Yellow Garage Phase 1 (3,000 spaces, seven-story smart garage north of Blue Garage) is opening in 2026, easing the squeeze; full 7,100-space completion is 2027. Separately, the South Terminal closed permanently March 31, 2026 (Allegiant and Frontier relocated to Barbara Jordan Terminal), adding gate/security congestion — note this does not remove parking capacity itself.',
      },
      {
        order: 3,
        heading: 'Off-Site Alternatives During Blue Garage Ramp Closures',
        summary:
          'Name real off-site AUS lots by name, daily rate, and drive time from the verified airport data.',
      },
      {
        order: 4,
        heading: 'AUS On-Airport vs Off-Site vs Park-and-Ride',
        summary:
          'One comparison table: on-airport garages (overnight ramp closures) vs off-site lots vs park-and-ride — daily rate, shuttle, who each suits.',
      },
      {
        order: 5,
        heading: 'When Austin Airport Parking Construction Eases',
        summary:
          'Yellow Garage Phase 1 opens in 2026 adding 3,000 spaces and is expected to significantly ease parking constraints per the airport’s own travel-impact notice; the Blue Garage overnight ramp closures continue through 2026 regardless.',
      },
    ],
  },
  {
    airportCode: 'LGA',
    keyword: 'laguardia airport parking construction 2026',
    hubSlug: 'laguardia-airport-parking',
    disruption: 'LaGuardia Marriott parking lot closed indefinitely',
    date: 'January 31, 2026',
    outline: [
      {
        order: 1,
        heading: 'Check LaGuardia Marriott Parking Status Before You Book',
        summary:
          'Live-status framing: the LaGuardia Marriott parking lot has been closed indefinitely since January 31, 2026 due to ongoing construction. Confirm your intended lot is still open before relying on it.',
      },
      {
        order: 2,
        heading: 'What Closed at LGA in 2026',
        summary:
          'Quote exactly: LaGuardia Marriott parking — CLOSED indefinitely as of January 31, 2026 due to ongoing construction. Terminal construction (the $8B LaGuardia transformation) is substantially complete; some roadway and infrastructure work continues. The Marriott lot closure affects travelers who previously used that option.',
      },
      {
        order: 3,
        heading: 'Off-Site Alternatives Now That the Marriott Lot Is Gone',
        summary:
          'Name real off-site LGA lots by name, daily rate, and drive time from the verified airport data as direct replacements for the closed Marriott lot.',
      },
      {
        order: 4,
        heading: 'LGA On-Airport vs Off-Site vs Park-and-Ride',
        summary:
          'One comparison table: on-airport options vs off-site lots vs park-and-ride — daily rate, shuttle, who each suits.',
      },
      {
        order: 5,
        heading: 'Is the Marriott Lot Coming Back?',
        summary:
          'The record states the closure is indefinite — no reopening date is published. Advise planning around off-site options for the foreseeable future rather than waiting on it.',
      },
    ],
  },
  {
    airportCode: 'LAS',
    keyword: 'las vegas airport parking construction 2026',
    hubSlug: 'las-airport-parking',
    disruption: 'Airport’s own advisory: parking lots may see reduced capacity during major construction phases (Terminal 1 rebuild / Terminal 3 reconfiguration / baggage expansion)',
    date: '2025-2026 (Terminal 3 reconfiguration, baggage expansion ~2026)',
    outline: [
      {
        order: 1,
        heading: 'Check Harry Reid Parking Capacity Before You Go',
        summary:
          'Live-status framing: Harry Reid’s own travel-impact notice says parking lots may have reduced capacity during major construction phases — verify current status and pre-book ahead of peak travel, exactly as the airport advises.',
      },
      {
        order: 2,
        heading: 'What’s Under Construction at LAS in 2026',
        summary:
          'Quote exactly, and do not go beyond it: "Parking lots may have reduced capacity during major construction phases — pre-book during peak travel periods." Context: Terminal 1 Rebuild (multi-year, existing gates stay open), Terminal 3 Ticketing Reconfiguration (2025-2026, Terminal 3 being redesignated Terminal 2), Baggage Processing Expansion (completion ~2026). No specific space count or closure date is published for parking — do not invent one; use only the airport’s general advisory language above.',
      },
      {
        order: 3,
        heading: 'Off-Site Alternatives to Pre-Book Ahead of LAS Construction',
        summary:
          'Name real off-site LAS lots by name, daily rate, and drive time from the verified airport data, framed around the airport’s own pre-book advisory.',
      },
      {
        order: 4,
        heading: 'LAS On-Airport vs Off-Site vs Park-and-Ride',
        summary:
          'One comparison table: on-airport parking (advisory: may see reduced capacity) vs off-site lots vs park-and-ride — daily rate, shuttle, who each suits.',
      },
      {
        order: 5,
        heading: 'Peak Periods to Book Around',
        summary:
          'Tie to the dated 2025-2026 Terminal 3 / baggage-expansion construction window and the airport’s own peak-travel-period advisory from the verified data.',
      },
    ],
  },
  {
    airportCode: 'EWR',
    keyword: 'newark airport parking construction 2026',
    hubSlug: 'newark-airport-parking',
    disruption: 'AirTrain Newark weekday suspensions and a full closure window, replaced by shuttle buses',
    date: 'Jan 15-Sep 29, 2026 (weekday); Sep 30-Oct 30, 2026 (full closure); Oct 30, 2026-Jan 15, 2027 (TBD)',
    outline: [
      {
        order: 1,
        heading: 'Check the AirTrain Newark Status Before Your Trip',
        summary:
          'Live-status framing: AirTrain Newark service is suspended for parts of 2026 on a published schedule. Verify today’s status before planning your terminal-to-parking connection.',
      },
      {
        order: 2,
        heading: 'AirTrain Newark Closures in 2026',
        summary:
          'Quote exactly: January 15 - September 29, 2026: weekday suspensions 5 AM - 3 PM. September 30 - October 30, 2026: full closure. October 30, 2026 - January 15, 2027: to be confirmed. Free shuttle buses replace it, with stops at all terminals, the rental car facility, P4, and the RailLink station. This is the $3.5B AirTrain Newark Replacement project (ground broken October 2025); the new permanent system opens 2030.',
      },
      {
        order: 3,
        heading: 'Off-Site Alternatives With Direct Shuttles (Skip the AirTrain Entirely)',
        summary:
          'Name real off-site EWR lots by name, daily rate, and drive time from the verified airport data, emphasizing lots with their own direct terminal shuttle as a way to avoid the AirTrain disruption altogether.',
      },
      {
        order: 4,
        heading: 'EWR On-Airport vs Off-Site vs Park-and-Ride',
        summary:
          'One comparison table: on-airport (AirTrain-dependent) vs off-site direct-shuttle lots vs park-and-ride — daily rate, shuttle, who each suits.',
      },
      {
        order: 5,
        heading: 'When AirTrain Service Returns to Normal',
        summary:
          'Full closure runs through October 30, 2026; the November 2026-mid-January 2027 window is still unconfirmed per the Port Authority. Advise checking back before travel in that window.',
      },
    ],
  },
]

/** Identical to the rule used by every importer (see upsert-queue.ts) and seed-rescue-articles.ts. */
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
    console.error(`No construction target defined for "${ONLY_AIRPORT}".`)
    console.error(`Warranted airports: ${TARGETS.map((t) => t.airportCode).join(', ')}`)
    console.error(`(All other airports in the construction record were reviewed and found NOT`)
    console.error(`warranted this season — see the comment above TARGETS in this file for why.)`)
    process.exit(1)
  }

  console.log(`\nSeeding "parking construction 2026" articles`)
  console.log(`CMS: ${CMS}`)
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`)
  if (OMIT_STYLE) {
    console.log(`articleStyle: OMITTED — generate with "--style rescue", and re-run without`)
    console.log(`              --omit-style once confirmed live to persist the style.`)
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
      console.log(`  ℹ ${label} — ${t.disruption} (${t.date})`)

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
        outline: t.outline,
        notes: `Construction-chaos article — ${t.disruption} (${t.date}). See reports/construction-parking-impact.json.`,
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
  if (DRY_RUN) console.log(`\nDRY RUN — nothing was written.`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
