/**
 * dashboard.ts — a zero-dependency local dashboard for the IMPROVEMENT engine.
 *
 * Turns the engine's on-disk JSON (reports/articles/*.json, treatment-roi.json,
 * maintenance-plan.json, the newest clarity report) into a live view so you can
 * SEE what the perf/maintain loop is doing: position trends, tiers, what's due,
 * treatment verdicts (helped/hurt/reverted), AI-citation, and UX friction.
 *
 * Read-only. No express/vite — Node's built-in http + inline SVG (fully offline).
 * Auto-polls every 60s, so a daily test run's fresh snapshots show up on reload.
 *
 * Run:  npm run dashboard      → http://localhost:4319   (or DASHBOARD_PORT)
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const ARTICLES_DIR = path.join(ROOT, 'reports', 'articles')
const REPORTS_DIR = path.join(ROOT, 'reports')
const PORT = parseInt(process.env.DASHBOARD_PORT || '4319', 10)

function readJson(p: string): any {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

function latestFile(dir: string, re: RegExp): string | null {
  try {
    const files = fs.readdirSync(dir).filter((f) => re.test(f)).sort()
    return files.length ? path.join(dir, files[files.length - 1]) : null
  } catch { return null }
}

// ── Aggregate everything the improvement engine has written ────────────────────
function buildData() {
  const records: any[] = []
  try {
    for (const f of fs.readdirSync(ARTICLES_DIR)) {
      if (!f.endsWith('.json')) continue
      const r = readJson(path.join(ARTICLES_DIR, f))
      if (r && r.slug) records.push(r)
    }
  } catch { /* dir may not exist yet */ }

  const buckets: Record<string, number> = { top3: 0, page1: 0, 'striking-distance': 0, page2plus: 0, unranked: 0, unknown: 0 }
  const tiers: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0, unclassified: 0 }
  const verdicts: Record<string, number> = { helped: 0, hurt: 0, neutral: 0, inconclusive: 0 }
  const changeTypes: Record<string, number> = {}
  let changesTotal = 0, changesPending = 0, changesMeasured = 0, reverted = 0
  let geoChecked = 0, geoCited = 0
  const cit: Record<string, number> = { gained: 0, lost: 0, held: 0, unknown: 0 }
  let clicks = 0, impressions = 0
  const posSamples: number[] = []

  const rows = records.map((r) => {
    const snaps: any[] = Array.isArray(r.snapshots) ? r.snapshots : []
    const last = snaps[snaps.length - 1] || null
    const positions = snaps.map((s) => s?.gsc?.totals?.position).filter((n) => typeof n === 'number')
    const bucket = last?.derived?.positionBucket || 'unknown'
    buckets[bucket] = (buckets[bucket] || 0) + 1

    const tier = r.maintenance?.tier
    tiers[tier === undefined || tier === null ? 'unclassified' : String(tier)]++

    const chs: any[] = Array.isArray(r.changes) ? r.changes : []
    let latestVerdict: string | null = null
    let pendingCount = 0
    for (const c of chs) {
      changesTotal++
      changeTypes[c.type] = (changeTypes[c.type] || 0) + 1
      if (c.reverted) reverted++
      if (c.measuredAfter) { changesMeasured++; verdicts[c.measuredAfter.verdict] = (verdicts[c.measuredAfter.verdict] || 0) + 1; latestVerdict = c.measuredAfter.verdict }
      else { changesPending++; pendingCount++ }
      if (c.citationDelta) cit[c.citationDelta] = (cit[c.citationDelta] || 0) + 1
    }
    if (last?.geo) { geoChecked++; if (last.geo.aioCitesUs) geoCited++ }
    if (last?.gsc?.totals) {
      clicks += last.gsc.totals.clicks || 0
      impressions += last.gsc.totals.impressions || 0
      if (typeof last.gsc.totals.position === 'number') posSamples.push(last.gsc.totals.position)
    }

    return {
      slug: r.slug,
      airport: r.airportCode || '',
      type: r.articleType || '',
      tier: tier ?? null,
      position: last?.gsc?.totals?.position ?? null,
      impressions: last?.gsc?.totals?.impressions ?? null,
      clicks: last?.gsc?.totals?.clicks ?? null,
      bucket,
      seoScore: last?.onPage?.seoScore ?? null,
      seoGrade: last?.onPage?.seoGrade ?? '',
      positions,               // sparkline series (oldest→newest)
      snapshotCount: snaps.length,
      pending: pendingCount,
      latestVerdict,
      nextDueAt: r.maintenance?.nextDueAt ?? null,
      lastMaintainedAt: r.maintenance?.lastMaintainedAt ?? null,
      holdout: !!r.holdout,
    }
  })

  const roi = readJson(path.join(REPORTS_DIR, 'treatment-roi.json'))
  const policy = readJson(path.join(REPORTS_DIR, 'treatment-policy.json'))
  const plan = readJson(path.join(REPORTS_DIR, 'maintenance-plan.json'))

  // Latest Clarity report → top friction pages (dead+rage).
  const clarityPath = latestFile(REPORTS_DIR, /^clarity-report-.*\.json$/)
  const clarity = clarityPath ? readJson(clarityPath) : null
  const friction: { url: string; dead: number; rage: number }[] = []
  if (clarity && Array.isArray(clarity.byUrl)) {
    const byUrl: Record<string, { dead: number; rage: number }> = {}
    for (const m of clarity.byUrl) for (const info of (m.information || [])) {
      const url = info.Url || info.URL || info.url
      if (!url) continue
      const v = parseFloat(info.subTotal ?? info.sessionsCount ?? '0') || 0
      byUrl[url] = byUrl[url] || { dead: 0, rage: 0 }
      if (m.metricName === 'DeadClickCount') byUrl[url].dead = v
      if (m.metricName === 'RageClickCount') byUrl[url].rage = v
    }
    for (const [url, v] of Object.entries(byUrl)) friction.push({ url, ...v })
    friction.sort((a, b) => (b.dead + b.rage) - (a.dead + a.rage))
  }

  // Latest cannibalization audit (on-demand report from `npm run cannibalization`).
  const cannibPath = latestFile(REPORTS_DIR, /^cannibalization-.*\.json$/)
  const cz = cannibPath ? readJson(cannibPath) : null
  const cannibalization = cz ? {
    generatedAt: cz.generatedAt,
    airport: cz.airport || null,
    count: cz.count ?? (cz.items || []).length,
    stolenImpressions: (cz.items || []).reduce((s: number, i: any) => s + (i.stolenImpressions || 0), 0),
    top: (cz.items || []).slice(0, 6).map((i: any) => ({ query: i.query, competitors: i.competitors, stolen: i.stolenImpressions })),
  } : null

  const avgPos = posSamples.length ? posSamples.reduce((a, b) => a + b, 0) / posSamples.length : null
  const dueNow = Array.isArray(plan?.items) ? plan.items.filter((i: any) => i.dueNow).length : null

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      articles: records.length,
      snapshots: records.reduce((a, r) => a + (r.snapshots?.length || 0), 0),
      clicks, impressions,
      avgPosition: avgPos,
      changesTotal, changesPending, changesMeasured, reverted,
      dueNow,
      geoChecked, geoCited,
    },
    buckets, tiers, verdicts, changeTypes, citation: cit,
    roi: roi ? { totalMeasured: roi.totalMeasured, byType: roi.byType || [], generatedAt: roi.generatedAt } : null,
    policyDisabled: policy?.disabled ? Object.keys(policy.disabled).length : 0,
    clarity: clarity ? { capturedAt: clarity.timestamp, days: clarity.days, friction: friction.slice(0, 8) } : null,
    cannibalization,
    rows: rows.sort((a, b) => (b.impressions || 0) - (a.impressions || 0)),
  }
}

// ── The page (self-contained; fetches /api/data and renders) ───────────────────
const HTML = /* html */ `<!doctype html><html><head><meta charset="utf-8">
<title>Triply Improvement Engine</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{--ink:#1F2933;--blue:#1F6FEB;--teal:#0E9F92;--amber:#B45309;--red:#DC2626;--grey:#5B6470;--line:#E1E6EC;--bg:#F6F8FB;--card:#fff}
  *{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial;color:var(--ink);background:var(--bg)}
  header{background:var(--ink);color:#fff;padding:14px 22px;display:flex;align-items:center;gap:12px}
  header h1{font-size:16px;margin:0;font-weight:700}header .sub{color:#9AA6B2;font-size:12px}
  .wrap{max-width:1200px;margin:0 auto;padding:18px 22px 60px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:18px}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .kpi .n{font-size:22px;font-weight:700}.kpi .l{font-size:11px;color:var(--grey);text-transform:uppercase;letter-spacing:.03em}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .card h2{font-size:13px;margin:0 0 10px;color:var(--blue);text-transform:uppercase;letter-spacing:.04em}
  table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
  th{color:var(--grey);font-weight:600;cursor:pointer;user-select:none;position:sticky;top:0;background:var(--card)}
  td.slug{max-width:280px;overflow:hidden;text-overflow:ellipsis}
  .pill{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;font-weight:600}
  .b-top3{background:#DCFCE7;color:#166534}.b-page1{background:#E0F2FE;color:#075985}.b-striking-distance{background:#FEF9C3;color:#854D0E}
  .b-page2plus{background:#FEE2E2;color:#991B1B}.b-unranked,.b-unknown{background:#EEF1F5;color:#5B6470}
  .v-helped{color:#166534;font-weight:600}.v-hurt{color:#DC2626;font-weight:600}.v-neutral{color:#5B6470}.v-inconclusive{color:#94A3B8}
  .tablewrap{max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:10px}
  .muted{color:var(--grey)}.right{text-align:right}
  .bar{height:8px;border-radius:5px;background:#EEF1F5;overflow:hidden;display:flex}
  .note{font-size:12px;color:var(--grey);background:#FBF6E9;border:1px solid #F0E4C8;border-radius:8px;padding:9px 12px;margin-bottom:14px}
  .foot{color:var(--grey);font-size:11px;margin-top:8px}
  a{color:var(--blue)}
</style></head><body>
<header><h1>Triply · Improvement Engine</h1><span class="sub" id="stamp"></span></header>
<div class="wrap">
  <div class="note" id="how"></div>
  <div class="kpis" id="kpis"></div>
  <div class="grid">
    <div class="card"><h2>Position buckets</h2><div id="buckets"></div></div>
    <div class="card"><h2>Maintenance tiers</h2><div id="tiers"></div></div>
    <div class="card"><h2>Treatment verdicts</h2><div id="verdicts"></div></div>
    <div class="card"><h2>What actually works (ROI)</h2><div id="roi"></div></div>
    <div class="card"><h2>AI-Overview citation (GEO)</h2><div id="geo"></div></div>
    <div class="card"><h2>User-behavior friction (Clarity)</h2><div id="clarity"></div></div>
    <div class="card"><h2>Keyword cannibalization</h2><div id="cannib"></div></div>
  </div>
  <div class="card"><h2>Articles (sorted by impressions)</h2>
    <div class="tablewrap"><table id="tbl"><thead><tr>
      <th data-k="slug">Article</th><th data-k="airport">Airport</th><th data-k="type">Type</th>
      <th data-k="tier">Tier</th><th data-k="position" class="right">Pos</th><th>Trend</th>
      <th data-k="impressions" class="right">Impr</th><th data-k="seoScore" class="right">SEO</th>
      <th data-k="pending" class="right">Pending</th><th data-k="latestVerdict">Verdict</th>
    </tr></thead><tbody></tbody></table></div>
    <div class="foot" id="rowcount"></div>
  </div>
  <div class="foot">Read-only view · auto-refreshes every 60s · reads reports/articles, treatment-roi, maintenance-plan, latest clarity report.</div>
</div>
<script>
let DATA=null, sortK='impressions', sortDir=-1;
const el=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const num=n=>n==null?'—':(typeof n==='number'?(Math.round(n*100)/100).toLocaleString():n);

function spark(series){
  if(!series||series.length===0)return '<span class="muted">—</span>';
  if(series.length===1)return '<span class="muted">•</span>';
  const w=70,h=18,min=Math.min(...series),max=Math.max(...series),rng=(max-min)||1;
  // Lower position = better, so INVERT y (better goes up).
  const pts=series.map((v,i)=>{const x=(i/(series.length-1))*w;const y=((v-min)/rng)*(h-4)+2;return x.toFixed(1)+','+y.toFixed(1)}).join(' ');
  const up=series[series.length-1]<=series[0];
  return '<svg width="'+w+'" height="'+h+'"><polyline fill="none" stroke="'+(up?'#0E9F92':'#DC2626')+'" stroke-width="1.6" points="'+pts+'"/></svg>';
}
function barRow(map,colors){
  const total=Object.values(map).reduce((a,b)=>a+b,0)||1;
  let seg='',leg='';
  for(const [k,v] of Object.entries(map)){if(!v)continue;const c=colors[k]||'#94A3B8';
    seg+='<div style="width:'+(v/total*100)+'%;background:'+c+'"></div>';
    leg+='<span style="display:inline-block;margin:4px 10px 0 0"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:'+c+';vertical-align:middle"></span> '+esc(k)+' <b>'+v+'</b></span>';}
  return '<div class="bar">'+seg+'</div><div>'+leg+'</div>';
}

function render(){
  const d=DATA,t=d.totals;
  el('stamp').textContent='updated '+new Date(d.generatedAt).toLocaleString();
  el('how').innerHTML='<b>How to read this:</b> the engine snapshots each article\\'s Google position weekly, applies small fixes to under-performers, then measures ~28 days later and auto-reverts anything that hurt. '+
    'Tiers, verdicts and GEO fill in once the maintain loop runs (they\\'re sparse now — that\\'s expected). Positions/impressions update every run.';
  const K=[
    ['Articles tracked',t.articles],['Snapshots',t.snapshots],['Avg position',t.avgPosition==null?'—':num(t.avgPosition)],
    ['Total impressions',num(t.impressions)],['Changes applied',t.changesTotal],['Pending measure',t.changesPending],
    ['Measured',t.changesMeasured],['Auto-reverted',t.reverted],['Due now',t.dueNow==null?'—':t.dueNow],
    ['AI cites us',t.geoChecked?(t.geoCited+'/'+t.geoChecked):'—'],
  ];
  el('kpis').innerHTML=K.map(([l,n])=>'<div class="kpi"><div class="n">'+esc(n)+'</div><div class="l">'+esc(l)+'</div></div>').join('');
  el('buckets').innerHTML=barRow(d.buckets,{top3:'#16A34A','page1':'#0EA5E9','striking-distance':'#EAB308','page2plus':'#EF4444',unranked:'#94A3B8',unknown:'#CBD5E1'});
  el('tiers').innerHTML=barRow(d.tiers,{'0':'#94A3B8','1':'#DC2626','2':'#EAB308','3':'#0EA5E9',unclassified:'#CBD5E1'})+
    '<div class="foot">0 watch · 1 rewrite · 2 standard · 3 small · unclassified = maintain plan not yet run</div>';
  el('verdicts').innerHTML=(t.changesMeasured?barRow(d.verdicts,{helped:'#16A34A',hurt:'#DC2626',neutral:'#94A3B8',inconclusive:'#CBD5E1'}):'<span class="muted">No measured verdicts yet — they appear ~28 days after the first edits are applied.</span>');
  // ROI
  if(d.roi && d.roi.byType && d.roi.byType.length){
    el('roi').innerHTML='<table><tr><th>Treatment</th><th class="right">Win%</th><th class="right">Net</th><th class="right">Δpos</th></tr>'+
      d.roi.byType.map(g=>'<tr><td>'+esc(g.type)+'</td><td class="right">'+Math.round((g.winRate||0)*100)+'%</td><td class="right">'+(g.net>0?'+':'')+g.net+'</td><td class="right">'+num(g.medianPosDelta)+'</td></tr>').join('')+'</table>';
  } else el('roi').innerHTML='<span class="muted">No measured treatments yet. Win-rates by fix type appear here once verdicts land ('+d.policyDisabled+' tactics currently disabled by policy).</span>';
  el('geo').innerHTML=(t.geoChecked? barRow(d.citation,{gained:'#16A34A',lost:'#DC2626',held:'#0EA5E9',unknown:'#CBD5E1'})+'<div class="foot">'+t.geoCited+' of '+t.geoChecked+' checked pages are cited in Google\\'s AI Overview.</div>' : '<span class="muted">No AI-citation captures yet — run maintain geo capture (or the weekly loop) to populate.</span>');
  // Clarity
  if(d.clarity && d.clarity.friction.length){
    el('clarity').innerHTML='<div class="foot">from '+esc((d.clarity.capturedAt||'').slice(0,10))+' · dead+rage clicks</div><table><tr><th>Page</th><th class="right">Rage</th><th class="right">Dead</th></tr>'+
      d.clarity.friction.map(f=>'<tr><td class="slug">'+esc(f.url.replace(/^https?:\\/\\/(www\\.)?triplypro\\.com/,''))+'</td><td class="right">'+f.rage+'</td><td class="right">'+f.dead+'</td></tr>').join('')+'</table>';
  } else el('clarity').innerHTML='<span class="muted">No Clarity report found. Run: npm run clarity -- suggest</span>';
  // Cannibalization
  if(d.cannibalization && d.cannibalization.top.length){var cz=d.cannibalization;
    el('cannib').innerHTML='<div class="foot">from '+esc((cz.generatedAt||'').slice(0,10))+(cz.airport?' · '+esc(cz.airport.toUpperCase()):' · all clusters')+' · '+cz.count+' queries, '+cz.stolenImpressions.toLocaleString()+' impr split across duplicate pages</div>'+
      '<table><tr><th>Query (2+ of our pages compete)</th><th class="right">Pages</th><th class="right">Split impr</th></tr>'+
      cz.top.map(function(t){return '<tr><td class="slug" title="'+esc(t.query)+'">'+esc(t.query)+'</td><td class="right">'+t.competitors+'</td><td class="right">'+(t.stolen||0).toLocaleString()+'</td></tr>'}).join('')+'</table>';
  } else el('cannib').innerHTML='<span class="muted">No audit yet. Run: npm run cannibalization -- -a ATL</span>';
  renderTable();
}
function renderTable(){
  const rows=[...DATA.rows].sort((a,b)=>{let x=a[sortK],y=b[sortK];if(x==null)x=-Infinity;if(y==null)y=-Infinity;if(typeof x==='string')return sortDir*x.localeCompare(y);return sortDir*(x-y)});
  el('tbl').querySelector('tbody').innerHTML=rows.map(r=>'<tr>'+
    '<td class="slug" title="'+esc(r.slug)+'">'+esc(r.slug)+(r.holdout?' <span class="muted">(holdout)</span>':'')+'</td>'+
    '<td>'+esc(r.airport)+'</td><td>'+esc(r.type)+'</td>'+
    '<td>'+(r.tier==null?'<span class="muted">—</span>':r.tier)+'</td>'+
    '<td class="right">'+(r.position==null?'—':num(r.position))+' <span class="pill b-'+r.bucket+'">'+esc(r.bucket)+'</span></td>'+
    '<td>'+spark(r.positions)+'</td>'+
    '<td class="right">'+num(r.impressions)+'</td>'+
    '<td class="right">'+(r.seoScore==null?'—':r.seoScore+' '+esc(r.seoGrade))+'</td>'+
    '<td class="right">'+(r.pending||'')+'</td>'+
    '<td>'+(r.latestVerdict?'<span class="v-'+r.latestVerdict+'">'+r.latestVerdict+'</span>':'<span class="muted">—</span>')+'</td>'+
    '</tr>').join('');
  el('rowcount').textContent=rows.length+' articles';
}
document.querySelectorAll('#tbl th[data-k]').forEach(th=>th.onclick=()=>{const k=th.dataset.k;sortDir=(sortK===k)?-sortDir:-1;sortK=k;renderTable()});
async function load(){try{DATA=await (await fetch('/api/data')).json();render()}catch(e){el('kpis').innerHTML='<div class="kpi">error loading data</div>'}}
load();setInterval(load,60000);
</script></body></html>`

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/api/data')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(buildData()))
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(HTML)
})

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ⚠ Port ${PORT} is already in use — the dashboard may already be running.\n    Open http://localhost:${PORT}, or start on another port: DASHBOARD_PORT=4320 npm run dashboard\n`)
    process.exit(1)
  }
  throw e
})

server.listen(PORT, () => {
  console.log(`\n📊 Improvement-engine dashboard → http://localhost:${PORT}\n   (reads reports/articles, treatment-roi, maintenance-plan, latest clarity. Ctrl+C to stop.)\n`)
})
