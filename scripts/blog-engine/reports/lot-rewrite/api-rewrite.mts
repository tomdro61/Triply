// Lot-rewrite writer + adversarial fact-checker on the Anthropic API (Sonnet 5.5, Batch API = half price).
// Replaces the in-session subagents. Same inputs/outputs as before:
//   write: <a>/<slug>.blocks.json + factsheet + RULES.md + <a>/writer-brief.md  -> <a>/<slug>.edits.json
//   check: + <slug>.edits.json + <slug>.preview.html (run preview.mts first)    -> edits.json (fixed) + <slug>.factcheck.json
//          the writer's version is kept as <slug>.edits.writer.json
//   npx tsx reports/lot-rewrite/api-rewrite.mts clt write [--batch batch1] [--sync] [--only slug]
//   npx tsx reports/lot-rewrite/api-rewrite.mts clt check [--batch batch1] [--sync] [--only slug]
// Costs append to reports/lot-rewrite/api-cost-ledger.jsonl.
import 'dotenv/config'
import fs from 'fs'
import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-sonnet-5-5'
// USD per 1M tokens (standard). Batch = 50% of every line.
const PRICE = { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 }

const args = process.argv.slice(2)
const A = args[0], STAGE = args[1]
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : null)
const BATCH = opt('--batch') || 'batch1', ONLY = opt('--only'), SYNC = args.includes('--sync')
if (!/^[a-z]{3}$/.test(A || '') || !['write', 'check'].includes(STAGE)) { console.error('usage: api-rewrite.mts <a> write|check [--batch b] [--sync] [--only slug]'); process.exit(1) }
const R = 'reports/lot-rewrite', D = `${R}/${A}`
const read = (p: string) => fs.readFileSync(p, 'utf8')
for (const f of [`${D}/factsheet.json`, `${D}/writer-brief.md`, ...(STAGE === 'check' ? [`${D}/factcheck-brief.md`] : [])])
  if (!fs.existsSync(f)) { console.error(`missing ${f}`); process.exit(1) }

const slugs: string[] = (ONLY ? [ONLY] : JSON.parse(read(`${D}/${BATCH}.json`)).map((p: any) => p.slug)).filter((s: string) =>
  STAGE === 'write' ? !fs.existsSync(`${D}/${s}.edits.json`) : fs.existsSync(`${D}/${s}.edits.json`) && fs.existsSync(`${D}/${s}.preview.html`) && !fs.existsSync(`${D}/${s}.factcheck.json`))
// Don't pay to check a post the writer left untouched: record it as clean with a note.
if (STAGE === 'check') for (const s of [...slugs]) {
  const e = JSON.parse(read(`${D}/${s}.edits.json`))
  if (!(e.edits || []).length && !(e.deletes || []).length && !e.seo?.metaTitle && !e.seo?.metaDescription && !e.title && !e.excerpt && !e.faqItems) {
    fs.writeFileSync(`${D}/${s}.factcheck.json`, JSON.stringify({ slug: s, verdict: 'clean', fixes: [], open: ['writer made no edits; not sent to the checker'] }, null, 1))
    slugs.splice(slugs.indexOf(s), 1)
  }
}
if (!slugs.length) { console.log('nothing to do'); process.exit(0) }

const HOW = `You are working through the API, not in a file system: ignore any instruction in the briefs about reading, writing or editing files, tools, Python or replying with a summary. Everything you need is in this prompt. Reply with ONE JSON object and nothing else (no prose, no code fence).`
const example = fs.existsSync(`${R}/mco/orlando-airport-parking-options.edits.json`) ? read(`${R}/mco/orlando-airport-parking-options.edits.json`) : ''
const system = [
  { type: 'text', text: `${HOW}\n\n# RULES.md\n${read(`${R}/RULES.md`)}\n\n# Writer brief (${A.toUpperCase()})\n${read(`${D}/writer-brief.md`)}` },
  ...(STAGE === 'check' ? [{ type: 'text', text: `# Adversarial fact-check brief (${A.toUpperCase()})\n${read(`${D}/factcheck-brief.md`)}` }] : []),
  { type: 'text', text: `# factsheet.json (the ONLY source of truth about lots and rates)\n${read(`${D}/factsheet.json`)}${example ? `\n\n# Example edits.json from an earlier airport (shape and tone only; its facts do not apply here)\n${example}` : ''}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
]

// SCOPE=small (Vin, 16 Oct 2026): post already names our lots; fix only old prices and rival booking sites.
const SMALL = process.env.SCOPE === 'small' ? `\n\nSMALL-FIX PASS (Vin, 16 Oct 2026; overrides RULES.md rule 2 and any brief wording that says to remove every mention of a not-sellable lot): this article already names our sellable lots. Change ONLY (a) prices that are not factsheet figures (rules 4, 5, 10, 13), (b) rival booking sites (rule 16), (c) anything rule 9 forces as a consequence. Not-sellable lots MAY stay named as context, but never as bookable on Triply and never with a price that is not in the factsheet (drop their old price). Edit only the blocks that need it; leave every other block, the title and FAQ untouched unless they contain (a) or (b). If nothing needs fixing, return no edits.` : ''

function userFor(slug: string): string {
  const blocks = read(`${D}/${slug}.blocks.json`)
  if (STAGE === 'write') return `Rewrite this article per the rules and brief.${SMALL} Output the edits.json object for slug "${slug}" exactly as RULES.md "Output" describes.\n\n# ${slug}.blocks.json\n${blocks}`
  const nw = fs.existsSync(`${D}/${slug}.new.json`) ? JSON.parse(read(`${D}/${slug}.new.json`)) : {}
  return `Fact-check the rewrite of "${slug}". Inputs: the original blocks (block numbers i are always these), the writer's edits.json, and the rendered post after edits.\n\n# ${slug}.blocks.json (original)\n${blocks}\n\n# ${slug}.edits.json (writer)\n${read(`${D}/${slug}.edits.json`)}\n\n# ${slug}.preview.html (post after edits: title, meta title | meta description, body, FAQ)\n${read(`${D}/${slug}.preview.html`)}\n\n# excerpt after edits\n${JSON.stringify(nw.excerpt ?? null)}\n\nOutput one JSON object with ONLY your changes (do not repeat writer edits you keep; that wastes tokens): {"slug": "${slug}", "verdict": "clean"|"fixed", "fixes": [{"i": <block or -1>, "problem": "...", "fix": "..."}], "open": ["..."], "patch": {"edits": [{"i": <original block number>, "html": "<full corrected html for that block>", "why": "..."}], "dropEdits": [<block numbers whose writer edit should be removed, restoring the original>], "deletes": <full corrected deletes array, or null if unchanged>, "seo": <{metaTitle, metaDescription} or null if unchanged>, "title": <string or null>, "excerpt": <string or null>, "faqItems": <full corrected array or null if unchanged>}}. A patch edit replaces the writer's edit for that block (or adds one). Keep "open" to at most 4 short items.${SMALL}`
}

const params = (slug: string) => ({ model: MODEL, max_tokens: 32000, output_config: { effort: process.env.EFFORT || 'high' }, system, messages: [{ role: 'user', content: userFor(slug) }] }) as any

// First balanced top-level {...} in the reply (string-aware), so trailing prose or a second object is ignored.
function parseJson(text: string): any {
  const s = text.indexOf('{')
  if (s < 0) throw new Error('no JSON object in reply')
  let depth = 0, inStr = false, escp = false
  for (let k = s; k < text.length; k++) {
    const c = text[k]
    if (inStr) { if (escp) escp = false; else if (c === '\\') escp = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(s, k + 1))
  }
  throw new Error('unterminated JSON object in reply')
}
function save(slug: string, msg: any): string {
  const text = (msg.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
  if (msg.stop_reason !== 'end_turn') { fs.writeFileSync(`${D}/${slug}.${STAGE}.raw.txt`, text); return `FAIL stop_reason=${msg.stop_reason}` }
  let j: any
  try { j = parseJson(text) } catch (e) { fs.writeFileSync(`${D}/${slug}.${STAGE}.raw.txt`, text); return `FAIL ${(e as Error).message}` }
  if (STAGE === 'write') {
    if (!Array.isArray(j.edits)) { fs.writeFileSync(`${D}/${slug}.write.raw.txt`, text); return 'FAIL no edits array' }
    j.slug = slug; fs.writeFileSync(`${D}/${slug}.edits.json`, JSON.stringify(j, null, 1))
    return `${j.edits.length} edits, ${(j.deletes || []).length} deletes${j.seo?.metaTitle || j.seo?.metaDescription ? ', seo' : ''}${j.faqItems ? ', faq' : ''}${j.title ? ', title' : ''}`
  }
  // Patch mode: the checker returns only its changes; merge them onto the writer's edits.
  const p = j.patch
  if (!p || typeof p !== 'object') { fs.writeFileSync(`${D}/${slug}.check.raw.txt`, text); return 'FAIL no patch' }
  const w = JSON.parse(read(`${D}/${slug}.edits.json`))
  fs.copyFileSync(`${D}/${slug}.edits.json`, `${D}/${slug}.edits.writer.json`)
  const byI = new Map<number, any>((w.edits || []).map((e: any) => [e.i, e]))
  for (const i of p.dropEdits || []) byI.delete(i)
  for (const e of p.edits || []) if (Number.isInteger(e?.i) && typeof e.html === 'string') byI.set(e.i, e)
  w.edits = [...byI.values()].sort((a: any, b: any) => a.i - b.i)
  if (Array.isArray(p.deletes)) w.deletes = p.deletes
  if (p.seo) w.seo = { ...(w.seo || {}), ...p.seo }
  for (const k of ['title', 'excerpt', 'faqItems']) if (p[k] != null) w[k] = p[k]
  w.slug = slug; fs.writeFileSync(`${D}/${slug}.edits.json`, JSON.stringify(w, null, 1))
  const { patch, ...fc } = j; fs.writeFileSync(`${D}/${slug}.factcheck.json`, JSON.stringify(fc, null, 1))
  return `${fc.verdict}, ${(fc.fixes || []).length} fixes${(fc.open || []).length ? `, ${fc.open.length} open` : ''}`
}

const tot = { input: 0, output: 0, cw5: 0, cw1h: 0, cr: 0 }
function add(u: any) {
  tot.input += u.input_tokens || 0; tot.output += u.output_tokens || 0; tot.cr += u.cache_read_input_tokens || 0
  tot.cw5 += u.cache_creation?.ephemeral_5m_input_tokens || 0; tot.cw1h += u.cache_creation?.ephemeral_1h_input_tokens || (u.cache_creation ? 0 : u.cache_creation_input_tokens || 0)
}
const usd = (k: number) => k * (tot.input * PRICE.input + tot.output * PRICE.output + tot.cw5 * PRICE.cacheWrite5m + tot.cw1h * PRICE.cacheWrite1h + tot.cr * PRICE.cacheRead) / 1e6

const client = new Anthropic({ maxRetries: 4, timeout: 15 * 60 * 1000 })
const results: any[] = []
const t0 = Date.now()
if (SYNC) {
  // One at a time, full price. For a single slug or a quick retry.
  for (const slug of slugs) {
    const msg = await client.messages.create(params(slug))
    add(msg.usage); results.push({ slug, result: save(slug, msg) }); console.log(slug, results.at(-1).result)
  }
} else {
  const batch = await client.messages.batches.create({ requests: slugs.map(s => ({ custom_id: s.slice(0, 64), params: params(s) })) } as any)
  console.log(`batch ${batch.id}: ${slugs.length} ${STAGE} requests`)
  fs.appendFileSync(`${R}/api-batches.log`, `${new Date().toISOString()} ${A} ${STAGE} ${batch.id} ${slugs.length}\n`)
  let b: any = batch
  while (b.processing_status !== 'ended') {
    await new Promise(r => setTimeout(r, 30000))
    b = await client.messages.batches.retrieve(batch.id)
    console.log(`  ${new Date().toLocaleTimeString()} ${JSON.stringify(b.request_counts)}`)
  }
  const byId = new Map(slugs.map(s => [s.slice(0, 64), s]))
  for await (const r of await client.messages.batches.results(batch.id) as any) {
    const slug = byId.get(r.custom_id)!
    if (r.result.type !== 'succeeded') { results.push({ slug, result: `FAIL ${r.result.type} ${JSON.stringify(r.result.error || '').slice(0, 200)}` }); continue }
    add(r.result.message.usage); results.push({ slug, result: save(slug, r.result.message) })
  }
}
console.table(results)
const cost = usd(SYNC ? 1 : 0.5)
console.log(`tokens: in ${tot.input}, out ${tot.output}, cache write ${tot.cw5 + tot.cw1h}, cache read ${tot.cr} | cost $${cost.toFixed(2)} (${SYNC ? 'standard' : 'batch 50%'}) | ${Math.round((Date.now() - t0) / 60000)} min`)
fs.appendFileSync(`${R}/api-cost-ledger.jsonl`, JSON.stringify({ at: new Date().toISOString(), airport: A, stage: STAGE, model: MODEL, mode: SYNC ? 'sync' : 'batch', requests: slugs.length, failed: results.filter(r => r.result.startsWith('FAIL')).length, tokens: tot, usd: Number(cost.toFixed(4)) }) + '\n')
