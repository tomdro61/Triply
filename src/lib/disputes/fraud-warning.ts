import type Stripe from "stripe";
import { capturePaymentError } from "@/lib/sentry";
import { sendFraudWarningAlert } from "@/lib/resend/send-dispute-alert";
import type { createAdminClient } from "@/lib/supabase/server";
import { markAlertSent, releaseAlertLease, takeAlertLease, type AlertLedger, type DisputeOutcome } from "./handle-dispute";

type Db = Awaited<ReturnType<typeof createAdminClient>>;

const MISSING_TABLE = new Set(["42P01", "PGRST205"]);
const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : x?.id ?? null);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
const LEDGER: AlertLedger = { table: "fraud_warnings", key: "stripe_warning_id" };

type WarningBooking = {
  id: string;
  reslab_reservation_number: string | null;
  status: string | null;
  check_in: string | null;
};

/**
 * radar.early_fraud_warning.created: the card network says this charge is
 * likely fraud, usually days before the dispute. Refunding first avoids the
 * dispute and its fee — but only a person decides (the parking may already
 * have been used). Ledger row and one alert email, sent through the same
 * lease as the dispute alert (`alert_sent_at` only after Resend accepted it).
 * Nothing is refunded here.
 */
export async function handleEarlyFraudWarning(supabase: Db, w: Stripe.Radar.EarlyFraudWarning): Promise<DisputeOutcome> {
  const paymentIntentId = idOf(w.payment_intent);
  const ctx = { stripePaymentIntentId: paymentIntentId ?? "unknown", amount: 0 };
  // Every failure asks Stripe to redeliver, a missing table included: unlike
  // a dispute there is no booking flip waiting on this delivery, and a 200
  // before the warning is stored or emailed loses it for good (round-1
  // Codex). Once 046 is applied, the next redelivery records and sends it.
  const fail = (what: string, err: { message: string; code?: string }): DisputeOutcome => {
    const missing = err.code != null && MISSING_TABLE.has(err.code);
    capturePaymentError(
      new Error(`Fraud warning ${w.id}: ${what}: ${err.message}${missing ? " — is migration 046 applied?" : ""}`),
      ctx
    );
    return { retryable: true };
  };

  let booking: WarningBooking | null = null;
  if (paymentIntentId) {
    const { data, error } = await supabase
      .from("bookings")
      .select("id, reslab_reservation_number, status, check_in")
      .eq("stripe_payment_intent_id", paymentIntentId)
      .maybeSingle();
    if (error) return fail("booking lookup failed", error);
    booking = (data as WarningBooking | null) ?? null;
  }

  const { error: insErr } = await supabase.from("fraud_warnings").insert({
    stripe_warning_id: w.id,
    charge_id: idOf(w.charge),
    payment_intent_id: paymentIntentId,
    booking_id: booking?.id ?? null,
    fraud_type: w.fraud_type,
    actionable: w.actionable,
    livemode: w.livemode,
  });
  if (insErr && insErr.code !== "23505") return fail("ledger insert failed", insErr);

  let lease: "taken" | "sent" | "held";
  try {
    lease = await takeAlertLease(supabase, LEDGER, w.id);
  } catch (err) {
    return fail("alert lease failed", { message: messageOf(err) });
  }
  if (lease === "sent") return { retryable: false };
  // Another delivery is sending now, or died less than 2 minutes ago.
  if (lease === "held") return { retryable: true };

  try {
    // No amount: a warning carries none, and bookings.grand_total is not the
    // card charge. The email links to the charge in Stripe.
    await sendFraudWarningAlert({
      warningId: w.id,
      chargeId: idOf(w.charge),
      fraudType: w.fraud_type,
      actionable: w.actionable,
      livemode: w.livemode,
      confirmationNumber: booking?.reslab_reservation_number ?? null,
      bookingStatus: booking?.status ?? null,
      checkIn: booking?.check_in ?? null,
    });
  } catch (err) {
    const { error } = await releaseAlertLease(supabase, LEDGER, w.id);
    if (error) {
      capturePaymentError(
        new Error(`Fraud warning ${w.id}: alert lease release failed (a redelivery sends it after the lease expires): ${error.message}`),
        ctx
      );
    }
    return fail("alert email failed", { message: messageOf(err) });
  }

  const { error: sentErr } = await markAlertSent(supabase, LEDGER, w.id);
  if (sentErr) {
    // The email went out. Not retried: a redelivery would only send it twice.
    capturePaymentError(new Error(`Fraud warning ${w.id}: alert sent but not recorded: ${sentErr.message}`), ctx);
  }
  return { retryable: false };
}
