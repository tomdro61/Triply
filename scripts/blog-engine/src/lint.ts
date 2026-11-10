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
  /**
   * W1.8 P3c: the P3 price allow-list (collectMoneyFigures(figureSource(...)), the figures the writer saw).
   * When set, a $ figure that is not in it fails the write: body paragraphs that link an EXTERNAL source are
   * exempt; title, meta, excerpt and FAQ have no exemption. Same check as apply-edit. `generate` sets it.
   */
  knownPrices?: number[]
  /** W1.8 P3c: the allow-list for a figure written as a per-day price ("$12/day"): no N-day totals. */
  knownDailyPrices?: number[]
  /** W1.8 P3c: every sourced figure as written (no N-day totals), for a per-day figure worded as a past price. */
  knownSourcedPrices?: number[]
  /** W1.8 P3c rollout: report the knownPrices check as a warning instead of failing the write. */
  priceGateWarnOnly?: boolean
  /**
   * Overrides the PROMO_WORD gate for the code check. apply-edit lints new html on its own, and a snippet like
   * "SpotHero's SPOT10 offer…" names no promo word: whether codes are checked is a question about the whole post.
   */
  promoContext?: boolean
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
  /\[price omitted\]/i, // the writer prompt's placeholder for a removed stale figure (prompts/write.ts printableNotes)
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
export const PROMO_WORD = /\b(?:promo|promotional|coupon|discount|voucher)\s?codes?\b|\b(?:promo|coupon)s?\b/i
// "verified"/"working"/… near "promo code" (any case), or near "code TRIPLY10" (an upper-case token that looks like a code).
/** #176: a Triply booking with a protection plan is partly non-refundable, so our copy never promises a full refund. */
const REFUND_PROMISE = /\bfree cancell?ation\b[^.<>]{0,40}\b(?:full|100%) refund\b|\bfully refundable\b|\bmoney[- ]back\b/i
/** Any other "full refund" may be an airport's own published policy (MKE, SJC): a warning to check, not a block. */
const FULL_REFUND = /\bfull refund\b/i
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

interface CodeEntry { code?: unknown; airport?: unknown; expiresAt?: unknown; amountOff?: unknown; minSubtotal?: unknown; percentOff?: unknown }

/** The entries that may be quoted now (fail closed): a code of 3+ letters/digits, and not past its `expiresAt` (an
 *  unreadable date counts as expired). Checkout refuses an expired code, so the blog must stop quoting it too. */
function liveEntries(file: string, now: Date): (CodeEntry & { code: string })[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { codes?: CodeEntry[] } | unknown[]
  const list: CodeEntry[] = Array.isArray(raw) ? raw.map((code) => ({ code })) : raw.codes || []
  return list.flatMap((c) => {
    const code = String(c.code ?? '').trim().toUpperCase()
    if (!/^[A-Z0-9]{3,}$/.test(code)) return []
    if (c.expiresAt !== undefined && !(Date.parse(String(c.expiresAt)) > now.getTime())) return []
    return [{ ...c, code }]
  })
}

export function loadApprovedCodes(file: string = APPROVED_CODES_PATH, now: Date = new Date()): string[] {
  try {
    return liveEntries(file, now).map((c) => c.code)
  } catch {
    return []
  }
}

export interface ApprovedOffer { airport: string; figures: number[] }

/** Code → its airport and the dollar figures its own terms state (`amountOff`, `minSubtotal`), e.g. DFW5 →
 *  { airport: 'DFW', figures: [5, 25] }. A flat-amount code's "$5 off" and "$25 minimum" come from the code itself,
 *  so apply-edit's price check accepts them beside that code in a post for its airport. No airport, no figures. */
export function loadApprovedOfferFigures(file: string = APPROVED_CODES_PATH, now: Date = new Date()): Record<string, ApprovedOffer> {
  try {
    const out: Record<string, ApprovedOffer> = {}
    for (const c of liveEntries(file, now)) {
      const airport = typeof c.airport === 'string' ? c.airport.trim().toUpperCase() : ''
      const figures = [c.amountOff, c.minSubtotal].filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
      if (/^[A-Z]{3}$/.test(airport) && figures.length) out[c.code] = { airport, figures }
    }
    return out
  } catch {
    return {}
  }
}

/** Code → documented percent off, from the same file. A code with no `percentOff` sources no savings claim at all. */
export function loadApprovedOffers(file: string = APPROVED_CODES_PATH, now: Date = new Date()): Record<string, number> {
  try {
    const out: Record<string, number> = {}
    for (const c of liveEntries(file, now)) if (typeof c.percentOff === 'number') out[c.code] = c.percentOff
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
  const approved = new Set((input.approvedCodes || loadApprovedCodes(undefined, now)).map((c) => c.toUpperCase()))
  const offers = input.approvedOffers ?? (input.approvedCodes ? {} : loadApprovedOffers(undefined, now))
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

  // 1b. Refund promises (#176)
  {
    const m = allText.match(REFUND_PROMISE)
    if (m) errors.push({ level: 'error', rule: 'refund-claim', message: `"${m[0]}": say "free cancellation up to 24 hours before check-in"; a protection plan is partly non-refundable`, snippet: context(allText, m.index || 0) })
    else {
      const f = allText.match(FULL_REFUND)
      if (f) warnings.push({ level: 'warn', rule: 'refund-claim', message: '"full refund": fine only as an airport\'s own published policy, never for a Triply booking', snippet: context(allText, f.index || 0) })
    }
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
  if (input.promoContext ?? PROMO_WORD.test(allText)) {
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
      errors.push({ level: 'error', rule: 'unapproved-code', message: `promo code "${code}" is not an approved, unexpired code in config/approved-promo-codes.json`, snippet: context(allText, index) })
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

  // W1.8 P3c: every $ figure comes from the data the writer saw or sits next to its source. Fails the write.
  if (input.knownPrices) {
    const known = new Set(input.knownPrices.map((n) => Math.round(n * 100)))
    const fieldText = [input.title, input.metaTitle, input.metaDescription, input.excerpt,
      ...(input.faqItems || []).map((f) => `${f.question} ${stripTags(f.answer)}`)].filter(Boolean).join('\n')
    const perDay = input.knownDailyPrices ? new Set(input.knownDailyPrices.map((n) => Math.round(n * 100))) : undefined
    const sourced = input.knownSourcedPrices ? new Set(input.knownSourcedPrices.map((n) => Math.round(n * 100))) : undefined
    const bad = priceCheck(input.html, fieldText, known, perDay, sourced)
    if (bad.length) (input.priceGateWarnOnly ? warnings : errors).push({ level: input.priceGateWarnOnly ? 'warn' : 'error', rule: 'unsourced-price', message: `prices not in the airport data file and not next to an outside source link: ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ` (+${bad.length - 8} more)` : ''}` })
  }

  // W1.3: official figures come from the data file or a cited URL. Warning only; skipped when the P3c
  // check above runs, which covers the same figures and blocks.
  if (input.knownFigures && !input.knownPrices) {
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

/**
 * The price allow-list: money-bearing figures only — "$24/day" in prose, and numeric fields whose key says
 * price (dailyRate, parkOnlyRate, dailyMax, total, fee…). `collectFigures` takes EVERY number, so "Terminal 5",
 * "2026-11-01" and "Lot 20" would have passed "$5", "$2026" and "$20" (pass-2 review of #142).
 */
export function collectMoneyFigures(data: unknown, out: number[] = [], key = ''): number[] {
  if (typeof data === 'number' && Number.isFinite(data)) {
    // Case-sensitive on purpose: "totalGates" / "totalReliefAreas" are counts; "fare10Trip" / "mtaStateTax" / "dailyMax" are money.
    if (/(?:^|[a-z])(?:[Rr]ate|[Pp]rice|[Cc]ost|[Ff]ee|[Ff]are|[Ss]urcharge|[Pp]remium|[Tt]ax(?:es)?|[Cc]harge|Max|[Tt]otals)(?![a-z])/.test(key)) out.push(data)
  } else if (typeof data === 'string') {
    for (const m of data.matchAll(/(?:C\$|CA\$|US\$|\$)\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) out.push(Number(m[1].replace(/,/g, '')))
  } else if (Array.isArray(data)) {
    for (const v of data) collectMoneyFigures(v, out, key)
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) collectMoneyFigures(v, out, k)
  }
  return out
}

const MONEY = /(?:C\$|CA\$|US\$|\$)\s?(\d(?:[\d,]*\d)?(?:\.\d{1,2})?)(?:\s?[-–]\s?\$?(\d(?:[\d,]*\d)?(?:\.\d{1,2})?))?/g

/** Keys whose value is a per-day price: data-file lot rates, on-airport daily maxima/rates, the rate chart's perDay/baseRate. */
const DAILY_RATE_KEY = /(?:^|[a-z])(?:[Dd]ailyRate|[Dd]ailyMax)|^(?:reservationRate|parkOnlyRate|preBookRate|preBookedRate|advanceReservationRate|onlineRate|coveredRate|uncoveredRate|valetRate|rateTerminal\w*|perDay|baseRate)$/

/** Text right after a $ figure that makes it a per-day price ("$12/day", "$12 per day", "$12 a night", "$12 daily"). */
export const PER_DAY_AFTER = /^\s*(?:\/\s*(?:day|night|24\s*h(?:ou)?rs?)\b|per[-\s]+(?:day|night|24\s*h(?:ou)?rs?)\b|(?:for|per|\/)\s*(?:the\s+)?first\s+24\s*h(?:ou)?rs?\b|an?\s+(?:day|night)\b|each\s+day\b|daily(?![-\w]))/i
/**
 * Text right before a $ figure that makes it a per-day price ("daily rate of $12", "per-day price: $12"). Plural and
 * "parking" forms too: "Daily rates: $20" and the title "Daily Parking Rates: From $20" passed as 2-day totals (review, 5 Nov).
 */
// "cost" stays singular: "a week of daily parking costs $245" is a total, not a per-day claim.
export const PER_DAY_BEFORE = /\b(?:daily|per[-\s]day|nightly)\s+(?:parking\s+)?(?:rates?|prices?|max(?:imum)?|cost|fees?)\s*(?:of|is|are|was|were|:)?\s*(?:(?:about|around|from|only|just|start(?:s|ing)?\s+at|~)\s*){0,2}$/i
/** How far before a $ figure PER_DAY_BEFORE looks: "Per-day parking rates: from about " is 34 characters. */
const PER_DAY_LOOKBACK = 45

/** Text right before a $ figure that makes it an old price ("increased from $19/day"): never a current daily rate. */
const OLD_PRICE_BEFORE = /\b(?:from|was|were|previously|formerly|up from)\s*(?:about|around|~)?\s*$/i
/**
 * The same in a post, narrower: a bare "from $18/day" is how a post states a current low rate, so only explicit
 * past-price wording ("rose from $19/day", "rates were $19/day") marks a per-day figure as old. An old price must
 * be a sourced figure as written (priceAllowList `sourced`), never an N-day total.
 */
const OLD_PRICE_IN_POST = /\b(?:(?:increased|rose|raised|went\s+up|jumped|climbed|up)\s+from|was|were|previously|formerly|used\s+to\s+(?:be|cost))\s*(?:about|around|~)?\s*$/i
/** Savings wording before a range in source data ("savings ... are modest (~$3-5/day)"): a difference, not a rate. */
const SAVINGS_BEFORE = /\b(?:sav(?:e|es|ed|ings?)|difference|cheaper|modest)\b[^$]*$/i
/** Not parking prices, even when written per-day. */
const NOT_PARKING_KEY = /^(?:luggageStorage|baggageStorage)$/i

const DOLLAR = /(?:C\$|CA\$|US\$|\$)\s?(\d[\d,]*(?:\.\d{1,2})?)/g
/**
 * A price range in source data: "$15-25", "C$8–10", "$55–$70", "$2.25 - $8.75". A spaced dash counts only when the
 * second figure has its own currency mark, so punctuation like "$24 – 7 day max" or "$5 - 30 minutes" is no range.
 */
const SOURCE_RANGE = /(?:C\$|CA\$|US\$|\$)\s?(\d[\d,]*(?:\.\d{1,2})?)(?:[-–](?:C\$|CA\$|US\$|\$)?|\s[-–]\s(?:C\$|CA\$|US\$|\$))\s?(\d[\d,]*(?:\.\d{1,2})?)/g
const num = (raw: string) => Number(raw.replace(/,/g, ''))

/**
 * The upper end of every $ range in the data the writer saw. collectMoneyFigures (shared with apply-edit) reads only
 * figures with their own $ sign, so "$15-25 each way" gave the gate $15 but not $25 and a post quoting the range was
 * flagged (review, 5 Nov). `generate` adds these to its allow-list; apply-edit's is unchanged.
 */
export function collectRangeEnds(data: unknown, out: number[] = []): number[] {
  if (typeof data === 'string') for (const m of data.matchAll(SOURCE_RANGE)) out.push(num(m[2]))
  else if (Array.isArray(data)) for (const v of data) collectRangeEnds(v, out)
  else if (data && typeof data === 'object') for (const v of Object.values(data as Record<string, unknown>)) collectRangeEnds(v, out)
  return out
}

/**
 * The per-day prices in an object (airport data via figureSource, or a chart-prices.json row): numbers under a
 * daily-rate key (nested objects inherit it: STL `dailyMax: { covered, uncovered }`), the leading $ figure of a
 * string under one (HOU `dailyMax: "$25.00"`, `"$15.00 per day"`), and any $ figure in prose that is itself
 * written as per-day (`rate: "$15/day ($3/hr)"`). Never a bare prose figure like a "$55 taxi" or "$5 surcharge".
 */
export function collectDailyRates(data: unknown, out: number[] = [], key = '', underDaily = false): number[] {
  if (NOT_PARKING_KEY.test(key)) return out
  const daily = underDaily || DAILY_RATE_KEY.test(key)
  if (typeof data === 'number' && Number.isFinite(data)) { if (daily) out.push(data) }
  else if (typeof data === 'string') {
    const lead = daily ? data.trim().match(/^~?\s?(?:C\$|CA\$|US\$|\$)\s?(\d[\d,]*(?:\.\d{1,2})?)/) : null
    if (lead) out.push(Number(lead[1].replace(/,/g, '')))
    for (const m of data.matchAll(DOLLAR)) {
      const end = (m.index ?? 0) + m[0].length
      if (OLD_PRICE_BEFORE.test(data.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0))) continue
      if (PER_DAY_AFTER.test(data.slice(end, end + 24)) || PER_DAY_BEFORE.test(data.slice(Math.max(0, (m.index ?? 0) - PER_DAY_LOOKBACK), m.index ?? 0))) out.push(Number(m[1].replace(/,/g, '')))
    }
    // A per-day range ("$15–25/day"): both ends are daily rates. The loop above sees only "$15", and not as per-day.
    for (const m of data.matchAll(SOURCE_RANGE)) {
      const end = (m.index ?? 0) + m[0].length
      const before = data.slice(Math.max(0, (m.index ?? 0) - PER_DAY_LOOKBACK), m.index ?? 0)
      if (OLD_PRICE_BEFORE.test(before.slice(-20)) || SAVINGS_BEFORE.test(before)) continue
      if (PER_DAY_AFTER.test(data.slice(end, end + 24)) || PER_DAY_BEFORE.test(before)) out.push(num(m[1]), num(m[2]))
    }
  }
  else if (Array.isArray(data)) for (const v of data) collectDailyRates(v, out, key, daily)
  else if (data && typeof data === 'object') for (const [k, v] of Object.entries(data as Record<string, unknown>)) collectDailyRates(v, out, k, daily)
  return out
}

/**
 * W1.8 P3c allow-list: the data-file prices, every price the engine's own rate chart prints (the airport's
 * data/chart-prices.json row), and a 2–30 day total of each structured DAILY rate ($5–$100) from either source.
 * Only daily rates are multiplied: multiplying prose figures ($1 toll, $2 fare) let nearly every whole-dollar
 * price through (review, 4 Nov). The 3 Nov RIC test refused 5 of 5 posts on correct 7-day totals and chart prices.
 * `onAirport`: the rate chart's posted on-airport rows (rate-chart.ts ON_AIRPORT_RATES). The chart caption prints
 * them as "$35/day", and the 7-day table as the row's week figure or lo×7 / hi×7, so without them the gate refused
 * the engine's own caption at JFK, LGA and BNA (review, 5 Nov). Exactly those figures are added, never multiplied.
 * `sourced`: every figure above as written, with no N-day totals: the list an old price ("rose from $19/day") must be in.
 */
export function priceAllowList(dataPrices: number[], dailyRates: number[], chartRow?: unknown, onAirport?: readonly { lo: number; hi: number; week?: number }[]): { all: number[]; perDay: number[]; sourced: number[] } {
  const sourced = new Set<number>()
  const add = (n: number) => { if (Number.isFinite(n) && n >= 0) sourced.add(Math.round(n * 100)) }
  dataPrices.forEach(add)
  const walk = (v: unknown, key = '') => {
    if (typeof v === 'number') { if (!/days|listed|count/i.test(key)) add(v) }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k)
  }
  walk(chartRow)
  const daily = [...dailyRates, ...collectDailyRates(chartRow)].filter((n) => Number.isFinite(n) && n >= 0)
  const onAirportDaily = (onAirport ?? []).flatMap((r) => [r.lo, r.hi]).filter((n) => Number.isFinite(n) && n >= 0)
  for (const r of onAirport ?? []) { add(r.week ?? r.lo * 7); add(r.week ?? r.hi * 7) }
  daily.forEach(add)
  onAirportDaily.forEach(add)
  // A figure written as per-day ("$X/day") must be one of the daily rates as written: never an N-day total, a fare or a fee.
  const perDay = [...new Set([...daily, ...onAirportDaily].map((n) => Math.round(n * 100)))].map((c) => c / 100)
  const cents = new Set(sourced)
  for (const n of daily) {
    if (n < 5 || n > 100) continue
    const c = Math.round(n * 100)
    for (let d = 2; d <= 30; d++) cents.add(c * d)
  }
  return { all: [...cents].map((c) => c / 100), perDay, sourced: [...sourced].map((c) => c / 100) }
}

/**
 * P3 price check (deny by default). `known` = the figures the writer prompt sees for this airport
 * (collectFigures(figureSource(data))) — NOT every number in the file. Inserted HTML is checked
 * paragraph by paragraph; a paragraph that links an EXTERNAL source is exempt. Field text (title,
 * meta, FAQ) has no exemption. A range "$12–18" checks both ends. Returns the figures that fail.
 * `perDayKnown` (optional): a figure written as per-day (PER_DAY_AFTER / PER_DAY_BEFORE) must be in it instead.
 * `sourcedKnown` (optional): a per-day figure worded as a past price must be in it (sourced as written, no N-day totals).
 */
export function priceCheck(insertedHtml: string, fieldText: string, known: ReadonlySet<number>, perDayKnown?: ReadonlySet<number>, sourcedKnown?: ReadonlySet<number>): string[] {
  const bad: string[] = []
  const check = (text: string) => {
    for (const m of text.matchAll(MONEY)) {
      const end = (m.index ?? 0) + m[0].length
      const before = text.slice(Math.max(0, (m.index ?? 0) - PER_DAY_LOOKBACK), m.index ?? 0)
      const isPerDay = PER_DAY_AFTER.test(text.slice(end, end + 24)) || PER_DAY_BEFORE.test(before)
      // A past price ("rose from $19/day") is no current daily rate, but it must still be a figure the data states.
      const set = !perDayKnown || !isPerDay ? known : OLD_PRICE_IN_POST.test(before) ? sourcedKnown ?? known : perDayKnown
      for (const raw of [m[1], m[2]]) {
        if (!raw) continue
        const cents = Math.round(Number(raw.replace(/,/g, '')) * 100)
        const label = `$${raw}`
        if (!set.has(cents) && !bad.includes(label)) bad.push(label)
      }
    }
  }
  // </blockquote> too: a quote's figure must not borrow the external link of the paragraph after it (review, Nov 2026).
  for (const chunk of insertedHtml.split(/<\/p>|<\/li>|<\/td>|<\/th>|<\/h[1-6]>|<\/blockquote>/i)) {
    if (EXTERNAL_SOURCE_LINK.test(chunk)) continue
    check(stripTags(chunk))
  }
  check(fieldText)
  return bad
}
