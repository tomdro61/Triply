/**
 * Cancel a ResLab reservation and mark the matching Supabase booking refunded.
 *
 * Usage (run from triply/ root):
 *   node scripts/cancel-reservation.mjs <RES_NUM>            # dry-run: shows current state
 *   node scripts/cancel-reservation.mjs <RES_NUM> --apply [--status refunded|cancelled]
 *
 * ResLab cancel applies the cancellation policy (vs DELETE which only works
 * within 1 min of creation). Reservation must not be checked in. Supabase is
 * only updated if the ResLab cancel succeeds. Does NOT touch Stripe (refund is
 * handled in the dashboard) or Park Guard (prod key not in local .env.local).
 */

import dotenv from 'dotenv';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
dotenv.config({ path: '.env.local' });

const API_URL = process.env.RESLAB_API_URL || 'https://api.reservationslab.com/v1';
const API_KEY = process.env.RESLAB_API_KEY;
const API_DOMAIN = process.env.RESLAB_API_DOMAIN || 'triplypro.com';

if (!API_KEY) {
  console.error('Missing RESLAB_API_KEY in .env.local');
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const statusIdx = args.indexOf('--status');
const newStatus = statusIdx !== -1 ? args[statusIdx + 1] : 'refunded';
const resNum = args.find((a) => !a.startsWith('--') && a !== newStatus);

if (!resNum) {
  console.error('Usage: node scripts/cancel-reservation.mjs <RES_NUM> --apply [--status refunded|cancelled]');
  process.exit(1);
}

async function authenticate() {
  const res = await fetch(`${API_URL}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: API_KEY, domain: API_DOMAIN }),
  });
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text()}`);
  return (await res.json()).token;
}

async function api(token, path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const token = await authenticate();

// Current state
const before = await api(token, `/reservations/${resNum}`);
console.log(`\nReservation: ${resNum}`);
console.log(`  reserved_for: ${before.history?.[0]?.reserved_for}`);
console.log(`  cancelled:    ${before.cancelled}`);

if (before.cancelled) {
  console.log('\nAlready cancelled in ResLab — skipping ResLab cancel, will still sync Supabase.');
}

if (!apply) {
  console.log('\n*** DRY RUN. Re-run with --apply to cancel in ResLab + mark Supabase. ***\n');
  process.exit(0);
}

// Step 1: ResLab cancel
if (!before.cancelled) {
  console.log('\nCancelling in ResLab...');
  const result = await api(token, `/reservations/${resNum}/cancel`, { method: 'PUT' });
  if (!result?.cancelled) {
    console.error('ERROR: ResLab did not report cancelled=true. Response:', JSON.stringify(result, null, 2));
    console.error('Refusing to update Supabase. Investigate before retrying.');
    process.exit(1);
  }
  console.log(`ResLab cancelled = ${result.cancelled} ✓`);
}

// Step 2: Supabase status update (only after ResLab confirmed cancelled)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error('\nResLab cancelled, but missing Supabase env vars — set status manually.');
  process.exit(1);
}
const supabase = createSupabaseClient(supabaseUrl, serviceKey);
const { data, error } = await supabase
  .from('bookings')
  .update({ status: newStatus })
  .eq('reslab_reservation_number', resNum)
  .select('id, reslab_reservation_number, status');

if (error) {
  console.error('\nSupabase update failed:', error.message);
  process.exit(1);
}
if (!data || data.length === 0) {
  console.error(`\nNo bookings row found with reslab_reservation_number=${resNum}`);
  process.exit(1);
}
console.log(`\nSupabase status -> ${newStatus} ✓`, data[0]);
console.log('\n⚠️  Stripe refund handled separately (dashboard). Park Guard NOT cancelled (prod key not local).\n');
