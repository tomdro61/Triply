/**
 * Send the standard cancellation-confirmation email for a single reservation.
 *
 * Usage (run from triply/ root):
 *   # Dry-run (default): renders HTML to a file, prints summary, does NOT send
 *   npx tsx --env-file=.env.local scripts/send-cancellation-email.ts <RES_NUM> --refund <amount> [--out <path>]
 *   # Actually send via Resend:
 *   npx tsx --env-file=.env.local scripts/send-cancellation-email.ts <RES_NUM> --refund <amount> --send
 *
 * --refund is REQUIRED and must be the amount Stripe actually CAPTURED
 * (amount_received), NOT the Supabase grand_total — the booking row only
 * stores the ResLab portion and understates the real charge by the Triply
 * service fee + any protection-plan premium. See memory
 * reference_accounting_source_of_truth.md (cash -> Stripe).
 *
 * Full-refund context (lot closure): serviceFee and protectionPlanRefund are
 * intentionally NOT passed, so the email shows a single clean "Refund Amount"
 * total with no "service fee retained" line and no itemization.
 */

import { createClient } from "@supabase/supabase-js";
import { render } from "@react-email/render";
import { writeFileSync } from "fs";
import { CancellationConfirmationEmail } from "../src/lib/resend/templates/cancellation-confirmation";

// Render all dates/times in UTC to match production (Vercel runs UTC), so a run
// from a non-UTC machine can't shift a customer's dates a day.
process.env.TZ = "UTC";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const resNum = process.argv[2];
  const send = process.argv.includes("--send");
  const refundRaw = arg("--refund");
  const outPath = arg("--out") || `${process.env.TEMP || "."}/cancellation-${resNum}.html`;

  if (!resNum || resNum.startsWith("--")) {
    console.error("Usage: npx tsx --env-file=.env.local scripts/send-cancellation-email.ts <RES_NUM> --refund <amount> [--send]");
    process.exit(1);
  }
  if (refundRaw == null || isNaN(Number(refundRaw)) || Number(refundRaw) <= 0) {
    console.error("ERROR: --refund <amount> is required and must be a positive number (the amount Stripe CAPTURED, not the Supabase grand_total).");
    process.exit(1);
  }
  const refundAmount = Number(refundRaw);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: booking, error } = await supabase
    .from("bookings")
    .select(`
      status, location_name, location_address, check_in, check_out,
      grand_total, protection_plan, protection_plan_price,
      customers ( email, first_name, last_name )
    `)
    .eq("reslab_reservation_number", resNum)
    .single();

  if (error || !booking) {
    console.error(`No booking found for ${resNum}:`, error?.message);
    process.exit(1);
  }

  const customer = booking.customers as unknown as {
    email: string;
    first_name: string | null;
    last_name: string | null;
  } | null;

  if (!customer?.email) {
    console.error(`Booking ${resNum} has no customer email — cannot send.`);
    process.exit(1);
  }

  // Match the standard admin-tool template: itemize Parking + Parking Protection
  // when the booking carries a protection plan.
  const protectionPlanRefund = booking.protection_plan
    ? Number(booking.protection_plan_price ?? 0) || 0
    : 0;

  const params = {
    to: customer.email,
    customerName: `${customer.first_name || ""} ${customer.last_name || ""}`.trim() || "Customer",
    confirmationNumber: resNum,
    lotName: booking.location_name || "Parking Location",
    lotAddress: booking.location_address || "",
    checkInDate: booking.check_in as string,
    checkOutDate: booking.check_out as string,
    refundAmount,
    wasRefunded: true,
    protectionPlanRefund: protectionPlanRefund > 0 ? protectionPlanRefund : undefined,
    // serviceFee intentionally omitted — this is a FULL refund (lot closure),
    // so the standard "service fee non-refundable / retained" line must NOT show.
  };

  console.log("\n--- EMAIL PARAMS ---");
  console.log(JSON.stringify({ ...params, bookingStatus: booking.status, supabaseGrandTotal: booking.grand_total }, null, 2));

  if (!send) {
    const html = await render(CancellationConfirmationEmail(params));
    writeFileSync(outPath, html, "utf8");
    console.log(`\n*** DRY RUN — no email sent. ***`);
    console.log(`Rendered HTML written to: ${outPath}`);
    console.log(`Re-run with --send to actually email ${customer.email}.\n`);
    return;
  }

  // --send path: use the app's own sender for fidelity (Resend + Sentry wiring).
  const { sendCancellationConfirmation } = await import(
    "../src/lib/resend/send-cancellation-confirmation"
  );
  const result = await sendCancellationConfirmation(params);
  if (!result.success) {
    console.error("\nEmail send FAILED:", result.error);
    process.exit(1);
  }
  console.log(`\nEmail sent to ${customer.email}. Resend id: ${result.emailId}\n`);
}

main().catch((err) => {
  console.error("\nFAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
