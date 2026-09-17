// Backfill bookings.airport_code for rows that carry "RESLAB" / "" / NULL.
//
// Before migration 023 + the fulfill.ts change, checkout-form.tsx derived
// airportCode from the lot id ("reslab-416" → "RESLAB"), so 297 of 298 rows are
// unusable for per-airport reporting. This resolves the nearest PRODUCTION
// airport (enabled, non-test) within 25 miles of each DISTINCT lot's
// coordinates — one /locations/{id} call per lot, never the paged list — and
// writes it back. Same rule as src/lib/attribution/airport.ts rule 2 (no
// searched-airport context exists for historical rows).
//
// Safety:
//   - dry-run by default; --apply to write. Non-zero exit on any failure.
//   - only rows whose airport_code is 'RESLAB', '' or NULL are touched — a row
//     that already carries a real code (e.g. EWR) is never overwritten, which
//     also makes the run resumable.
//   - cancelled rows ARE included (reporting wants them).
//   - a ResLab 404 is a STAGING booking (shared Supabase, separate ResLab env)
//     → skipped and counted, never written as NULL.
//   - paced (250 ms between ResLab calls). Run once, off-peak.
//   - side effects: update_bookings_updated_at bumps updated_at on touched rows
//     (no reader found); customers see the reservation badge change from
//     "RESLAB" to e.g. "EWR"; the partner API returns the new value too.
//
//   node scripts/backfill-airport-code.mjs            # preview
//   node scripts/backfill-airport-code.mjs --apply    # write
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const API_URL = process.env.RESLAB_API_URL || 'https://api.reservationslab.com/v1';
const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESLAB_API_KEY } = process.env;
const API_DOMAIN = process.env.RESLAB_API_DOMAIN || 'triplypro.com';
if (!SUPABASE_SERVICE_ROLE_KEY || !NEXT_PUBLIC_SUPABASE_URL || !RESLAB_API_KEY) {
  console.error('Missing env (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESLAB_API_KEY).');
  process.exit(1);
}
const NEAREST_MAX_MILES = 25;
const PACE_MS = 250;

// Parse the airport config without a TS toolchain: code + coords + enabled/isTest.
const src = fs.readFileSync(new URL('../src/config/airports.ts', import.meta.url), 'utf8');
const airports = [];
for (const block of src.split(/\n\s*\{\s*\n/).slice(1)) {
  const code = block.match(/code:\s*"([A-Z0-9-]+)"/)?.[1];
  const lat = parseFloat(block.match(/latitude:\s*([-\d.]+)/)?.[1] ?? '');
  const lng = parseFloat(block.match(/longitude:\s*([-\d.]+)/)?.[1] ?? '');
  const enabled = /enabled:\s*true/.test(block);
  const isTest = /isTest:\s*true/.test(block);
  if (code && Number.isFinite(lat) && Number.isFinite(lng) && enabled && !isTest) {
    airports.push({ code, lat, lng });
  }
}
if (airports.length < 50) { console.error(`Parsed only ${airports.length} airports — refusing to run.`); process.exit(1); }

const toRad = (x) => (x * Math.PI) / 180;
const miles = (a, b, c, d) => {
  const R = 3959, dLat = toRad(c - a), dLon = toRad(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};
const nearest = (lat, lng) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  let best = null;
  for (const a of airports) {
    const d = miles(lat, lng, a.lat, a.lng);
    if (d <= NEAREST_MAX_MILES && (!best || d < best.d)) best = { code: a.code, d };
  }
  return best?.code ?? null;
};

const supa = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
console.log(`Parsed ${airports.length} production airports from src/config/airports.ts (${airports.slice(0, 5).map((a) => a.code).join(', ')}, …)`);

// Page the SELECT (PostgREST silently caps at 1000 rows) and filter the
// unusable codes CLIENT-SIDE: a PostgREST `in.("RESLAB","")` with an empty
// string member is grammar we cannot verify, and a mis-parse would silently
// skip the '' rows while reporting success. ~300 rows makes the scan free.
const all = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await supa
    .from('bookings')
    .select('id, reslab_location_id, airport_code')
    .not('reslab_location_id', 'is', null)
    .order('id', { ascending: true })
    .range(from, from + 999);
  if (error) { console.error('supabase:', error.message); process.exit(1); }
  all.push(...(data ?? []));
  if (!data || data.length < 1000) break;
}
const isUnusable = (r) => r.airport_code === null || r.airport_code === 'RESLAB' || r.airport_code === '';
const rows = all.filter(isUnusable);
console.log(`Scanned ${all.length} bookings.`);

const locIds = [...new Set(rows.map((r) => r.reslab_location_id))];
console.log(`${rows.length} bookings with unusable airport_code across ${locIds.length} lots (${APPLY ? 'APPLY' : 'DRY-RUN'}).`);
if (!locIds.length) { console.log('Nothing to backfill.'); process.exit(0); }

const authRes = await fetch(`${API_URL}/authenticate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: RESLAB_API_KEY, domain: API_DOMAIN }),
});
if (!authRes.ok) { console.error('ResLab auth failed', authRes.status); process.exit(1); }
const { token } = await authRes.json();

let updated = 0, unresolved = 0, staging404 = 0, fetchFailed = 0, updateFailed = 0;
const byAirport = {};
for (const id of locIds) {
  await new Promise((r) => setTimeout(r, PACE_MS));
  let loc = null, status = 0;
  try {
    const r = await fetch(`${API_URL}/locations/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    status = r.status;
    if (r.ok) { const j = await r.json(); loc = j.data ?? j; }
  } catch { status = -1; }

  if (status === 404) { console.log(`  loc ${id}: 404 in this ResLab env (staging booking?) — skipped`); staging404++; continue; }
  if (!loc) { console.log(`  loc ${id}: ResLab fetch FAILED (${status}) — left for a rerun`); fetchFailed++; continue; }

  const code = nearest(parseFloat(loc.latitude), parseFloat(loc.longitude));
  const n = rows.filter((r) => r.reslab_location_id === id).length;
  if (!code) { console.log(`  loc ${id} (${loc.name}): no production airport within ${NEAREST_MAX_MILES} mi — left NULL/unchanged`); unresolved += n; continue; }
  byAirport[code] = (byAirport[code] || 0) + n;

  if (APPLY) {
    // Update BY ID from the filtered SELECT above. Never `.or()` on an UPDATE —
    // real PostgREST rejects it (it matched zero rows and stalled every booking
    // once; see CLAUDE.md "PostgREST rejects .or() on UPDATE"). The id list is
    // exactly the rows the preview showed, so a real code is never overwritten.
    const ids = rows.filter((r) => r.reslab_location_id === id).map((r) => r.id);
    // Chunked: the id list travels in the query string (a UUID ≈ 39 bytes
    // encoded), and this script is rerunnable on a table that only grows.
    let lotUpdated = 0, lotFailed = false;
    for (let i = 0; i < ids.length; i += 100) {
      const { count, error: upErr } = await supa
        .from('bookings')
        .update({ airport_code: code }, { count: 'exact' })
        .in('id', ids.slice(i, i + 100));
      if (upErr) { console.log(`  loc ${id} → ${code}: UPDATE error ${upErr.message}`); lotFailed = true; break; }
      lotUpdated += count ?? 0;
    }
    if (lotFailed) { updateFailed++; continue; }
    console.log(`  loc ${id} (${loc.name}) → ${code}: updated ${lotUpdated} rows`);
    updated += lotUpdated;
  } else {
    console.log(`  loc ${id} (${loc.name}) → ${code}: ${n} rows (dry-run)`);
  }
}
console.log('\nBy airport:', Object.entries(byAirport).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`${APPLY ? 'APPLIED' : 'DRY-RUN'} — lots: ${locIds.length}, staging-404 skipped: ${staging404}, unresolved rows: ${unresolved}, fetchFailed: ${fetchFailed}, updateFailed: ${updateFailed}${APPLY ? `, rows updated: ${updated}` : ''}`);
process.exit(fetchFailed || updateFailed ? 1 : 0);
