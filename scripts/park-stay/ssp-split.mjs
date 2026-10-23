// Park & Stay V6 re-run (plan v3 §5.3) — a READ-ONLY, OFFLINE copy kept for reproducibility.
//
// Inputs (saved earlier; this script makes NO network calls and writes only its own output):
//   <dir>/out/ssp-split-raw.json         sandbox /hotels/rates per hotel (2 adults, margin 0; 11 + 14 Nov 2026)
//   <dir>/reslab-liteapi-match.json      the 18 Oct ResLab hotel lot ↔ LiteAPI match
//   <dir>/reslab-snap-production.json    the 18 Oct production ResLab location snapshot (per-lot commission)
// Output: <dir>/ssp-split-v2-P<parking>.json
//
// Usage: node scripts/park-stay/ssp-split.mjs <parkingDollars=100> <dir=.>
//
// Model (float dollars — this is analysis, not pricing; production pricing is
// src/lib/hotels/pricing.ts in integer cents): per-lot parking commission from
// the snapshot, a 5% ResLab channel fee, Stripe 2.9% + 30c on the whole charge,
// LiteAPI's 4% on the room SELL price. Lead room = cheapest refundable by SSP,
// else cheapest.
import fs from "node:fs";
import path from "node:path";
const dir = process.argv[3] ?? ".";
const rows = JSON.parse(fs.readFileSync(path.join(dir, "out/ssp-split-raw.json"), "utf8"));
const match = JSON.parse(fs.readFileSync(path.join(dir, "reslab-liteapi-match.json"), "utf8"));
const snapRaw = JSON.parse(fs.readFileSync(path.join(dir, "reslab-snap-production.json"), "utf8"));
const snap = Array.isArray(snapRaw) ? snapRaw : (snapRaw.locations ?? snapRaw.data ?? Object.values(snapRaw));
const lotOf = new Map(match.filter((m) => m.best?.id).map((m) => [m.best.id, m.lotId]));
const locById = new Map(snap.map((l) => [Number(l.id), l]));
const NY = new Set(["JFK", "LGA", "EWR"]);
const P = Number(process.argv[2] ?? 100), RLFEE = 0.05, F = Math.max(5.95, 0.06 * P);
const lead = (r) => { const ok = r.filter((x) => x.ssp != null); const p = ok.some((x) => x.rfn) ? ok.filter((x) => x.rfn) : ok; return p.sort((a, b) => a.ssp - b.ssp)[0]; };
function comm(lotId) {
  const l = locById.get(Number(lotId));
  if (!l || l.parking_commission_type !== "percentage") return { c: 0, pc: null };
  const pc = Number(l.parking_commission); if (!(pc > 0 && pc < 100)) return { c: 0, pc };
  return { c: P * (100 - pc) / 100 - P * RLFEE, pc };
}
// profit(R) = R + F + C - fee*R - net - (0.029*(R+P+F) + 0.30)  >= 0
const profit = (R, net, C, fee) => R + F + C - fee * R - net - (0.029 * (R + P + F) + 0.30);
const floor = (net, C, fee) => (net - F - C + 0.029 * (P + F) + 0.30) / (1 - fee - 0.029);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const out = {};
for (const ci of ["2026-11-11", "2026-11-14"]) for (const [lab, f] of [["NYNJ", (r) => NY.has(r.port) && !/red carpet/i.test(r.lot)], ["all", () => true]]) {
  const L = rows.filter((r) => r.checkin === ci && f(r)).map((r) => ({ r, l: lead(r.rates), ...comm(lotOf.get(r.hotelId)) })).filter((x) => x.l);
  const o = { n: L.length, unknownCommission: L.filter((x) => x.pc == null).length };
  for (const fee of [0.04, 0]) {
    const pr = L.map((x) => profit(x.l.ssp, x.l.net, x.c, fee));
    o[`fee${fee * 100}%: at SSP`] = L.filter((x) => x.l.ssp >= floor(x.l.net, x.c, fee)).length;
    o[`fee${fee * 100}%: median profit at SSP $`] = +med(pr).toFixed(2);
    o[`fee${fee * 100}%: median raise above SSP when floor binds`] = (() => { const b = L.filter((x) => x.l.ssp < floor(x.l.net, x.c, fee)); return b.length ? +(med(b.map((x) => floor(x.l.net, x.c, fee) / x.l.ssp - 1)) * 100).toFixed(1) + "%" : "-"; })();
  }
  if (lab === "NYNJ") o.detail = L.map((x) => `${x.r.port} ${x.r.lot} [lot ${lotOf.get(x.r.hotelId)}, lot keeps ${x.pc}%]: SSP $${x.l.ssp.toFixed(0)} net $${x.l.net.toFixed(0)} → profit at SSP $${profit(x.l.ssp, x.l.net, x.c, 0.04).toFixed(2)} (4% fee) / $${profit(x.l.ssp, x.l.net, x.c, 0).toFixed(2)} (no fee)`);
  out[`${ci} ${lab}`] = o;
}
fs.writeFileSync(path.join(dir, `ssp-split-v2-P${P}.json`), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
