// Create new-airport posts written in-session (Max plan) from reports/new-airports/<a>/<slug>.page.json.
// One page per search intent (hub + 2-4 spokes). Dry-run by default; --apply creates them as published,
// hub first, re-reads each to verify, then pings IndexNow.
//   npx tsx reports/new-airports/create.mts mdw pit ric [--only slug] [--apply]
//
// page.json: { slug, keyword, title, articleType: 'hub'|'spoke', parentSlug?, hubSlug?, tags: string[],
//   seo: { metaTitle, metaDescription }, excerpt, html, faqItems: [{ question, answer }] }
import fs from 'fs'
import { env } from '../../src/config.js'
import { createPost, uploadMedia, getApiUser, findOrCreateCategory, findOrCreateTag, getClusterUsedPhotoIds } from '../../src/payload.js'
import { htmlToLexical } from '../../src/html-to-lexical.js'
import { getAirportPhoto } from '../../src/unsplash.js'
import { submitUrls, postUrlFor } from '../../src/indexnow.js'

const args = process.argv.slice(2), APPLY = args.includes('--apply')
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const AIRPORTS = args.filter(a => /^[a-z]{3}$/.test(a))
const cms = async (p: string) => { const r = await fetch(`${env.PAYLOAD_CMS_URL}/api${p}`, { headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` } }); if (!r.ok) throw new Error(`GET ${p} ${r.status}`); return r.json() }
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

// Same bans as the lot-rewrite RULES + Tom's plan v3.2 W1.4 lint.
const LINT: [RegExp, string][] = [
  [/\bwait,|let's be precise|competitor article|as an ai\b/i, 'AI artifact'],
  [/—/, 'em dash'],
  [/\b(verified|working)\b[^.]{0,40}\b(code|coupon|promo)/i, '"verified/working" next to a code'],
  [/save up to \d+ ?%/i, 'unsourced "save up to N%"'],
  [/spothero|way\.com|parkwhiz|parkingaccess|parksleepfly|airport parking reservations|park ?n ?fly|cheap airport parking/i, 'names a competing booking site'],
  [/commission/i, 'mentions commission'],
  [/&amp;amp;/, 'double-escaped &'],
]

function lint(p: any): string[] {
  const out: string[] = []
  const all = [p.title, p.seo?.metaTitle, p.seo?.metaDescription, p.excerpt, text(p.html), ...(p.faqItems || []).flatMap((f: any) => [f.question, f.answer])].join('\n')
  for (const [re, why] of LINT) if (re.test(all)) out.push(why)
  if (!p.title?.toLowerCase().includes(p.keyword.toLowerCase().split(' ').slice(-2).join(' '))) out.push('title may not carry the keyword')
  if ((p.title || '').length > 100) out.push(`title ${p.title.length} > 100`)
  if ((p.seo?.metaTitle || '').length > 60) out.push(`metaTitle ${p.seo.metaTitle.length} > 60`)
  if ((p.seo?.metaDescription || '').length > 160) out.push(`metaDescription ${p.seo.metaDescription.length} > 160`)
  if ((p.excerpt || '').length > 300) out.push(`excerpt ${p.excerpt.length} > 300`)
  const first = text((p.html.match(/<p[^>]*>[\s\S]*?<\/p>/i) || [''])[0])
  if (!/\$\d/.test(first) && ['hub', 'spoke'].includes(p.articleType) && /cost|price|rate|cheap|long term|economy|remote|coupon|promo/i.test(p.keyword)) out.push('first paragraph has no price')
  if (/<h2[^>]*>\s*(faq|frequently asked)/i.test(p.html)) out.push('FAQ section in body (FAQs go in faqItems)')
  return out
}

const results: any[] = [], urls: string[] = []
const apiUser = APPLY ? await getApiUser() : null
const category = APPLY ? await findOrCreateCategory('Airport Parking') : null

for (const a of AIRPORTS) {
  const dir = `reports/new-airports/${a}`
  const pages = fs.readdirSync(dir).filter(f => f.endsWith('.page.json')).map(f => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8')))
    .filter(p => !ONLY || p.slug === ONLY)
    .sort((x, y) => (x.articleType === 'hub' ? -1 : 0) - (y.articleType === 'hub' ? -1 : 0))
  const used = APPLY ? await getClusterUsedPhotoIds(a.toUpperCase()).catch(() => [] as string[]) : []
  for (const p of pages) {
    const res: any = { airport: a, slug: p.slug, type: p.articleType, words: text(p.html).split(' ').length }
    results.push(res)
    try {
      const exists = (await cms(`/posts?where[slug][equals]=${encodeURIComponent(p.slug)}&limit=1&depth=0`)).docs?.[0]
      if (exists) { res.status = `SKIP: slug exists (id ${exists.id}, ${exists.status})`; continue }
      const problems = lint(p)
      if (problems.length) { res.status = `LINT: ${problems.join('; ')}`; continue }
      if (!APPLY) { res.status = 'dry-run ok'; continue }

      const content = htmlToLexical(p.html)
      const tagIds: string[] = []
      for (const t of p.tags || []) { const tag = await findOrCreateTag(t); tagIds.push(tag.doc?.id || tag.id) }
      let featuredImage: string | undefined
      const photo = await getAirportPhoto(a.toUpperCase(), p.keyword, used)
      if (photo) { const m = await uploadMedia(photo.buffer, photo.filename, photo.alt); featuredImage = m.doc?.id || m.id; used.push(photo.filename) }

      const created = await createPost({
        title: p.title, slug: p.slug, excerpt: p.excerpt, content,
        category: category.doc?.id || category.id, tags: tagIds, author: apiUser.id,
        status: 'published', publishedAt: new Date().toISOString(),
        airportCode: a.toUpperCase(), articleType: p.articleType,
        parentSlug: p.parentSlug || undefined, hubSlug: p.hubSlug || undefined,
        faqItems: p.faqItems, seo: p.seo, ...(featuredImage ? { featuredImage } : {}),
      })
      const id = created.doc?.id || created.id
      const after = await cms(`/posts/${id}?depth=0`)
      const ok = after.slug === p.slug && after.status === 'published' && after.content?.root?.children?.length === content.root.children.length
      res.status = ok ? `published + verified (id ${id})` : `POST-SAVE CHECK FAILED (id ${id})`
      if (ok) urls.push(postUrlFor(p.slug))
    } catch (e) { res.status = `ERROR: ${(e as Error).message.slice(0, 200)}` }
  }
}
console.table(results)
if (APPLY) {
  const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  let log = `reports/new-airports/create-${day}-${AIRPORTS.join('-')}${ONLY ? '-' + ONLY : ''}.json`
  for (let n = 2; fs.existsSync(log); n++) log = log.replace(/(-\d+)?\.json$/, `-${n}.json`)
  fs.writeFileSync(log, JSON.stringify(results, null, 1)); console.log('log:', log)
  await submitUrls(urls)
}
