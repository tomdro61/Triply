/**
 * Reconciliation tool: replay a Park Guard capture for a booking whose
 * pg_identifier is null. Use when a transient PG outage or env-misconfig
 * caused the original POST to fail after Stripe and ResLab succeeded.
 *
 * The capture endpoint requires a structured address (street/city/state/zip)
 * which Triply does not store on the booking row — we only persist the
 * concatenated `location_address`. To stay general, this script first looks
 * for a previous successful capture against the same `reslab_location_id`
 * and reuses those address values; it falls back to CLI overrides.
 *
 * Usage (run from triply/ root):
 *   npx tsx --env-file=.env.local scripts/resync-orphan-booking.ts <booking_id>
 *   npx tsx --env-file=.env.local scripts/resync-orphan-booking.ts <booking_id> \
 *     --street "1 Main St" --city Cincinnati --state OH --zip 45202
 *
 * Hits whichever Park Guard host PARKGUARD_API_URL points to in .env.local
 * (testing or prod). Writes pg_identifier + pg_sync_status='synced' back
 * to Supabase using the service-role key.
 */

import { createClient } from "@supabase/supabase-js";
import { parkGuard, formatPgDate, PROTECTION_PLAN } from "../src/lib/parkguard/client";

interface AddressOverrides {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

function parseArgs(argv: string[]): { bookingId?: string; addr: AddressOverrides } {
  const addr: AddressOverrides = {};
  let bookingId: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--street") addr.street = argv[++i];
    else if (a === "--city") addr.city = argv[++i];
    else if (a === "--state") addr.state = argv[++i];
    else if (a === "--zip") addr.zip = argv[++i];
    else if (!bookingId && !a.startsWith("--")) bookingId = a;
  }
  return { bookingId, addr };
}

const { bookingId, addr: cliAddr } = parseArgs(process.argv);
if (!bookingId) {
  console.error(
    "Usage: npx tsx --env-file=.env.local scripts/resync-orphan-booking.ts <booking_id> " +
      "[--street S] [--city C] [--state ST] [--zip Z]"
  );
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function findPriorAddressForLot(
  reslabLocationId: number
): Promise<AddressOverrides | null> {
  // PG doesn't echo the address fields back when we capture, and we don't
  // store them per-booking. But a prior successful capture's payload reflects
  // the same lot, so the simplest reuse path is "find any sibling booking
  // with the same lot that already has a pg_identifier" and ask the operator
  // to confirm. Since address isn't on bookings either, we fall through to
  // CLI overrides if no other source is available.
  const { data, error } = await supabase
    .from("bookings")
    .select("id, location_address")
    .eq("reslab_location_id", reslabLocationId)
    .not("pg_identifier", "is", null)
    .limit(1);
  if (error || !data || data.length === 0) return null;
  // location_address is "street, city, state" — best-effort split for the
  // operator to sanity-check; zip is never present in this string.
  const parts = (data[0].location_address ?? "").split(",").map((s: string) => s.trim());
  const out: AddressOverrides = {};
  if (parts[0]) out.street = parts[0];
  if (parts[1]) out.city = parts[1];
  if (parts[2]) out.state = parts[2];
  return out;
}

async function main() {
  const { data: booking, error: fetchErr } = await supabase
    .from("bookings")
    .select(
      "id, customer_id, reslab_location_id, reslab_reservation_number, check_in, check_out, vehicle_info, protection_plan, protection_plan_price, pg_identifier, pg_sync_status, created_at"
    )
    .eq("id", bookingId)
    .single();

  if (fetchErr || !booking) {
    throw new Error(`Booking not found: ${fetchErr?.message ?? "no row"}`);
  }
  if (booking.pg_identifier) {
    throw new Error(
      `Booking already has pg_identifier=${booking.pg_identifier}; refusing to duplicate.`
    );
  }
  if (!booking.protection_plan) {
    throw new Error("Booking has no protection_plan; nothing to capture.");
  }

  const { data: customer, error: custErr } = await supabase
    .from("customers")
    .select("email, first_name, last_name, phone")
    .eq("id", booking.customer_id)
    .single();
  if (custErr || !customer) {
    throw new Error(`Customer not found: ${custErr?.message ?? "no row"}`);
  }

  // Address resolution: CLI overrides win; otherwise reuse what we can
  // extract from a sibling capture for the same lot. Zip is never stored,
  // so it MUST come from CLI overrides.
  const inferred = await findPriorAddressForLot(booking.reslab_location_id);
  const street = cliAddr.street ?? inferred?.street;
  const city = cliAddr.city ?? inferred?.city;
  const state = cliAddr.state ?? inferred?.state;
  const zip = cliAddr.zip;
  if (!street || !city || !state || !zip) {
    throw new Error(
      `Missing address fields (street=${!!street} city=${!!city} state=${!!state} zip=${!!zip}). ` +
        `Pass --street, --city, --state, --zip explicitly. Zip is never stored on bookings ` +
        `and must always come from the CLI.`
    );
  }

  const startDate = formatPgDate(new Date(booking.check_in));
  const endDate = formatPgDate(new Date(booking.check_out));
  const startTime = booking.check_in.slice(11, 19);
  const endTime = booking.check_out.slice(11, 19);
  const bookingDate = formatPgDate(new Date(booking.created_at));

  const vehicle = (booking.vehicle_info ?? {}) as {
    make?: string;
    model?: string;
    year?: number | string;
  };

  const payload = {
    reservation_id: booking.id,
    reservation_start_date: startDate,
    reservation_end_date: endDate,
    booking_date: bookingDate,
    parking_street_address: street,
    parking_city: city,
    parking_state: state,
    parking_zipcode: zip,
    protection_plan: PROTECTION_PLAN.name,
    protection_plan_price: Number(booking.protection_plan_price),
    email: customer.email,
    first_name: customer.first_name,
    last_name: customer.last_name,
    phone_number: customer.phone,
    reservation_start_time: startTime,
    reservation_end_time: endTime,
    car_make: vehicle.make,
    car_model: vehicle.model,
    car_year: typeof vehicle.year === "string" ? Number(vehicle.year) : vehicle.year,
    booking_site: "reconciliation-script",
  };

  console.log("Posting to Park Guard:", JSON.stringify(payload, null, 2));

  const pgRes = await parkGuard.captureReservation(payload);
  console.log("Park Guard response:", pgRes);

  const { error: updateErr } = await supabase
    .from("bookings")
    .update({
      pg_identifier: pgRes.pg_identifier,
      pg_sync_status: "synced",
    })
    .eq("id", booking.id);
  if (updateErr) {
    throw new Error(
      `Captured to PG (id=${pgRes.pg_identifier}) but failed to update DB: ${updateErr.message}`
    );
  }
  console.log(`OK: booking ${booking.id} synced as pg_identifier=${pgRes.pg_identifier}`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
