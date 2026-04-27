/**
 * Re-send a booking confirmation email to a customer using the existing template.
 *
 * Pulls booking + customer data from Supabase and sends via Resend. Use after
 * updating a reservation's dates (see update-reservation.mjs --sync-supabase).
 *
 * Usage:
 *   npx tsx scripts/resend-confirmation.ts <RES_NUMBER> [--subject="Custom subject"]
 *
 * Defaults the subject to "Updated Booking Confirmation - <RES_NUMBER>".
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
dotenv.config({ path: ".env.local" });

// Dynamic imports below for @/lib/resend/* — ES module hoisting would otherwise
// evaluate the resend client before dotenv.config() loads RESEND_API_KEY.

function formatTime(dbValue: string): string {
  // Supabase returns e.g. "2026-04-26T11:00:00+00:00" or similar
  const d = new Date(dbValue);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

function formatDateOnly(dbValue: string): string {
  // Return "YYYY-MM-DD" regardless of input shape
  return dbValue.slice(0, 10);
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const resNum = positional[0];
  const dryRun = args.includes("--dry-run");
  const subjectArg = args.find((a) => a.startsWith("--subject="));
  const subject = subjectArg
    ? subjectArg.replace("--subject=", "")
    : `Updated Booking Confirmation - ${resNum}`;

  if (!resNum) {
    console.error(
      "Usage: npx tsx scripts/resend-confirmation.ts <RES_NUMBER> [--subject=\"...\"]"
    );
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: booking, error } = await supabase
    .from("bookings")
    .select(
      "reslab_reservation_number, location_name, location_address, check_in, check_out, grand_total, triply_service_fee, due_at_location, vehicle_info, customer_id"
    )
    .eq("reslab_reservation_number", resNum)
    .single();

  if (error || !booking) {
    console.error("Booking not found:", error?.message);
    process.exit(1);
  }

  const { data: customer, error: custErr } = await supabase
    .from("customers")
    .select("first_name, last_name, email")
    .eq("id", booking.customer_id)
    .single();

  if (custErr || !customer) {
    console.error("Customer not found:", custErr?.message);
    process.exit(1);
  }

  const vehicle = booking.vehicle_info as {
    make?: string;
    model?: string;
    color?: string;
    licensePlate?: string;
  } | null;

  const vehicleInfo = vehicle
    ? `${vehicle.make ?? ""} ${vehicle.model ?? ""} (${vehicle.color ?? ""}) - ${vehicle.licensePlate ?? ""}`
    : undefined;

  const totalAmount =
    Number(booking.grand_total ?? 0) + Number(booking.triply_service_fee ?? 0);

  const emailProps = {
    customerName: `${customer.first_name} ${customer.last_name}`,
    confirmationNumber: booking.reslab_reservation_number,
    lotName: booking.location_name,
    lotAddress: booking.location_address,
    checkInDate: formatDateOnly(booking.check_in),
    checkOutDate: formatDateOnly(booking.check_out),
    checkInTime: formatTime(booking.check_in),
    checkOutTime: formatTime(booking.check_out),
    totalAmount,
    dueAtLocation: Number(booking.due_at_location ?? 0),
    vehicleInfo,
  };

  console.log(`\n${dryRun ? "DRY-RUN " : ""}Subject: "${subject}"`);
  console.log(`  To:        ${customer.email}`);
  console.log(`  Customer:  ${emailProps.customerName}`);
  console.log(`  Lot:       ${emailProps.lotName}`);
  console.log(`  Check-in:  ${emailProps.checkInDate} ${emailProps.checkInTime}`);
  console.log(`  Check-out: ${emailProps.checkOutDate} ${emailProps.checkOutTime}`);
  console.log(`  Total:     $${totalAmount.toFixed(2)}`);
  console.log(`  Vehicle:   ${vehicleInfo ?? "(none)"}`);

  if (dryRun) {
    // Render the template to verify it compiles without sending
    const { render } = await import("@react-email/render");
    const { BookingConfirmationEmail } = await import(
      "@/lib/resend/templates/booking-confirmation"
    );
    const html = await render(BookingConfirmationEmail(emailProps));
    console.log(`\n✅ Template rendered (${html.length} chars). Not sent.`);
    console.log(`Re-run without --dry-run to send.\n`);
    return;
  }

  const { sendBookingConfirmation } = await import(
    "@/lib/resend/send-booking-confirmation"
  );
  const result = await sendBookingConfirmation({
    to: customer.email,
    ...emailProps,
    subject,
  });

  if (!result.success) {
    console.error("\nFailed to send:", result.error);
    process.exit(1);
  }

  console.log(`\n✅ Email sent. Resend ID: ${result.emailId}\n`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
