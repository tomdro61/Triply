/**
 * duplicate-guard.ts — W1.1: refuse to write a second page for a question an airport already answers.
 *
 * Before `generate` writes a post, the item's keyword is normalised and compared with every slug
 * the airport already has in the CMS (ANY status — a draft counts) plus the redirect map the app
 * serves (`src/config/blog-redirects.json`, a flattened old-slug → new-slug map). On a match the
 * job is not a new page: the caller logs the refusal to `logs/duplicate-refusals.log` for a person
 * to read and marks the queue item so the next step is "update that page".
 *
 * Normalisation (plan v3.2 §W1.1):
 *   - drop airport names/codes and the fillers for/in/near/at/the/a/an/to/of/and/your
 *   - fold cost ≈ price ≈ rates ≈ fee ≈ per day;  shuttle ≈ bus;  pick-up ≈ visitor ≈ waiting
 *   - intent words stay distinct: long-term, hourly, short-term, economy, terminal X, garage names
 * Nothing here calls the network: callers pass the slugs in, so this is unit-testable.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(ENGINE_ROOT, '..', '..')
export const REDIRECT_MAP_PATH = path.join(REPO_ROOT, 'src', 'config', 'blog-redirects.json')
export const REFUSAL_LOG_PATH = path.join(ENGINE_ROOT, 'logs', 'duplicate-refusals.log')

const FILLERS = new Set([
  'for', 'in', 'near', 'at', 'the', 'a', 'an', 'to', 'of', 'and', 'your', 'my', 'on', 'with', 'by', 'is', 'are', 'it', 'do', 'does', 'what', 'which',
  'airport', 'airports', 'international', 'intl', 'intl.', 'parking', 'park', 'guide', 'complete', 'best',
  'options', 'option', 'info', 'information', 'tips', 'blog',
])

// Each entry: every surface form on the left folds to the canonical token on the right.
const SYNONYMS: [RegExp, string][] = [
  [/^(cost|costs|price|prices|pricing|rate|rates|fee|fees|charge|charges|perday|daily|cheap|cheapest|affordable|budget|how-much)$/, 'cost'],
  [/^(shuttle|shuttles|bus|buses|transfer|transfers)$/, 'shuttle'],
  [/^(pickup|pick-up|visitor|visitors|waiting|cellphone|cell-phone|cell|arrivals|arrival|meet)$/, 'pickup'],
  [/^(longterm|long-term|extended|weekly|monthly|economy|econo|remote)$/, 'long-term'],
  [/^(shortterm|short-term|hourly|hour|hours|daily-max)$/, 'hourly'],
  [/^(coupon|coupons|promo|promos|code|codes|discount|discounts|deal|deals|voucher|vouchers|save|savings)$/, 'promo'],
  [/^(offsite|off-site|off-airport|offairport|nearby|private|lot|lots)$/, 'offsite'],
  [/^(onsite|on-site|on-airport|onairport|official)$/, 'onsite'],
  [/^(garage|garages|deck|structure)$/, 'garage'],
  [/^(valet)$/, 'valet'],
  [/^(ev|electric|charging|charger|chargers)$/, 'ev'],
  [/^(review|reviews|rating|ratings)$/, 'review'],
  [/^(map|maps|directions|address|location|where)$/, 'map'],
  [/^(hotel|hotels|park-sleep-fly|park-and-fly|sleep)$/, 'hotel'],
  [/^(terminal|terminals|term)$/, 'terminal'],
  [/^(2025|2026|2027|2028)$/, ''], // years never make a different question
  [/^p\d{1,2}$/, ''], // engine slug suffixes like -p6 (promo variant numbering) are not intent
]

const AIRPORT_NAME_WORDS = new Set([
  'jfk', 'kennedy', 'lga', 'laguardia', 'guardia', 'ewr', 'newark', 'liberty', 'bos', 'boston', 'logan',
  'lax', 'los', 'angeles', 'sfo', 'san', 'francisco', 'ord', 'ohare', "o'hare", 'chicago', 'mdw', 'midway',
  'dfw', 'dallas', 'fort', 'worth', 'iah', 'houston', 'hou', 'hobby', 'atl', 'atlanta', 'hartsfield', 'jackson',
  'den', 'denver', 'sea', 'seattle', 'tacoma', 'seatac', 'sea-tac', 'phx', 'phoenix', 'sky', 'harbor', 'las', 'vegas',
  'harry', 'reid', 'mco', 'orlando', 'mia', 'miami', 'fll', 'lauderdale', 'tpa', 'tampa', 'msp', 'minneapolis',
  'dtw', 'detroit', 'metro', 'phl', 'philadelphia', 'philly', 'bwi', 'baltimore', 'dca', 'reagan', 'national',
  'iad', 'dulles', 'washington', 'clt', 'charlotte', 'douglas', 'slc', 'salt', 'lake', 'city', 'pdx', 'portland',
  'san', 'diego', 'stl', 'louis', 'bna', 'nashville', 'aus', 'austin', 'bergstrom', 'mci', 'kansas', 'cle',
  'cleveland', 'hopkins', 'cvg', 'cincinnati', 'rdu', 'raleigh', 'durham', 'pit', 'pittsburgh', 'ric', 'richmond',
  'buf', 'buffalo', 'bdl', 'hartford', 'bradley', 'mke', 'milwaukee', 'msy', 'new', 'orleans', 'oak', 'oakland',
  'sjc', 'jose', 'sdf', 'louisville', 'yyz', 'toronto', 'pearson', 'yul', 'montreal', 'trudeau', 'yyc', 'calgary',
  'yow', 'ottawa', 'yvr', 'vancouver', 'hpn', 'westchester', 'white', 'plains', 'bur', 'burbank', 'alb', 'albany',
  'bhm', 'birmingham', 'chs', 'charleston', 'dsm', 'des', 'moines', 'elp', 'el', 'paso', 'fat', 'fresno', 'gso',
  'greensboro', 'ind', 'indianapolis', 'jax', 'jacksonville', 'lit', 'little', 'rock', 'mlb', 'melbourne', 'okc',
  'oklahoma', 'orf', 'norfolk', 'pbi', 'palm', 'beach', 'pvd', 'providence', 'rno', 'reno', 'roc', 'rochester',
  'sat', 'antonio', 'sav', 'savannah', 'syr', 'syracuse', 'tus', 'tucson', 'tys', 'knoxville', 'poe',
])

export interface RedirectMap { [fromSlug: string]: string }

export function loadRedirectMap(file: string = REDIRECT_MAP_PATH): RedirectMap {
  if (!fs.existsSync(file)) return {}
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RedirectMap) : {}
}

/**
 * Normalise a keyword or slug into a sorted set of intent tokens.
 * `airportCode` (and its known name words) are dropped so "jfk long term parking" and
 * "long-term parking at kennedy airport" compare equal.
 */
export function normalizeKeyword(text: string, airportCode?: string): string[] {
  const code = (airportCode || '').toLowerCase()
  const tokens = text
    .toLowerCase()
    .replace(/&amp;/g, ' ')
    .replace(/[_/]+/g, ' ')
    .replace(/[^a-z0-9$%\-\s']/g, ' ')
    .split(/[\s]+/)
    .flatMap((t) => (t.includes('-') && !/^(long-term|short-term|pick-up|off-site|on-site|off-airport|on-airport|park-sleep-fly|park-and-fly|cell-phone|sea-tac|how-much|daily-max)$/.test(t) ? t.split('-') : [t]))
    .map((t) => t.replace(/^'+|'+$/g, ''))
    .filter(Boolean)

  // "per day", "how much" → one token before folding
  const joined: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], n = tokens[i + 1]
    if (t === 'per' && n === 'day') { joined.push('perday'); i++; continue }
    if (t === 'how' && n === 'much') { joined.push('how-much'); i++; continue }
    if (t === 'long' && n === 'term') { joined.push('long-term'); i++; continue }
    if (t === 'short' && n === 'term') { joined.push('short-term'); i++; continue }
    if (t === 'pick' && n === 'up') { joined.push('pick-up'); i++; continue }
    if (t === 'off' && (n === 'site' || n === 'airport')) { joined.push('off-site'); i++; continue }
    if (t === 'on' && (n === 'site' || n === 'airport')) { joined.push('on-site'); i++; continue }
    if (t === 'cell' && n === 'phone') { joined.push('cell-phone'); i++; continue }
    joined.push(t)
  }

  const out = new Set<string>()
  let pendingTerminal = false
  for (const raw of joined) {
    if (raw === code || AIRPORT_NAME_WORDS.has(raw)) continue
    if (FILLERS.has(raw)) continue
    let t = raw
    for (const [re, canon] of SYNONYMS) {
      if (re.test(t)) { t = canon; break }
    }
    if (!t) continue
    if (t === 'terminal') { pendingTerminal = true; out.add('terminal'); continue }
    // "terminal b", "terminal 4": the designator stays distinct
    if (pendingTerminal && /^([a-f]|\d{1,2})$/.test(t)) { out.add(`terminal-${t}`); pendingTerminal = false; continue }
    pendingTerminal = false
    out.add(t)
  }
  return [...out].sort()
}

export function normalizedKey(text: string, airportCode?: string): string {
  return normalizeKeyword(text, airportCode).join(' ')
}

export interface DuplicateMatch {
  /** The slug that already answers this question (the redirect destination when the hit was an old slug). */
  slug: string
  /** Which list produced the hit. */
  via: 'existing-post' | 'redirect-map'
  /** The slug that matched before following the redirect map (same as `slug` for a direct hit). */
  matchedSlug: string
  normalized: string
}

/**
 * Compare a queued keyword with every slug at the airport (any status) and the redirect map.
 * `ownSlug` is the item's own slug: a hit on it is a regenerate, not a duplicate, so it is skipped.
 */
export function findDuplicate(
  keyword: string,
  airportCode: string,
  existingSlugs: string[],
  redirects: RedirectMap,
  ownSlug?: string,
): DuplicateMatch | null {
  const key = normalizedKey(keyword, airportCode)
  if (!key) return null
  const ownKey = ownSlug ? normalizedKey(ownSlug, airportCode) : null

  for (const slug of existingSlugs) {
    if (ownSlug && slug === ownSlug) continue
    if (normalizedKey(slug, airportCode) === key) {
      const dest = redirects[slug] || slug
      return { slug: dest, via: 'existing-post', matchedSlug: slug, normalized: key }
    }
  }
  for (const [from, to] of Object.entries(redirects)) {
    if (ownSlug && (from === ownSlug || to === ownSlug)) continue
    if (normalizedKey(from, airportCode) === key || normalizedKey(to, airportCode) === key) {
      return { slug: to, via: 'redirect-map', matchedSlug: from, normalized: key }
    }
  }
  // An item whose own slug normalises the same as an existing one is a regenerate; nothing to do.
  void ownKey
  return null
}

export interface RefusalRecord {
  at: string
  airportCode: string
  keyword: string
  queuedSlug: string
  queueItemId?: string
  match: DuplicateMatch
}

/** Append one line a person can read later. Never throws (a log failure must not stop the run). */
export function logRefusal(rec: RefusalRecord, file: string = REFUSAL_LOG_PATH): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = `${rec.at}\t${rec.airportCode}\t"${rec.keyword}"\tqueued=${rec.queuedSlug}\t→ update /blog/${rec.match.slug} instead (${rec.match.via}: ${rec.match.matchedSlug}; key="${rec.match.normalized}")${rec.queueItemId ? `\tqueue=${rec.queueItemId}` : ''}\n`
    fs.appendFileSync(file, line)
  } catch (e) {
    console.warn(`  ⚠ could not write duplicate-refusal log: ${e instanceof Error ? e.message : e}`)
  }
}
