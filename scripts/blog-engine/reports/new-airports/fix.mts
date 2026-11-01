// Fact correction for already-live new-airport pages: PATCH title, content, excerpt, seo, faqItems from the local
// <a>/<slug>.page.json (or .hub.json) when they differ from live. Stamps contentUpdatedAt (facts changed), backs up
// the live post, re-reads to verify, pings IndexNow. Dry-run by default.
//   npx tsx reports/new-airports/fix.mts pit ric [--only slug] [--apply] [--stamp]
import fs from 'fs'
import { env } from '../../src/config.js'
import { updatePost } from '../../src/payload.js'
import { htmlToLexical, extractTextFromLexical } from '../../src/html-to-lexical.js'
import { submitUrls, postUrlFor } from '../../src/indexnow.js'
import { stampField } from '../../src/stamp.js'

const args = process.argv.slice(2), APPLY = args.includes('--apply')
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const AIRPORTS = args.filter(a => /^[a-z]{3}$/.test(a))
const cms = async (p: string) => { const r = await fetch(`${env.PAYLOAD_CMS_URL}/api${p}`, { headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` } }); if (!r.ok) throw new Error(`GET ${p} ${r.status}`); return r.json() }
const faq = (f: any[]) => JSON.stringify((f || []).map(({ question, answer }) => ({ question, answer })))

const results: any[] = [], urls: string[] = []
for (const a of AIRPORTS) {
  const dir = `reports/new-airports/${a}`
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.page.json') || x.endsWith('.hub.json'))) {
    const p = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'))
    if (ONLY && ONLY !== p.slug) continue
    const res: any = { airport: a, slug: p.slug }
    results.push(res)
    try {
      const live = (await cms(`/posts?where[slug][equals]=${encodeURIComponent(p.slug)}&limit=1&depth=0`)).docs?.[0]
      if (!live) { res.status = 'SKIP: not live (use create.mts)'; continue }
      const content = htmlToLexical(p.html)
      const changed = [
        live.title !== p.title && 'title',
        extractTextFromLexical(live.content.root.children) !== extractTextFromLexical(content.root.children) && 'body',
        live.excerpt !== p.excerpt && 'excerpt',
        (live.seo?.metaTitle !== p.seo?.metaTitle || live.seo?.metaDescription !== p.seo?.metaDescription) && 'seo',
        faq(live.faqItems) !== faq(p.faqItems) && 'faq',
      ].filter(Boolean)
      res.changed = changed.join(',') || '-'
      if (!changed.length) { res.status = 'no change'; continue }
      if (!APPLY) { res.status = 'dry-run ok'; continue }
      fs.writeFileSync(`${dir}/${p.slug}.fix-backup.json`, JSON.stringify(live))
      await updatePost(String(live.id), {
        title: p.title, content, excerpt: p.excerpt, seo: { ...live.seo, ...p.seo },
        faqItems: (p.faqItems || []).map(({ question, answer }: any) => ({ question, answer })),
        ...stampField({ factsChanged: changed.includes('body') || changed.includes('title') || changed.includes('faq'), reason: `changed: ${changed.join(',')} (needs --stamp)` }),
      })
      const back = await cms(`/posts/${live.id}?depth=0`)
      const ok = back.title === p.title && back.content.root.children.length === content.root.children.length && faq(back.faqItems) === faq(p.faqItems)
      res.status = ok ? `fixed + verified (id ${live.id})` : `CHECK FAILED (id ${live.id}) — restore ${p.slug}.fix-backup.json`
      if (ok) urls.push(postUrlFor(p.slug))
    } catch (e) { res.status = `ERROR: ${(e as Error).message.slice(0, 160)}` }
  }
}
console.table(results)
if (APPLY && urls.length) await submitUrls(urls)
