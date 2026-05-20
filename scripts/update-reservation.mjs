/**
 * Manually update a ResLab reservation's dates.
 *
 * Usage:
 *   node scripts/update-reservation.mjs <RES_NUMBER> "<FROM>" "<TO>" [--apply] [--sync-supabase]
 *
 *   FROM/TO format: "YYYY-MM-DD HH:MM:SS" (24h)
 *
 * Default is dry-run: fetches current reservation, previews the new price via
 * /cost, and prints the diff. Re-run with --apply to PUT the update.
 *
 * --sync-supabase additionally writes the new subtotal / tax_total /
 * grand_total / check_in / check_out to the matching bookings row. ResLab's
 * PUT response only includes subtotal + grand_total, so tax_total is derived
 * as (grand_total - subtotal - fees_total), keeping fees_total constant
 * (typically a flat facility fee that doesn't scale with duration).
 *
 * Does NOT touch Stripe (handle the price delta via Stripe Dashboard or a
 * payment link). Does NOT update Park Guard — see
 * reference_park_guard_envs.md in memory: the prod PG env requires its own
 * API key that local .env.local doesn't have by default.
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

async function authenticate() {
  const res = await fetch(`${API_URL}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: API_KEY, domain: API_DOMAIN }),
  });
  if (!res.ok) {
    throw new Error(`Auth failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.token;
}

async function api(token, path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function fmtMoney(n) {
  return `$${Number(n).toFixed(2)}`;
}

function assertValidReslabHistory(history, label) {
  if (!history || history.grand_total == null || history.subtotal == null) {
    console.error(`\nERROR: ResLab ${label} missing subtotal or grand_total — refusing to continue.`);
    console.error(`  subtotal:    ${history?.subtotal}`);
    console.error(`  grand_total: ${history?.grand_total}`);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const list = args.includes('--list');
  const syncSupabase = args.includes('--sync-supabase');
  const positional = args.filter((a) => !a.startsWith('--'));

  if (list) {
    const token = await authenticate();
    const page = await api(token, '/reservations?page=1');
    const rows = page?.data || [];
    console.log(`\nAPI key sees ${page?.total ?? rows.length} reservations. First page:\n`);
    for (const r of rows.slice(0, 15)) {
      const h = r.history?.[0];
      console.log(
        `  ${r.reservation_number}  channel=${r.channel_id}  testing=${r.testing}  ` +
          `created=${r.created_at}  loc=${h?.location_id}  for=${h?.reserved_for}`
      );
    }
    console.log('');
    return;
  }

  const [resNum, newFrom, newTo] = positional;

  if (!resNum || !newFrom || !newTo) {
    console.error('Usage: node scripts/update-reservation.mjs <RES_NUMBER> "<FROM>" "<TO>" [--apply]');
    console.error('       node scripts/update-reservation.mjs --list    (show reservations visible to this API key)');
    console.error('       Dates in "YYYY-MM-DD HH:MM:SS" format (24h)');
    process.exit(1);
  }

  console.log(`\nReservation: ${resNum}`);
  console.log(`New dates:   ${newFrom}  →  ${newTo}\n`);

  const token = await authenticate();

  // Fetch current reservation
  const current = await api(token, `/reservations/${resNum}`);
  const history = current.history?.[0];
  if (!history) throw new Error('Reservation has no history entries');

  const currentDate = history.dates?.[0];
  if (!currentDate) throw new Error('Reservation has no date entry');

  console.log('--- CURRENT ---');
  console.log(`Reserved for: ${history.reserved_for}`);
  console.log(`Email:        ${history.email}`);
  console.log(`Location ID:  ${history.location_id}`);
  console.log(`From:         ${currentDate.from_date}`);
  console.log(`To:           ${currentDate.to_date}`);
  console.log(`Grand total:  ${fmtMoney(history.grand_total)}`);

  // Rebuild extra fields (vehicle info, etc.) so PUT doesn't wipe them
  const extraFields = {};
  for (const f of history.extra_fields || []) {
    if (f.value !== undefined && f.value !== null) {
      extraFields[f.name] = f.value;
    }
  }

  const items = [
    {
      type: 'parking',
      reservation_type: 'parking',
      type_id: currentDate.type_id,
      from_date: newFrom,
      to_date: newTo,
      number_of_spots: 1,
    },
  ];

  // Price preview
  const cost = await api(token, `/cost?reservation_number=${resNum}`, {
    method: 'POST',
    body: JSON.stringify({
      items,
      location_id: history.location_id,
      reservation_type: 'parking',
    }),
  });
  const newTotal = cost.reservation?.grand_total ?? 0;
  const delta = newTotal - Number(history.grand_total);

  console.log('\n--- NEW (preview) ---');
  console.log(`From:         ${newFrom}`);
  console.log(`To:           ${newTo}`);
  console.log(`Grand total:  ${fmtMoney(newTotal)}`);
  console.log(`Delta:        ${delta >= 0 ? '+' : ''}${fmtMoney(delta)}`);
  if (cost.warning) console.log(`Warning:      ${cost.warning}`);

  // If --sync-supabase without --apply, ResLab must already match the target dates
  // (i.e. we're backfilling Supabase after a prior update). Otherwise require --apply.
  if (syncSupabase && !apply) {
    if (currentDate.from_date !== newFrom || currentDate.to_date !== newTo) {
      console.error('\nERROR: --sync-supabase without --apply requires ResLab to already have the target dates.');
      console.error(`  ResLab now: ${currentDate.from_date}  →  ${currentDate.to_date}`);
      console.error(`  Target:     ${newFrom}  →  ${newTo}`);
      console.error('Add --apply to push the update to ResLab first, or fix the target dates.\n');
      process.exit(1);
    }
  }

  if (!apply && !syncSupabase) {
    console.log('\n*** DRY RUN. Re-run with --apply to commit this change. ***\n');
    return;
  }

  // ResLab history record we'll sync from. Set after --apply, or re-fetched
  // in the syncSupabase block if running in backfill mode.
  let newHistory;

  if (apply) {
    const updateBody = {
      location_id: history.location_id,
      reserved_for: history.reserved_for,
      phone: history.phone,
      email: history.email,
      items,
      ...extraFields,
    };

    console.log('\nApplying update...');
    const updated = await api(token, `/reservations/${resNum}`, {
      method: 'PUT',
      body: JSON.stringify(updateBody),
    });

    // ResLab returns history newest-first, so index 0 is the post-update state.
    newHistory = updated.history?.[0];

    // Validate the response shape BEFORE printing it. Avoids "$NaN" lines
    // in the operator's terminal when ResLab returns a malformed body.
    assertValidReslabHistory(newHistory, 'PUT response');

    const newDate = newHistory.dates?.[0];
    console.log('\n--- UPDATED ---');
    console.log(`From:         ${newDate?.from_date}`);
    console.log(`To:           ${newDate?.to_date}`);
    console.log(`Subtotal:     ${fmtMoney(newHistory.subtotal)}`);
    console.log(`Grand total:  ${fmtMoney(newHistory.grand_total)}`);
  }

  if (syncSupabase) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      console.error('\nMissing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
      process.exit(1);
    }

    // Backfill mode: --sync-supabase without --apply means ResLab already
    // has the target dates from a prior run. Re-fetch so we sync against
    // the post-update state rather than the pre-update `history` variable.
    if (!newHistory) {
      const refetched = await api(token, `/reservations/${resNum}`);
      newHistory = refetched.history?.[0];
      assertValidReslabHistory(newHistory, 'GET response (backfill mode)');
    }

    const supabase = createSupabaseClient(supabaseUrl, serviceKey);

    // Read fees_total before update — ResLab's response doesn't break it
    // out separately, so we treat it as constant and back-derive tax_total.
    const { data: existing, error: readErr } = await supabase
      .from('bookings')
      .select('id, fees_total')
      .eq('reslab_reservation_number', resNum)
      .single();

    if (readErr || !existing) {
      console.error(`\nNo bookings row found with reslab_reservation_number=${resNum}`);
      process.exit(1);
    }

    if (existing.fees_total == null) {
      console.error(`\nERROR: bookings.fees_total is null for ${resNum} — cannot back-derive tax_total.`);
      console.error('  Likely cause: historical row predating the booking-insert fallback that writes "feesTotal || 0".');
      console.error('  Recovery: backfill via SQL, e.g.');
      console.error(`    UPDATE bookings SET fees_total = <amount> WHERE reslab_reservation_number = '${resNum}';`);
      console.error('  Then re-run this script.');
      process.exit(1);
    }

    const newSubtotal = Number(newHistory.subtotal);
    const newGrandTotal = Number(newHistory.grand_total);
    const feesTotal = Number(existing.fees_total);

    // Back-derive tax_total. A negative result means ResLab's
    // grand_total < subtotal + fees_total, which is impossible if the inputs
    // are right — fail loudly rather than clamp to zero and hide the bug.
    const rawTaxDelta = newGrandTotal - newSubtotal - feesTotal;
    if (rawTaxDelta < 0) {
      console.error(
        `\nERROR: Derived tax_total negative ` +
          `(grand=${newGrandTotal} - subtotal=${newSubtotal} - fees=${feesTotal} = ${rawTaxDelta}). ` +
          `Refusing to write nonsense to Supabase.`
      );
      process.exit(1);
    }
    const derivedTaxTotal = Number(rawTaxDelta.toFixed(2));

    console.log('\nSyncing Supabase bookings row...');
    console.log(`  check_in     -> ${newFrom}`);
    console.log(`  check_out    -> ${newTo}`);
    console.log(`  subtotal     -> ${fmtMoney(newSubtotal)}`);
    console.log(`  tax_total    -> ${fmtMoney(derivedTaxTotal)}  (derived: grand_total - subtotal - fees_total)`);
    console.log(`  grand_total  -> ${fmtMoney(newGrandTotal)}`);

    const { data, error } = await supabase
      .from('bookings')
      .update({
        check_in: newFrom,
        check_out: newTo,
        subtotal: newSubtotal,
        tax_total: derivedTaxTotal,
        grand_total: newGrandTotal,
      })
      .eq('reslab_reservation_number', resNum)
      .select(
        'id, reslab_reservation_number, check_in, check_out, subtotal, tax_total, grand_total'
      );

    if (error) {
      console.error('Supabase update failed:', error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) {
      console.error(`No bookings row found with reslab_reservation_number=${resNum}`);
      process.exit(1);
    }
    console.log(`\nUpdated ${data.length} booking row(s):`, data[0]);
  }

  if (apply && !syncSupabase) {
    console.log('\n⚠️  Supabase bookings row NOT updated. Re-run with --sync-supabase if needed.\n');
  }
  if (apply) {
    console.log('\n⚠️  Stripe charge NOT updated. Handle separately if the total changed (Stripe Dashboard or payment link).');
    console.log('⚠️  Park Guard dates NOT updated. Local .env.local typically only has the PG STAGING key — see memory ref reference_park_guard_envs.md for prod-key setup, or contact PG support manually.\n');
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
