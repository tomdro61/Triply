/**
 * Triply revenue reconciliation script.
 *
 * Pulls all bookings in a date range from Supabase, optionally cross-checks
 * each against Stripe (amount_received / amount_refunded) and/or ResLab
 * (channel_total / location_total / commissions_total), and produces:
 *
 *   1. A console summary
 *   2. A CSV with per-booking detail (reconcile-revenue.csv)
 *
 * Read-only — never writes to Supabase, Stripe, or ResLab.
 *
 * Money model (per src/app/api/admin/bookings/cancel/route.ts:126-135 and
 * the ResLab dashboard):
 *   - Supabase bookings.grand_total            = ResLab grand_total (parking + tax + fees)
 *   - Supabase bookings.due_at_location        = what the customer pays at the lot directly
 *   - Stripe captures: (grand_total − due_at_location) + service_fee + protection_plan_price
 *   - Owed to ResLab (settlement)              = ResLab history[0].location_total
 *                                                 (= commissions_total + total_tax + location_fees_total)
 *                                                 = $0 when Due at Lot = Yes (customer paid at gate)
 *   - Triply parking-side revenue              = ResLab history[0].channel_total
 *   - Service fee non-refundable on cancel: Triply retains it even on refunded bookings.
 *
 * Refund assumption: refunded bookings are excluded from the "Owed to
 * ResLab" total (lot doesn't get paid → ResLab shouldn't bill us). Both
 * totals are surfaced so you can verify against the actual invoice.
 *
 * Usage:
 *   node scripts/reconcile-revenue.mjs --no-stripe
 *   node scripts/reconcile-revenue.mjs --no-stripe --reslab
 *   node scripts/reconcile-revenue.mjs --from=2026-05-01 --to=2026-05-31 --reslab
 */

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { writeFileSync } from 'fs';

dotenv.config({ path: '.env.local' });

// ---- Config ---------------------------------------------------------------

const DEFAULT_FROM = '2026-02-19'; // Triply launch
const DEFAULT_TO = '2026-05-31';   // through May (ResLab invoice period)
const PG_WHOLESALE = 6.0;
const CSV_PATH = 'reconcile-revenue.csv';
const DEFAULT_INVOICE_AMOUNT = 1608.88; // May 2026 invoice; override with --invoice=N

const args = process.argv.slice(2);
function flag(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const FROM_DATE = flag('from', DEFAULT_FROM);
const TO_DATE = flag('to', DEFAULT_TO);
const SKIP_STRIPE = args.includes('--no-stripe');
const USE_RESLAB = args.includes('--reslab');
// ResLab invoices by trip-completion month — pass --by=checkout to match.
// Allowed: created (default, when bookings were made), checkout (trip end),
// checkin (trip start).
const BY_FIELD_RAW = flag('by', 'created');
const BY_FIELD = ['created', 'checkout', 'checkin'].includes(BY_FIELD_RAW) ? BY_FIELD_RAW : 'created';
const DATE_COLUMN = { created: 'created_at', checkout: 'check_out', checkin: 'check_in' }[BY_FIELD];
const RESLAB_INVOICE_AMOUNT = parseFloat(flag('invoice', DEFAULT_INVOICE_AMOUNT)) || DEFAULT_INVOICE_AMOUNT;

// Test-booking exclusion — MUST mirror src/config/admin.ts:isTestBooking
// and src/lib/accounting/reconcile.ts (2026-06-01 alignment). A booking
// is "test" iff it's at a TEST ResLab lot id. Admin-email bookings at
// REAL airport lots are NOT excluded — that conflation previously hid
// legitimate revenue from monthly reports.
const TEST_RESLAB_LOCATION_IDS = new Set([194, 195, 196, 197]);

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripeKey = process.env.STRIPE_SECRET_KEY;
const reslabKey = process.env.RESLAB_API_KEY;
const reslabUrl = process.env.RESLAB_API_URL || 'https://api.reservationslab.com/v1';
const reslabDomain = process.env.RESLAB_API_DOMAIN || 'triplypro.com';

if (!supabaseUrl || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}
if (!SKIP_STRIPE && !stripeKey) {
  console.error('Missing STRIPE_SECRET_KEY in .env.local (or pass --no-stripe)');
  process.exit(1);
}
if (USE_RESLAB && !reslabKey) {
  console.error('Missing RESLAB_API_KEY in .env.local (--reslab was requested)');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);
const stripe = stripeKey ? new Stripe(stripeKey) : null;

// ---- Helpers --------------------------------------------------------------

const fnum = (n) => (Math.round(n * 100) / 100).toFixed(2);
const usd = (n) => `$${fnum(n)}`;
const pad = (s, w) => String(s).padEnd(w);
const padR = (s, w) => String(s).padStart(w);

function row(label, val, extra = '') {
  console.log(`  ${pad(label, 42)} ${padR(usd(val), 14)}  ${extra}`);
}
function divider() {
  console.log('  ' + '─'.repeat(60));
}

// ---- ResLab API -----------------------------------------------------------

async function reslabAuth() {
  const res = await fetch(`${reslabUrl}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: reslabKey, domain: reslabDomain }),
  });
  if (!res.ok) throw new Error(`ResLab auth failed (${res.status}): ${await res.text()}`);
  const { token } = await res.json();
  if (!token) throw new Error('ResLab auth response missing token');
  return token;
}

async function reslabReservation(resNum, token) {
  const res = await fetch(`${reslabUrl}/reservations/${resNum}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`ResLab ${res.status} on ${resNum}: ${await res.text()}`);
  return res.json();
}

// ---- Pull bookings --------------------------------------------------------

console.log(`\nTriply revenue reconciliation\n`);
console.log(`  Period:        ${FROM_DATE} → ${TO_DATE} (inclusive, by ${DATE_COLUMN})`);
console.log(`  Test-lot filter: reslab_location_id in {${[...TEST_RESLAB_LOCATION_IDS].join(',')}}`);
console.log(`  Stripe check:  ${SKIP_STRIPE ? 'OFF' : 'ON'}`);
console.log(`  ResLab check:  ${USE_RESLAB ? 'ON' : 'OFF'}`);
console.log(`  Invoice target: $${RESLAB_INVOICE_AMOUNT.toFixed(2)}\n`);

const { data: bookings, error } = await supabase
  .from('bookings')
  .select(`
    id,
    reslab_reservation_number,
    status,
    created_at,
    check_in,
    check_out,
    grand_total,
    due_at_location,
    triply_service_fee,
    protection_plan,
    protection_plan_price,
    pg_identifier,
    stripe_payment_intent_id,
    reslab_location_id,
    location_name,
    airport_code,
    customers ( email )
  `)
  .gte(DATE_COLUMN, `${FROM_DATE}T00:00:00Z`)
  .lte(DATE_COLUMN, `${TO_DATE}T23:59:59.999Z`)
  .order(DATE_COLUMN, { ascending: true });

if (error) {
  console.error('Supabase query failed:', error);
  process.exit(1);
}

console.log(`Pulled ${bookings.length} bookings from Supabase.`);

const real = [];
const testBookings = [];
for (const b of bookings) {
  if (TEST_RESLAB_LOCATION_IDS.has(b.reslab_location_id)) testBookings.push(b);
  else real.push(b);
}
console.log(`Excluded ${testBookings.length} booking(s) at TEST lots.\n`);

// ---- Cross-check loop -----------------------------------------------------

let reslabToken = null;
if (USE_RESLAB) {
  process.stdout.write('Authenticating with ResLab… ');
  reslabToken = await reslabAuth();
  console.log('ok');
}

const enriched = [];
const stripeMismatches = [];
const reslabErrors = [];
const grandTotalMismatches = [];
let stripeChecked = 0;
let stripeMissingPI = 0;
let reslabChecked = 0;

if (!SKIP_STRIPE) process.stdout.write(`Cross-checking ${real.length} bookings against Stripe… `);
for (let i = 0; i < real.length; i++) {
  const b = real[i];
  let stripeReceived = null;
  let stripeRefunded = null;
  let stripeStatus = null;
  let stripeError = null;

  if (!SKIP_STRIPE && b.stripe_payment_intent_id) {
    try {
      const pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id, {
        expand: ['latest_charge'],
      });
      stripeReceived = (pi.amount_received || 0) / 100;
      stripeStatus = pi.status;
      const charge = pi.latest_charge && typeof pi.latest_charge === 'object'
        ? pi.latest_charge
        : null;
      stripeRefunded = charge ? (charge.amount_refunded || 0) / 100 : 0;
      stripeChecked++;
    } catch (e) {
      stripeError = e.message;
    }
  } else if (!SKIP_STRIPE && !b.stripe_payment_intent_id) {
    stripeMissingPI++;
  }

  // Supabase-side composition
  const grandTotal = parseFloat(b.grand_total ?? 0) || 0;
  const dueAtLot = parseFloat(b.due_at_location ?? 0) || 0;
  const parkingOnline = Math.max(0, grandTotal - dueAtLot);
  const serviceFee = parseFloat(b.triply_service_fee ?? 0) || 0;
  const pgPremium = parseFloat(b.protection_plan_price ?? 0) || 0;
  const hasPG = !!b.protection_plan;
  const expectedStripe = parkingOnline + serviceFee + pgPremium;

  if (stripeReceived !== null) {
    const diff = Math.abs(expectedStripe - stripeReceived);
    if (diff > 0.01) {
      stripeMismatches.push({
        resNum: b.reslab_reservation_number,
        expectedFromRow: expectedStripe,
        stripeReceived,
        diff: expectedStripe - stripeReceived,
      });
    }
  }

  // ResLab cross-check
  let reslabLocationTotal = null;
  let reslabChannelTotal = null;
  let reslabCommissionsTotal = null;
  let reslabGrandTotal = null;
  let reslabRefundAmount = null;
  let reslabPartialRefund = null;
  let reslabDueAtLot = null;
  let reslabCancelled = null;
  let reslabError = null;

  if (USE_RESLAB && b.reslab_reservation_number) {
    try {
      const data = await reslabReservation(b.reslab_reservation_number, reslabToken);
      const h = data.history?.[0];
      reslabCancelled = !!data.cancelled;
      if (h) {
        reslabLocationTotal = parseFloat(h.location_total ?? 0) || 0;
        reslabChannelTotal = parseFloat(h.channel_total ?? 0) || 0;
        reslabCommissionsTotal = parseFloat(h.commissions_total ?? 0) || 0;
        reslabGrandTotal = parseFloat(h.grand_total ?? 0) || 0;
        reslabRefundAmount = parseFloat(h.refund_amount ?? 0) || 0;
        reslabPartialRefund = parseFloat(h.partial_refund ?? 0) || 0;
        reslabDueAtLot = parseFloat(h.due_at_location_total ?? 0) || 0;
        reslabChecked++;
        // Skip the mismatch flag when ResLab correctly zeroed out a
        // refunded/cancelled booking — both systems agree, just at
        // different "levels of history" (Supabase preserves the original
        // grand_total for audit; ResLab clears it on cancellation).
        const bothAgreeCancelled = b.status === 'refunded' && reslabCancelled;
        if (!bothAgreeCancelled && Math.abs(reslabGrandTotal - grandTotal) > 0.01) {
          grandTotalMismatches.push({
            resNum: b.reslab_reservation_number,
            supabase: grandTotal,
            reslab: reslabGrandTotal,
            diff: grandTotal - reslabGrandTotal,
          });
        }
      } else {
        reslabError = 'no history[0] in response';
      }
    } catch (e) {
      reslabError = e.message;
      reslabErrors.push({ resNum: b.reslab_reservation_number, err: e.message });
    }
  }

  enriched.push({
    ...b,
    grandTotal, dueAtLot, parkingOnline, serviceFee, pgPremium, hasPG, expectedStripe,
    stripeReceived, stripeRefunded, stripeStatus, stripeError,
    reslabLocationTotal, reslabChannelTotal, reslabCommissionsTotal,
    reslabGrandTotal, reslabRefundAmount, reslabPartialRefund, reslabDueAtLot,
    reslabCancelled, reslabError,
  });

  // Progress dot every 10 bookings (since ResLab is the slow path)
  if (USE_RESLAB && (i + 1) % 10 === 0) process.stdout.write('.');
}
if (!SKIP_STRIPE) console.log(`done (${stripeChecked} checked, ${stripeMissingPI} no PI)`);
if (USE_RESLAB) console.log(` done (${reslabChecked} ResLab fetches, ${reslabErrors.length} errors)\n`);

// ---- Aggregate ------------------------------------------------------------

const confirmed = enriched.filter((b) => b.status === 'confirmed');
const refunded = enriched.filter((b) => b.status === 'refunded');
const cancelled = enriched.filter((b) => b.status === 'cancelled');
const otherStatus = enriched.filter(
  (b) => !['confirmed', 'refunded', 'cancelled'].includes(b.status)
);

// Supabase-side
let confParkingOnline = 0, confDueAtLot = 0, confServiceFee = 0, confPGPremium = 0, confPGOptIns = 0;
for (const b of confirmed) {
  confParkingOnline += b.parkingOnline;
  confDueAtLot += b.dueAtLot;
  confServiceFee += b.serviceFee;
  if (b.hasPG) { confPGPremium += b.pgPremium; confPGOptIns += 1; }
}

let refServiceFeeKept = 0, refParkingRefunded = 0, refPGRefunded = 0, refPGOptIns = 0;
let refStripeReceived = 0, refStripeRefunded = 0;
for (const b of refunded) {
  refServiceFeeKept += b.serviceFee;
  refParkingRefunded += b.parkingOnline;
  refStripeReceived += b.stripeReceived ?? b.expectedStripe;
  refStripeRefunded += b.stripeRefunded ?? Math.max(0, (b.stripeReceived ?? b.expectedStripe) - b.serviceFee);
  if (b.hasPG) { refPGRefunded += b.pgPremium; refPGOptIns += 1; }
}

const grossStripe = confirmed.reduce((s, b) => s + (b.stripeReceived ?? b.expectedStripe), 0) + refStripeReceived;
const totalRefunded = refStripeRefunded + confirmed.reduce((s, b) => s + (b.stripeRefunded ?? 0), 0);
const netStripe = grossStripe - totalRefunded;

const netServiceFee = confServiceFee + refServiceFeeKept;
const netPGMargin = Math.max(0, confPGPremium - confPGOptIns * PG_WHOLESALE);
const netTriplyRevenue = netServiceFee + netPGMargin;
const pgWholesaleOwed = confPGOptIns * PG_WHOLESALE;

// ResLab-side (only meaningful when USE_RESLAB)
let confLocTotalOwed = 0, confChannelTotal = 0, confLocCommissions = 0;
let refLocTotalIfBilled = 0;
let reslabRefundsSeen = 0;
for (const b of confirmed) {
  confLocTotalOwed += b.reslabLocationTotal ?? 0;
  confChannelTotal += b.reslabChannelTotal ?? 0;
  confLocCommissions += b.reslabCommissionsTotal ?? 0;
}
for (const b of refunded) {
  refLocTotalIfBilled += b.reslabLocationTotal ?? 0;
  if ((b.reslabRefundAmount ?? 0) > 0 || (b.reslabPartialRefund ?? 0) > 0) reslabRefundsSeen++;
}

// ---- Console report -------------------------------------------------------

console.log('═'.repeat(72));
console.log(' BOOKING COUNTS');
console.log('═'.repeat(72));
console.log(`  Confirmed:   ${confirmed.length}`);
console.log(`  Refunded:    ${refunded.length}`);
console.log(`  Cancelled:   ${cancelled.length}  (no payment captured)`);
if (otherStatus.length) {
  const byStatus = otherStatus.reduce((acc, b) => {
    acc[b.status || '(null)'] = (acc[b.status || '(null)'] || 0) + 1;
    return acc;
  }, {});
  console.log(`  Other:       ${otherStatus.length}  (${JSON.stringify(byStatus)})`);
}
console.log(`  Total:       ${enriched.length}\n`);

console.log('═'.repeat(72));
console.log(' STRIPE CASH FLOW');
console.log('═'.repeat(72));
row('Gross collected (sum amount_received)', grossStripe);
row('Refunded (sum amount_refunded)', -totalRefunded);
divider();
row('Net Stripe receipts', netStripe);

console.log('\n' + '═'.repeat(72));
console.log(' NET BREAKDOWN — where the net cash is');
console.log('═'.repeat(72));
console.log('\n  CONFIRMED bookings (full revenue path)');
row('Parking — collected online', confParkingOnline);
row('Triply service fee (→ Triply)', confServiceFee);
row('Park Guard premium (→ passthrough)', confPGPremium, `(${confPGOptIns} opt-ins)`);
row('    of which PG wholesale owed ($6 × n)', pgWholesaleOwed);
row('    of which Triply PG margin', confPGPremium - pgWholesaleOwed);
divider();
row('Subtotal (confirmed contribution)', confParkingOnline + confServiceFee + confPGPremium);

console.log('\n  REFUNDED bookings (only service fee retained)');
row('Service fee retained (→ Triply)', refServiceFeeKept);
row('Parking refunded to customer', refParkingRefunded, '(net 0 — refunded)');
row('PG premium refunded to customer', refPGRefunded, `(${refPGOptIns} opt-ins auto-cancelled)`);
divider();
row('Subtotal (refunded contribution)', refServiceFeeKept);

console.log('\n' + '═'.repeat(72));
console.log(' TRIPLY NET REVENUE (after refunds)');
console.log('═'.repeat(72));
row('Service fee (incl. retained on refunds)', netServiceFee);
row('Park Guard margin', netPGMargin);
divider();
row('Total Triply net revenue', netTriplyRevenue);

console.log('\n' + '═'.repeat(72));
console.log(' INFORMATIONAL (not in cash flow above)');
console.log('═'.repeat(72));
row('Due-at-location (paid directly to lot)', confDueAtLot, '(Triply never touched)');
row('PG wholesale owed to Park Guard', pgWholesaleOwed, `(${confPGOptIns} confirmed × $${PG_WHOLESALE})`);

// ResLab-anchored breakdown — the authoritative one for the invoice
if (USE_RESLAB) {
  console.log('\n' + '═'.repeat(72));
  console.log(' RESLAB-SOURCED BREAKDOWN (the authoritative settlement view)');
  console.log('═'.repeat(72));
  console.log('\n  CONFIRMED bookings');
  row('Owed to ResLab (sum location_total)', confLocTotalOwed, '← compare to invoice');
  row('Triply channel commission (channel_total)', confChannelTotal, '← Triply parking revenue');
  row('Location commission (commissions_total)', confLocCommissions, '(lot share, included in owed)');

  console.log('\n  REFUNDED bookings');
  row('location_total if ResLab still bills', refLocTotalIfBilled, '(excluded from owed; verify w/ ResLab)');
  if (reslabRefundsSeen > 0) {
    console.log(`  (${reslabRefundsSeen} refunded booking(s) show non-zero refund_amount/partial_refund in ResLab)`);
  }

  console.log('\n' + '═'.repeat(72));
  console.log(` RESLAB INVOICE RECONCILIATION ($${RESLAB_INVOICE_AMOUNT.toFixed(2)})`);
  console.log('═'.repeat(72));
  const variance = confLocTotalOwed - RESLAB_INVOICE_AMOUNT;
  row('Sum location_total (confirmed only)', confLocTotalOwed);
  row('Invoice amount', RESLAB_INVOICE_AMOUNT);
  divider();
  row('Variance (positive = invoice underbills)', variance);
  if (BY_FIELD !== 'checkout') {
    console.log('  💡 ResLab invoices by TRIP-COMPLETION month. For invoice matching,');
    console.log('     rerun with --by=checkout (e.g., --from=2026-05-01 --to=2026-05-31 --by=checkout).');
  }

  // Per-booking grand_total mismatches
  if (grandTotalMismatches.length === 0) {
    console.log(`\n  ✅ All ${reslabChecked} ResLab grand_totals match Supabase exactly.`);
  } else {
    console.log(`\n  ⚠️  ${grandTotalMismatches.length} Supabase↔ResLab grand_total mismatches (see CSV):`);
    for (const m of grandTotalMismatches.slice(0, 10)) {
      console.log(`    ${m.resNum}  supabase=${usd(m.supabase)}  reslab=${usd(m.reslab)}  diff=${usd(m.diff)}`);
    }
    if (grandTotalMismatches.length > 10) console.log(`    … and ${grandTotalMismatches.length - 10} more`);
  }

  if (reslabErrors.length > 0) {
    console.log(`\n  ⚠️  ${reslabErrors.length} ResLab fetch errors:`);
    for (const e of reslabErrors.slice(0, 5)) console.log(`    ${e.resNum}: ${e.err}`);
  }
} else {
  console.log('\n  (Pass --reslab to fetch the ResLab-side breakdown and reconcile the invoice.)');
}

// ---- Stripe reconciliation warnings ---------------------------------------

if (!SKIP_STRIPE) {
  if (stripeMismatches.length === 0) {
    console.log('\n✅ Stripe cross-check: every booking matches its row composition.\n');
  } else {
    console.log(`\n⚠️  Stripe mismatches (${stripeMismatches.length}) — investigate:\n`);
    for (const m of stripeMismatches.slice(0, 10)) {
      console.log(`  ${m.resNum}  expected=${usd(m.expectedFromRow)}  stripe=${usd(m.stripeReceived)}  diff=${usd(m.diff)}`);
    }
    if (stripeMismatches.length > 10) console.log(`  … and ${stripeMismatches.length - 10} more (see CSV)`);
    console.log('');
  }
}

// ---- CSV ------------------------------------------------------------------

const csvHeader = [
  'booking_id',
  'reslab_res_num',
  'status',
  'created_at',
  'check_in',
  'check_out',
  'customer_email',
  'airport_code',
  'reslab_location_id',
  'location_name',
  'grand_total',
  'due_at_location',
  'parking_online',
  'triply_service_fee',
  'protection_plan',
  'protection_plan_price',
  'pg_identifier',
  'expected_stripe',
  'stripe_amount_received',
  'stripe_amount_refunded',
  'stripe_status',
  'stripe_diff',
  // ResLab fields
  'reslab_grand_total',
  'reslab_due_at_lot',
  'reslab_location_total_owed',
  'reslab_channel_total',
  'reslab_commissions_total',
  'reslab_refund_amount',
  'reslab_partial_refund',
  'grand_total_diff',
  'reslab_error',
  // Roll-ups
  'triply_keeps',
  'note',
].join(',');

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const csvLines = [csvHeader];
for (const b of enriched) {
  const stripeDiff = b.stripeReceived !== null ? fnum(b.expectedStripe - b.stripeReceived) : '';
  const grandDiff = b.reslabGrandTotal !== null ? fnum(b.grandTotal - b.reslabGrandTotal) : '';
  let triplyKeeps = 0;
  let note = '';
  if (b.status === 'confirmed') {
    triplyKeeps = b.serviceFee + (b.hasPG ? Math.max(0, b.pgPremium - PG_WHOLESALE) : 0);
  } else if (b.status === 'refunded') {
    triplyKeeps = b.serviceFee;
    note = 'service fee retained';
  } else if (b.status === 'cancelled') {
    note = 'no payment captured';
  }
  if (b.stripeError) note = (note ? note + '; ' : '') + `stripe error: ${b.stripeError}`;
  if (b.reslabError) note = (note ? note + '; ' : '') + `reslab error: ${b.reslabError}`;
  csvLines.push([
    b.id,
    b.reslab_reservation_number,
    b.status,
    b.created_at,
    b.check_in,
    b.check_out,
    b.customers?.email || '',
    b.airport_code || '',
    b.reslab_location_id || '',
    b.location_name || '',
    fnum(b.grandTotal),
    fnum(b.dueAtLot),
    fnum(b.parkingOnline),
    fnum(b.serviceFee),
    b.protection_plan || '',
    fnum(b.pgPremium),
    b.pg_identifier || '',
    fnum(b.expectedStripe),
    b.stripeReceived !== null ? fnum(b.stripeReceived) : '',
    b.stripeRefunded !== null ? fnum(b.stripeRefunded) : '',
    b.stripeStatus || '',
    stripeDiff,
    b.reslabGrandTotal !== null ? fnum(b.reslabGrandTotal) : '',
    b.reslabDueAtLot !== null ? fnum(b.reslabDueAtLot) : '',
    b.reslabLocationTotal !== null ? fnum(b.reslabLocationTotal) : '',
    b.reslabChannelTotal !== null ? fnum(b.reslabChannelTotal) : '',
    b.reslabCommissionsTotal !== null ? fnum(b.reslabCommissionsTotal) : '',
    b.reslabRefundAmount !== null ? fnum(b.reslabRefundAmount) : '',
    b.reslabPartialRefund !== null ? fnum(b.reslabPartialRefund) : '',
    grandDiff,
    b.reslabError || '',
    fnum(triplyKeeps),
    note,
  ].map(csvEscape).join(','));
}

writeFileSync(CSV_PATH, csvLines.join('\n'));
console.log(`📄 CSV written: ${CSV_PATH}  (${csvLines.length - 1} rows)\n`);
