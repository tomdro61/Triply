// Chart redraw, step 5 (no writes): one page with every new chart, its caption, the lots behind it and every post
// block it would replace — held ones expanded with the text around them. Tom approves from this page.
// Writes reports/chart-redraw/out/contact/index.html + charts/ (publish the folder as an artifact).
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
const posts = (ds: Decision[]) => new Set(ds.map((d) => d.post_id)).size
const D = plan.decisions
const swaps = D.filter((d) => d.action === 'swap'), holds = D.filter((d) => d.action === 'hold')
const flagged = (f: Flag) => D.filter((d) => d.flags.includes(f))
const leftAlone = inv.items.filter((i) => i.cls === 'airport' || i.cls === 'not-rate')
const orphans = inv.items.filter((i) => (i.cls === 'standard' || i.cls === 'one-off') && !i.uses.length)
const codes = [...new Set(plan.charts.map((c) => c.code))].sort()

const FLAG_LABEL: Record<Flag, string> = { unsold: 'names a lot we don\'t sell', price: 'old price', 'pre-fee': 'pre-fee rate', missing: 'lot not in this search' }
const FLAG_CLASS: Record<Flag, string> = { unsold: 'stop', price: 'warn', 'pre-fee': 'info', missing: 'info' }
const chip = (f: Flag) => `<span class="sev ${FLAG_CLASS[f]}">${FLAG_LABEL[f]}</span>`
const transfer: Record<ChartLot['transfer'], string> = { shuttle: 'Shuttle', valet: 'Valet', paid: 'Paid shuttle', none: 'No shuttle', unknown: '—' }

/** The text around a chart, cut to the part a flag points at (a figure or a lot name), ~420 characters. */
function excerpt(d: Decision): string {
  const ctx = d.context.replace(/\s+/g, ' ').replace(/ \|\| /g, ' ¶ ')
  const needles = d.notes.flatMap((x) => [...x.matchAll(/"([^"]+)"|((?:C\$|\$)\d[\d.]*\/day)/g)].map((m) => (m[1] ?? m[2]).replace('/day', '')))
  const at = needles.map((k) => ctx.indexOf(k)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0
  const from = Math.max(0, at - 200), to = Math.min(ctx.length, from + 420)
  let s = esc(ctx.slice(from, to))
  for (const k of needles) if (k.length >= 3) s = s.split(esc(k)).join(`<mark>${esc(k)}</mark>`)
  return `${from > 0 ? '… ' : ''}${s}${to < ctx.length ? ' …' : ''}`
}

const blog = (slug: string) => `https://www.triplypro.com/blog/${slug}`
const decisionRow = (d: Decision) => `<li><a href="${blog(d.slug)}">${esc(d.slug)}</a> <span class="muted">· ${d.kind === 'week' ? '7-day table' : 'daily chart'}${d.kind !== d.oldKind ? ' (was the other kind)' : ''}</span> ${d.flags.map(chip).join(' ')}</li>`

function airportSection(code: string): string {
  const row = snap.airports[code]
  const lots = row?.lots ?? []
  const charts = plan.charts.filter((c) => c.code === code)
  const ds = D.filter((d) => d.code === code)
  const h = ds.filter((d) => d.action === 'hold'), s = ds.filter((d) => d.action === 'swap')
  const excluded = run.excluded[code] ?? []
  const lotRows = [...lots].sort((a, b) => Number(b.mayLead) - Number(a.mayLead) || a.perDay - b.perDay).map((l, i) => `<tr${i >= 6 ? ' class="off"' : ''}>
    <td>${esc(l.name)}</td><td class="num">${money(l.perDay, row!.currency ?? 'USD')}</td><td class="num">${money(l.stayTotal, row!.currency ?? 'USD')}${l.billedDays !== 7 ? ` <span class="muted">(${l.billedDays} days)</span>` : ''}</td>
    <td>${transfer[l.transfer]}</td><td>${l.mayLead ? '' : '<span class="sev warn">never first</span>'}${i >= 6 ? ' <span class="muted">not on chart (6 max)</span>' : ''}</td></tr>`).join('')
  return `<section class="airport" id="${code}">
  <div class="ahead"><h2>${code}</h2><span class="muted">${n(ds.length)} chart spots in ${n(posts(ds))} posts · <b class="good">${n(s.length)} swap</b> · <b class="${h.length ? 'warnt' : 'muted'}">${n(h.length)} held</b></span></div>
  <div class="charts">${charts.map((c) => `<figure><img src="${c.file}" alt="${esc(c.alt)}" width="800" height="500" loading="lazy"><figcaption><b>${c.kind === 'daily' ? 'Daily chart' : '7-day table'}</b> · caption on the post: ${esc(c.alt)}</figcaption></figure>`).join('')}</div>
  <div class="tablewrap"><table><thead><tr><th>Lot in the ${esc(fmtStay(plan.checkin, plan.checkout))} search</th><th class="num">Per day</th><th class="num">7-day stay</th><th>To terminal</th><th></th></tr></thead><tbody>${lotRows}</tbody></table></div>
  ${excluded.length ? `<p class="small muted">Left off: ${excluded.map(esc).join('; ')}.</p>` : ''}
  ${h.length ? `<h3>Held (${n(h.length)})</h3>${h.map((d) => `<div class="hold"><div class="hhead"><a href="${blog(d.slug)}">${esc(d.slug)}</a> ${d.flags.map(chip).join(' ')}</div>
    <ul class="notes">${[...d.blockers, ...d.notes].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <p class="ctx">${excerpt(d)}</p><p class="small muted">Old caption: ${esc(d.oldAlt.slice(0, 220))}${d.oldAlt.length > 220 ? '…' : ''}</p></div>`).join('')}` : ''}
  ${s.length ? `<details><summary>Swap list (${n(s.length)})</summary><ul class="swaps">${s.map(decisionRow).join('')}</ul></details>` : ''}
</section>`
}

const html = `<title>Chart Redraw Contact Sheet</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@600;700&family=Inter:wght@400;500;600&display=swap">
<style>
/* Triply review page: one column, airports in alphabetical order, decisions first. */
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
h1 { font-size: 30px; } h2 { font-size: 22px; } h3 { font-size: 16px; margin-top: 18px; }
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
.decide ol { margin: 0; padding-left: 20px; } .decide li { margin: 8px 0; }
.rec { margin-top: 6px; padding: 8px 12px; background: var(--good-soft); border-left: 3px solid var(--good); border-radius: 0 8px 8px 0; font-size: 14px; }
.how { margin-top: 18px; font-size: 14px; color: var(--muted); }
.how ul { margin: 6px 0 0; padding-left: 20px; } .how li { margin: 3px 0; }
.toc { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 22px; }
.toc a { font-size: 13px; text-decoration: none; padding: 3px 9px; border: 1px solid var(--rule); border-radius: 999px; background: var(--surface); color: var(--navy); font-variant-numeric: tabular-nums; }
.toc a.h { border-color: var(--warn); }
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
.hold { background: var(--surface); border: 1px solid var(--rule); border-radius: 12px; padding: 10px 14px; margin-top: 8px; min-width: 0; }
.hhead { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; font-weight: 600; overflow-wrap: anywhere; }
.notes { margin: 6px 0 0; padding-left: 18px; font-size: 13.5px; }
.ctx { font-size: 13px; margin-top: 8px; padding: 8px 10px; background: var(--bg); border-radius: 8px; overflow-wrap: anywhere; }
mark { background: var(--mark); color: inherit; padding: 0 2px; border-radius: 3px; }
details { margin-top: 12px; } summary { cursor: pointer; font-weight: 600; color: var(--navy); }
summary:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.swaps { margin: 8px 0 0; padding-left: 18px; font-size: 13px; columns: 2 320px; } .swaps li { margin: 3px 0; break-inside: avoid; overflow-wrap: anywhere; }
.foot { margin-top: 40px; color: var(--muted); font-size: 13px; }
@media (max-width: 520px) { h1 { font-size: 25px; } }
</style>
<div class="wrap">
  <div class="kicker">Triply · blog chart redraw · stage 1 · ${esc(fmtDate(snap.asOf))}</div>
  <h1>New rate charts, before anything goes live</h1>
  <p class="lede">One live triplypro.com search per airport on ${esc(fmtDate(snap.asOf))}, for a 7-day stay ${esc(fmtStay(snap.checkin, snap.checkout))}, drawn into a daily chart and a 7-day table for each airport. They would replace the October charts that call lots we don't sell "bookable on Triply". Nothing on the live site has changed.</p>

  <div class="stats">
    <div class="stat"><b>${plan.charts.length}</b><span>new charts, ${codes.length} airports</span></div>
    <div class="stat"><b>${n(D.length)}</b><span>October charts in ${n(posts(D))} live posts</span></div>
    <div class="stat"><b>${n(swaps.length)}</b><span>swap as proposed (${n(posts(swaps))} posts)</span></div>
    <div class="stat"><b>${n(holds.length)}</b><span>held for you (${n(posts(holds))} posts)</span></div>
    <div class="stat"><b>${n(leftAlone.length + orphans.length)}</b><span>left alone (no lot prices, or unused)</span></div>
  </div>

  <div class="decide">
    <h2>What you're deciding</h2>
    <ol>
      <li><b>Do the charts look right?</b> Each airport below shows both charts, their captions and the lots behind them.</li>
      <li><b>The ${n(posts(holds))} held posts.</b> The text next to the chart ${n(posts(flagged('unsold')))} times names a lot we don't sell, and ${n(posts(flagged('price')))} times quotes an October off-site price that no lot of ours has today. Swapping the chart puts today's dated price next to that old text; keeping the old chart keeps unsold lots marked "bookable on Triply".
        <div class="rec">Recommended: swap these too, and list the posts for a text fix (removing per-lot prices from prose is already on the roadmap).</div></li>
      <li><b>The pilot.</b> DFW (one lot), a new-airport post (BDL), YYZ (Canadian dollars, valet lots), JFK and LGA. No airport in scope needs the airport-only fallback chart this time.</li>
    </ol>
  </div>

  <div class="how">
    <b>How the numbers were made</b>
    <ul>
      <li>Lot price = the search card's total for the stay (taxes, fees and our service fee included) ÷ the lot's billed days. Lots that bill 8 days for the 7-day stay are starred on the table.</li>
      <li>Only lots the search returned that day. Up to 6 per chart, cheapest first; a lot with a paid shuttle or a "do not lead" note is never first.</li>
      <li>"To terminal" comes from each lot's own shuttle text on our site: "No shuttle" only where the lot says so; "—" where it's neither a shuttle nor valet (a hotel Lyft, the AirTrain).</li>
      <li>On-airport rows are the October postings, labelled "checked October 2026". YYZ's were never verified, so YYZ shows our lots only. Port Everglades shows only lots with a known cruise-port shuttle.</li>
      <li>Also flagged but swapped: ${n(posts(flagged('pre-fee')))} posts quote a lot's rate before taxes and fees (the chart shows the total), and ${n(posts(flagged('missing')))} name a lot we sell that was sold out for these dates.</li>
      <li>Left alone: ${n(inv.items.filter((i) => i.cls === 'airport').length)} charts with on-airport prices only, ${n(inv.items.filter((i) => i.cls === 'not-rate').length)} with no parking prices (arrival times, taxi fares, maps), ${n(orphans.length)} chart images no post uses.</li>
    </ul>
  </div>

  <nav class="toc" aria-label="Airports">${codes.map((c) => `<a href="#${c}"${D.some((d) => d.code === c && d.action === 'hold') ? ' class="h"' : ''}>${c}</a>`).join('')}</nav>

  ${codes.map(airportSection).join('\n')}

  <p class="foot">Search window ${esc(snap.asOf)} (searches tagged "triply-chart-redraw"). Built by reports/chart-redraw/ in the blog engine; plan in notes/2026-11-02-chart-redraw-plan.md. Next step after your approval: the pilot write for the five airports, with a backup of every post first.</p>
</div>`

fs.mkdirSync(`${OUT}/contact/charts`, { recursive: true })
for (const c of plan.charts) fs.copyFileSync(`${OUT}/${c.file}`, `${OUT}/contact/${c.file}`)
fs.writeFileSync(`${OUT}/contact/index.html`, html)
console.log(`wrote ${OUT}/contact/index.html (${Math.round(html.length / 1024)} KB) + ${plan.charts.length} charts`)
