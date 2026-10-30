/**
 * lint.ts — W1.4 / W1.10: checks that FAIL a write to the CMS.
 *
 * Runs on the final HTML + title/meta right before createPost/updatePost. Any `error` finding stops
 * the write; `warn` findings are printed only. Pure function, no network — unit-tested in lint.test.ts.
 *
 * Checks (plan v3.2 §W1.4, §W1.10):
 *   - artifact phrases: "wait,", "let's be precise", "competitor article", "as an AI", …
 *   - money without a currency sign: "15/day", "costs 15 per day", "from 12 a day"
 *   - "verified" / "working" within a few words of a promo code or the word code/coupon
 *   - code strings (ALLCAPS+digits) not in src/config/approved-promo-codes.json
 *   - "save up to N %" / "up to N % off" with no source link in the same paragraph
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

const MONTHS = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/i

const BARE_MONEY: RegExp[] = [
  // "15/day", "15 per day", "15 a day", "15 daily" with no $, C$, CA$, US$ or % right before the number
  /(?<![$€£\d.,%A-Za-z-])\b(\d{1,3}(?:\.\d{2})?)\s?(?:\/|per\s|a\s|each\s)(?:day|night|hour|hr|week|wk|month)\b/i,
  // "costs 15" / "from 15" / "rate of 15" — followed by nothing that makes it a non-price (no % / years / minutes)
  /\b(?:costs?|priced?|rates? of|from|starting at|as low as|only)\s(\d{1,3}(?:\.\d{2})?)(?!\s?(?:%|percent|minutes?|mins?|hours?|hrs?|days?|miles?|km|feet|ft|spaces|spots|lots|terminals?|years?|am|pm|-|–|to\b|\d))\b(?!\s?(?:\/|per|a)\s?(?:day|night|hour))/i,
]

const PROMO_WORD = /\b(?:promo|coupon|discount)\s?codes?\b|\bcodes?\b/i
const VERIFIED_NEAR_CODE = /\b(?:verified|working|tested|confirmed|guaranteed)\b[^.<>]{0,60}\b(?:promo|coupon|discount)?\s?codes?\b|\b(?:promo|coupon|discount)?\s?codes?\b[^.<>]{0,60}\b(?:verified|working|tested|confirmed|guaranteed)\b/i
const CODE_STRING = /\b([A-Z][A-Z0-9]{3,}\d[A-Z0-9]*|[A-Z]{2,}\d{1,3}[A-Z]*|[A-Z]{5,})\b/g
const NOT_CODES = new Set(['AIRTRAIN', 'PRECHECK', 'COVID', 'SKYTRAIN', 'TRAIN', 'TERMINAL', 'ECONOMY', 'DAILY', 'HOURLY', 'GARAGE', 'SHUTTLE', 'PARKING', 'AIRPORT', 'NORTH', 'SOUTH', 'CENTRAL', 'EXPRESS', 'VALET', 'TRIPLY', 'CLEAR', 'GLOBAL', 'ENTRY', 'LYFT', 'UBER', 'METRO', 'MARTA', 'SEPTA', 'AMTRAK', 'UPDATED', 'VERIFIED', 'WORKING', 'TOTAL', 'PRICE', 'RATES', 'NOTE', 'FREE', 'CHEAP'])
const SAVE_UP_TO = /\b(?:save|savings of|discounts? of)?\s?up to\s?\d{1,2}\s?%(?:\s?off)?|\b\d{1,2}\s?%\s?off\b/i

export function loadApprovedCodes(file: string = APPROVED_CODES_PATH): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { codes?: { code: string }[] } | string[]
    if (Array.isArray(raw)) return raw.map(String)
    return (raw.codes || []).map((c) => String(c.code))
  } catch {
    return []
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

  // 3. "verified"/"working" next to a code
  if (PROMO_WORD.test(allText)) {
    const m = allText.match(VERIFIED_NEAR_CODE)
    if (m) errors.push({ level: 'error', rule: 'verified-code', message: `"${m[0].trim().slice(0, 60)}": never call a code verified/working`, snippet: context(allText, m.index || 0) })
  }

  // 4. Code strings not in the approved list — only where the text talks about codes at all
  if (PROMO_WORD.test(allText)) {
    const seen = new Set<string>()
    for (const m of allText.matchAll(CODE_STRING)) {
      const code = m[1].toUpperCase()
      if (seen.has(code) || approved.has(code) || NOT_CODES.has(code)) continue
      // Skip obvious non-codes: airport codes with digits don't exist; terminal labels, PNG sizes, model names
      if (/^(?:T\d|B\d|P\d{1,2}|LOT\d{1,2}|HWY\d+|I\d{2,3}|US\d{1,3}|SR\d{1,3}|A\d{1,2}|C\d{1,2}|D\d{1,2}|E\d{1,2}|F\d{1,2}|G\d{1,2}|H\d{1,2}|\d+X\d+|COVID19|SB\d{2,4}|HB\d{2,4})$/.test(code)) continue
      seen.add(code)
      errors.push({ level: 'error', rule: 'unapproved-code', message: `promo code "${code}" is not in config/approved-promo-codes.json`, snippet: context(allText, m.index || 0) })
    }
  }

  // 5. "save up to N %" needs a source link in the same paragraph
  for (const p of paragraphs(input.html)) {
    const text = stripTags(p)
    if (SAVE_UP_TO.test(text) && !/<a\s[^>]*href=/i.test(p)) {
      errors.push({ level: 'error', rule: 'unsourced-saving', message: `"${text.match(SAVE_UP_TO)![0]}" has no source link in its paragraph`, snippet: text.slice(0, 160) })
      break
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
    const hasAsOf = /\bas of\s+(?:[A-Z][a-z]+\.? )?(?:\d{1,2} )?(?:[A-Z][a-z]+ )?\d{4}\b|\bas of\s+[A-Z][a-z]+\b/.test(first) && MONTHS.test(first)
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
