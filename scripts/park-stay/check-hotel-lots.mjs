// Park & Stay hotel ↔ lot drift check (plan v3 §3.5). READ-ONLY.
//
// For every entry in src/lib/hotels/hotel-lots.ts it compares the ResLab lot
// (the production location snapshot row) and the LiteAPI hotel (/data/hotel)
// with the map and with the 18 Oct baseline below, prints a drift table, and
// exits 1 on any drift. Run it before an airport is switched on, before
// Phase E, after any `park_stay_map_drift` alert, and monthly.
//
// Online (reads production; writes nothing):
//   node scripts/park-stay/check-hotel-lots.mjs [--env .env.local]
//     - snapshot: GET reslab_location_snapshot (service role, newest row for
//       this RESLAB_API_KEY's fingerprint) — no ResLab call at all
//     - LiteAPI: one GET /data/hotel per entry with LITEAPI_SANDBOX_KEY
//       (content is the same in sandbox and live; not budget-metered — 10 calls)
// Offline (no network):
//   node scripts/park-stay/check-hotel-lots.mjs --snapshot <locations.json> --liteapi <rates-or-hotels.json>
//     - locations.json: an array of ResLab locations (a decoded snapshot payload)
//     - rates-or-hotels.json: a /hotels/rates response with `hotels[]`
//       (includeHotelData: true), or an array of /data/hotel `data` objects
//
// Needs Node ≥ 22.6 (imports the TypeScript map with type stripping).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { HOTEL_LOTS } = await import(pathToFileURL(path.join(here, "../../src/lib/hotels/hotel-lots.ts")).href);

const MAX_DRIFT_M = 300;
// Fields the map does not store, as the 18 Oct production snapshot had them.
const BASELINE = {
  132: { minimum_booking_days: 0, checkin_time: "16:00", shuttle_available: 1 },
  304: { minimum_booking_days: 2, checkin_time: "15:00", shuttle_available: 1 },
  159: { minimum_booking_days: 0, checkin_time: "15:00", shuttle_available: 1 },
  454: { minimum_booking_days: 0, checkin_time: "16:00", shuttle_available: 1 },
  184: { minimum_booking_days: 1, checkin_time: "15:00", shuttle_available: 0 },
  259: { minimum_booking_days: 0, checkin_time: "16:00", shuttle_available: 1 },
  378: { minimum_booking_days: 0, checkin_time: "15:00", shuttle_available: 1 },
  320: { minimum_booking_days: 0, checkin_time: "16:00", shuttle_available: 1 },
  277: { minimum_booking_days: 0, checkin_time: "15:00", shuttle_available: 1 },
  323: { minimum_booking_days: 2, checkin_time: "15:00", shuttle_available: 1 },
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function meters(a, b, c, d) {
  const x = Math.sin(rad(c - a) / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(rad(d - b) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s) => new Set(String(s ?? "").toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9]+/).filter(Boolean));
const sameTokens = (a, b) => {
  const x = tokens(a), y = tokens(b);
  return x.size > 0 && x.size === y.size && [...x].every((t) => y.has(t));
};
const streetNumber = (s) => (/^\s*([\d-]+)/.exec(String(s ?? "")) ?? [])[1] ?? null;

async function loadLocations() {
  const file = arg("--snapshot");
  if (file) return JSON.parse(fs.readFileSync(file, "utf8"));
  const env = readEnv(arg("--env") ?? ".env.local");
  const key = (env.RESLAB_API_KEY ?? "").trim();
  if (!key || !env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("need RESLAB_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  const fp = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/reslab_location_snapshot?select=env_key,built_at,payload_gzip_b64&key_fingerprint=eq.${fp}&order=built_at.desc&limit=1`;
  const res = await fetch(url, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
  if (!res.ok) throw new Error(`snapshot read failed: ${res.status}`);
  const rows = await res.json();
  if (!rows[0]) throw new Error(`no snapshot row for fingerprint ${fp}`);
  console.log(`snapshot ${rows[0].env_key} built ${rows[0].built_at}`);
  return JSON.parse(zlib.gunzipSync(Buffer.from(rows[0].payload_gzip_b64, "base64")).toString("utf8"));
}

async function loadHotels() {
  const file = arg("--liteapi");
  if (file) {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(j) ? j : (j.hotels ?? []);
    return new Map(list.map((h) => [h.id, h]));
  }
  const env = readEnv(arg("--env") ?? ".env.local");
  if (!env.LITEAPI_SANDBOX_KEY) throw new Error("need LITEAPI_SANDBOX_KEY");
  const out = new Map();
  for (const e of HOTEL_LOTS) {
    const res = await fetch(`https://api.liteapi.travel/v3.0/data/hotel?hotelId=${encodeURIComponent(e.liteapi.hotelId)}`, {
      headers: { "X-API-Key": env.LITEAPI_SANDBOX_KEY, accept: "application/json" },
    });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.data) out.set(e.liteapi.hotelId, body.data);
    else console.log(`LiteAPI /data/hotel ${e.liteapi.hotelId}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  return out;
}

const locations = await loadLocations();
const hotels = await loadHotels();
const byId = new Map(locations.map((l) => [Number(l.id), l]));
const rows = [];
for (const e of HOTEL_LOTS) {
  const id = e.reslab.ids.production;
  const l = byId.get(Number(id));
  const h = hotels.get(e.liteapi.hotelId);
  const drift = [];
  if (!l) drift.push("lot missing from snapshot");
  else {
    if (norm(l.name) !== norm(e.reslab.name)) drift.push(`lot renamed: ${JSON.stringify(l.name)}`);
    const d = meters(Number(l.latitude), Number(l.longitude), e.reslab.latitude, e.reslab.longitude);
    if (!(d <= MAX_DRIFT_M)) drift.push(`lot moved ${d} m`);
    if (l.type !== "parking_room") drift.push(`lot type ${JSON.stringify(l.type)}`);
    if (Number(l.parking_due_at_location) !== 0) drift.push("lot now due at the lot");
    const pol = (l.cancellation_policies ?? []).filter((p) => p.type === "parking");
    if (pol.length === 0 || !pol.every((p) => p.percentage === 100)) drift.push(`refund policy ${JSON.stringify(pol.map((p) => p.percentage))}`);
    const b = BASELINE[id];
    if (b) {
      for (const k of Object.keys(b)) if (String(l[k] ?? "") !== String(b[k])) drift.push(`${k} ${JSON.stringify(b[k])} → ${JSON.stringify(l[k] ?? null)}`);
    } else drift.push("no baseline for this lot — add one");
  }
  if (!h) drift.push("LiteAPI hotel missing");
  else {
    if (!sameTokens(h.name, e.liteapi.name)) drift.push(`hotel renamed: ${JSON.stringify(h.name)}`);
    const lat = Number(h.latitude ?? h.location?.latitude);
    const lng = Number(h.longitude ?? h.location?.longitude);
    const d = meters(lat, lng, e.liteapi.latitude, e.liteapi.longitude);
    if (!(d <= MAX_DRIFT_M)) drift.push(`hotel moved ${Number.isFinite(d) ? d + " m" : "(no coordinates)"}`);
    if (l && streetNumber(l.address) !== streetNumber(h.address)) drift.push(`address: lot ${JSON.stringify(l.address)} vs hotel ${JSON.stringify(h.address)}`);
    const hotelCheckin = h.checkinCheckoutTimes?.checkin;
    if (l && hotelCheckin && String(hotelCheckin).slice(0, 5) !== String(l.checkin_time ?? "").slice(0, 5)) {
      drift.push(`check-in: lot ${JSON.stringify(l.checkin_time)} vs hotel ${JSON.stringify(hotelCheckin)}`);
    }
  }
  rows.push({ key: e.key, enabled: e.enabled, lot: id, hotel: e.liteapi.hotelId, shuttle: l ? String(l.shuttle_info_summary ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 50) : "", drift: drift.join("; ") || "ok" });
}
console.table(rows);
// Address forms differ legitimately at some hotels (e.g. Hyatt Flushing's garage is on another street) —
// those print as drift on purpose, so a person re-confirms them on each run.
const drifted = rows.filter((r) => r.drift !== "ok");
console.log(`${drifted.length} of ${rows.length} entries drifted`);
process.exit(drifted.length > 0 ? 1 : 0);
