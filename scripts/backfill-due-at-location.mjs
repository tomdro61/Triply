// Backfill bookings.due_at_location from ResLab for rows created before
// migration 006. Pulls history[0].due_at_location_total from ResLab's
// /reservations/{id} and writes it to the corresponding booking row.
//
// Usage:
//   node scripts/backfill-due-at-location.mjs           # dry run
//   node scripts/backfill-due-at-location.mjs --write   # apply updates
//
// Safe to re-run. Only updates rows where the new value differs from what's
// stored.

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.local' });

const WRITE = process.argv.includes('--write');

const RESLAB_URL = process.env.RESLAB_API_URL || 'https://api.reservationslab.com/v1';
const RESLAB_KEY = process.env.RESLAB_API_KEY;
const RESLAB_DOMAIN = process.env.RESLAB_API_DOMAIN || 'triplypro.com';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!RESLAB_KEY) throw new Error('Missing RESLAB_API_KEY in .env.local');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
});

async function authReslab() {
  const res = await fetch(`${RESLAB_URL}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: RESLAB_KEY, domain: RESLAB_DOMAIN }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const data = await res.json();
  return data.token;
}

async function fetchDueAtLocation(token, reservationNumber) {
  const res = await fetch(`${RESLAB_URL}/reservations/${reservationNumber}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return { error: `HTTP ${res.status}` };
  }
  const data = await res.json();
  const history = data?.history?.[0];
  if (!history) return { error: 'no history entry' };
  return { dueAtLocation: Number(history.due_at_location_total) || 0 };
}

async function main() {
  console.log(WRITE ? '=== WRITE MODE ===' : '=== DRY RUN ===');
  console.log('Authenticating with ResLab...');
  const token = await authReslab();

  // Pull only candidates — rows where we'd be overwriting zero. If some rows
  // really are $0 due at location, fetching and storing 0 is a harmless no-op.
  const { data: rows, error } = await supabase
    .from('bookings')
    .select('id, reslab_reservation_number, location_name, grand_total, triply_service_fee, due_at_location')
    .eq('due_at_location', 0)
    .order('created_at', { ascending: true });

  if (error) throw error;
  console.log(`Found ${rows.length} bookings to check\n`);

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const row of rows) {
    const result = await fetchDueAtLocation(token, row.reslab_reservation_number);
    if (result.error) {
      console.log(`  ✗ ${row.reslab_reservation_number} (${row.location_name}): ${result.error}`);
      failed++;
      continue;
    }

    const newValue = result.dueAtLocation;
    if (newValue === 0) {
      unchanged++;
      continue;
    }

    console.log(
      `  ${WRITE ? '→' : '·'} ${row.reslab_reservation_number} (${row.location_name}): ` +
        `due_at_location $0 → $${newValue.toFixed(2)}`
    );

    if (WRITE) {
      const { error: updateError } = await supabase
        .from('bookings')
        .update({ due_at_location: newValue })
        .eq('id', row.id);
      if (updateError) {
        console.log(`    ✗ update failed: ${updateError.message}`);
        failed++;
        continue;
      }
    }
    updated++;

    // Light rate limit: ResLab API is shared with live traffic.
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log(`\n${WRITE ? 'Updated' : 'Would update'}: ${updated}`);
  console.log(`Unchanged (truly $0): ${unchanged}`);
  console.log(`Failed: ${failed}`);

  if (!WRITE && updated > 0) {
    console.log('\nRun again with --write to apply.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
