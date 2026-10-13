import { z } from "zod";
import type { createAdminClient } from "@/lib/supabase/server";
import { cancelSource, isOtherStripeMode, OTHER_MODE_MESSAGE } from "@/lib/cancellation/source-guard";
import { STALE_NOTICE_CLAIM_MS } from "@/lib/direct/lot-notice";
import { captureAPIError } from "@/lib/sentry";

/**
 * Shared steps of the direct-booking admin actions (6b plan §6): the request
 * shape, the booking lookup, and the guards every action runs before any side
 * effect — direct rows only, never a booking paid in the other Stripe mode.
 */

export type AdminClient = Awaited<ReturnType<typeof createAdminClient>>;

/** Every read/write here is bounded: a hung database must answer inside the route's 30 s. */
export const DB_TIMEOUT_MS = 3_000;
export const dbSignal = () => AbortSignal.timeout(DB_TIMEOUT_MS);

export const DIRECT_ADMIN_ACTIONS = [
  "retry_lot_notice",
  "repoint_lot_inbox",
  "resend_lot_cancellation",
  "resend_customer_confirmation",
  "resolve_alerts",
] as const;
export type DirectAdminAction = (typeof DIRECT_ADMIN_ACTIONS)[number];

export const reservationNumberSchema = z.string().trim().min(1, "reservationNumber is required").max(64);

export const actionBodySchema = z.object({
  reservationNumber: reservationNumberSchema,
  action: z.enum(DIRECT_ADMIN_ACTIONS),
});

/** A refusal or failure the route answers as-is. `error` is staff-facing and never carries PII. */
export interface ActionRefusal {
  ok: false;
  status: 400 | 404 | 409 | 500 | 502 | 503;
  error: string;
}

export const refuse = (status: ActionRefusal["status"], error: string): ActionRefusal => ({ ok: false, status, error });

export interface DirectBookingRow {
  id: string;
  stripe_payment_intent_id: string;
  reslab_reservation_number: string;
  inventory_source: string | null;
  status: string;
  livemode: boolean;
  direct_lot_id: string;
  lot_notified_at: string | null;
  lot_notice_claimed_at: string | null;
  lot_cancel_notified_at: string | null;
  cancel_state: string | null;
  cancel_claimed_at: string | null;
  location_name: string | null;
  check_in: string;
  check_out: string;
  vehicle_info: { make?: string; model?: string; color?: string; licensePlate?: string; state?: string } | null;
  customer_id: string | null;
}

// One literal (not a concatenation): supabase-js parses the select string's type.
export const DIRECT_BOOKING_COLUMNS =
  "id, stripe_payment_intent_id, reslab_reservation_number, inventory_source, status, livemode, direct_lot_id, lot_notified_at, lot_notice_claimed_at, lot_cancel_notified_at, cancel_state, cancel_claimed_at, location_name, check_in, check_out, vehicle_info, customer_id";

/**
 * The direct booking with this TRP- number. Refuses: no such booking (404), a
 * ResLab booking or an inconsistent row (409), a row without the columns every
 * direct booking carries (500), and — when `requireThisMode` — a booking paid
 * in the other Stripe mode (409): staging and production share this database,
 * and acting on the other environment's booking would mail with the wrong
 * recipients rule and read its PaymentIntent with the wrong key.
 */
export async function loadDirectBooking(
  supabase: AdminClient,
  reservationNumber: string,
  { requireThisMode }: { requireThisMode: boolean }
): Promise<{ ok: true; booking: DirectBookingRow; otherMode: boolean } | ActionRefusal> {
  const { data, error } = await supabase
    .from("bookings")
    .select(DIRECT_BOOKING_COLUMNS)
    .eq("reslab_reservation_number", reservationNumber)
    .abortSignal(dbSignal())
    .maybeSingle();
  if (error) throw new Error(`booking read failed: ${error.message}`);
  if (!data) return refuse(404, "Booking not found");
  const row: Record<string, unknown> = data;
  const source = cancelSource({
    inventory_source: typeof row.inventory_source === "string" ? row.inventory_source : null,
    reslab_reservation_number: reservationNumber,
  });
  if (source.kind !== "direct") return refuse(409, "This action is only for bookings at Triply's own lots.");
  const booking = parseDirectBookingRow(row);
  if (!booking) {
    captureAPIError(new Error(`direct admin action: booking ${reservationNumber} is missing a required direct-row column`), {
      endpoint: "/api/admin/direct-bookings/action",
      method: "POST",
      stage: "load_booking",
    });
    return refuse(500, "This booking is missing fields every Triply-lot booking has — handle it by hand (see Sentry).");
  }
  const otherMode = isOtherStripeMode(booking.livemode);
  if (requireThisMode && otherMode) return refuse(409, OTHER_MODE_MESSAGE);
  return { ok: true, booking, otherMode };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Narrow the PostgREST row; null when a column every direct row must carry is absent. */
function parseDirectBookingRow(r: Record<string, unknown>): DirectBookingRow | null {
  const id = str(r.id);
  const pi = str(r.stripe_payment_intent_id);
  const number = str(r.reslab_reservation_number);
  const status = str(r.status);
  const lotId = r.direct_lot_id == null ? null : String(r.direct_lot_id);
  // 034's direct CHECK makes livemode NOT NULL on a direct row; a null here is a broken row, not "live".
  if (!id || !pi || !number || !status || !lotId || typeof r.livemode !== "boolean") return null;
  const vehicle = r.vehicle_info;
  return {
    id,
    stripe_payment_intent_id: pi,
    reslab_reservation_number: number,
    inventory_source: str(r.inventory_source),
    status,
    livemode: r.livemode,
    direct_lot_id: lotId,
    lot_notified_at: str(r.lot_notified_at),
    lot_notice_claimed_at: str(r.lot_notice_claimed_at),
    lot_cancel_notified_at: str(r.lot_cancel_notified_at),
    cancel_state: str(r.cancel_state),
    cancel_claimed_at: str(r.cancel_claimed_at),
    location_name: str(r.location_name),
    check_in: String(r.check_in ?? ""),
    check_out: String(r.check_out ?? ""),
    vehicle_info: vehicle && typeof vehicle === "object" ? (vehicle as DirectBookingRow["vehicle_info"]) : null,
    customer_id: str(r.customer_id),
  };
}

const midCancel = (b: DirectBookingRow) => !!(b.cancel_state || b.cancel_claimed_at);

/** Is a booking-notice claim still live (its sender may be mid-send)? */
export function noticeClaimIsLive(claimedAt: string | null, nowMs: number = Date.now()): boolean {
  if (!claimedAt) return false;
  const at = Date.parse(claimedAt);
  // An unparseable timestamp is treated as live: never act over a claim we cannot read.
  return !Number.isFinite(at) || nowMs - at < STALE_NOTICE_CLAIM_MS;
}

/**
 * Retry lot notice (§6): these mirror the lot-notice gates — confirmed, not
 * told, no live claim, not mid-cancel — so a refusal here is never "it would
 * have done nothing anyway" in disguise. A notice already stamped is refused
 * even when the customer confirmation is still unsent: that one is retried
 * automatically (the sweep), and this action is about the lot.
 */
export function retryRefusal(b: DirectBookingRow, nowMs: number = Date.now()): ActionRefusal | null {
  if (b.status !== "confirmed") return refuse(409, `This booking is ${b.status} — there is no booking notice to send.`);
  if (b.lot_notified_at) return refuse(409, "The lot was already told about this booking.");
  if (midCancel(b)) return refuse(409, "A cancellation of this booking is in progress — no booking notice will be sent.");
  if (noticeClaimIsLive(b.lot_notice_claimed_at, nowMs)) {
    return refuse(409, "A booking notice is being sent right now — wait a few minutes and refresh.");
  }
  return null;
}

/** Re-point (§4): only while nothing can have been delivered — no stamp and no claim at all (a stale claim may have delivered). */
export function repointRefusal(b: DirectBookingRow): ActionRefusal | null {
  if (b.status !== "confirmed") return refuse(409, `This booking is ${b.status} — there is nothing to re-point.`);
  if (b.lot_notified_at) return refuse(409, "The lot was already told about this booking — its notices can no longer be re-pointed.");
  if (midCancel(b)) return refuse(409, "A cancellation of this booking is in progress.");
  if (b.lot_notice_claimed_at) {
    return refuse(409, "A booking notice is being sent or may already have been sent — it can no longer be re-pointed.");
  }
  return null;
}

/** Re-send lot cancellation (§6): a reminder of a cancellation the lot was already sent. */
export function cancelReminderRefusal(b: DirectBookingRow): ActionRefusal | null {
  if (b.status !== "cancelled" && b.status !== "refunded") {
    return refuse(409, `This booking is ${b.status} — there is no cancellation to re-send.`);
  }
  if (!b.lot_cancel_notified_at) {
    return refuse(409, "The lot has not been sent a cancellation for this booking yet — nothing to re-send.");
  }
  return null;
}

/** Re-send customer confirmation (§6): a standing booking only. */
export function customerResendRefusal(b: DirectBookingRow): ActionRefusal | null {
  if (b.status !== "confirmed") return refuse(409, `This booking is ${b.status} — no confirmation is re-sent for it.`);
  if (midCancel(b)) return refuse(409, "A cancellation of this booking is in progress.");
  return null;
}
