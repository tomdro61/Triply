// Fix title / metaTitle / metaDescription / excerpt fields that quote a not-sellable lot's price.
// Three kinds of field, from stale-price-scan-2026-10-06.json:
//   swap    — price only, no lot named: "$7.95/day" → the airport's cheapest live rate, rounded UP to the dollar
//   pct     — same swap, plus an "up to N%" savings claim re-checked against the airport's garage rate
//   named   — the unsellable lot is named next to its price: one Sonnet call rewrites just that field
// Anything the rules can't settle goes to `manual` and is left alone.
//   npx tsx reports/lot-rewrite/stale-swap.mts              → plan (reads live CMS, calls Sonnet for `named`), writes stale-swap-plan.json
//   npx tsx reports/lot-rewrite/stale-swap.mts --apply      → applies the plan: refuses posts changed since planning, backs up, PATCHes, verifies
import fs from 'fs'
import Anthropic from '@anthropic-ai/sdk'
import { env } from '../../src/config.js'
import { updatePost } from '../../src/payload.js'
import { loadRecord, saveRecord } from '../../src/perf-snapshot.js'
import { submitUrls, postUrlFor } from '../../src/indexnow.js'

const DIR = 'reports/lot-rewrite'
const PLAN = `${DIR}/stale-swap-plan.json`
const APPLY = process.argv.includes('--apply'), RISKY = process.argv.includes('--risky')
const H = { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` }
const cms = async (p: string) => { const r = await fetch(`${env.PAYLOAD_CMS_URL}/api${p}`, { headers: H }); if (!r.ok) throw new Error(`GET ${p} ${r.status}`); return r.json() }
const LIMIT: Record<string, number> = { title: 100, metaTitle: 60, metaDescription: 160, excerpt: 300 }
const esc = (s: string) => s.replace(/[$.]/g, '\\$&')
const GENERIC = new Set(['park', 'parking', 'airport', 'lot', 'lots', 'inn', 'hotel', 'the', 'and', 'suites', 'express', 'international', 'off', 'site', 'self', 'valet', 'economy', 'long', 'term', 'premium', 'covered', 'outdoor', 'garage'])

const fieldsOf = (d: any): Record<string, string> => ({ title: d.title || '', metaTitle: d.seo?.metaTitle || '', metaDescription: d.seo?.metaDescription || '', excerpt: d.excerpt || '' })

async function plan() {
  const scan = JSON.parse(fs.readFileSync(`${DIR}/stale-price-scan-2026-10-06.json`, 'utf8'))
  const cheapest: Record<string, number | null> = JSON.parse(fs.readFileSync(`${DIR}/cheapest-live-2026-10-06.json`, 'utf8'))
  const live = JSON.parse(fs.readFileSync(`${DIR}/live-lots-2026-10-06.json`, 'utf8')).airports
  const garage: Record<string, number> = {}
  for (const g of JSON.parse(fs.readFileSync('reports/airport-price-claim.json', 'utf8'))) if (g.garage) garage[g.code] = g.garage
  for (const g of JSON.parse(fs.readFileSync('reports/garage-rate-reverify-2026-09-15.json', 'utf8'))) if (g.live_garage_rate) garage[g.code] = g.live_garage_rate
  const ai = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  let inTok = 0, outTok = 0

  const out: any[] = []
  const rows = scan.rows.filter((r: any) => r.inTitleOrMeta)
  for (const [n, r] of rows.entries()) {
    const A = r.airport
    const q = new URLSearchParams({ 'where[slug][equals]': r.slug, 'where[status][equals]': 'published', limit: '1', depth: '0',
      'select[title]': 'true', 'select[seo]': 'true', 'select[excerpt]': 'true', 'select[slug]': 'true', 'select[updatedAt]': 'true' })
    const d = (await cms(`/posts?${q}`)).docs?.[0]
    if (!d) continue
    const stale: [string, string][] = r.prices.split('; ').map((p: string) => [p.split(' (')[0], p.slice(p.indexOf(' (') + 2, -1)])
    const sellNames: string[] = (live[A]?.lots || []).map((l: any) => l.name.toLowerCase())
    const c = cheapest[A]
    const newP = c == null ? null : Math.ceil(c)
    const post: any = { id: d.id, slug: d.slug, airport: A, updatedAt: d.updatedAt, fields: {} }

    for (const [f, v] of Object.entries(fieldsOf(d))) {
      const here = stale.filter(([p]) => new RegExp(esc(p) + '(?!\\d)').test(v))
      if (!here.length) continue
      const res: any = { old: v }
      post.fields[f] = res
      if (newP == null) { res.kind = 'manual'; res.why = 'airport has no sellable lot'; continue }
      // Named = a distinctive word of the stale lot's name (one no sellable lot at this airport shares) appears in the field.
      const named = here.filter(([, name]) => name.toLowerCase().split(/[^a-z']+/).filter(w => w.length >= 4 && !GENERIC.has(w) && !sellNames.some(s => s.includes(w)))
        .some(w => new RegExp(`\\b${w}\\b`, 'i').test(v)))
      if (named.length) {
        res.kind = 'named'
        const lots = (live[A]?.lots || []).map((l: any) => `- ${l.name}: about $${Math.ceil(l.price)}/day`).join('\n')
        const prompt = `You are fixing one SEO field on a Triply airport-parking blog post. Triply can only sell the lots listed under "Lots Triply sells". The field names a lot Triply cannot sell, together with a price, and that price is stale.

Post slug: ${d.slug}
Post title: ${d.title}
Field: ${f} (hard limit ${LIMIT[f]} characters)
Current text: ${v}
Lot(s) Triply cannot sell, named in the text: ${named.map(([p, name]) => `${name} (stale price ${p})`).join('; ')}
Lots Triply sells at ${A}:
${lots}
Cheapest rate Triply sells at ${A}: about $${newP}/day

Rules:
1. Remove every stale price listed above. Never attach a price to a lot Triply cannot sell.
2. If the post is specifically about the unsellable lot (its slug or title is about that lot), keep the lot's name as the subject but drop its price; you may point readers to "lots you can book on Triply from $${newP}/day".
3. Otherwise, replace the unsellable lot with Triply's own offer: either the cheapest rate ("from $${newP}/day") or a named lot from the list with its listed rate.
4. Change as little as possible. Keep every other claim, word and the tone. Invent nothing: no new amenities, shuttle claims, ratings or percentages.
5. Do not add em dashes. Stay within ${LIMIT[f]} characters.

Reply with ONLY the new text, nothing else.`
        const msg = await ai.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
        inTok += msg.usage.input_tokens; outTok += msg.usage.output_tokens
        res.proposed = (msg.content[0] as any).text.trim().replace(/^"|"$/g, '')
      } else {
        let nv = v
        for (const [p] of here) {
          const simple = new RegExp(`(from |starting at |starts at |as low as |just |only |under )?${esc(p)}(?=\\s*(/|per |a )?\\s*(day|daily|night)\\b|\\s*/\\s*day)`, 'gi')
          nv = nv.replace(simple, (_m, pre) => `${pre || ''}$${newP}`)
        }
        if (here.some(([p]) => new RegExp(esc(p) + '(?!\\d)').test(nv))) { res.kind = 'manual'; res.why = 'price not in a simple per-day form'; continue }
        res.kind = 'swap'
        // "up to N%" / "N% less|cheaper|off" / "save N%" — only "up to" claims are checked against the garage; others go manual.
        const pcts = [...nv.matchAll(/(\d{1,3})\s*%/g)]
        if (pcts.length) {
          res.kind = 'pct'
          const g = garage[A]
          if (!g) { res.kind = 'manual'; res.why = '% claim, no garage rate on file'; continue }
          const allowed = Math.floor((1 - newP / g) * 100 / 5) * 5
          res.check = `$${newP} vs garage $${g} → up to ${allowed}% holds`
          let bad = false
          nv = nv.replace(/((?:up to|save up to|saving up to)\s*)(\d{1,3})(\s*%)/gi, (m, a, num, b) => Number(num) <= allowed ? m : `${a}${allowed}${b}`)
          for (const m of nv.matchAll(/(\d{1,3})\s*%/g)) if (Number(m[1]) > allowed) bad = true
          if (bad || allowed < 10) { res.kind = 'manual'; res.why = `% claim not of the "up to" form or below 10% (${res.check})`; continue }
        }
        res.proposed = nv
      }
      if (res.proposed != null) {
        const leftover = stale.filter(([p]) => res.proposed.includes(p))
        if (leftover.length || res.proposed.length > LIMIT[f] || !res.proposed.trim()) { res.why = `invalid: ${leftover.length ? 'stale price left' : res.proposed.length > LIMIT[f] ? `too long (${res.proposed.length})` : 'empty'}`; res.kind = 'manual' }
      }
    }
    if (Object.keys(post.fields).length) out.push(post)
    if (n % 100 === 0) console.log(`${n}/${rows.length}  sonnet in ${inTok} out ${outTok}`)
  }
  fs.writeFileSync(PLAN, JSON.stringify({ at: new Date().toISOString(), posts: out }, null, 1))
  const all = out.flatMap(p => Object.values(p.fields)) as any[]
  const by: Record<string, number> = {}
  for (const x of all) by[x.kind] = (by[x.kind] || 0) + 1
  console.log(`posts ${out.length}, fields ${all.length}`, by, `sonnet $${(inTok * 3 + outTok * 15) / 1e6}`)
}

async function apply() {
  const { posts } = JSON.parse(fs.readFileSync(PLAN, 'utf8'))
  const stamp = new Date().toISOString().slice(0, 10)
  const backup: any[] = [], log: any[] = [], urls: string[] = []
  for (const p of posts) {
    // Fields flagged `risk` (a swapped price not clearly in an off-site context) wait for review unless --risky.
    const change = Object.entries(p.fields).filter(([, x]: any) => x.kind !== 'manual' && x.proposed && x.proposed !== x.old && !!x.risk === RISKY && !x.applied) as [string, any][]
    if (!change.length) continue
    try {
      const live = await cms(`/posts/${p.id}?depth=0`)
      const cur = fieldsOf(live)
      if (change.some(([f, x]) => cur[f] !== x.old)) { log.push({ slug: p.slug, status: 'SKIP: field differs from plan' }); continue }
      backup.push({ id: live.id, slug: live.slug, title: live.title, seo: live.seo, excerpt: live.excerpt })
      const nx: Record<string, string> = { ...cur }
      for (const [f, x] of change) nx[f] = x.proposed
      const data: any = {}
      if (nx.title !== cur.title) data.title = nx.title
      if (nx.excerpt !== cur.excerpt) data.excerpt = nx.excerpt
      if (nx.metaTitle !== cur.metaTitle || nx.metaDescription !== cur.metaDescription) data.seo = { ...live.seo, metaTitle: nx.metaTitle, metaDescription: nx.metaDescription }
      await updatePost(String(p.id), data)
      const after = fieldsOf(await cms(`/posts/${p.id}?depth=0`))
      const ok = Object.keys(nx).every(f => after[f] === nx[f])
      log.push({ slug: p.slug, fields: change.map(([f]) => f).join(','), status: ok ? 'ok' : 'VERIFY FAILED — restore from backup' })
      if (ok) { urls.push(postUrlFor(p.slug)); for (const [, x] of change) x.applied = stamp }
      const rec = loadRecord(p.slug)
      if (rec) {
        const s: any = rec.snapshots.at(-1) || {}
        rec.changes.push({ at: new Date().toISOString(), type: 'meta', summary: `stale-swap: replaced a not-sellable lot's price in ${change.map(([f]) => f).join(', ')}`,
          baselineMetrics: { clicks: s.clicks || 0, impressions: s.impressions || 0, position: s.position || 0 },
          preEdit: { title: live.title, seo: live.seo, excerpt: live.excerpt } })
        saveRecord(rec)
      }
    } catch (e) { log.push({ slug: p.slug, status: `ERROR: ${(e as Error).message.slice(0, 200)}` }) }
    fs.writeFileSync(`${DIR}/stale-swap-backup-${stamp}${RISKY ? '-risky' : ''}.json`, JSON.stringify(backup))
  }
  fs.writeFileSync(`${DIR}/stale-swap-applied-${stamp}${RISKY ? '-risky' : ''}.json`, JSON.stringify(log, null, 1))
  fs.writeFileSync(PLAN, JSON.stringify({ at: new Date().toISOString(), posts }, null, 1))
  const by: Record<string, number> = {}
  for (const l of log) by[l.status.split(':')[0]] = (by[l.status.split(':')[0]] || 0) + 1
  console.log(by)
  await submitUrls(urls)
}

await (APPLY ? apply() : plan())
