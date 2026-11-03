// Chart redraw, step 1b (no network): sort the images from inventory.sql by what can happen to them.
//   standard  — `<code>-parking-rates-*` from the lot rewrite (daily bars or a 7-day table of "lots bookable on Triply"),
//               or a redrawn `<code>-rate-chart-<kind>-<date>` from an earlier run (the monthly refresh) → redraw
//   one-off   — an engine infographic whose subject is a parking-rate comparison that prices off-site lots → redraw
//   mixed     — prices off-site lots inside another subject (a map, an arrival timeline, rideshare vs parking, steps…):
//               a rate chart can't replace it → held for Tom (remove the image, or keep it)
//   airport   — prices only on-airport parking: no lot of ours on it, left alone
//   not-rate  — no parking price (arrival times, taxi fares, maps…): left alone
// Off-site lots are found by Triply / off-site words, brand words, AND the airport's own lot names (its data file and
// the price snapshot), so "2 Birds $7.61" or "ExecPark $12.21" isn't mistaken for on-airport parking. Captions only — the
// contact sheet lists every left-alone priced caption for a human look. An image no post uses is skipped.
// Writes reports/chart-redraw/out/inventory.json — the stored list the monthly re-run reuses.
//   npx tsx reports/chart-redraw/classify.mts
import fs from 'fs'
import { LOT_BRANDS, OFF_SITE_WORDS, lotKeys, loadPriceSnapshot, type ChartKind } from '../../src/rate-chart.js'

const OUT = 'reports/chart-redraw/out'
interface Use { post_id: number; slug: string; status: string; airport: string | null; updated_at: string; block: number; context: string | null }
interface Raw { media_id: number; filename: string; alt: string | null; created_at: string; uses: Use[]; featured_in: unknown[] | null }
export type ChartClass = 'standard' | 'one-off' | 'mixed' | 'airport' | 'not-rate'
export interface Item { media_id: number; filename: string; alt: string; created_at: string; code: string; family: 'parking-rates' | 'rate-chart' | 'infographic' | 'other'; cls: ChartClass; kind: ChartKind; why: string; uses: Use[]; featured: boolean }

const raw: Raw[] = JSON.parse(fs.readFileSync(`${OUT}/inventory-raw.json`, 'utf-8'))
const snap = loadPriceSnapshot()

const PRICE = /(?:C\$|\$)\s?\d/
const TRIPLY = /triply|bookable/i
const PARKING = /park|\blots?\b|garage|valet|economy|\/day|per day|daily/i
const RATE_WORDS = /daily rates?|rates? in (?:cad|canadian)|per day|\/day|parking (?:rates|costs|prices)/i
const WEEK = /\btable\b|7-day|7 day|7 nights|seven|weekly|\bweek\b|total|for \d+ (?:days|nights)/i
/** A subject that is a parking-price comparison (the October charts' own wording). */
const RATE_SUBJECT = /parking (?:rates?|costs?|prices?|lots?|comparison|savings|stay)|daily rates?|(?:7|seven|8|eight)[- ](?:day|night) (?:parking )?(?:costs?|totals?|trip)|parking (?:cost|price|rate) (?:comparison|breakdown)|rates? compar|park(?:ing)?[- ](?:and|&|n)[- ]fly|park,? sleep|off-(?:site|airport) (?:parking|lots?|options)|lots? (?:near|bookable)|cruise parking/i
/**
 * Another subject, ANYWHERE in the caption, even when the image also prices a lot: a rate chart would drop what the
 * post needs (clearance, chargers, fares, steps). Errs toward holding — a held image keeps its old picture for Tom.
 */
const OTHER_SUBJECT = /\bmap\b|timeline|arrival|how early|step-by-step|\bsteps?\b|process|flow ?chart|wait times?|\btsa\b|catsa|security program|\buber\b|\blyft\b|rideshare|taxi|\bbus\b|\btrain\b|transit|lounge|\bev\b|electric vehicle|charging|charger|rental car|oversi[sz]ed|over-?height|clearance|\bada\b|disabled|accessible|veteran|motorcycle|lost (?:parking )?ticket|receipt|pick-?up|drop-?off|cell phone|game day|terminal guide|which terminal|\bclear\b|precheck|wi-?fi|restaurant|weather|construction|transportation|hourly|free parking|rewards?|loyalty|points/i

function codeOf(r: Raw): string {
  const m = r.filename.match(/^([a-z]{3})-(?:parking-rates|rate-chart|infographic)-/)
  return (m?.[1] ?? r.uses[0]?.airport ?? '').toUpperCase()
}

const keyCache = new Map<string, string[]>()
/** Lowercase lookup keys for the airport's off-site lots (data file, sellable or not, + this run's live lots). */
function airportLotKeys(code: string): string[] {
  if (keyCache.has(code)) return keyCache.get(code)!
  const f = `data/airports/${code}.json`
  const data = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) as { fullName?: string; parkingLots?: { name?: string }[] } : {}
  const names = [...(data.parkingLots ?? []).map((l) => l.name), ...(snap?.airports[code]?.lots ?? []).map((l) => l.name)].filter((n): n is string => typeof n === 'string')
  const keys = lotKeys(names, `${data.fullName ?? ''} ${code}`.split(/[^A-Za-z]+/).filter(Boolean))
  keyCache.set(code, keys)
  return keys
}

function classify(r: Raw, code: string): Pick<Item, 'family' | 'cls' | 'kind' | 'why'> {
  const alt = r.alt ?? ''
  const kind: ChartKind = WEEK.test(alt) ? 'week' : 'daily'
  if (/-parking-rates-/.test(r.filename)) return { family: 'parking-rates', cls: 'standard', kind: /7-day|for 7 days/.test(alt) ? 'week' : 'daily', why: 'lot-rewrite chart' }
  const redrawn = r.filename.match(/-rate-chart-(daily|week)-/)
  if (redrawn) return { family: 'rate-chart', cls: 'standard', kind: redrawn[1] as ChartKind, why: 'redrawn chart (monthly refresh)' }
  const family = /-infographic-/.test(r.filename) ? 'infographic' : 'other'
  const priced = PRICE.test(alt) || (RATE_WORDS.test(alt) && PARKING.test(alt))
  if (!priced) return { family, cls: 'not-rate', kind, why: 'no parking price in the caption' }
  const lower = alt.toLowerCase()
  const lotHit = airportLotKeys(code).find((k) => lower.includes(k))
  const hit = alt.match(TRIPLY)?.[0] ?? alt.match(OFF_SITE_WORDS)?.[0] ?? alt.match(LOT_BRANDS)?.[0] ?? lotHit
  if (!hit) {
    return PARKING.test(alt) ? { family, cls: 'airport', kind, why: 'prices on-airport parking only' } : { family, cls: 'not-rate', kind, why: 'prices, but not parking (fares, lounges…)' }
  }
  const other = alt.match(OTHER_SUBJECT)?.[0]
  if (!other && RATE_SUBJECT.test(alt)) return { family, cls: 'one-off', kind, why: `rate comparison pricing off-site lots ("${hit}")` }
  return { family, cls: 'mixed', kind, why: `prices off-site lots ("${hit}") inside another subject${other ? ` ("${other}")` : ''}` }
}

const items: Item[] = raw.map((r) => {
  const code = codeOf(r)
  return { media_id: r.media_id, filename: r.filename, alt: r.alt ?? '', created_at: r.created_at, code, ...classify(r, code), uses: r.uses, featured: !!r.featured_in?.length }
})
const inScope = items.filter((i) => (i.cls === 'standard' || i.cls === 'one-off' || i.cls === 'mixed') && i.uses.length)
const airports = [...new Set(inScope.map((i) => i.code))].sort()
fs.writeFileSync(`${OUT}/inventory.json`, JSON.stringify({ builtAt: new Date().toISOString(), airports, items }, null, 1))

const count = (f: (i: Item) => boolean) => items.filter(f).length
console.log(`images: ${items.length}  (featured images among them: ${count((i) => i.featured)})`)
for (const cls of ['standard', 'one-off', 'mixed', 'airport', 'not-rate'] as const) {
  console.log(`  ${cls.padEnd(9)} ${String(count((i) => i.cls === cls)).padStart(4)} · used ${count((i) => i.cls === cls && i.uses.length > 0)} · unused ${count((i) => i.cls === cls && !i.uses.length)}`)
}
const posts = new Set(inScope.flatMap((i) => i.uses.map((u) => u.post_id)))
console.log(`in scope: ${inScope.length} images in ${posts.size} posts, ${airports.length} airports: ${airports.join(' ')}`)
