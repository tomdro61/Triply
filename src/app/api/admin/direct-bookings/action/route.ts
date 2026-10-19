import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { badRequest, requireAdmin } from "@/lib/direct/payout-admin";
import {
  buildDirectResendView,
  redriveDirectBookingSends,
  type DirectRedriveResult,
  type DirectResendView,
} from "@/lib/booking/create-booking";
import { sendDirectCustomerConfirmation } from "@/lib/booking/fulfill";
import { fetchDirectLot } from "@/lib/direct/store";
import {
  actionBodySchema,
  dbSignal,
  loadDirectBooking,
  reservationNumberSchema,
  retryRefusal,
  type ActionRefusal,
  type AdminClient,
} from "@/lib/direct/admin-actions/booking";
import { readOpenAlerts, resolveBookingAlerts, type OpenAlert } from "@/lib/direct/admin-actions/alerts";
import { repointLotInbox } from "@/lib/direct/admin-actions/repoint";
import {
  resendCustomerConfirmation,
  resendLotCancellation,
  type ConfirmationResender,
} from "@/lib/direct/admin-actions/resends";

/**
 * Admin actions on ONE direct (Triply-lot) booking — 6b plan §6 / §4.
 *
 *   GET  ?reservationNumber=TRP-…   what the booking modal shows: the lot inbox
 *                                   on file (and the lot's current CMS inbox),
 *                                   when the lot was told / sent the
 *                                   cancellation, whether the customer
 *                                   confirmation has gone, and the booking's
 *                                   open alerts.
 *   POST { reservationNumber, action }
 *     retry_lot_notice              re-drive the unsent booking notice (and the
 *                                   customer confirmation if that is unsent too);
 *                                   once the lot is told, still sends a customer
 *                                   confirmation that never went ("Send
 *                                   confirmation now")
 *     repoint_lot_inbox             copy the lot's current CMS inbox onto an
 *                                   UNSENT notice (takes the notice claim as its lock)
 *     resend_lot_cancellation       remind the lot of a cancellation it was sent
 *     resend_customer_confirmation  re-send the guest's confirmation email
 *                                   (only once the original has gone)
 *     resolve_alerts                "lot phoned": mark the booking's open
 *                                   alerts resolved by this admin
 *
 * Admin only. Direct rows only. A booking paid in the other Stripe mode is
 * refused (409) before any side effect: staging and production share one
 * database. Can send a booking notice (`redriveDirectBookingSends`), so its
 * lifetime is pinned well inside the notice claim window
 * (notice-claim-window.test.ts).
 */
export const maxDuration = 30;

const ENDPOINT = "/api/admin/direct-bookings/action";

type ReadyView = Extract<DirectResendView, { ok: true }>;

/**
 * The booking engine's halves of a confirmation re-send, handed to the
 * src/lib/direct helper (which must never import the engine — it reaches
 * ResLab). `build` returns the engine's refusal as-is: a reason the helper
 * doesn't map is a type error here.
 */
const confirmationResender: ConfirmationResender<ReadyView> = {
  async build(piId) {
    const v = await buildDirectResendView(piId);
    return v.ok ? { ok: true, view: v, guestEmail: v.dp.customer.email } : v;
  },
  send: (v, idempotencyKey) =>
    sendDirectCustomerConfirmation(v.dp, v.fr, v.pgSyncStatus, v.charged, v.promo, { idempotencyKey }),
};

/**
 * Has the original customer confirmation gone (`pending_bookings.email_sent`)?
 * `sent` null = no staged row or an unreadable value; `error` = the read failed.
 */
async function readCustomerEmailSent(
  supabase: AdminClient,
  piId: string
): Promise<{ sent: boolean | null; error: string | null }> {
  const { data, error } = await supabase
    .from("pending_bookings")
    .select("email_sent")
    .eq("stripe_payment_intent_id", piId)
    .abortSignal(dbSignal())
    .maybeSingle();
  if (error) return { sent: null, error: error.message };
  const emailSent = (data as { email_sent?: unknown } | null)?.email_sent;
  return { sent: typeof emailSent === "boolean" ? emailSent : null, error: null };
}

const refusal = (r: ActionRefusal) => NextResponse.json({ error: r.error }, { status: r.status });

const fail = (method: "GET" | "POST", stage: string, err: unknown) => {
  captureAPIError(err instanceof Error ? err : new Error(String(err)), { endpoint: ENDPOINT, method, stage });
  return NextResponse.json({ error: "Something went wrong — refresh and check before trying again." }, { status: 500 });
};

export async function GET(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.response;
  const parsed = reservationNumberSchema.safeParse(new URL(request.url).searchParams.get("reservationNumber") ?? "");
  if (!parsed.success) return badRequest(parsed.error);

  try {
    const supabase = await createAdminClient();
    const loaded = await loadDirectBooking(supabase, parsed.data, { requireThisMode: false });
    if (!loaded.ok) return refusal(loaded);
    const { booking, otherMode } = loaded;
    const { data, error } = await supabase
      .from("direct_booking_terms")
      .select("lot_recipients, recipients_rev")
      .eq("stripe_payment_intent_id", booking.stripe_payment_intent_id)
      .abortSignal(dbSignal())
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Couldn't read this booking's lot inbox — try again." }, { status: 503 });
    const terms = data as { lot_recipients: string[] | null; recipients_rev: number | null } | null;
    // Has the original customer confirmation gone? Until it has, the re-send is
    // refused and "Send confirmation now" (retry_lot_notice) sends the original
    // instead; the sweep also retries it until check-out. null = couldn't read —
    // the panel then offers the re-send button and the POST re-checks.
    const staged = await readCustomerEmailSent(supabase, booking.stripe_payment_intent_id);
    if (staged.error) {
      captureAPIError(new Error(`email_sent read failed: ${staged.error}`), { endpoint: ENDPOINT, method: "GET", stage: "email_sent" });
    }
    const customerEmailSent = staged.sent;
    // Open alerts: shown only. null = couldn't read (the panel says so).
    let openAlerts: OpenAlert[] | null;
    try {
      openAlerts = await readOpenAlerts(supabase, booking);
    } catch (err) {
      openAlerts = null;
      captureAPIError(err instanceof Error ? err : new Error(String(err)), { endpoint: ENDPOINT, method: "GET", stage: "open_alerts" });
    }
    // The lot's CURRENT CMS inbox, for the re-point confirm (old → new). Shown
    // only; the action re-reads it. null = the CMS couldn't say right now.
    const lot = await fetchDirectLot(Number(booking.direct_lot_id));
    return NextResponse.json({
      lotRecipients: terms?.lot_recipients ?? null,
      cmsInbox: lot.status === "found" ? lot.lot.notificationEmails : null,
      recipientsRev: terms?.recipients_rev ?? null,
      lotNotifiedAt: booking.lot_notified_at,
      lotNoticeClaimedAt: booking.lot_notice_claimed_at,
      lotCancelNotifiedAt: booking.lot_cancel_notified_at,
      customerEmailSent,
      openAlerts,
      // The other environment's booking: shown, but every action is refused here.
      otherEnvironment: otherMode,
    });
  } catch (err) {
    return fail("GET", "info", err);
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin.ok) return admin.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const parsed = actionBodySchema.safeParse(body);
  if (!parsed.success) return badRequest(parsed.error);
  const { reservationNumber, action } = parsed.data;

  try {
    const supabase = await createAdminClient();
    const loaded = await loadDirectBooking(supabase, reservationNumber, { requireThisMode: true });
    if (!loaded.ok) return refusal(loaded);
    const { booking } = loaded;

    switch (action) {
      case "retry_lot_notice": {
        // Once the lot is told, this action is still the way to send a customer
        // confirmation that never went — so read whether it has.
        let customerEmailSent: boolean | null = null;
        if (booking.lot_notified_at) {
          const staged = await readCustomerEmailSent(supabase, booking.stripe_payment_intent_id);
          if (staged.error) {
            captureAPIError(new Error(`email_sent read failed: ${staged.error}`), { endpoint: ENDPOINT, method: "POST", stage: "email_sent" });
            return NextResponse.json({ error: "Couldn't check whether the customer confirmation has gone — nothing was sent. Try again." }, { status: 503 });
          }
          customerEmailSent = staged.sent;
        }
        const pre = retryRefusal(booking, customerEmailSent);
        if (pre) return refusal(pre);
        let result: DirectRedriveResult;
        try {
          result = await redriveDirectBookingSends(booking.stripe_payment_intent_id);
        } catch (err) {
          // A Stripe or database READ failed before anything was sent.
          captureAPIError(
            new Error(`retry lot notice for ${booking.reslab_reservation_number}: ${err instanceof Error ? err.message : String(err)}`),
            { endpoint: ENDPOINT, method: "POST", stage: "retry_lot_notice" }
          );
          return NextResponse.json({ error: "Couldn't read the booking from Stripe or the database — nothing was sent. Try again." }, { status: 502 });
        }
        return NextResponse.json({ ok: true, action, result });
      }
      case "repoint_lot_inbox": {
        const r = await repointLotInbox(supabase, booking);
        return r.ok ? NextResponse.json({ ...r, action }) : refusal(r);
      }
      case "resend_lot_cancellation": {
        const r = await resendLotCancellation(supabase, booking, admin.value.email);
        return r.ok ? NextResponse.json({ ...r, action }) : refusal(r);
      }
      case "resend_customer_confirmation": {
        const r = await resendCustomerConfirmation(supabase, booking, admin.value.email, confirmationResender);
        return r.ok ? NextResponse.json({ ...r, action }) : refusal(r);
      }
      case "resolve_alerts": {
        const r = await resolveBookingAlerts(supabase, booking, admin.value.email);
        return r.ok ? NextResponse.json({ ...r, action }) : refusal(r);
      }
    }
  } catch (err) {
    return fail("POST", action, err);
  }
}
