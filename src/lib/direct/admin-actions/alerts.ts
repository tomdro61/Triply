import { dbSignal, refuse, type ActionRefusal, type AdminClient, type DirectBookingRow } from "./booking";

/**
 * "Lot phoned — mark resolved" (6b review, migration 042): an admin records
 * that they dealt with this booking by phone, and its open alerts stop.
 *
 * A booking's alert rows (041's subjects):
 *   lot_notice / cancel_notice  subject = the booking's PaymentIntent id
 *   followup                    subject = "{bookingId}:{source}" (the manifest cron's)
 * Only rows still open (`resolved_at IS NULL`) in the booking's own Stripe
 * mode are touched; staging and production share this table. Re-running is
 * harmless: a resolved row no longer matches.
 */

const BOOKING_ALERT_KINDS = ["lot_notice", "cancel_notice"] as const;

export type BookingAlertKind = (typeof BOOKING_ALERT_KINDS)[number] | "followup";

/** What the panel shows for an open alert. No `detail` — the panel never needs it. */
export interface OpenAlert {
  kind: BookingAlertKind;
  first_seen_at: string;
  alerted_at: string | null;
}

export interface ResolveAlertsResult {
  ok: true;
  resolved: number;
}

/** A followup subject starts with "{bookingId}:"; a UUID has no LIKE wildcards. */
const followupPattern = (b: DirectBookingRow) => `${b.id}:%`;

const asOpenAlert = (r: Record<string, unknown>): OpenAlert | null => {
  const kind = r.kind;
  if (kind !== "lot_notice" && kind !== "cancel_notice" && kind !== "followup") return null;
  if (typeof r.first_seen_at !== "string") return null;
  return { kind, first_seen_at: r.first_seen_at, alerted_at: typeof r.alerted_at === "string" ? r.alerted_at : null };
};

/** This booking's open alerts, oldest first. Throws on a read failure. */
export async function readOpenAlerts(supabase: AdminClient, booking: DirectBookingRow): Promise<OpenAlert[]> {
  const [direct, followups] = await Promise.all([
    supabase
      .from("direct_lot_alerts")
      .select("kind, first_seen_at, alerted_at")
      .eq("livemode", booking.livemode)
      .eq("subject", booking.stripe_payment_intent_id)
      .in("kind", [...BOOKING_ALERT_KINDS])
      .is("resolved_at", null)
      .abortSignal(dbSignal()),
    supabase
      .from("direct_lot_alerts")
      .select("kind, first_seen_at, alerted_at")
      .eq("livemode", booking.livemode)
      .eq("kind", "followup")
      .like("subject", followupPattern(booking))
      .is("resolved_at", null)
      .abortSignal(dbSignal()),
  ]);
  if (direct.error) throw new Error(`open alerts read failed: ${direct.error.message}`);
  if (followups.error) throw new Error(`open follow-up alerts read failed: ${followups.error.message}`);
  const rows: Array<Record<string, unknown>> = [...(direct.data ?? []), ...(followups.data ?? [])];
  return rows
    .map(asOpenAlert)
    .filter((a): a is OpenAlert => a !== null)
    .sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at));
}

/**
 * Mark this booking's open alerts resolved by `resolvedBy` (the admin's email).
 * Two UPDATEs (never `.or()` on an UPDATE). A failed write is a 503: nothing
 * is lost by pressing it again — a row it did resolve no longer matches.
 */
export async function resolveBookingAlerts(
  supabase: AdminClient,
  booking: DirectBookingRow,
  resolvedBy: string
): Promise<ResolveAlertsResult | ActionRefusal> {
  const stamp = { resolved_at: new Date().toISOString(), resolved_by: resolvedBy };
  const { data: direct, error: directError } = await supabase
    .from("direct_lot_alerts")
    .update(stamp)
    .eq("livemode", booking.livemode)
    .eq("subject", booking.stripe_payment_intent_id)
    .in("kind", [...BOOKING_ALERT_KINDS])
    .is("resolved_at", null)
    .select("kind")
    .abortSignal(dbSignal());
  if (directError) return refuse(503, "Couldn't mark this booking's alerts resolved — refresh and try again.");
  const { data: followups, error: followupError } = await supabase
    .from("direct_lot_alerts")
    .update(stamp)
    .eq("livemode", booking.livemode)
    .eq("kind", "followup")
    .like("subject", followupPattern(booking))
    .is("resolved_at", null)
    .select("kind")
    .abortSignal(dbSignal());
  if (followupError) {
    return refuse(503, "Couldn't mark all of this booking's alerts resolved — refresh and press it again.");
  }
  return { ok: true, resolved: (direct?.length ?? 0) + (followups?.length ?? 0) };
}
