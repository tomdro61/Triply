import type Stripe from "stripe";
import { capturePaymentError } from "@/lib/sentry";
import { sendFraudWarningAlert } from "@/lib/resend/send-dispute-alert";
import type { createAdminClient } from "@/lib/supabase/server";
import type { DisputeOutcome } from "./handle-dispute";

type Db = Awaited<ReturnType<typeof createAdminClient>>;

const MISSING_TABLE = new Set(["42P01", "PGRST205"]);
const idOf = (x: string | { id: string } | null | undefined) => (typeof x === "string" ? x : x?.id ?? null);

type WarningBooking = {
  id: string;
  reslab_reservation_number: string | null;
  status: string | null;
  check_in: string | null;
  grand_total: number | string | null;
};

/**
 * radar.early_fraud_warning.created: the card network says this charge is
 * likely fraud, usually days before the dispute. Refunding first avoids the
 * dispute and its fee — but only a person decides (the parking may already
 * have been used). Ledger row and one alert email.
 * Nothing is refunded here.
 */
export async function handleEarlyFraudWarning(supabase: Db, w: Stripe.Radar.EarlyFraudWarning): Promise<DisputeOutcome> {
  const paymentIntentId = idOf(w.payment_intent);
  const ctx = { stripePaymentIntentId: paymentIntentId ?? "unknown", amount: 0 };
  const fail = (what: string, err: { message: string; code?: string }): DisputeOutcome => {
    const missing = err.code != null && MISSING_TABLE.has(err.code);
    capturePaymentError(
      new Error(`Fraud warning ${w.id}: ${what}: ${err.message}${missing ? " — is migration 046 applied?" : ""}`),
      ctx
    );
    return { retryable: !missing };
  };

  let booking: WarningBooking | null = null;
  if (paymentIntentId) {
    const { data, error } = await supabase
      .from("bookings")
      .select("id, reslab_reservation_number, status, check_in, grand_total")
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

  const { data: claimed, error: claimErr } = await supabase
    .from("fraud_warnings")
    .update({ alert_sent_at: new Date().toISOString() })
    .eq("stripe_warning_id", w.id)
    .is("alert_sent_at", null)
    .select("stripe_warning_id");
  if (claimErr) return fail("alert claim failed", claimErr);
  if (!Array.isArray(claimed) || claimed.length === 0) return { retryable: false };

  const amount = booking?.grand_total != null ? `$${Number(booking.grand_total).toFixed(2)}` : null;
  try {
    await sendFraudWarningAlert({
      warningId: w.id,
      chargeId: idOf(w.charge),
      fraudType: w.fraud_type,
      actionable: w.actionable,
      livemode: w.livemode,
      confirmationNumber: booking?.reslab_reservation_number ?? null,
      bookingStatus: booking?.status ?? null,
      checkIn: booking?.check_in ?? null,
      amount,
    });
  } catch (err) {
    const { error } = await supabase.from("fraud_warnings").update({ alert_sent_at: null }).eq("stripe_warning_id", w.id);
    if (error) capturePaymentError(new Error(`Fraud warning ${w.id}: claim release failed: ${error.message}`), ctx);
    return fail("alert email failed", { message: err instanceof Error ? err.message : String(err) });
  }

  return { retryable: false };
}
