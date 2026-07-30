// Backfill bookings.location_timezone from ResLab's location.timezone.code.
//
// Bookings created before migration 017 + the fulfill.ts persist have
// location_timezone = NULL, which fail-closes the self-cancel 24h gate for them.
// This resolves the tz per DISTINCT reslab_location_id (one getLocation per lot)
// and backfills every matching row.
//
// Requires migration 017 applied first (the column must exist). Dry-run by
// default; --apply to write.
//   node scripts/backfill-location-timezone.mjs            # preview
//   node scripts/backfill-location-timezone.mjs --apply    # write
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const API_URL = process.env.RESLAB_API_URL || 'https://api.reservationslab.com/v1';
const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESLAB_API_KEY } = process.env;
const API_DOMAIN = process.env.RESLAB_API_DOMAIN || 'triplypro.com';
if (!SUPABASE_SERVICE_ROLE_KEY || !NEXT_PUBLIC_SUPABASE_URL || !RESLAB_API_KEY) {
  console.error('Missing env (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESLAB_API_KEY).');
  process.exit(1);
}
const supa = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const { data: rows, error } = await supa
  .from('bookings')
  .select('reslab_location_id')
  .eq('status', 'confirmed')
  .is('location_timezone', null)
  .not('reslab_location_id', 'is', null);
if (error) { console.error('supabase:', error.message); process.exit(1); }

const locIds = [...new Set(rows.map((r) => r.reslab_location_id))];
console.log(`${rows.length} confirmed bookings missing location_timezone across ${locIds.length} lots.`);
if (!locIds.length) { console.log('Nothing to backfill.'); process.exit(0); }

const authRes = await fetch(`${API_URL}/authenticate`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: RESLAB_API_KEY, domain: API_DOMAIN }),
});
if (!authRes.ok) { console.error('ResLab auth failed', authRes.status); process.exit(1); }
const { token } = await authRes.json();

let updated = 0, noTz = 0, fetchFailed = 0, updateFailed = 0;
for (const id of locIds) {
  let tz = null, fetchErr = false;
  try {
    const r = await fetch(`${API_URL}/locations/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) tz = (await r.json())?.timezone?.code ?? null;
    else fetchErr = true; // 401/404/5xx — distinct from "location has no timezone"
  } catch { fetchErr = true; }

  if (fetchErr) { console.log(`  loc ${id}: ResLab fetch FAILED — left for a rerun`); fetchFailed++; continue; }
  if (!tz) { console.log(`  loc ${id}: location has no timezone — skipped`); noTz++; continue; }

  if (APPLY) {
    const { count, error: upErr } = await supa
      .from('bookings')
      .update({ location_timezone: tz }, { count: 'exact' })
      .eq('reslab_location_id', id)
      .eq('status', 'confirmed') // match the preview SELECT
      .is('location_timezone', null);
    if (upErr) { console.log(`  loc ${id} (${tz}): UPDATE error ${upErr.message}`); updateFailed++; continue; }
    console.log(`  loc ${id} → ${tz}: updated ${count} rows`);
    updated += count || 0;
  } else {
    console.log(`  loc ${id} → ${tz} (dry-run)`);
  }
}
console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'} — resolved: ${locIds.length - noTz - fetchFailed}, no-timezone: ${noTz}, fetchFailed: ${fetchFailed}, updateFailed: ${updateFailed}${APPLY ? `, rows updated: ${updated}` : ''}`);
// Non-zero exit if anything failed, so a rerun/CI doesn't read a partial run as success.
process.exit(fetchFailed || updateFailed ? 1 : 0);
