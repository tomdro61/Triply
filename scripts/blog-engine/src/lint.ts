/**
 * lint.ts — W1.4 / W1.10: checks that FAIL a write to the CMS.
 *
 * Runs on the final HTML + title/meta right before createPost/updatePost. Any `error` finding stops
 * the write; `warn` findings are printed only. Pure function, no network — unit-tested in lint.test.ts.
 *
 * Checks (plan v3.2 §W1.4, §W1.10):
 *   - artifact phrases: "wait,", "let's be precise", "competitor article", "as an AI", …
 *   - money without a currency sign: "15/day", "costs 15 per day", "from 12 a day"
 *     (times, counts and ranges are not prices: "from 5:00 a.m.", "from 3 airlines", "$25–35/day" pass)
 *   - "verified" / "working" within a few words of a promo code ("QR code", "zip code" are not promo talk)
 *   - code strings (a code with a digit anywhere; "code WELCOME" / "use triply10" in context) not in
 *     src/config/approved-promo-codes.json — only in posts that talk about promo/coupon/discount codes
 *   - "save up to N %" / "N % off" / "N-M % below" with no OUTSIDE source link in the same paragraph or
 *     FAQ answer (a Triply search link is a CTA, not a source); naming one of our approved codes is its own source
 *   - NEW posts only: a year other than the current one in title/metaTitle
 *   - NEW rates/cost posts only (answer-first): the first paragraph must carry at least one $ figure and "as of <Month>"
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const APPROVED_CODES_PATH = path.resolve(__dirname, 'config', 'approved-promo-codes.json')

export interface LintInput {
  title: string
  metaTitle?: string
  metaDescription?: string
  html: string
  excerpt?: string
  faqItems?: { question: string; answer: string }[]
  /** Slug or keyword, used to decide whether this is a rates/cost post. */
  keyword: string
  slug?: string
  /** True when the post does not exist in the CMS yet (year check + answer-first apply to new posts only). */
  isNew: boolean
  /** Override for tests. Defaults to the list in config/approved-promo-codes.json. */
  approvedCodes?: string[]
  /** Code → its documented percent off (`percentOff` in the config). Only THAT claim ("10% off" for a 10% code) is self-sourced. */
  approvedOffers?: Record<string, number>
  /** W1.3: every number in the airport data file. A $ figure not in here and not next to a link is flagged. */
  knownFigures?: number[]
  now?: Date
}

export interface LintFinding {
  level: 'error' | 'warn'
  rule: string
  message: string
  snippet?: string
}

export interface LintResult {
  ok: boolean
  errors: LintFinding[]
  warnings: LintFinding[]
}

const ARTIFACT_PHRASES: RegExp[] = [
  /\bwait,/i,
  /let'?s be precise/i,
  /competitor(?:'s)? article/i,
  /\bas an ai\b/i,
  /\bas a language model\b/i,
  /\bi (?:cannot|can't) browse\b/i,
  /\[(?:insert|todo|tbd|citation needed)[^\]]*\]/i,
  /\blorem ipsum\b/i,
  /\bno competitor\b/i,
  /\bthe (?:source|scraped) (?:article|articles|content) (?:says|said|mentions?)\b/i,
]

// "as of October 2026", "As of 15 October 2026", "as of Oct. 15, 2026": a month name AND a year. "as of Sunday" is not a date,
// and "may"/"mar" as ordinary words never count (the old check accepted "as of Sunday; prices may rise").
const MONTH_NAMES = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)'
const AS_OF_MONTH_YEAR = new RegExp(`\\bas of\\s+(?:\\d{1,2}\\s+)?${MONTH_NAMES}\\.?\\s+(?:\\d{1,2},?\\s+)?20\\d{2}\\b`, 'i')

const BARE_MONEY: RegExp[] = [
  // "15/day", "15 per day", "15 a day", "15 daily" with no $, C$, CA$, US$ or % right before the number.
  // A range dash before the number means it is the top of one price ("$25–35/day"), not a second bare price.
  /(?<![$€£\d.,%A-Za-z\-–—])(?<![–—-]\s)\b(\d{1,3}(?:\.\d{2})?)\s?(?:\/|per\s|a\s|each\s)(?:day|night|hour|hr|week|wk|month)\b/i,
  // "costs 15" / "from 15" / "rate of 15" — followed by nothing that makes it a non-price: no %, no clock time
  // ("from 5:00 a.m.", "from 10 a.m."), no count noun ("from 3 airlines", "2 levels"), no year, no range.
  // "only N" was dropped from the triggers: "only 2 levels" / "only 1 of the lots" are counts far more often than prices.
  /\b(?:costs?|priced?|rates? of|from|starting at|as low as)\s(\d{1,3}(?:\.\d{2})?)(?![:.]\d)(?!\s?(?:%|percent|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|miles?|mi\b|km|feet|ft|spaces|spots|lots?|levels?|floors?|stops?|gates?|terminals?|airlines?|carriers?|options?|locations?|lanes?|routes?|shuttles?|buses|vans?|a\.?m\b|p\.?m\b|o'clock|-|–|—|to\b|\d))\b(?!\s?(?:\/|per|a)\s?(?:day|night|hour))/i,
]

// A post "talks about codes" only when it names promo/coupon/discount codes. A bare "code" is a QR code, a zip code,
// a confirmation code — those posts must not have every all-caps word read as a promo code (NJ TRANSIT, PANYNJ).
const PROMO_WORD = /\b(?:promo|promotional|coupon|discount|voucher)\s?codes?\b|\b(?:promo|coupon)s?\b/i
// "verified"/"working"/… near "promo code" (any case), or near "code TRIPLY10" (an upper-case token that looks like a code).
const VERIFIED_NEAR_CODE = /\b(?:verified|working|tested|confirmed|guaranteed)\b[^.<>]{0,60}\b(?:promo|coupon|discount)\s?codes?\b|\b(?:promo|coupon|discount)\s?codes?\b[^.<>]{0,60}\b(?:verified|working|tested|confirmed|guaranteed)\b/i
// The token must look like a promo code (letters AND digits, "TRIPLY10"), and "gate code 4821" / "confirmation code" are not promo codes.
const NOT_PROMO_CODE_WORD = '(?<!\\b(?:[Gg]ate|[Aa]ccess|[Dd]oor|[Cc]onfirmation|[Bb]ooking|[Rr]eservation|[Zz]ip|[Pp]ostal|[Qq][Rr]|[Bb]ar|[Aa]rea|[Pp]in)[\\s-]+)'
const CODE_TOKEN = '(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\\d)[A-Z0-9]{4,}'
const VERIFIED_NEAR_CODE_TOKEN = new RegExp(`\\b(?:[Vv]erified|[Ww]orking|[Tt]ested|[Cc]onfirmed|[Gg]uaranteed)\\b[^.<>]{0,40}${NOT_PROMO_CODE_WORD}\\b[Cc]odes?\\s+${CODE_TOKEN}\\b|${NOT_PROMO_CODE_WORD}\\b[Cc]odes?\\s+${CODE_TOKEN}\\b[^.<>]{0,40}\\b(?:verified|working|tested|confirmed|guaranteed)\\b`)
// A code with a digit, anywhere in the text ("SAVE10", "TRIPLY10", "FLY2024").
const CODE_STRING = /\b([A-Z][A-Z0-9]{3,}\d[A-Z0-9]*|[A-Z]{2,}\d{1,3}[A-Z]*)\b/g
// A token in code position, any case, when it carries a digit ("use triply10", "enter: Save20") …
const CODE_CONTEXT_DIGIT = /\b(?:[Cc]odes?|[Uu]se|[Ee]nter|[Aa]pply|[Tt]ype)\s*[:"“']?\s*([A-Za-z]+\d[A-Za-z0-9]*|\d+[A-Za-z]{2,}[A-Za-z0-9]*)\b/g
// … or an all-caps word right after "code" ("code WELCOME"), or a longer one after use/enter/apply ("use EARLYBIRD";
// "use LINK light rail" stays a word: four letters).
const CODE_AFTER_CODEWORD = /\b[Cc]odes?\s*[:"“']?\s*([A-Z]{4,})\b|\b(?:[Uu]se|[Ee]nter|[Aa]pply)\s*[:"“']?\s*([A-Z]{5,})\b/g
const ORDINAL = /^\d+(?:ST|ND|RD|TH)$/
// A candidate right after "confirmation code" / "gate code" / … is that kind of code, not a promo code; "RTL855661" is a ResLab reservation number.
const NON_PROMO_CONTEXT = /\b(?:gate|access|door|confirmation|booking|reservation|zip|postal|qr|bar|area|pin)[\s-]+codes?[\s:"“'-]*$/i
const RESERVATION_NUMBER = /^RTL\d{5,}$/
const NOT_CODES = new Set(['AIRTRAIN', 'PRECHECK', 'COVID', 'SKYTRAIN', 'TRAIN', 'TERMINAL', 'ECONOMY', 'DAILY', 'HOURLY', 'GARAGE', 'SHUTTLE', 'PARKING', 'AIRPORT', 'NORTH', 'SOUTH', 'CENTRAL', 'EXPRESS', 'VALET', 'TRIPLY', 'CLEAR', 'GLOBAL', 'ENTRY', 'LYFT', 'UBER', 'METRO', 'MARTA', 'SEPTA', 'AMTRAK', 'UPDATED', 'VERIFIED', 'WORKING', 'TOTAL', 'PRICE', 'RATES', 'NOTE', 'FREE', 'CHEAP', 'TRANSIT', 'PANYNJ', 'MBTA', 'BART', 'DART', 'LIRR', 'PATH', 'CTA', 'WMATA', 'MASSPORT', 'TSA', 'CATSA', 'FAA', 'CBSA', 'NEXUS', 'LOGAN', 'EXIT', 'CHECKOUT', 'ONLINE'])
// "save up to 40%", "40% off", "40-60% below/less/cheaper", "60% savings"
const SAVE_UP_TO = /\b(?:save|savings of|discounts? of)?\s?up to\s?\d{1,2}\s?%(?:\s?off)?|\b\d{1,2}\s?%\s?off\b|\b\d{1,2}\s?[-–]\s?\d{1,2}\s?%\s?(?:off|below|less|cheaper|lower|savings?)\b|\b\d{1,2}\s?%\s?(?:below|less|cheaper|lower|savings?)\b/i
// A source for a savings claim is an outside page; a link to our own site is a CTA.
const EXTERNAL_SOURCE_LINK = /<a\s[^>]*href=["']https?:\/\/(?!(?:www\.)?triplypro\.com)[^"']+["']/i

export function loadApprovedCodes(file: string = APPROVED_CODES_PATH): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { codes?: { code: string }[] } | string[]
    if (Array.isArray(raw)) return raw.map(String)
    return (raw.codes || []).map((c) => String(c.code))
  } catch {
    return []
  }
}

/** Code → documented percent off, from the same file. A code with no `percentOff` sources no savings claim at all. */
export function loadApprovedOffers(file: string = APPROVED_CODES_PATH): Record<string, number> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { codes?: { code: string; percentOff?: unknown }[] }
    const out: Record<string, number> = {}
    for (const c of raw.codes || []) if (typeof c.percentOff === 'number') out[String(c.code).toUpperCase()] = c.percentOff
    return out
  } catch {
    return {}
  }
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

export function firstParagraph(html: string): string {
  const m = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
  return m ? stripTags(m[1]) : stripTags(html).slice(0, 400)
}

export function isRatesPost(keywordOrSlug: string): boolean {
  return /\b(?:cost|costs|price|prices|pricing|rate|rates|fee|fees|cheap|cheapest|how[- ]much|per[- ]day|daily)\b/i.test(keywordOrSlug.replace(/-/g, ' '))
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Our own published offer is its own source — but only the offer itself: "TRIPLY10: 10% off" when the config says
 * TRIPLY10 is 10% off. "TRIPLY10 takes 90% off" or a garage-savings claim beside the code still needs an outside source.
 */
function ownCodeCovers(text: string, claim: string, offers: Record<string, number>): boolean {
  const m = claim.trim().match(/^(\d{1,2})\s?%\s?off$/i)
  if (!m) return false
  const pct = Number(m[1])
  return Object.entries(offers).some(([code, off]) => off === pct && new RegExp(`\\b${escapeRe(code)}\\b`, 'i').test(text))
}

function paragraphs(html: string): string[] {
  const out: string[] = []
  const re = /<(p|li|td|th|h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) out.push(m[2])
  return out.length ? out : [html]
}

export function lintArticle(input: LintInput): LintResult {
  const errors: LintFinding[] = []
  const warnings: LintFinding[] = []
  const now = input.now || new Date()
  const approved = new Set((input.approvedCodes || loadApprovedCodes()).map((c) => c.toUpperCase()))
  const offers = input.approvedOffers ?? (input.approvedCodes ? {} : loadApprovedOffers())
  const savingsClaims = (text: string) => [...text.matchAll(new RegExp(SAVE_UP_TO.source, 'gi'))].map((m) => m[0])

  const faqText = (input.faqItems || []).map((f) => `${f.question} ${f.answer}`).join(' ')
  const allText = [input.title, input.metaTitle, input.metaDescription, input.excerpt, stripTags(input.html), faqText]
    .filter(Boolean)
    .join(' \n ')

  // 1. Artifact phrases
  for (const re of ARTIFACT_PHRASES) {
    const m = allText.match(re)
    if (m) errors.push({ level: 'error', rule: 'artifact-phrase', message: `AI/editing artifact "${m[0]}" left in the text`, snippet: context(allText, m.index || 0) })
  }

  // 2. Money without a currency sign
  for (const re of BARE_MONEY) {
    const m = allText.match(re)
    if (m) errors.push({ level: 'error', rule: 'bare-money', message: `price "${m[0].trim()}" has no $ / C$ sign`, snippet: context(allText, m.index || 0) })
  }

  // 3. "verified"/"working" next to a promo code (either wording is a promo claim on its own; no gate needed)
  {
    const m = allText.match(VERIFIED_NEAR_CODE) || allText.match(VERIFIED_NEAR_CODE_TOKEN)
    if (m) errors.push({ level: 'error', rule: 'verified-code', message: `"${m[0].trim().slice(0, 60)}": never call a code verified/working`, snippet: context(allText, m.index || 0) })
  }

  // 4. Code strings not in the approved list — only in posts that talk about promo/coupon codes
  if (PROMO_WORD.test(allText)) {
    const seen = new Set<string>()
    const candidates: { code: string; index: number }[] = []
    for (const m of allText.matchAll(CODE_STRING)) candidates.push({ code: m[1], index: m.index || 0 })
    // index = where the TOKEN starts (the match starts at the keyword), so the context look-back sees "gate-code".
    for (const m of allText.matchAll(CODE_CONTEXT_DIGIT)) candidates.push({ code: m[1], index: (m.index || 0) + m[0].lastIndexOf(m[1]) })
    for (const m of allText.matchAll(CODE_AFTER_CODEWORD)) { const tok = m[1] || m[2]; candidates.push({ code: tok, index: (m.index || 0) + m[0].lastIndexOf(tok) }) }
    for (const { code: raw, index } of candidates) {
      const code = raw.toUpperCase()
      if (seen.has(code) || approved.has(code) || NOT_CODES.has(code) || ORDINAL.test(code) || RESERVATION_NUMBER.test(code)) continue
      // "booking code RTL855661" is a reservation number — unless the sentence USES it ("use booking code TRIPLY20 at checkout").
      const before = allText.slice(Math.max(0, index - 40), index)
      if (NON_PROMO_CONTEXT.test(before) && !/\b(?:use|enter|apply|type)\b/i.test(before)) continue
      // Skip obvious non-codes: airport codes with digits don't exist; terminal labels, PNG sizes, model names
      if (/^(?:T\d|B\d|P\d{1,2}|LOT\d{1,2}|HWY\d+|I\d{2,3}|US\d{1,3}|SR\d{1,3}|A\d{1,2}|C\d{1,2}|D\d{1,2}|E\d{1,2}|F\d{1,2}|G\d{1,2}|H\d{1,2}|\d+X\d+|COVID19|SB\d{2,4}|HB\d{2,4})$/.test(code)) continue
      seen.add(code)
      errors.push({ level: 'error', rule: 'unapproved-code', message: `promo code "${code}" is not in config/approved-promo-codes.json`, snippet: context(allText, index) })
    }
  }

  // 5. "save up to N %" needs an OUTSIDE source link in the same paragraph (body) or answer (FAQ).
  // Our own approved code is its own source ("TRIPLY10: 10% off the parking rate"); a Triply search link is a CTA, not a source.
  paragraphLoop: for (const p of paragraphs(input.html)) {
    const text = stripTags(p)
    if (EXTERNAL_SOURCE_LINK.test(p)) continue
    for (const claim of savingsClaims(text)) {
      if (ownCodeCovers(text, claim, offers)) continue
      errors.push({ level: 'error', rule: 'unsourced-saving', message: `"${claim}" has no source link in its paragraph`, snippet: text.slice(0, 160) })
      break paragraphLoop
    }
  }
  faqLoop: for (const f of input.faqItems || []) {
    const text = `${f.question} ${f.answer}`
    if (EXTERNAL_SOURCE_LINK.test(f.answer)) continue
    for (const claim of savingsClaims(text)) {
      if (ownCodeCovers(text, claim, offers)) continue
      // FAQ answers render as plain text on the site (FaqAccordion), so an answer can never carry a working source link.
      errors.push({ level: 'error', rule: 'unsourced-saving', message: `FAQ "${f.question.slice(0, 60)}": "${claim}" — FAQ answers cannot carry a source link; remove the claim or move it to the body with its source`, snippet: stripTags(f.answer).slice(0, 160) })
      break faqLoop
    }
  }
  for (const field of [input.title, input.metaTitle, input.metaDescription, input.excerpt]) {
    if (field && SAVE_UP_TO.test(field)) {
      warnings.push({ level: 'warn', rule: 'unsourced-saving', message: `"${field.match(SAVE_UP_TO)![0]}" in title/meta — make sure the body sources it` })
    }
  }

  // W1.3: official figures come from the data file or a cited URL. Warning only (does not block the
  // write) until the data files carry every figure the writer is allowed to quote.
  if (input.knownFigures) {
    const known = new Set(input.knownFigures.map((n) => Math.round(n * 100)))
    const flagged = new Set<string>()
    for (const p of paragraphs(input.html)) {
      if (/<a\s[^>]*href=/i.test(p)) continue
      for (const m of stripTags(p).matchAll(/(?:C\$|CA\$|US\$|\$)\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) {
        const n = Number(m[1].replace(/,/g, ''))
        if (!Number.isFinite(n) || known.has(Math.round(n * 100)) || flagged.has(m[0])) continue
        flagged.add(m[0])
      }
    }
    if (flagged.size) warnings.push({ level: 'warn', rule: 'unsourced-figure', message: `figures not in the airport data file and not next to a source link: ${[...flagged].slice(0, 8).join(', ')}` })
  }

  // W1.5: promo posts are "how to save" — a title that promises a list of codes is the old pattern
  if (/coupon|promo|discount|deal|code/i.test(`${input.keyword} ${input.slug || ''}`) && /\b(?:promo|coupon|discount) codes\b/i.test(`${input.title} ${input.metaTitle || ''}`)) {
    warnings.push({ level: 'warn', rule: 'promo-framing', message: 'promo post title promises "codes"; frame it as how to save and name only published codes' })
  }

  // 6. NEW posts only: a non-current year in title / metaTitle
  if (input.isNew) {
    const year = now.getFullYear()
    for (const [name, field] of [['title', input.title], ['metaTitle', input.metaTitle]] as const) {
      const m = field?.match(/\b(20\d{2})\b/)
      if (m && Number(m[1]) !== year) {
        errors.push({ level: 'error', rule: 'stale-year', message: `${name} says ${m[1]}; new posts carry ${year} or no year` })
      }
    }
  }

  // 7. Answer-first for NEW rates/cost posts (W1.10)
  if (input.isNew && isRatesPost(`${input.keyword} ${input.slug || ''}`)) {
    const first = firstParagraph(input.html)
    const hasFigure = /(?:\$|C\$|CA\$|US\$)\s?\d/.test(first)
    const hasAsOf = AS_OF_MONTH_YEAR.test(first)
    if (!hasFigure) errors.push({ level: 'error', rule: 'answer-first', message: 'rates/cost post: the first paragraph has no $ figure', snippet: first.slice(0, 200) })
    if (!hasAsOf) errors.push({ level: 'error', rule: 'answer-first', message: 'rates/cost post: the first paragraph has no "as of <Month YYYY>"', snippet: first.slice(0, 200) })
  }

  return { ok: errors.length === 0, errors, warnings }
}

function context(text: string, idx: number): string {
  return text.slice(Math.max(0, idx - 60), idx + 100).replace(/\s+/g, ' ')
}

export function formatLint(result: LintResult): string {
  const lines: string[] = []
  for (const e of result.errors) lines.push(`  ✗ [${e.rule}] ${e.message}${e.snippet ? `\n      …${e.snippet}…` : ''}`)
  for (const w of result.warnings) lines.push(`  ⚠ [${w.rule}] ${w.message}`)
  return lines.join('\n')
}

/** Every finite number anywhere in an airport data object (W1.3 allow-list for $ figures). */
export function collectFigures(data: unknown, out: number[] = []): number[] {
  if (typeof data === 'number' && Number.isFinite(data)) out.push(data)
  else if (typeof data === 'string') for (const m of data.matchAll(/\d[\d,]*(?:\.\d{1,2})?/g)) out.push(Number(m[0].replace(/,/g, '')))
  else if (Array.isArray(data)) for (const v of data) collectFigures(v, out)
  else if (data && typeof data === 'object') for (const v of Object.values(data)) collectFigures(v, out)
  return out
}
