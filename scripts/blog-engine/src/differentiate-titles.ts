/**
 * differentiate-titles.ts — task 73 (stop our own pages competing with each other)
 *
 * The cannibalization plan (`reports/cannibalization-plan-2026-09-15.md/.json`) sorts
 * every weaker page in a cannibalized group into MERGE / DIFFERENTIATE / LEAVE /
 * HUB-DEMOTE. MERGE is a 301 in the Next.js site (not ours). DIFFERENTIATE is ours:
 * the weaker page earns its keep, it is just wearing the primary page's clothes. We
 * retitle it — title + seo.metaTitle + seo.metaDescription — onto the DIFFERENT
 * intent the plan identified, so the two pages stop bidding for the same query.
 *
 * PRICE-FREE BY CONTRACT. Most airport rate JSONs are ~5 months stale, and a title
 * rewrite bakes an on-page price into the SERP title where it then rots in public.
 * Every generated field is rejected if it contains `$`, a decimal price, or any other
 * money token, and the model is retried once before the row is skipped. This is a
 * hard gate, not a preference — see the caution in the plan markdown.
 *
 * Like ctr-rescue.ts this records each edit into the article's perf record via
 * loadRecord/saveRecord as a `title-meta` change with `preEdit`, so `perf revert` can
 * undo it, `perf measure` can judge it, and the maintain cooldown can see it.
 *
 * Input: JSON array of rows from the plan —
 *   { slug, primary, query: string[] | string, angle, ... }
 * Extra fields (airport, primaryTitle, primaryMetaTitle, primaryKeyword, why,
 * keyword, articleType, impressions, clicks, position) are used when present.
 *
 * Usage:
 *   npx tsx src/differentiate-titles.ts --dry-run --out reports/x.json
 *   npx tsx src/differentiate-titles.ts --input reports/differentiate-input-2026-09-15.json --dry-run
 *   npx tsx src/differentiate-titles.ts --apply                      # regenerates, then writes
 *   npx tsx src/differentiate-titles.ts --apply --from reports/x.json # writes the reviewed text
 *
 * `--from` matters: generation is non-deterministic, so a plain `--apply` after a
 * dry-run writes DIFFERENT copy from the copy you just eyeballed. Review the
 * `--out` file, hand-fix any row in it, then `--apply --from` that file so what
 * ships is exactly what was approved. The price gate re-runs on every `--from` row.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { env, PERF_MODEL } from './config.js'
import { loadRecord, saveRecord } from './perf-snapshot.js'
import { pingIndexNow, postUrlFor } from './indexnow.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CMS_URL = env.PAYLOAD_CMS_URL
const API_KEY = env.PAYLOAD_API_KEY
const headers = { 'Content-Type': 'application/json', Authorization: `users API-Key ${API_KEY}` }
const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
const MODEL = PERF_MODEL // cheap; title/meta is a simple task

const args = process.argv.slice(2)
const flag = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? '') : d }
const APPLY = args.includes('--apply')
const INPUT = flag('--input', 'reports/differentiate-input-2026-09-15.json')!
const LIMIT = parseInt(flag('--limit', '0') || '0', 10) // 0 = all
const OUT = flag('--out', '')
const FROM = flag('--from', '')
const ONLY = (flag('--only', '') || '').split(',').map(s => s.trim()).filter(Boolean)

interface Row {
  slug: string
  primary: string
  query: string[] | string
  angle: string | null
  airport?: string
  primaryTitle?: string
  primaryMetaTitle?: string
  primaryKeyword?: string
  why?: string
  keyword?: string
  articleType?: string
  impressions?: number
  clicks?: number
  position?: number
  stolenFromLead?: number
}

const RewriteSchema = z.object({
  title: z.string().min(1),
  metaTitle: z.string().min(1),
  metaDescription: z.string().min(1),
})
type Rewrite = z.infer<typeof RewriteSchema>

// ── Price gate ───────────────────────────────────────────────────────────────
// Rates in the airport JSONs are months old; a price promoted into a <title> is
// wrong in public for as long as the title stands. Nothing money-shaped ships.
const PRICE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\$/, label: 'dollar sign' },
  { re: /\d+\s*\.\s*\d+/, label: 'decimal price' },
  { re: /\bUSD\b/i, label: 'USD' },
  { re: /\d+\s*(dollars?|bucks|cents?)\b/i, label: 'money word' },
  { re: /\b(from|just|only|under|as low as)\s+\d+\s*\/?\s*(a\s+)?(day|night|week|hr|hour)\b/i, label: 'price-per-unit' },
  { re: /\b\d+\s*\/\s*(day|night|week|hr|hour)\b/i, label: 'rate per unit' },
]

function priceViolations(r: Rewrite): string[] {
  const out: string[] = []
  for (const [field, value] of Object.entries(r) as Array<[string, string]>) {
    for (const p of PRICE_PATTERNS) if (p.re.test(value)) out.push(`${field} contains a ${p.label}`)
  }
  return out
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The whole point: the weaker page's metaTitle must stop saying the primary's phrase. */
function chasesPrimary(r: Rewrite, primaryKeyword?: string): string[] {
  if (!primaryKeyword) return []
  const kw = normalize(primaryKeyword)
  if (!kw) return []
  return normalize(r.metaTitle).includes(kw)
    ? [`metaTitle still contains the primary page's keyword "${primaryKeyword}"`]
    : []
}

function lengthWarnings(r: Rewrite): string[] {
  const out: string[] = []
  if (r.title.length < 50 || r.title.length > 65) out.push(`title is ${r.title.length} chars (want 50-65)`)
  if (r.metaTitle.length > 60) out.push(`metaTitle is ${r.metaTitle.length} chars (want 60 or fewer)`)
  if (r.metaDescription.length < 120 || r.metaDescription.length > 160) out.push(`metaDescription is ${r.metaDescription.length} chars (want 120-160)`)
  return out
}

function queriesOf(row: Row): string[] {
  if (Array.isArray(row.query)) return row.query.filter(Boolean)
  return row.query ? [row.query] : []
}

async function getPost(slug: string): Promise<any | null> {
  const r = await fetch(`${CMS_URL}/api/posts?where[slug][equals]=${encodeURIComponent(slug)}&depth=0`, { headers })
  if (!r.ok) return null
  const j = await r.json()
  return (j.docs || [])[0] || null
}

function buildPrompt(row: Row, post: any, retryNotes: string[]): string {
  const qs = queriesOf(row)
  const keyword = row.keyword || post.keyword || ''
  const airport = row.airport || post.airportCode || ''
  const retryBlock = retryNotes.length
    ? `\nYOUR PREVIOUS ATTEMPT WAS REJECTED:\n${retryNotes.map(n => `  - ${n}`).join('\n')}\nFix every point above.\n`
    : ''
  return `You are an SEO editor fixing KEYWORD CANNIBALIZATION on an airport-parking blog. Two of OUR OWN pages compete for the same Google queries. The page below is the WEAKER one. It is not being deleted - it is being re-pointed at a DIFFERENT search intent so it stops bidding against our stronger page.

THE WEAKER PAGE (the one you are rewriting)
  slug: ${row.slug}
  current title: "${post.title || ''}"
  current metaTitle: "${post.seo?.metaTitle || ''}"
  current metaDescription: "${post.seo?.metaDescription || ''}"
  focus keyword: "${keyword}"
  article type: ${row.articleType || post.articleType || 'spoke'}
  airport: ${airport}

THE PRIMARY PAGE (the one that must keep these queries - do NOT write for it)
  slug: ${row.primary}
  title: "${row.primaryTitle || ''}"
  metaTitle: "${row.primaryMetaTitle || ''}"
  its keyword: "${row.primaryKeyword || ''}"

SHARED QUERIES THEY BOTH RANK FOR (the collision to walk away from):
${qs.length ? qs.map(q => `  - ${q}`).join('\n') : '  (none captured)'}

WHY THIS PAGE IS THE WEAKER ONE: ${row.why || 'it duplicates the primary page intent'}

THE NEW ANGLE THIS PAGE MUST OWN: ${row.angle || 'a distinct, narrower facet of the topic'}

Write a new title, metaTitle and metaDescription that own THE NEW ANGLE and read as a clearly different page from the primary.

HARD RULES - output is rejected and regenerated if any is broken:
1. NO PRICES OF ANY KIND. No "$", no decimal numbers, no "from 8 a day", no "USD", no dollars/cents, no per-day or per-week rate figures. Our stored rates are months old and a price in a search title rots in public. Describe value in words ("cheaper than the garage", "discounted", "member rate") - never a figure.
2. The metaTitle must NOT contain the primary page's keyword phrase "${row.primaryKeyword || ''}" and must not read as an answer to the shared queries above.
3. Lead with the new angle, not the generic topic. Someone scanning the SERP must be able to tell these two pages apart at a glance.
4. Mention the airport (code "${airport}" or its name) in the title and in the metaTitle.
5. Lengths: title 50-65 characters. metaTitle 60 characters or fewer. metaDescription 120-160 characters.
6. Specific and factual. No clickbait, no invented facts, no superlatives you cannot support. A year is fine; a price is not.
${retryBlock}
Respond with ONLY JSON: {"title":"...","metaTitle":"...","metaDescription":"..."}`
}

async function askModel(prompt: string): Promise<Rewrite | null> {
  try {
    const res = await client.messages.create({ model: MODEL, max_tokens: 700, messages: [{ role: 'user', content: prompt }] })
    const block = res.content.find((b) => b.type === 'text')
    const text = block && block.type === 'text' ? block.text : ''
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    const parsed = RewriteSchema.safeParse(JSON.parse(m[0]))
    if (!parsed.success) { console.error('   ⚠ response missing required fields'); return null }
    return parsed.data
  } catch (e) { console.error('   ⚠ rewrite failed:', (e as Error).message); return null }
}

/**
 * Generate, validate, retry once. Price violations and "still chasing the primary"
 * are BLOCKING (a second failure skips the row). Length misses are advisory: they
 * trigger the one retry, but a second near-miss still ships rather than losing a
 * good differentiated title over three characters.
 */
async function rewrite(row: Row, post: any): Promise<{ out: Rewrite; warnings: string[] } | null> {
  let notes: string[] = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await askModel(buildPrompt(row, post, notes))
    if (!out) { notes = ['Your previous response was not valid JSON with the three required fields.']; continue }
    const blocking = [...priceViolations(out), ...chasesPrimary(out, row.primaryKeyword)]
    const soft = lengthWarnings(out)
    if (!blocking.length && !soft.length) return { out, warnings: [] }
    if (attempt === 0) { notes = [...blocking, ...soft]; continue }
    if (blocking.length) { console.error(`   ✗ rejected after retry: ${blocking.join('; ')}`); return null }
    return { out, warnings: soft }
  }
  return null
}

/**
 * Log the retitle into the article's perf record, exactly as perf-apply and
 * ctr-rescue do. Without it the edit is invisible to the improvement loop:
 * `maintain` sees no cooldown and can re-treat the page immediately, `perf measure`
 * never judges whether de-cannibalizing worked, and `perf revert` has no pre-edit
 * state to restore.
 */
function recordChange(
  slug: string,
  preEdit: Record<string, unknown>,
  reason: string,
  baseline: { clicks: number; impressions: number; position: number },
): boolean {
  const record = loadRecord(slug)
  if (!record) return false // snapshot-less article — nothing to attach the change to
  record.changes.push({
    at: new Date().toISOString(),
    type: 'title-meta',
    summary: `differentiate: ${reason}`,
    baselineMetrics: baseline,
    preEdit,
  })
  saveRecord(record)
  return true
}

async function patchPost(id: string, r: Rewrite, slug?: string): Promise<boolean> {
  const res = await fetch(`${CMS_URL}/api/posts/${id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ title: r.title, seo: { metaTitle: r.metaTitle, metaDescription: r.metaDescription } }),
  })
  if (!res.ok) console.error(`   ✗ PATCH ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  else if (slug) await pingIndexNow([postUrlFor(slug)])
  return res.ok
}

async function main() {
  const inputPath = path.isAbsolute(INPUT) ? INPUT : path.resolve(ROOT, INPUT)
  if (!fs.existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`)
  let rows: Row[]
  try { rows = JSON.parse(fs.readFileSync(inputPath, 'utf8')) }
  catch (e) { throw new Error(`${path.basename(inputPath)} is not valid JSON (${(e as Error).message})`) }
  if (!Array.isArray(rows)) throw new Error('Input must be a JSON array of {slug, primary, query, angle} rows')
  if (ONLY.length) rows = rows.filter(r => ONLY.includes(r.slug))
  if (LIMIT > 0) rows = rows.slice(0, LIMIT)

  // --from: use already-reviewed copy instead of generating fresh (see header note).
  const approved = new Map<string, Rewrite>()
  if (FROM) {
    const fromPath = path.isAbsolute(FROM) ? FROM : path.resolve(ROOT, FROM)
    if (!fs.existsSync(fromPath)) throw new Error(`--from file not found: ${fromPath}`)
    const prior = JSON.parse(fs.readFileSync(fromPath, 'utf8'))
    if (!Array.isArray(prior)) throw new Error('--from file must be a JSON array of {slug, new:{...}} rows')
    for (const p of prior) {
      const parsed = RewriteSchema.safeParse(p?.new ?? p)
      if (parsed.success && p?.slug) approved.set(p.slug, parsed.data)
    }
    console.log(`   --from ${path.basename(fromPath)}: ${approved.size} reviewed rewrite(s) loaded`)
  }

  console.log(`\n🔀 Differentiate titles — ${rows.length} page(s) from ${path.basename(inputPath)}${APPLY ? '  [APPLY]' : '  [dry-run]'}`)
  console.log(`   model ${MODEL} · prices are a hard reject · body content is never touched\n`)

  let applied = 0, skipped = 0, unrecorded = 0
  const results: any[] = []
  for (const row of rows) {
    const post = await getPost(row.slug)
    if (!post) { console.log(`⊘ ${row.slug} — not found in CMS`); skipped++; continue }
    const stolen = row.stolenFromLead !== undefined ? `, ${row.stolenFromLead} stolen impr` : ''
    console.log(`\n📄 ${row.slug}  (vs ${row.primary}${stolen})`)
    console.log(`   angle: ${row.angle || '(none given)'}`)
    console.log(`   OLD title: ${post.title}`)
    console.log(`   OLD metaTitle: ${post.seo?.metaTitle || '(none)'}`)
    console.log(`   OLD meta:  ${post.seo?.metaDescription || '(none)'}`)
    const pre = approved.get(row.slug)
    let r: { out: Rewrite; warnings: string[] } | null
    if (pre) {
      // Reviewed copy still has to clear the price gate — a hand-edit can reintroduce one.
      const blocking = [...priceViolations(pre), ...chasesPrimary(pre, row.primaryKeyword)]
      if (blocking.length) { console.log(`   ✗ reviewed copy rejected: ${blocking.join('; ')}`); skipped++; continue }
      r = { out: pre, warnings: lengthWarnings(pre) }
      console.log('   (using reviewed copy from --from)')
    } else if (FROM) {
      console.log('   ⚠ skipped (no reviewed copy in --from for this slug)'); skipped++; continue
    } else {
      r = await rewrite(row, post)
    }
    if (!r) { console.log('   ⚠ skipped (no valid rewrite)'); skipped++; continue }
    const { out, warnings } = r
    console.log(`   NEW title: ${out.title} (${out.title.length})`)
    console.log(`   NEW metaTitle: ${out.metaTitle} (${out.metaTitle.length})`)
    console.log(`   NEW meta:  ${out.metaDescription} (${out.metaDescription.length})`)
    if (warnings.length) console.log(`   ⚠ ${warnings.join('; ')}`)
    results.push({
      slug: row.slug, primary: row.primary, angle: row.angle,
      old: { title: post.title, metaTitle: post.seo?.metaTitle || '', metaDescription: post.seo?.metaDescription || '' },
      new: out, warnings,
    })
    if (APPLY) {
      // Capture pre-edit state BEFORE the PATCH so the change is revertible.
      const preEdit = { title: post.title, seo: post.seo ? JSON.parse(JSON.stringify(post.seo)) : {} }
      const ok = await patchPost(post.id, out, post.slug)
      console.log(ok ? '   ✓ applied' : '   ✗ PATCH failed')
      if (ok) {
        applied++
        const reason = `${row.angle || 'distinct intent'} (was competing with ${row.primary})`
        if (!recordChange(row.slug, preEdit, reason, { clicks: row.clicks || 0, impressions: row.impressions || 0, position: row.position || 0 })) {
          unrecorded++
          console.log('   ⚠ no perf record for this slug — change applied but NOT revertible via `perf revert`')
        }
      } else skipped++
    }
  }
  if (OUT) {
    const outPath = path.isAbsolute(OUT) ? OUT : path.resolve(ROOT, OUT)
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2))
    console.log(`\n📝 wrote ${outPath}`)
  }
  const tail = APPLY
    ? `Done. Applied ${applied}/${rows.length}, skipped ${skipped}${unrecorded ? `, ${unrecorded} without a perf record` : ''}.`
    : '[dry-run] Re-run with --apply to write these. Body content is never touched.'
  console.log(`\n${tail}`)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
