// Add one "nearby airport" paragraph with a link from an existing hub to a new airport hub.
// Appends to the end of the live post's body (keeps every existing node), skips if the link is already there,
// backs up the live post, no contentUpdatedAt (a link is not a fact change), pings IndexNow. Dry-run by default.
//   npx tsx reports/new-airports/inbound.mts [--apply]
import fs from 'fs'
import { env } from '../../src/config.js'
import { updatePost } from '../../src/payload.js'
import { htmlToLexical } from '../../src/html-to-lexical.js'
import { submitUrls, postUrlFor } from '../../src/indexnow.js'

const APPLY = process.argv.includes('--apply')
const B = 'https://www.triplypro.com/blog/'
const ADD: [string, string, string][] = [
  ['fort-lauderdale-airport-parking', 'pbi-airport-parking', `<p>Flying from Palm Beach instead? Compare <a href="${B}pbi-airport-parking">PBI airport parking</a> rates, economy and garages.</p>`],
  ['miami-airport-parking', 'pbi-airport-parking', `<p>Live farther north in South Florida? See our <a href="${B}pbi-airport-parking">Palm Beach (PBI) airport parking guide</a>.</p>`],
  ['boston-logan-airport-parking', 'pvd-airport-parking', `<p>Starting south of Boston? Compare <a href="${B}pvd-airport-parking">T.F. Green (PVD) airport parking</a> in Rhode Island.</p>`],
  ['mco-airport-parking', 'mlb-airport-parking', `<p>Heading out from the Space Coast? See <a href="${B}mlb-airport-parking">Melbourne Orlando International (MLB) parking</a>.</p>`],
  ['ord-airport-parking', 'chicago-airport-parking-midway', `<p>Flying from Chicago's other airport instead? Our <a href="${B}chicago-airport-parking-midway">Midway Airport (MDW) parking guide</a> covers its garage, economy lots and cell phone lot.</p>`],
  ['lax-airport-parking', 'bur-airport-parking', `<p>Live closer to the San Fernando Valley? Compare <a href="${B}bur-airport-parking">Hollywood Burbank Airport (BUR) parking</a> before you book.</p>`],
  ['jfk-airport-parking', 'hpn-airport-parking', `<p>Live north of the city? See our <a href="${B}hpn-airport-parking">Westchester County Airport (HPN) parking guide</a> for its garage and long-term lot.</p>`],
  ['laguardia-airport-parking', 'hpn-airport-parking', `<p>Flying out of Westchester instead? Compare <a href="${B}hpn-airport-parking">HPN airport parking</a> rates and lots.</p>`],
  ['newark-airport-parking', 'hpn-airport-parking', `<p>Starting from Westchester or southern Connecticut? See <a href="${B}hpn-airport-parking">parking at Westchester County Airport (HPN)</a>.</p>`],
  ['yul-airport-parking', 'yow-airport-parking', `<p>Flying from Ottawa instead? Our <a href="${B}yow-airport-parking">YOW airport parking guide</a> covers the P1 Parkade, P4 long-term and off-site parking.</p>`],
  ['yyz-airport-parking', 'yow-airport-parking', `<p>Departing from Ottawa? See <a href="${B}yow-airport-parking">Ottawa airport (YOW) parking rates and lots</a>.</p>`],
]
const cms = async (p: string) => { const r = await fetch(`${env.PAYLOAD_CMS_URL}/api${p}`, { headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` } }); if (!r.ok) throw new Error(`GET ${p} ${r.status}`); return r.json() }
const links = (n: any, out: string[] = []): string[] => { if (n?.type === 'link' || n?.type === 'autolink') out.push(n.fields?.url || ''); (n?.children || []).forEach((c: any) => links(c, out)); return out }

const rows: any[] = [], urls: string[] = []
fs.mkdirSync('reports/new-airports/inbound-backups', { recursive: true })
for (const [from, to, html] of ADD) {
  const row: any = { from, to }
  rows.push(row)
  try {
    const live = (await cms(`/posts?where[slug][equals]=${from}&limit=1&depth=0`)).docs?.[0]
    const target = (await cms(`/posts?where[slug][equals]=${to}&where[status][equals]=published&limit=1&depth=0`)).docs?.[0]
    if (!live || !target) { row.status = `SKIP: ${!live ? 'source' : 'target'} not found/published`; continue }
    if (links(live.content.root).some(u => u.replace(/[#?].*$/, '').replace(/\/$/, '').endsWith(`/blog/${to}`))) { row.status = 'already links'; continue }
    const add = htmlToLexical(html).root.children
    const content = { ...live.content, root: { ...live.content.root, children: [...live.content.root.children, ...add] } }
    if (!APPLY) { row.status = `dry-run ok (+${add.length} node)`; continue }
    fs.writeFileSync(`reports/new-airports/inbound-backups/${from}.json`, JSON.stringify(live))
    await updatePost(String(live.id), { content })
    const back = await cms(`/posts/${live.id}?depth=0`)
    const ok = back.content.root.children.length === content.root.children.length && links(back.content.root).some(u => u.endsWith(`/blog/${to}`))
    row.status = ok ? `linked + verified (id ${live.id})` : `CHECK FAILED — restore inbound-backups/${from}.json`
    if (ok) urls.push(postUrlFor(from))
  } catch (e) { row.status = `ERROR: ${(e as Error).message.slice(0, 160)}` }
}
console.table(rows)
if (APPLY && urls.length) await submitUrls(urls)
