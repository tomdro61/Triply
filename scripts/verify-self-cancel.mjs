/**
 * Self-service cancellation soak verifier (staging).
 *
 * Usage:
 *   node scripts/verify-self-cancel.mjs <RES_NUMBER> [--preview-env <path>]
 *
 * Reads the booking across all four systems and prints what SHOULD happen on a
 * self-cancel, then (run again after cancelling) what DID happen.
 *
 * Environment straddling — this is why it's a script and not a one-liner:
 *   Supabase  -> .env.local        (shared prod DB; staging writes here too)
 *   Stripe    -> .env.local        (TEST key, which is what staging charges)
 *   ResLab    -> .env.preview      (STAGING ResLab — a different account from
 *                                   the prod creds in .env.local. Using the
 *                                   prod key here 404s on a staging booking and
 *                                   looks like data loss.)
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

dotenv.config({ path: ".env.local" });

const args = process.argv.slice(2);
const resNum = args.find((a) => !a.startsWith("--"));
const previewIdx = args.indexOf("--preview-env");
const previewEnvPath = previewIdx >= 0 ? args[previewIdx + 1] : null;

if (!resNum) {
  console.error("Usage: node scripts/verify-self-cancel.mjs <RES_NUMBER> [--preview-env <path>]");
  process.exit(1);
}

// Staging ResLab creds, loaded WITHOUT clobbering the prod ones above.
let reslabEnv = {
  url: process.env.RESLAB_API_URL,
  key: process.env.RESLAB_API_KEY,
  domain: process.env.RESLAB_API_DOMAIN,
  label: "PROD (.env.local)",
};
if (previewEnvPath) {
  const parsed = dotenv.config({ path: previewEnvPath, processEnv: {} }).parsed || {};
  reslabEnv = {
    url: parsed.RESLAB_API_URL,
    key: parsed.RESLAB_API_KEY,
    domain: parsed.RESLAB_API_DOMAIN,
    label: `STAGING (${previewEnvPath})`,
  };
}

const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;
const line = (s = "") => console.log(s);
const head = (s) => { line(); line(`── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}`); };

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function reslabToken() {
  const res = await fetch(`${reslabEnv.url}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: reslabEnv.key, domain: reslabEnv.domain }),
  });
  if (!res.ok) throw new Error(`ResLab auth ${res.status}`);
  return (await res.json()).token;
}

async function main() {
  head("BOOKING (Supabase)");
  const { data: b, error } = await supabase
    .from("bookings")
    .select("*")
    .eq("reslab_reservation_number", resNum)
    .single();
  if (error || !b) {
    console.error(`No booking row for ${resNum}: ${error?.message}`);
    process.exit(1);
  }

  const { data: cust } = await supabase
    .from("customers")
    .select("email, first_name, last_name, user_id")
    .eq("id", b.customer_id)
    .single();

  line(`  reservation : ${b.reslab_reservation_number}`);
  line(`  lot         : ${b.location_name} (loc ${b.reslab_location_id})`);
  line(`  customer    : ${cust?.first_name} ${cust?.last_name} <${cust?.email}>`);
  line(`  status      : ${b.status}`);
  line(`  cancel_state: ${b.cancel_state ?? "null"}   claimed=${b.cancel_claimed_at ?? "null"}`);
  line(`  check_in    : ${b.check_in}   tz=${b.location_timezone ?? "MISSING"}`);
  line(`  grand_total : ${money(b.grand_total)}   service_fee=${money(b.triply_service_fee)}`);
  line(`  park guard  : ${b.protection_plan ?? "none"} ${money(b.protection_plan_price)}  sync=${b.pg_sync_status ?? "n/a"}  id=${b.pg_identifier ?? "null"}`);
  line(`  fee_refunded: ${b.service_fee_refunded}`);

  // ── Preconditions the self-cancel path requires ────────────────────────────
  head("SELF-CANCEL PRECONDITIONS");
  const checks = [];
  checks.push(["status is 'confirmed'", b.status === "confirmed"]);
  checks.push(["not already claimed", !b.cancel_state]);
  checks.push(["location_timezone present", !!b.location_timezone]);
  checks.push(["stripe_payment_intent_id present", !!b.stripe_payment_intent_id]);
  checks.push([
    "customer linked to an account (user_id)",
    !!cust?.user_id,
    "self-cancel is RLS-scoped to customers.user_id — a guest booking is invisible to it",
  ]);

  // 24h eligibility, evaluated in the LOT's timezone (never the server's).
  const [datePart, timePart] = String(b.check_in).replace("T", " ").split(" ");
  const wall = `${datePart} ${(timePart || "00:00:00").slice(0, 8)}`;
  const asUtc = Date.parse(`${wall}Z`);
  const offsetMs = (() => {
    const d = new Date(asUtc);
    const local = new Date(d.toLocaleString("en-US", { timeZone: b.location_timezone || "UTC" }));
    const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
    return local.getTime() - utc.getTime();
  })();
  const checkInInstant = asUtc - offsetMs;
  const hoursOut = (checkInInstant - Date.now()) / 3_600_000;
  checks.push([`check-in is >24h away (currently ${hoursOut.toFixed(1)}h)`, hoursOut > 24]);

  for (const [label, ok, note] of checks) {
    line(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok && note) line(`        ${note}`);
  }

  // ── Expected refund, per the LOCKED policy ─────────────────────────────────
  head("EXPECTED REFUND (locked policy)");
  let paidCents = null;
  let pi = null;
  try {
    pi = await stripe.paymentIntents.retrieve(b.stripe_payment_intent_id, {
      expand: ["latest_charge"],
    });
    paidCents = pi.amount_received;
  } catch (e) {
    line(`  ! Stripe lookup failed (${e.message})`);
    line(`    If this says 'No such payment_intent', the booking is LIVE-mode and`);
    line(`    this script is using the TEST key — i.e. NOT a staging booking.`);
  }

  const pgPremium = Number(b.protection_plan_price ?? 0);
  const pgWholesale = b.protection_plan ? Math.min(6, pgPremium) : 0;
  if (paidCents !== null) {
    const expected = paidCents - Math.round(pgWholesale * 100);
    line(`  charged        : ${money(paidCents / 100)}`);
    line(`  PG wholesale   : -${money(pgWholesale)}   (non-refundable; PG never returns it)`);
    line(`  service fee    : refunded in FULL on self-cancel (unlike admin-standard)`);
    line(`  => expected refund: ${money(expected / 100)}`);
  }

  // ── Current Stripe state ───────────────────────────────────────────────────
  head("STRIPE (test mode)");
  if (pi) {
    line(`  pi status      : ${pi.status}`);
    line(`  amount         : ${money(pi.amount / 100)}   received=${money(pi.amount_received / 100)}`);
    const ch = pi.latest_charge;
    if (ch) {
      line(`  amount_refunded: ${money(ch.amount_refunded / 100)}   (refunded flag=${ch.refunded} — false just means partial)`);
      const refunds = await stripe.refunds.list({ charge: ch.id, limit: 10 });
      line(`  refunds        : ${refunds.data.length}`);
      for (const r of refunds.data) {
        line(`    ${r.id}  ${money(r.amount / 100)}  ${r.status}  ${new Date(r.created * 1000).toISOString()}`);
      }
    }
  }

  // ── ResLab state ───────────────────────────────────────────────────────────
  head(`RESLAB — ${reslabEnv.label}`);
  try {
    const token = await reslabToken();
    const r = await fetch(`${reslabEnv.url}/reservations/${resNum}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      line(`  GET /reservations/${resNum} -> ${r.status}`);
      if (r.status === 404) {
        // Staging and prod are SEPARATE ResLab accounts, so a booking made in
        // one is genuinely absent from the other. A 404 means the creds and the
        // booking don't match — not that the reservation was lost.
        line(`  A 404 means these creds and this booking are from different`);
        line(`  ResLab accounts (staging and prod are separate):`);
        line(`    - querying STAGING creds? then this is a PROD booking`);
        line(`    - querying PROD creds? then this is a STAGING booking`);
        line(`  Currently querying: ${reslabEnv.label}`);
      }
    } else {
      const d = await r.json();
      const h = d.history?.[0];
      line(`  cancelled   : ${JSON.stringify(d.cancelled)}   (1/true = cancelled at the lot)`);
      line(`  reserved_for: ${h?.reserved_for}`);
      line(`  dates       : ${h?.dates?.[0]?.from_date} -> ${h?.dates?.[0]?.to_date}`);
      line(`  grand_total : ${money(h?.grand_total)}`);
    }
  } catch (e) {
    line(`  ! ResLab lookup failed: ${e.message}`);
  }

  line();
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
