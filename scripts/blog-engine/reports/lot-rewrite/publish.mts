// Publish rewritten posts (<a>/<slug>.new.json) + regenerated infographics (<a>/img/) to the CMS.
// Dry-run by default. --apply: per post, refuse if the live post changed since export, back up the live
// post, upload new images, PATCH, re-read and verify, log a perf change, ping IndexNow.
//   npx tsx reports/lot-rewrite/publish.mts [atl dfw ...] [--only slug] [--apply] [--stamp]
// --stamp (W1.7): also set contentUpdatedAt; default leaves the date alone.
import fs from 'fs'
import crypto from 'crypto'
import { env } from '../../src/config.js'
import { updatePost, uploadMedia } from '../../src/payload.js'
import { loadRecord, saveRecord } from '../../src/perf-snapshot.js'
import { submitUrls, postUrlFor } from '../../src/indexnow.js'
import { stampField } from '../../src/stamp.js'

const args = process.argv.slice(2), APPLY = args.includes('--apply')
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
// --batch <name>: publish only slugs listed in <a>/<name>.json that have a factcheck (never an unchecked rewrite).
const BATCH = args.includes('--batch') ? args[args.indexOf('--batch') + 1] : null
const AIRPORTS = args.filter(a => /^[a-z]{3}$/.test(a)).length ? args.filter(a => /^[a-z]{3}$/.test(a)) : ['atl', 'dfw', 'lax', 'phl', 'sfo']
const cms = async (p: string) => { const r = await fetch(`${env.PAYLOAD_CMS_URL}/api${p}`, { headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` } }); if (!r.ok) throw new Error(`GET ${p} ${r.status}`); return r.json() }
const links = (n: any): number => (n?.type === 'link' || n?.type === 'autolink' ? 1 : 0) + (n?.children || []).reduce((s: number, c: any) => s + links(c), 0)
const uploads = (c: any) => c.root.children.filter((b: any) => b.type === 'upload').map((b: any) => String(typeof b.value === 'object' ? b.value.id : b.value))

// Same chart is reused across an airport's posts: upload each distinct PNG once.
const uploaded = new Map<string, number>()
const results: any[] = [], urls: string[] = []
for (const a of AIRPORTS) {
  const dir = `reports/lot-rewrite/${a}`
  const inBatch = BATCH ? new Set(JSON.parse(fs.readFileSync(`${dir}/${BATCH}.json`, 'utf8')).map((p: any) => p.slug)) : null
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.new.json'))) {
    const nw = JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'))
    if (ONLY && ONLY !== nw.slug) continue
    if (inBatch && (!inBatch.has(nw.slug) || !fs.existsSync(`${dir}/${nw.slug}.factcheck.json`))) continue
    const res: any = { airport: a, id: nw.id, slug: nw.slug }
    results.push(res)
    try {
      const live = await cms(`/posts/${nw.id}?depth=0`)
      if (live.slug !== nw.slug || live.updatedAt !== nw.updatedAt) { res.status = `SKIP: live post changed since export (${live.updatedAt})`; continue }
      const content = JSON.parse(JSON.stringify(nw.content))
      const imgs: { i: number; png: string; alt: string }[] = []
      content.root.children.forEach((b: any, i: number) => {
        if (b.type !== 'upload') return
        if (typeof b.value === 'object') b.value = b.value.id
        const meta = `${dir}/img/${nw.slug}-${i}.json`
        // NOIMG=1: text-only pass (small fixes); don't re-upload charts left over from an earlier pass
        if (fs.existsSync(meta) && !process.env.NOIMG) imgs.push({ i, png: `${dir}/img/${nw.slug}-${i}.png`, alt: JSON.parse(fs.readFileSync(meta, 'utf8')).alt })
      })
      res.newImages = imgs.length
      res.titleChanged = nw.title !== live.title
      if (!APPLY) { res.status = 'dry-run ok'; continue }

      fs.writeFileSync(`${dir}/${nw.slug}.live-backup.json`, JSON.stringify(live))
      for (const im of imgs) {
        const buf = fs.readFileSync(im.png), h = crypto.createHash('sha1').update(buf).digest('hex')
        if (!uploaded.has(h)) { const m = await uploadMedia(buf, `${a}-parking-rates-${h.slice(0, 8)}.png`, im.alt); uploaded.set(h, Number(m.doc?.id ?? m.id)) }
        content.root.children[im.i].value = uploaded.get(h)
      }
      const now = new Date().toISOString()
      await updatePost(String(nw.id), { title: nw.title, content, seo: { ...live.seo, ...nw.seo }, excerpt: nw.excerpt, faqItems: nw.faqItems, ...stampField({ factsChanged: true, reason: 'lot rewrite: lots and prices repointed' }) })

      const after = await cms(`/posts/${nw.id}?depth=0`)
      const want = uploads(content), got = uploads(after.content)
      const ok = after.title === nw.title && links(after.content.root) === links(content.root) && JSON.stringify(got) === JSON.stringify(want) && after.status === live.status
      res.status = ok ? 'published + verified' : `POST-SAVE CHECK FAILED (title ${after.title === nw.title}, links ${links(content.root)}→${links(after.content.root)}, images ${want.length}→${got.length}) — restore from ${nw.slug}.live-backup.json`
      if (ok) urls.push(postUrlFor(nw.slug))

      const rec = loadRecord(nw.slug)
      if (rec) {
        const s: any = rec.snapshots.at(-1) || {}
        rec.changes.push({ at: now, type: 'content', summary: `lot-rewrite: repointed to sellable lots${imgs.length ? `, ${imgs.length} infographic(s) regenerated` : ''}`,
          baselineMetrics: { clicks: s.clicks || 0, impressions: s.impressions || 0, position: s.position || 0 },
          preEdit: { title: live.title, content: live.content, seo: live.seo, excerpt: live.excerpt, faqItems: live.faqItems } })
        saveRecord(rec)
      }
    } catch (e) { res.status = `ERROR: ${(e as Error).message.slice(0, 200)}` }
  }
}
console.table(results)
if (APPLY) {
  // Name the log by local date + airport(s) and never overwrite an existing log (12 Oct: ORD overwrote FLL's).
  const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  let log = `reports/lot-rewrite/publish-${day}-${AIRPORTS.join('-')}${ONLY ? '-' + ONLY : ''}.json`
  for (let n = 2; fs.existsSync(log); n++) log = log.replace(/(-\d+)?\.json$/, `-${n}.json`)
  fs.writeFileSync(log, JSON.stringify(results, null, 1)); console.log('log:', log)
  await submitUrls(urls)
}
