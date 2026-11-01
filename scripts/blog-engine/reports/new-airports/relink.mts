// Re-publish the BODY of already-live new-airport pages after a linking pass (internal + external links only).
// Reads <a>/<slug>.page.json (and <a>/<slug>.hub.json), compares to the live post, PATCHes content only
// (no contentUpdatedAt: links are not a fact change), re-reads to verify, pings IndexNow.
// Refuses if the live text changed beyond links (word count drift > 3%), so it can't overwrite other edits.
//   npx tsx reports/new-airports/relink.mts pit ric mdw [--apply]
import fs from 'fs'
import { env } from '../../src/config.js'
import { updatePost } from '../../src/payload.js'
import { htmlToLexical } from '../../src/html-to-lexical.js'
import { submitUrls, postUrlFor } from '../../src/indexnow.js'

const args = process.argv.slice(2), APPLY = args.includes('--apply')
const AIRPORTS = args.filter(a => /^[a-z]{3}$/.test(a))
const cms = async (p: string) => { const r = await fetch(`${env.PAYLOAD_CMS_URL}/api${p}`, { headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` } }); if (!r.ok) throw new Error(`GET ${p} ${r.status}`); return r.json() }
const links = (n: any, out: string[] = []): string[] => { if (n?.type === 'link' || n?.type === 'autolink') out.push(n.fields?.url || ''); (n?.children || []).forEach((c: any) => links(c, out)); return out }
const words = (n: any): number => (n?.text ? n.text.split(/\s+/).filter(Boolean).length : 0) + (n?.children || []).reduce((s: number, c: any) => s + words(c), 0)

const results: any[] = [], urls: string[] = []
for (const a of AIRPORTS) {
  const dir = `reports/new-airports/${a}`
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.page.json') || x.endsWith('.hub.json'))) {
    const p = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'))
    const res: any = { airport: a, slug: p.slug }
    results.push(res)
    try {
      const live = (await cms(`/posts?where[slug][equals]=${encodeURIComponent(p.slug)}&limit=1&depth=0`)).docs?.[0]
      if (!live) { res.status = 'SKIP: not live'; continue }
      const content = htmlToLexical(p.html)
      const before = links(live.content.root), after = links(content.root)
      const wl = words(live.content.root), wn = words(content.root)
      res.int = `${before.filter(u => u.includes('triplypro.com/blog/')).length}→${after.filter(u => u.includes('triplypro.com/blog/')).length}`
      res.ext = `${before.filter(u => /^https?:/.test(u) && !u.includes('triplypro.com')).length}→${after.filter(u => /^https?:/.test(u) && !u.includes('triplypro.com')).length}`
      if (Math.abs(wn - wl) / wl > 0.03) { res.status = `SKIP: text drift ${wl}→${wn} words (only links may change)`; continue }
      if (JSON.stringify(before) === JSON.stringify(after)) { res.status = 'no link change'; continue }
      if (!APPLY) { res.status = 'dry-run ok'; continue }
      fs.writeFileSync(`${dir}/${p.slug}.relink-backup.json`, JSON.stringify(live))
      await updatePost(String(live.id), { content })
      const back = await cms(`/posts/${live.id}?depth=0`)
      const ok = JSON.stringify(links(back.content.root)) === JSON.stringify(after)
      res.status = ok ? `relinked + verified (id ${live.id})` : `CHECK FAILED (id ${live.id}) — restore ${p.slug}.relink-backup.json`
      if (ok) urls.push(postUrlFor(p.slug))
    } catch (e) { res.status = `ERROR: ${(e as Error).message.slice(0, 160)}` }
  }
}
console.table(results)
if (APPLY && urls.length) await submitUrls(urls)
