// Chart redraw, step 1b (no network): sort the October images from inventory.sql into what gets redrawn.
//   standard  — `<code>-parking-rates-*` from the lot rewrite (daily bars or a 7-day table of "lots bookable on Triply"),
//               or a redrawn `<code>-rate-chart-<kind>-<date>` from an earlier run (the monthly refresh)
//   one-off   — an engine infographic whose caption prices off-site lots (Triply, off-site, park-and-fly, a hotel or lot name)
//   airport   — prices only on-airport parking: no lot of ours on it, left alone
//   not-rate  — no parking price (arrival times, taxi fares, steps…): left alone
// An image no post uses is an orphan and is skipped. The kind of the replacement (daily bars / 7-day table) follows the
// caption. Writes reports/chart-redraw/out/inventory.json — the stored list the monthly re-run reuses.
//   npx tsx reports/chart-redraw/classify.mts
import fs from 'fs'
import type { ChartKind } from '../../src/rate-chart.js'

const OUT = 'reports/chart-redraw/out'
interface Use { post_id: number; slug: string; status: string; airport: string | null; updated_at: string; block: number; context: string | null }
interface Raw { media_id: number; filename: string; alt: string | null; created_at: string; uses: Use[]; featured_in: unknown[] | null }
export type ChartClass = 'standard' | 'one-off' | 'airport' | 'not-rate'
export interface Item { media_id: number; filename: string; alt: string; created_at: string; code: string; family: 'parking-rates' | 'rate-chart' | 'infographic' | 'other'; cls: ChartClass; kind: ChartKind; why: string; uses: Use[]; featured: boolean }

const raw: Raw[] = JSON.parse(fs.readFileSync(`${OUT}/inventory-raw.json`, 'utf-8'))

const PRICE = /(?:C\$|\$)\s?\d/
const TRIPLY = /triply|bookable/i
const OFFSITE = /off-site|offsite|off-airport|off airport|park[- ]?(?:and|&|n|'n)[- ]?fly|park,? sleep|hotel (?:lot|parking)|independent lots?|private lots?/i
const LOT_BRANDS = /\b(?:inn|hotel|suites|marriott|hilton|hyatt|westin|sheraton|doubletree|hampton|radisson|crowne plaza|best western|la quinta|travelodge|courtyard|four points|embassy|wyndham|days inn|super 8|red roof|clarion|sonesta|holiday inn|parking spot|park ?n ?fly|park ?2 ?fly|parkair|airpark|jetway|fast park|wallypark|express park|joy park|spring park|autoparc|eyepark|parkade lot)\b/i
const PARKING = /park|\blots?\b|garage|valet|economy|\/day|per day|daily/i
const RATE_WORDS = /daily rates?|rates? in (?:cad|canadian)|per day|\/day|parking (?:rates|costs|prices)/i
const WEEK = /\btable\b|7-day|7 day|7 nights|seven|weekly|\bweek\b|total|for \d+ (?:days|nights)/i

function codeOf(r: Raw): string {
  const m = r.filename.match(/^([a-z]{3})-(?:parking-rates|rate-chart|infographic)-/)
  return (m?.[1] ?? r.uses[0]?.airport ?? '').toUpperCase()
}

function classify(r: Raw): Pick<Item, 'family' | 'cls' | 'kind' | 'why'> {
  const alt = r.alt ?? ''
  const kind: ChartKind = WEEK.test(alt) ? 'week' : 'daily'
  if (/-parking-rates-/.test(r.filename)) return { family: 'parking-rates', cls: 'standard', kind: /7-day|for 7 days/.test(alt) ? 'week' : 'daily', why: 'lot-rewrite chart' }
  const redrawn = r.filename.match(/-rate-chart-(daily|week)-/)
  if (redrawn) return { family: 'rate-chart', cls: 'standard', kind: redrawn[1] as ChartKind, why: 'redrawn chart (monthly refresh)' }
  const family = /-infographic-/.test(r.filename) ? 'infographic' : 'other'
  const priced = PRICE.test(alt) || (RATE_WORDS.test(alt) && PARKING.test(alt))
  if (!priced) return { family, cls: 'not-rate', kind, why: 'no parking price in the caption' }
  if (!PARKING.test(alt) && !TRIPLY.test(alt)) return { family, cls: 'not-rate', kind, why: 'prices, but not parking (fares, lounges…)' }
  const hit = alt.match(TRIPLY) ?? alt.match(OFFSITE) ?? alt.match(LOT_BRANDS)
  if (hit) return { family, cls: 'one-off', kind, why: `prices off-site lots ("${hit[0]}")` }
  return { family, cls: 'airport', kind, why: 'prices on-airport parking only' }
}

const items: Item[] = raw.map((r) => ({ media_id: r.media_id, filename: r.filename, alt: r.alt ?? '', created_at: r.created_at, code: codeOf(r), ...classify(r), uses: r.uses, featured: !!r.featured_in?.length }))
const redraw = items.filter((i) => (i.cls === 'standard' || i.cls === 'one-off') && i.uses.length)
const airports = [...new Set(redraw.map((i) => i.code))].sort()
fs.writeFileSync(`${OUT}/inventory.json`, JSON.stringify({ builtAt: new Date().toISOString(), airports, items }, null, 1))

const count = (f: (i: Item) => boolean) => items.filter(f).length
console.log(`images: ${items.length}  (featured images among them: ${count((i) => i.featured)})`)
for (const cls of ['standard', 'one-off', 'airport', 'not-rate'] as const) {
  console.log(`  ${cls.padEnd(9)} ${String(count((i) => i.cls === cls)).padStart(4)} · used ${count((i) => i.cls === cls && i.uses.length > 0)} · orphan ${count((i) => i.cls === cls && !i.uses.length)}`)
}
const posts = new Set(redraw.flatMap((i) => i.uses.map((u) => u.post_id)))
console.log(`to redraw: ${redraw.length} images in ${posts.size} posts, ${airports.length} airports: ${airports.join(' ')}`)
console.log(`  daily ${redraw.filter((i) => i.kind === 'daily').length} · 7-day ${redraw.filter((i) => i.kind === 'week').length} · statuses ${JSON.stringify(redraw.flatMap((i) => i.uses.map((u) => u.status)).reduce<Record<string, number>>((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {}))}`)
