// Read-only: build the post-edit article from <slug>.preedit.json + <slug>.edits.json, run checks,
// write <slug>.preview.html + <slug>.new.json (content/seo/excerpt/faqItems). No network, no CMS writes.
//   npx tsx reports/lot-rewrite/preview.mts atl [slug ...]
import fs from 'fs'
import { htmlToLexical } from '../../src/html-to-lexical.js'
import { lexicalToHtml } from '../../src/lexical-to-html.js'

const args = process.argv.slice(2), dir = `reports/lot-rewrite/${args[0]}`, only = args.slice(1)
const fact = JSON.parse(fs.readFileSync(`${dir}/factsheet.json`, 'utf8'))
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const brands = fact.notSellableOnTriply.map((n: string) => n.replace(/\s*\(.*?\)\s*/g, ' ').trim())
const brandRe = new RegExp([...brands.map((b: string) => esc(b).replace(/&/g, '(?:&|&amp;|and)')), 'Peachy', 'Parking Spot', 'WallyPark', 'FastPark', "Park ?'?N'? ?Go"].join('|'), 'gi')
const strip = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

const slugs = only.length ? only : fs.readdirSync(dir).filter(f => f.endsWith('.edits.json')).map(f => f.replace('.edits.json', ''))
for (const slug of slugs) {
  if (!fs.existsSync(`${dir}/${slug}.edits.json`)) { console.log(`${slug}: no edits.json (writer failed), skipped`); continue }
  const pre = JSON.parse(fs.readFileSync(`${dir}/${slug}.preedit.json`, 'utf8'))
  const ed = JSON.parse(fs.readFileSync(`${dir}/${slug}.edits.json`, 'utf8'))
  const byI = new Map<number, string>((ed.edits || []).map((e: any) => [e.i, e.html])), del = new Set<number>(ed.deletes || [])
  const problems: string[] = [], out: any[] = []
  ;(pre.content.root.children as any[]).forEach((b, i) => {
    if (b.type === 'upload') { if (byI.has(i) || del.has(i)) problems.push(`touches image block ${i}`); out.push(b); return }
    if (del.has(i)) return
    if (!byI.has(i)) { out.push(b); return }
    const html = byI.get(i)!, nodes = htmlToLexical(html).root.children
    const n = (s: string) => (s.match(/href="[^"]*"/g) || []).length
    if (n(lexicalToHtml({ root: { children: nodes } } as any)) < n(html)) problems.push(`block ${i}: link lost in conversion`)
    out.push(...nodes)
  })
  // html-to-lexical keeps entities verbatim, so live text shows a literal "&amp;". Decode every text node
  // in the post (new and old blocks); repeat for double-escaped "&amp;amp;".
  const decode = (s: string) => { let p; do { p = s; s = s.replace(/&amp;/g, '&') } while (s !== p); return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ') }
  const fixText = (n: any) => { if (typeof n?.text === 'string') n.text = decode(n.text); (n?.children || []).forEach(fixText) }
  out.forEach(n => { if (n.type !== 'upload') fixText(n) })
  const content = { ...pre.content, root: { ...pre.content.root, children: out } }
  const html = lexicalToHtml(content)
  const seo = { ...(pre.seo || {}), ...(ed.seo?.metaTitle ? { metaTitle: ed.seo.metaTitle } : {}), ...(ed.seo?.metaDescription ? { metaDescription: ed.seo.metaDescription } : {}) }
  const faqItems = ed.faqItems ?? pre.faqItems, excerpt = ed.excerpt ?? pre.excerpt, title = ed.title ?? pre.title
  const text = strip(html) + ' ' + strip(JSON.stringify([title, seo, excerpt, faqItems]))
  const left = [...new Set((text.match(brandRe) || []).map(s => s.trim()))]
  for (const l of fact.sellableOnTriply) {
    const nm = esc(l.name.replace(/\s*\(.*?\)\s*/g, '').split(' ').slice(0, 2).join(' '))
    for (const m of text.matchAll(new RegExp(nm + '[^.$]{0,80}\\$(\\d+(?:\\.\\d+)?)', 'g')))
      if (Math.abs(Number(m[1]) - l.dailyRate) > 1.01) problems.push(`${l.name} shown at $${m[1]} (factsheet $${l.dailyRate})`)
  }
  if (/commission/i.test(text)) problems.push('mentions commission')
  if (/\$7\.95|\$8\.99|\$10\.95/.test(text)) problems.push('still has a not-sellable lot price')
  for (const p of fact.stalePrices || []) if (text.includes('$' + p)) problems.push(`stale price $${p}`)
  fs.writeFileSync(`${dir}/${slug}.new.json`, JSON.stringify({ id: pre.id, slug, updatedAt: pre.updatedAt, title, content, seo, excerpt, faqItems }))
  fs.writeFileSync(`${dir}/${slug}.preview.html`, `<meta charset="utf-8"><h1>${title}</h1><p><i>${seo.metaTitle} | ${seo.metaDescription}</i></p>${html}<h2>FAQ</h2>${(faqItems || []).map((f: any) => `<h3>${f.question}</h3><p>${f.answer}</p>`).join('')}`)
  console.log(`${slug}: ${byI.size} edits, ${del.size} deletes${ed.seo?.metaTitle || ed.seo?.metaDescription ? ', seo' : ''}${ed.faqItems ? ', faq' : ''} | still names: ${left.join(', ') || 'none'}${problems.length ? ' | ⚠ ' + problems.join('; ') : ''}`)
}
