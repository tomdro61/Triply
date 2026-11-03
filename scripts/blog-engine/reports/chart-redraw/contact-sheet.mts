// Chart redraw, step 5 (no writes): one page with every new chart, its caption, the lots behind it and every post
// block it would replace, grouped by what Tom decides. Writes reports/chart-redraw/out/contact/index.html + charts/
// (publish the folder as an artifact).
//   npx tsx reports/chart-redraw/contact-sheet.mts
import fs from 'fs'
import { fmtDate, fmtStay, loadPriceSnapshot, money, type ChartLot } from '../../src/rate-chart.js'
import type { Chart, Decision, Flag } from './render.mts'
import type { Item } from './classify.mts'

const OUT = 'reports/chart-redraw/out'
const snap = loadPriceSnapshot()!
const plan: { asOf: string; checkin: string; checkout: string; charts: Chart[]; noChart: Record<string, string>; decisions: Decision[] } = JSON.parse(fs.readFileSync(`${OUT}/plan.json`, 'utf-8'))
const inv: { items: Item[] } = JSON.parse(fs.readFileSync(`${OUT}/inventory.json`, 'utf-8'))
const run = fs.existsSync(`${OUT}/prices-run-${snap.asOf}.json`) ? JSON.parse(fs.readFileSync(`${OUT}/prices-run-${snap.asOf}.json`, 'utf-8')) as { excluded: Record<string, string[]> } : { excluded: {} }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n = (x: number) => x.toLocaleString('en-US')
const D = plan.decisions
const postsOf = (ds: Decision[]) => new Set(ds.map((d) => d.post_id)).size

// ── One group per decision Tom makes (a chart spot is in the first group that fits). Groups are about the IMAGE; the
// post text only ranks posts for the prose pass (every post in scope quotes off-site lot prices somewhere). ──
type Group = 'swap' | 'notrate' | 'lotpost' | 'currency' | 'other'
const groupOf = (d: Decision): Group => {
  if (d.action === 'swap') return 'swap'
  if (d.blockers.some((b) => b.startsWith('not a rate chart') || b.startsWith('not replaceable'))) return 'notrate'
  if (d.blockers.some((b) => b.includes('checkout charges'))) return 'currency'
  if (d.blockers.some((b) => b.startsWith('post is about one lot'))) return 'lotpost'
  return 'other'
}
const G: Record<Group, Decision[]> = { swap: [], notrate: [], lotpost: [], currency: [], other: [] }
for (const d of D) G[groupOf(d)].push(d)
const GROUP_TITLE: Record<Group, string> = {
  swap: 'Replaceable: the new chart can take this image\'s place',
  notrate: "Can't replace: a one-off chart or another topic",
  lotpost: 'Post about one lot: needs a look',
  currency: 'Canadian airport: checkout currency question',
  other: 'Another airport, a third chart in one post, or another price image in the post stays',
}
/** Posts whose text sells a lot we don't sell, or miscounts our lots: first in the prose pass. */
const firstInTextPass = (ds: Decision[]) => new Set(ds.filter((d) => d.flags.includes('unsold') || d.flags.includes('count')).map((d) => d.post_id)).size

const leftAlone = inv.items.filter((i) => i.cls === 'airport' || i.cls === 'not-rate')
const unused = inv.items.filter((i) => (i.cls === 'standard' || i.cls === 'one-off' || i.cls === 'mixed') && !i.uses.length)
const codes = [...new Set(D.map((d) => d.code))].sort()
const fallbackCount = plan.charts.filter((c) => c.fallback).length / 2
const notrateUnsold = G.notrate.filter((d) => d.captionUnsold.length)

const FLAG_LABEL: Record<Flag, string> = { unsold: "text names a lot we don't sell", prices: 'text quotes lot prices', count: 'text miscounts our lots', missing: 'text names a lot not in this search' }
const FLAG_CLASS: Record<Flag, string> = { unsold: 'stop', prices: 'info', count: 'warn', missing: 'info' }
const chip = (f: Flag) => `<span class="sev ${FLAG_CLASS[f]}">${FLAG_LABEL[f]}</span>`
const transfer: Record<ChartLot['transfer'], string> = { shuttle: 'Shuttle', valet: 'Valet', paid: 'Paid shuttle', none: 'No shuttle', unknown: '—' }
const blog = (slug: string) => `https://www.triplypro.com/blog/${slug}`

/** The post text a note points at (render.mts cut it from the whole post), with the figures and names marked. */
function excerpt(d: Decision): string {
  const needles = d.notes.flatMap((x) => [...x.matchAll(/"([^"]+)"|((?:C\$|\$)\d[\d.,]*|\d+%)/g)].map((m) => m[1] ?? m[2]))
  let s = esc(d.excerpt)
  for (const k of needles) if (k.length >= 3) s = s.split(esc(k)).join(`<mark>${esc(k)}</mark>`)
  return s
}
const oldCap = (d: Decision, max = 180) => `${esc(d.oldAlt.slice(0, max))}${d.oldAlt.length > max ? '…' : ''}`
const kindLabel = (d: Decision) => (d.kind ? (d.kind === 'week' ? '7-day table' : 'daily chart') : 'no chart')
const swapRow = (d: Decision) => `<li><a href="${blog(d.slug)}">${esc(d.slug)}</a> <span class="muted">→ ${kindLabel(d)}${d.flags.length ? ` ${d.flags.map(chip).join(' ')}` : ''} · old caption: ${oldCap(d, 140)}</span></li>`
const holdCard = (d: Decision) => `<div class="hold"><div class="hhead"><a href="${blog(d.slug)}">${esc(d.slug)}</a> <span class="muted">${kindLabel(d)}</span> ${d.flags.map(chip).join(' ')}</div>
  <ul class="notes">${[...d.blockers, ...d.notes].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
  ${d.excerpt ? `<p class="ctx">${excerpt(d)}</p>` : ''}<p class="small muted">Old caption: ${oldCap(d, 240)}</p></div>`

function airportSection(code: string): string {
  const row = snap.airports[code]
  const lots = row?.lots ?? []
  const cur = row?.currency ?? 'USD'
  const charts = plan.charts.filter((c) => c.code === code)
  const ds = D.filter((d) => d.code === code)
  const excluded = run.excluded[code] ?? []
  const lotRows = [...lots].sort((a, b) => Number(b.mayLead) - Number(a.mayLead) || a.stayTotal - b.stayTotal).map((l, i) => `<tr${i >= 6 ? ' class="off"' : ''}>
    <td>${esc(l.name)}</td><td class="num">${money(l.perDay, cur)}</td><td class="num">${money(l.stayTotal, cur)}${l.billedDays !== 7 ? ` <span class="muted">(${l.billedDays} days)</span>` : ''}</td>
    <td>${transfer[l.transfer]}</td><td>${l.mayLead ? '' : '<span class="sev warn">never first</span>'}${i >= 6 ? ' <span class="muted">not on chart (6 max)</span>' : ''}</td></tr>`).join('')
  const groups = (Object.keys(G) as Group[]).map((g) => {
    const xs = ds.filter((d) => groupOf(d) === g)
    if (!xs.length) return ''
    const body = g === 'swap' ? `<ul class="swaps">${xs.map(swapRow).join('')}</ul>` : xs.map(holdCard).join('')
    return `<details${g === 'swap' ? ' open' : ''}><summary>${GROUP_TITLE[g]} <span class="count">${n(xs.length)}</span></summary>${body}</details>`
  }).join('')
  const held = ds.filter((d) => d.action === 'hold').length
  return `<section class="airport" id="${code}">
  <div class="ahead"><h2>${code}</h2><span class="muted">${n(ds.length)} chart spots in ${n(postsOf(ds))} posts · <b class="good">${n(ds.length - held)} swap</b> · <b class="${held ? 'warnt' : 'muted'}">${n(held)} held</b></span></div>
  ${charts.length ? `<div class="charts">${charts.map((c) => `<figure><img src="${c.file}" alt="${esc(c.alt)}" width="800" height="500" loading="lazy"><figcaption><b>${c.kind === 'daily' ? 'Daily chart' : '7-day table'}</b> · caption on the post: ${esc(c.alt)}</figcaption></figure>`).join('')}</div>`
    : `<p class="note">No chart this run: ${esc(plan.noChart[code] ?? 'not searched')}.</p>`}
  ${lots.length ? `<div class="tablewrap"><table><thead><tr><th>Lot in the ${esc(fmtStay(plan.checkin, plan.checkout))} search</th><th class="num">Per day</th><th class="num">7-day stay</th><th>To terminal</th><th></th></tr></thead><tbody>${lotRows}</tbody></table></div>` : ''}
  ${excluded.length ? `<p class="small muted">Left off: ${excluded.map(esc).join('; ')}.</p>` : ''}
  ${groups}
</section>`
}

const stat = (num: number, label: string) => `<div class="stat"><b>${n(num)}</b><span>${label}</span></div>`
const decideItem = (g: Group, text: string, rec: string) => G[g].length ? `<li><b>${GROUP_TITLE[g]}: ${n(G[g].length)} charts in ${n(postsOf(G[g]))} posts.</b> ${text}<div class="rec">${rec}</div></li>` : ''

const html = `<title>Chart Redraw Contact Sheet</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&display=swap">
<style>
/* Triply review page: decisions first, then one section per airport (charts, lots, grouped post list). */
:root {
  --bg: #fbfaf9; --surface: #ffffff; --fg: #1e293b; --muted: #5d6676; --rule: #e7e3df;
  --navy: #1a1a2e; --accent: #e8603f; --accent-soft: #fdeae4;
  --good: #1f7a4d; --good-soft: #e3f3ea; --warn: #9a6200; --warn-soft: #fbf0d9;
  --stop: #a2322a; --stop-soft: #f8e3e1; --info: #2b4c7e; --info-soft: #e4ecf7; --mark: #fff1b8;
  --display: "Poppins", "Segoe UI", system-ui, sans-serif;
  --body: "Inter", "Segoe UI", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #14141f; --surface: #1c1c2b; --fg: #e6e8ee; --muted: #a3a9b8; --rule: #2e2e42;
  --navy: #e6e8ee; --accent: #ff8a6b; --accent-soft: #3a2420;
  --good: #6fd29c; --good-soft: #17322a; --warn: #f0c060; --warn-soft: #362c14;
  --stop: #ff8f86; --stop-soft: #3a1f1d; --info: #9fb9e3; --info-soft: #1f2a3f; --mark: #4a4020; color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #14141f; --surface: #1c1c2b; --fg: #e6e8ee; --muted: #a3a9b8; --rule: #2e2e42;
  --navy: #e6e8ee; --accent: #ff8a6b; --accent-soft: #3a2420;
  --good: #6fd29c; --good-soft: #17322a; --warn: #f0c060; --warn-soft: #362c14;
  --stop: #ff8f86; --stop-soft: #3a1f1d; --info: #9fb9e3; --info-soft: #1f2a3f; --mark: #4a4020; color-scheme: dark; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font-family: var(--body); font-size: 15px; line-height: 1.55; margin: 0; }
.wrap { max-width: 1000px; margin: 0 auto; padding-block: 28px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
h1, h2, h3 { font-family: var(--display); color: var(--navy); line-height: 1.2; text-wrap: balance; margin: 0; }
h1 { font-size: 30px; } h2 { font-size: 22px; }
p { margin: 0; }
a { color: var(--accent); }
.kicker { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); font-weight: 600; margin-bottom: 6px; }
.lede { color: var(--muted); margin-top: 10px; max-width: 72ch; }
.muted { color: var(--muted); } .small { font-size: 13px; margin-top: 8px; } .good { color: var(--good); } .warnt { color: var(--warn); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 22px; }
.stat { background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; padding: 12px 14px; }
.stat b { display: block; font-family: var(--display); font-size: 24px; color: var(--navy); font-variant-numeric: tabular-nums; }
.stat span { font-size: 12.5px; color: var(--muted); }
.decide { background: var(--surface); border: 1px solid var(--rule); border-radius: 14px; padding: 16px 18px; margin-top: 26px; }
.decide h2 { font-size: 19px; margin-bottom: 8px; }
.decide ol { margin: 0; padding-left: 20px; } .decide li { margin: 10px 0; }
.rec { margin-top: 6px; padding: 8px 12px; background: var(--good-soft); border-left: 3px solid var(--good); border-radius: 0 8px 8px 0; font-size: 14px; }
.note { margin-top: 12px; padding: 10px 14px; background: var(--warn-soft); border-radius: 10px; font-size: 14px; }
.how { margin-top: 18px; font-size: 14px; color: var(--muted); }
.how ul { margin: 6px 0 0; padding-left: 20px; } .how li { margin: 3px 0; }
.toc { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 22px; }
.toc a { font-size: 13px; text-decoration: none; padding: 3px 9px; border: 1px solid var(--rule); border-radius: 999px; background: var(--surface); color: var(--navy); }
.airport { margin-top: 34px; padding-top: 18px; border-top: 2px solid var(--rule); }
.ahead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin-top: 12px; }
figure { margin: 0; min-width: 0; }
figure img { display: block; width: 100%; height: auto; border: 1px solid var(--rule); border-radius: 10px; background: #fff; }
figcaption { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
.tablewrap { overflow-x: auto; margin-top: 12px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--rule); white-space: nowrap; }
th { font-weight: 600; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
td:first-child { white-space: normal; min-width: 180px; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.off td { color: var(--muted); }
.sev { font-size: 11px; font-weight: 600; letter-spacing: .03em; text-transform: uppercase; padding: 1px 7px; border-radius: 999px; white-space: nowrap; }
.sev.stop { background: var(--stop-soft); color: var(--stop); } .sev.warn { background: var(--warn-soft); color: var(--warn); } .sev.info { background: var(--info-soft); color: var(--info); }
details { margin-top: 12px; } summary { cursor: pointer; font-weight: 600; color: var(--navy); }
summary .count { font-family: var(--display); color: var(--accent); margin-left: 6px; font-variant-numeric: tabular-nums; }
summary:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.hold { background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; padding: 10px 14px; margin-top: 8px; min-width: 0; }
.hhead { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; font-weight: 600; overflow-wrap: anywhere; }
.notes { margin: 6px 0 0; padding-left: 18px; font-size: 13.5px; }
.ctx { font-size: 13px; margin-top: 8px; padding: 8px 10px; background: var(--bg); border-radius: 8px; overflow-wrap: anywhere; }
mark { background: var(--mark); color: inherit; padding: 0 2px; border-radius: 3px; }
.swaps { margin: 8px 0 0; padding-left: 18px; font-size: 13px; } .swaps li { margin: 4px 0; overflow-wrap: anywhere; }
.alone { margin: 8px 0 0; padding-left: 18px; font-size: 13px; } .alone li { margin: 3px 0; overflow-wrap: anywhere; }
.foot { margin-top: 40px; color: var(--muted); font-size: 13px; }
@media (max-width: 520px) { h1 { font-size: 25px; } }
</style>
<div class="wrap">
  <div class="kicker">Triply · blog chart redraw · stage 1 · ${esc(fmtDate(snap.asOf))}</div>
  <h1>New rate charts, before anything goes live</h1>
  <p class="lede">One live triplypro.com search per airport on ${esc(fmtDate(snap.asOf))}, for a 7-day stay ${esc(fmtStay(snap.checkin, snap.checkout))}, drawn into a daily chart and a 7-day table per airport. They would replace the October charts that call lots we don't sell "bookable on Triply". Nothing on the live site has changed.</p>

  <div class="stats">
    ${stat(plan.charts.length, `new charts, ${plan.charts.length / 2} airports`)}
    ${stat(D.length, `old charts in ${n(postsOf(D))} live posts`)}
    ${stat(G.swap.length, `ready to swap (${n(postsOf(G.swap))} posts)`)}
    ${stat(D.length - G.swap.length, `held for you (${n(postsOf(D.filter((d) => d.action === 'hold')))} posts)`)}
    ${stat(leftAlone.length + unused.length, 'left alone (no lot prices, or unused)')}
  </div>

  <div class="decide">
    <h2>What you're deciding</h2>
    <ol>
      <li><b>Do the charts look right?</b> Each airport below shows both charts, their captions and the lots behind them. ${fallbackCount ? `${fallbackCount} airport(s) get the airport-only chart (Triply sells nothing there).` : 'No airport in scope needs the airport-only chart this run.'}</li>
      ${decideItem('swap', `These are the October standard charts (${new Set(G.swap.map((d) => d.media_id)).size} images reused across posts: a daily chart and a 7-day table per airport, the ones that call unsold lots "bookable on Triply"). Each is replaced like for like: same airport, same kind of chart. But the post's text quotes October lot prices somewhere — every one of the ${n(postsOf(D))} posts does (often a template line like "lots on Triply from about $X/day") — so a new dated chart will sit beside older prose prices until the text pass. ${n(firstInTextPass(G.swap))} of these posts also name a lot we don't sell or miscount our lots.`, 'Swap now, before the text pass: the old charts are false (unsold lots "bookable on Triply", undated); the new ones are dated and true. Then the text pass takes per-lot prices out of the prose, starting with the posts that name lots we don\'t sell. The alternative is to wait until the text pass is done.')}
      ${decideItem('notrate', `The engine's one-off charts (each its own comparison: 3-day costs, a hotel package, one garage highlighted…), plus maps, timelines, step-by-step guides and transport images that also price lots at October prices. The standard chart can't reliably stand in for them. ${n(notrateUnsold.length)} name a lot we don't sell in their own caption.`, `Keep them for now. ${notrateUnsold.length ? `Remove the ${n(notrateUnsold.length)} whose caption names a lot we don't sell. ` : ''}In the text pass, each post gets the standard chart where it fits, or loses the image.`)}
      ${decideItem('lotpost', "Posts about one lot (Cambria, a Marriott, Fly Away…). The airport chart may not show that lot, or shows a different price from the post's.", 'Keep the old image for now; look at each with the text pass.')}
      ${decideItem('currency', "Toronto, Montreal and Calgary. ResLab prices these lots in Canadian dollars, and our checkout charges the same number in US dollars. A chart can't say which price is real until that's settled.", 'Decide the checkout currency first (separate from this work: 5 live bookings since Oct 18). Then these airports get charts.')}
      ${!G.currency.length && Object.values(plan.noChart).some((r) => r.includes('checkout charges')) ? `<li><b>Canadian airports (${Object.entries(plan.noChart).filter(([, r]) => r.includes('checkout charges')).map(([c]) => c).join(', ')}): no chart this run.</b> ResLab prices their lots in Canadian dollars and our checkout charges the same number in US dollars (5 live bookings since Oct 18), so a chart can't say which price is real. Their October images are all one-offs, held above anyway.<div class="rec">Decide the checkout currency first; that is separate from this work.</div></li>` : ''}
      ${decideItem('other', 'Posts filed under one airport but about another (Love Field under DFW), posts that would get a third chart, and posts where another image with October off-site prices stays.', 'Keep the old charts for now; these need a per-post look.')}
    </ol>
  </div>

  <div class="how">
    <b>How the numbers were made</b>
    <ul>
      <li>Lot price = the search card's total for the stay (taxes, fees and our service fee included) ÷ the lot's billed days. Lots that bill 8 days for the 7-day stay are starred.</li>
      <li>Only lots the search returned that day, in order of the stay's total, up to 6 per chart. A lot with a paid shuttle or a "do not lead" note is never first.</li>
      <li>Cruise-port lots (their shuttle runs to the port, not the terminal) are left off airport charts; Port Everglades shows only lots with a known port shuttle.</li>
      <li>"To terminal" comes from each lot's own shuttle text on our site: "No shuttle" only where the lot says so; "—" where it's neither a shuttle nor a valet.</li>
      <li>On-airport rows are the October postings, labelled "checked October 2026". Airports without a checked row show our lots only.</li>
      <li>Whether a chart can be swapped is decided on the image: a rate chart the new one fully replaces, at an airport with a chart, in a post about that airport and not about one lot. Images whose caption is about another topic (maps, timelines, steps, taxis, rideshare, oversized vehicles, EV charging, hourly or free parking), one-off images in posts about those topics, and one-off charts of the airport's own lots where our chart has no on-airport rows are never swapped.</li>
      <li>The post text (all of it) is read only to rank posts for the text pass: lot prices, lots we don't sell, wrong lot counts. Four review rounds tried to find posts whose text agrees with a new chart; reading whole posts showed none does.</li>
      <li>Left alone: ${n(inv.items.filter((i) => i.cls === 'airport').length)} images with on-airport prices only (listed at the bottom), ${n(inv.items.filter((i) => i.cls === 'not-rate').length)} with no parking prices, ${n(unused.length)} chart images no post uses.</li>
    </ul>
  </div>

  <nav class="toc" aria-label="Airports">${codes.map((c) => `<a href="#${c}">${c}</a>`).join('')}<a href="#left-alone">Left alone</a></nav>

  ${codes.map(airportSection).join('\n')}

  <section class="airport" id="left-alone">
    <h2>Left alone: on-airport prices only</h2>
    <p class="small muted">Captions the sorter read as pricing only the airport's own parking. Skim for any that price an off-site lot.</p>
    <details><summary>${n(inv.items.filter((i) => i.cls === 'airport' && i.uses.length).length)} images in use <span class="count"></span></summary>
      <ul class="alone">${inv.items.filter((i) => i.cls === 'airport' && i.uses.length).map((i) => `<li><b>${i.code}</b> · ${esc(i.alt.slice(0, 200))}${i.alt.length > 200 ? '…' : ''} <span class="muted">(${i.uses.length} post${i.uses.length > 1 ? 's' : ''})</span></li>`).join('')}</ul>
    </details>
  </section>

  <p class="foot">Searches on ${esc(snap.asOf)} are tagged "triply-chart-redraw" in the search log. Built by reports/chart-redraw/ in the blog engine; plan in notes/2026-11-02-chart-redraw-plan.md. After your decisions: a pilot write on five airports, with a backup of every post first.</p>
</div>`

fs.mkdirSync(`${OUT}/contact/charts`, { recursive: true })
// Drop the previous run's chart copies (only this script's own <CODE>-<kind>.png files), so a held airport shows none.
for (const f of fs.readdirSync(`${OUT}/contact/charts`)) if (/^[A-Z]{3}-(?:daily|week)\.png$/.test(f)) fs.rmSync(`${OUT}/contact/charts/${f}`)
for (const c of plan.charts) fs.copyFileSync(`${OUT}/${c.file}`, `${OUT}/contact/${c.file}`)
fs.writeFileSync(`${OUT}/contact/index.html`, html)
console.log(`wrote ${OUT}/contact/index.html (${Math.round(html.length / 1024)} KB) + ${plan.charts.length} charts`)
for (const g of Object.keys(G) as Group[]) console.log(`  ${g.padEnd(9)} ${String(G[g].length).padStart(4)} charts / ${String(postsOf(G[g])).padStart(4)} posts`)
