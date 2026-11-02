// Fixed-layout replacement infographics, drawn only from factsheet data (no LLM: the free-form
// regen invented facts and broke layouts). Per post, the 1st replaced image = daily-rate bars,
// the 2nd = 7-day cost table. Overwrites <a>/img/<slug>-<i>.{svg,png,json} made by regen-infographics.mts.
//   npx tsx reports/lot-rewrite/make-infographics.mts
import fs from 'fs'
import { Resvg } from '@resvg/resvg-js'

// ex = exact off-site daily rate: multi-day totals use ex x days (rounded), matching the article text.
// wk = posted weekly rate (on-airport): 7-day figures use it instead of daily x 7 (SEA General Parking $222/week).
type Row = { name: string; lo: number; hi: number; off: boolean; shuttle: string; ex?: number; wk?: number }
const tot = (r: Row, k: number, v: number) => (r.wk !== undefined && k === 7 ? r.wk : r.ex !== undefined && k > 1 ? Math.round(r.ex * k) : v * k)
const ON: Record<string, [string, number, number, number?][]> = {
  atl: [['Domestic Park-Ride', 15, 15], ['ATL Select', 15, 20], ['Economy Lots', 20, 20], ['Daily Decks', 30, 30], ['International Park-Ride', 30, 30]],
  lax: [['Budget Parking', 20, 20], ['Economy Parking', 35, 35], ['CTA Terminal Garages', 60, 60], ['CTA Premium', 70, 70], ['CTA Valet', 75, 75]],
  phl: [['Economy Lot', 18, 18], ['Garages (upper levels)', 32, 32], ['Short-Term (ground level)', 54, 54]],
  fll: [['Overflow (peak only)', 10, 10], ['Long-Term Garages', 20, 20], ['Valet', 30, 30], ['Short-Term Garages', 36, 36]],
  mco: [['Economy: Park Place & West Park', 14, 14], ['Garages A, B, C & Terminal Top', 24, 24], ['Valet', 35, 35]],
  msp: [['Quick Ride Ramp', 19, 19], ['Value Parking (Terminal 2)', 23, 23], ['Terminal 1 Daily Ramps', 30, 30], ['Valet (Terminal 1)', 55, 55]],
  sea: [['General Parking (garage)', 37, 37, 222], ['Reserved Parking (Floor 4)', 47, 47]],
  clt: [['Long Term Lots 1 & 2', 14, 14], ['Daily North Lot', 18, 18], ['Express Decks', 24, 24], ['Daily Decks', 28, 28], ['Hourly Deck', 35, 35]],
  iad: [['Economy Lot', 20, 20], ['Garages 1 & 2', 25, 25], ['Valet (Service Center)', 39, 39], ['Terminal Lot', 40, 40]],
  iah: [['ecopark (uncovered)', 10, 10], ['ecopark covered / ecopark2', 12, 12], ['Terminal garages', 25, 25], ['Valet', 30, 30]],
  aus: [['Economy Lots', 14, 14], ['Blue Garage', 26, 26], ['Red Garage', 35, 35]],
  dca: [['Economy Lot', 25, 25], ['Parking 1 & 2 garages', 35, 35]],
  las: [['Economy / Remote Lot', 14, 14], ['Long Term garage', 20, 20], ['Valet', 34, 34], ['Short Term garage', 38, 38]],
  tpa: [['Economy Garage', 22, 22], ['Long Term Garage', 26, 26], ['Short Term Garage', 32, 32]],
  dfw: [['Remote (TollTag)', 14, 14], ['Express uncovered', 20, 20], ['Express covered', 23, 23], ['Terminal garages', 37, 37], ['Valet', 55, 55]],
  sfo: [['Long-Term Garage', 27, 27], ['International Garage', 37, 37], ['Domestic Garage', 41, 41], ['ParkFAST', 60, 60]],
  bna: [['Economy', 24, 24], ['Garages', 36, 36], ['Valet', 48, 48]],
  bos: [['Advance reservation', 29, 29], ['Economy (walk-up)', 37, 37], ['Terminal garages', 46, 46]],
  bwi: [['Long Term', 11, 11], ['Express', 14, 14], ['Daily Garage', 16, 16], ['Hourly Garage', 30, 30]],
  den: [['Pikes Peak', 10, 10], ['Economy', 20, 20], ['Garages', 35, 35]],
  jfk: [['Long-term lot (prebook from)', 35, 35], ['Long-term lot (drive-up)', 45, 45], ['Red Lot (T8)', 70, 70], ['Yellow Lot (T5)', 75, 75], ['Blue Lot (T4)', 82, 82]],
  lga: [['Prepaid Economy (from)', 40, 40], ['Terminal A (prebook from)', 50, 50], ['Terminal B', 80, 80], ['Terminal C', 89, 89]],
  mia: [['Economy Park & Ride', 12, 12], ['Terminal garages', 25, 25], ['Valet', 39, 39]],
  san: [['Terminal 1/2 Parking Plazas', 40, 40], ['Valet', 60, 60]],
  ewr: [], // on-airport rates not published by the airport (13 Oct 2026): off-site lots only
  phx: [['Park & Walk (seasonal)', 10, 10], ['East Economy uncovered / 24th St', 16, 16], ['Economy garages (East & West)', 19, 19], ['Terminal 3 & 4 garages', 33, 33], ['Premium (T3 & T4)', 37, 37], ['Valet', 43, 43]],
  dtw: [['Green Lot', 20, 20], ['Big Blue Deck long-term', 23, 23], ['McNamara long-term', 32, 32], ['Short-term garages', 43, 44], ['McNamara valet', 51, 51]],
  pdx: [['Economy (7th day free)', 15, 15, 90], ['Long-Term garage', 24, 24], ['Short-Term garage', 30, 30], ['Valet', 45, 45]], // flypdx.com 14 Oct 2026; Economy 7 days $90 per the official calculator
  // YYZ (14 Oct 2026) is CAD: values are C$, but money()/alt() print a bare "$" - fix the currency prefix before rendering YYZ.
  // Source: parkingguidehub.com (Oct 2026); torontopearson.com blocked by captcha, all (verify). 4th value = posted first-7-day cap.
  yyz: [['Value Park Garage', 32, 32, 160], ['Daily Park T1 & T3 garages', 42, 42, 235], ['Preferred Park T1', 46, 46, 255], ['Valet Care T1 (+C$20 fee)', 56, 56, 275], ['Express Park T1', 59, 59]],
  ord: [['Economy Lots G & H', 16, 16], ['Economy Lot F (covered)', 30, 30], ['Main & T5 Garages (daily)', 43, 43], ['Main Garage Level 1 (hourly)', 79, 79]],
}
const C = { navy: '#1A1A2E', coral: '#f87356', green: '#22c55e', gray: '#64748b', line: '#e2e8f0' }
const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const short = (n: string) => n.replace(/\s*\([A-Z]{3}\)/g, '').replace(/\s+Formerly.*$/i, '').replace(/^(\d+) AIRPORT BLVD$/, '$1 Airport Blvd').replace(/ AIRPORT Parking$/, ' Airport Parking').replace(/ by Hilton Ft\. Lauderdale Airport$/, ' by Hilton').trim().replace(/^(.{1,34})\s.*$/, (m, p) => (m.length > 34 ? p : m))
const money = (r: Row, k = 1) => (r.off ? '~' : '') + (r.lo === r.hi ? `$${tot(r, k, r.lo)}` : `$${tot(r, k, r.lo)}–$${tot(r, k, r.hi)}`)
const t = (X: number, Y: number, s: string, o = '') => `<text x="${X}" y="${Y}" font-family="Arial, Helvetica, sans-serif" ${o}>${x(s)}</text>`

function rows(a: string, fact: any): Row[] {
  // chartExclude: lot not useful to flyers (e.g. TPA cruise-port-only); chartShuttle: override the shuttle cell.
  const off = fact.sellableOnTriply.filter((l: any) => !l.chartExclude).map((l: any) => ({ name: short(l.name), lo: Math.round(l.dailyRate), hi: Math.round(l.dailyRate), ex: l.dailyRate, off: true,
    shuttle: l.chartShuttle ? l.chartShuttle : !l.shuttleInfo ? '—' : /^\s*no shuttle/i.test(l.shuttleInfo) ? 'No shuttle' : 'Yes' }))
    .sort((p: Row, q: Row) => p.lo - q.lo).slice(0, 6)
  return [...off, ...ON[a].map(([name, lo, hi, wk]) => ({ name, lo, hi, off: false, shuttle: '', ...(wk ? { wk } : {}) }))]
}
const frame = (title: string, sub: string, body: string, foot: string) => `<svg width="800" height="500" xmlns="http://www.w3.org/2000/svg">
<rect width="800" height="500" fill="#ffffff"/>
${t(30, 42, title, `font-size="22" font-weight="bold" fill="${C.navy}"`)}
${t(30, 66, sub, `font-size="13" fill="${C.gray}"`)}
<rect x="560" y="52" width="12" height="12" fill="${C.green}"/>${t(578, 62, 'Off-site, bookable on Triply', `font-size="12" fill="${C.navy}"`)}
<rect x="560" y="70" width="12" height="12" fill="${C.navy}"/>${t(578, 80, 'On-airport', `font-size="12" fill="${C.navy}"`)}
${body}
${t(30, 470, foot, `font-size="11" fill="${C.gray}"`)}
${t(770, 488, 'Source: triplypro.com', `font-size="11" fill="${C.gray}" text-anchor="end"`)}
</svg>`
const FOOT = 'Off-site: daily rate shown on triplypro.com for a 7-day stay booked ahead; varies by date. On-airport: posted daily maximums.'

function bars(code: string, rs: Row[]): string {
  const max = Math.max(...rs.map(r => r.hi)), h = Math.min(32, 350 / rs.length), y0 = 100
  const body = rs.map((r, k) => {
    const y = y0 + k * h, w = Math.max(4, (r.hi / max) * 360)
    return `${t(290, y + h / 2 + 5, r.name, `font-size="13" fill="${C.navy}" text-anchor="end"`)}
<rect x="300" y="${y + 4}" width="${w.toFixed(1)}" height="${(h - 8).toFixed(1)}" fill="${r.off ? C.green : C.navy}"/>
${t(308 + w, y + h / 2 + 5, money(r) + '/day', `font-size="13" font-weight="bold" fill="${C.navy}"`)}`
  }).join('\n')
  return frame(`${code} parking: daily rates compared`, 'Off-site lots bookable on Triply vs on-airport parking', body, FOOT)
}

function table(code: string, rs: Row[]): string {
  const h = Math.min(30, 340 / (rs.length + 1)), y0 = 100, cols = [30, 330, 440, 560, 680]
  const head = ['Parking', 'Type', 'Per day', '7 days', 'Shuttle'].map((s, k) => t(cols[k], y0 + h / 2 + 5, s, `font-size="13" font-weight="bold" fill="${C.navy}"`)).join('')
  const body = rs.map((r, k) => {
    const y = y0 + (k + 1) * h, cy = y + h / 2 + 5
    return `${k % 2 ? '' : `<rect x="20" y="${y}" width="760" height="${h}" fill="#f8fafc"/>`}
${t(cols[0], cy, r.name, `font-size="13" fill="${C.navy}"`)}${t(cols[1], cy, r.off ? 'Off-site' : 'On-airport', `font-size="13" fill="${r.off ? C.green : C.gray}"`)}
${t(cols[2], cy, money(r), `font-size="13" fill="${C.navy}"`)}${t(cols[3], cy, money(r, 7), `font-size="13" font-weight="bold" fill="${C.navy}"`)}
${t(cols[4], cy, r.off ? r.shuttle : '', `font-size="13" fill="${C.gray}"`)}`
  }).join('\n')
  return frame(`${code} parking: what 7 days costs`, 'Off-site lots bookable on Triply vs on-airport parking', `<line x1="20" x2="780" y1="${y0 + h}" y2="${y0 + h}" stroke="${C.line}"/>` + head + body, FOOT)
}

function alt(code: string, rs: Row[], days: number): string {
  const off = rs.filter(r => r.off), on = rs.filter(r => !r.off)
  if (!on.length) { const k0 = days === 1 ? '/day' : ' for 7 days'; return `${code} parking ${days === 1 ? 'daily rates' : '7-day costs'}: off-site lots bookable on Triply from about ${tot(off[0], days, off[0].lo)}${k0} (${off[0].name}) to ${tot(off.at(-1)!, days, off.at(-1)!.hi)}${k0} (${off.at(-1)!.name}).` }
  const lo = on.reduce((m, r) => (r.lo < m.lo ? r : m)), hi = on.reduce((m, r) => (r.hi > m.hi ? r : m))
  const k = days === 1 ? '/day' : ' for 7 days'
  const offTxt = off.length === 1 ? `the off-site lot bookable on Triply, ${off[0].name}, about $${tot(off[0], days, off[0].lo)}${k}` : `off-site lots bookable on Triply from about $${tot(off[0], days, off[0].lo)}${k} (${off[0].name}) to $${tot(off.at(-1)!, days, off.at(-1)!.hi)}${k} (${off.at(-1)!.name})`
  return `${code} parking ${days === 1 ? 'daily rates' : '7-day costs'} compared: ${offTxt}; on-airport from $${tot(lo, days, lo.lo)}${k} (${lo.name}) to $${tot(hi, days, hi.hi)}${k} (${hi.name}).`
}

const ARGS = process.argv.slice(2).filter(x => /^[a-z]{3}$/.test(x))
for (const a of ARGS.length ? ARGS : Object.keys(ON)) {
  const dir = `reports/lot-rewrite/${a}`, fact = JSON.parse(fs.readFileSync(`${dir}/factsheet.json`, 'utf8')), rs = rows(a, fact), code = a.toUpperCase()
  const metas = fs.readdirSync(`${dir}/img`).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(`${dir}/img/${f}`, 'utf8')))
  const nth = new Map<string, number>()
  for (const m of metas.sort((p, q) => p.slug.localeCompare(q.slug) || p.i - q.i)) {
    const k = nth.get(m.slug) || 0; nth.set(m.slug, k + 1)
    const svg = k === 0 ? bars(code, rs) : table(code, rs), out = `${dir}/img/${m.slug}-${m.i}`
    fs.writeFileSync(`${out}.svg`, svg)
    fs.writeFileSync(`${out}.png`, new Resvg(svg, { fitTo: { mode: 'width', value: 800 }, font: { loadSystemFonts: true } }).render().asPng())
    fs.writeFileSync(`${out}.json`, JSON.stringify({ ...m, kind: k === 0 ? 'daily' : '7-day', alt: alt(code, rs, k === 0 ? 1 : 7) }, null, 1))
    console.log(`${m.slug}#${m.i}: ${k === 0 ? 'daily' : '7-day'}`)
  }
}
