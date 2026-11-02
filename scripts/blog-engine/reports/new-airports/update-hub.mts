// Correct an existing post in place and make it an airport's hub (Midway, 23 Oct 2026: chicago-airport-parking-midway).
// Reads reports/new-airports/<a>/<slug>.hub.json (same shape as a page.json). Dry-run by default; --apply backs up
// the live post, PATCHes title/content/excerpt/seo/faqItems + airportCode/articleType/parent/hub, stamps
// contentUpdatedAt (facts changed), keeps slug, publishedAt and featuredImage, re-reads to verify, pings IndexNow.
//   npx tsx reports/new-airports/update-hub.mts mdw chicago-airport-parking-midway [--apply] [--stamp]
import fs from 'fs'
import { env } from '../../src/config.js'
import { updatePost } from '../../src/payload.js'
import { htmlToLexical } from '../../src/html-to-lexical.js'
import { submitUrls, postUrlFor } from '../../src/indexnow.js'
import { stampField } from '../../src/stamp.js'

const [a, slug] = process.argv.slice(2).filter(x => !x.startsWith('--')), APPLY = process.argv.includes('--apply')
const cms = async (p: string) => { const r = await fetch(`${env.PAYLOAD_CMS_URL}/api${p}`, { headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` } }); if (!r.ok) throw new Error(`GET ${p} ${r.status}`); return r.json() }

const dir = `reports/new-airports/${a}`
const p = JSON.parse(fs.readFileSync(`${dir}/${slug}.hub.json`, 'utf8'))
if (p.slug !== slug) throw new Error(`slug mismatch: ${p.slug}`)
const live = (await cms(`/posts?where[slug][equals]=${encodeURIComponent(slug)}&limit=1&depth=0`)).docs?.[0]
if (!live) throw new Error('live post not found')
const content = htmlToLexical(p.html)
console.log({ id: live.id, from: { title: live.title, airportCode: live.airportCode, articleType: live.articleType, parent: live.parentSlug },
  to: { title: p.title, airportCode: a.toUpperCase(), articleType: 'hub' }, blocks: content.root.children.length, faq: p.faqItems.length })
if (!APPLY) { console.log('dry-run ok'); process.exit(0) }

fs.writeFileSync(`${dir}/${slug}.live-backup.json`, JSON.stringify(live))
await updatePost(String(live.id), {
  title: p.title, content, excerpt: p.excerpt, seo: { ...live.seo, ...p.seo },
  faqItems: p.faqItems.map(({ question, answer }: any) => ({ question, answer })),
  airportCode: a.toUpperCase(), articleType: 'hub', parentSlug: null, hubSlug: null,
  ...stampField({ factsChanged: true, reason: 'hub rewritten (needs --stamp)' }),
})
const after = await cms(`/posts/${live.id}?depth=0`)
const ok = after.slug === slug && after.title === p.title && after.status === live.status && after.airportCode === a.toUpperCase()
  && after.content.root.children.length === content.root.children.length
console.log(ok ? `updated + verified (id ${live.id}); backup ${dir}/${slug}.live-backup.json` : `POST-SAVE CHECK FAILED — restore from ${dir}/${slug}.live-backup.json`)
if (ok) await submitUrls([postUrlFor(slug)])
