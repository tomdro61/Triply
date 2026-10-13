import { z } from "zod";
import { fetchDirectLot } from "@/lib/direct/store";
import { captureAPIError } from "@/lib/sentry";
import { dbSignal, refuse, repointRefusal, type ActionRefusal, type AdminClient, type DirectBookingRow } from "./booking";

/**
 * "Re-point unsent notices" (6b plan §4): copy the lot's CURRENT CMS inbox onto
 * one booking's `direct_booking_terms.lot_recipients` and bump
 * `recipients_rev` — only while nothing can have been delivered.
 *
 * THE LOCK is the booking-notice claim itself. A single-condition UPDATE takes
 * `lot_notice_claimed_at` only while the notice is neither stamped nor
 * claimed; every sender (`claimAndSend` in lot-notice.ts) needs that same
 * claim and reads the recipients AFTER it wins it, so no sender can mail the
 * old inbox after a re-point, and a re-point can never land under a sender
 * that already read them. The terms are written with a compare-and-set on the
 * old rev, then the lock is released with a compare-and-set on our own
 * timestamp. A release that fails leaves the claim to go stale; the 4b-2 rule
 * then counts the booking as possibly told — at worst a harmless cancel notice
 * (plan §4). Once released, the admin presses Retry: the notice goes out under
 * a NEW Resend key (`/r{rev}`).
 */

const ENDPOINT = "/api/admin/direct-bookings/action";

/** Same rule the checkout stages recipients under (reservations/pending lotRecipientsSchema). */
const recipientsSchema = z.array(z.string().email()).min(1);

export interface RepointResult {
  ok: true;
  from: string[];
  to: string[];
  recipientsRev: number;
}

/** Trimmed, de-duplicated (case-insensitively), CMS order kept. */
export function normaliseRecipients(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const email = raw.trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

export function sameRecipientSet(a: readonly string[], b: readonly string[]): boolean {
  const ka = new Set(a.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const kb = new Set(b.map((s) => s.trim().toLowerCase()).filter(Boolean));
  return ka.size === kb.size && [...ka].every((k) => kb.has(k));
}

export async function repointLotInbox(
  supabase: AdminClient,
  booking: DirectBookingRow
): Promise<RepointResult | ActionRefusal> {
  const pre = repointRefusal(booking);
  if (pre) return pre;
  const piId = booking.stripe_payment_intent_id;

  const { data: termsData, error: termsError } = await supabase
    .from("direct_booking_terms")
    .select("lot_recipients, recipients_rev")
    .eq("stripe_payment_intent_id", piId)
    .abortSignal(dbSignal())
    .maybeSingle();
  if (termsError) return refuse(503, "Couldn't read this booking's lot inbox — try again.");
  if (!termsData) return refuse(500, "This booking has no lot terms on file — handle it by hand.");
  const terms = termsData as { lot_recipients: string[] | null; recipients_rev: number | null };
  const from = Array.isArray(terms.lot_recipients) ? terms.lot_recipients : [];
  const oldRev = terms.recipients_rev;
  if (typeof oldRev !== "number" || !Number.isInteger(oldRev) || oldRev < 0) {
    return refuse(500, "This booking's recipients revision is unreadable — handle it by hand.");
  }

  const lot = await fetchDirectLot(Number(booking.direct_lot_id));
  if (lot.status === "not_found") return refuse(409, "This lot is no longer in the CMS — fix the lot before re-pointing.");
  if (lot.status !== "found") return refuse(503, "Couldn't read the lot's current inbox from the CMS — try again.");
  const to = normaliseRecipients(lot.lot.notificationEmails);
  if (to.length === 0) return refuse(409, "The lot has no notification email in the CMS — add one first.");
  if (!recipientsSchema.safeParse(to).success) {
    return refuse(409, "The lot's notification emails in the CMS include an invalid address — fix them first.");
  }
  if (sameRecipientSet(from, to)) {
    return refuse(409, "This booking already goes to the lot's current CMS inbox — nothing to re-point.");
  }

  // Take the lock: the booking-notice claim, only while nothing is stamped or claimed.
  const lockAt = new Date().toISOString();
  const { data: locked, error: lockError } = await supabase
    .from("bookings")
    .update({ lot_notice_claimed_at: lockAt })
    .eq("id", booking.id)
    .eq("status", "confirmed")
    .is("lot_notice_claimed_at", null)
    .is("lot_notified_at", null)
    .is("cancel_state", null)
    .is("cancel_claimed_at", null)
    .select("id")
    .abortSignal(dbSignal())
    .maybeSingle();
  if (lockError) return refuse(503, "Couldn't lock this booking's notice — try again.");
  if (!locked) return refuse(409, "A notice is being sent or was already sent — it can no longer be re-pointed. Refresh.");

  let outcome: RepointResult | ActionRefusal;
  try {
    const newRev = oldRev + 1;
    const { data: written, error: writeError } = await supabase
      .from("direct_booking_terms")
      .update({ lot_recipients: to, recipients_rev: newRev })
      .eq("stripe_payment_intent_id", piId)
      .eq("recipients_rev", oldRev)
      .select("stripe_payment_intent_id")
      .abortSignal(dbSignal())
      .maybeSingle();
    // A timed-out write may still have committed: never claim "nothing changed".
    if (writeError) outcome = refuse(503, "Couldn't confirm the new inbox was saved — refresh and check before trying again.");
    else if (!written) outcome = refuse(409, "This booking's inbox was changed by someone else just now — refresh and check.");
    else outcome = { ok: true, from, to, recipientsRev: newRev };
  } catch (err) {
    outcome = refuse(500, "Re-pointing failed — nothing is confirmed changed. Refresh and check.");
    captureAPIError(new Error(`re-point terms write threw for ${booking.reslab_reservation_number}: ${err instanceof Error ? err.message : String(err)}`), {
      endpoint: ENDPOINT,
      method: "POST",
      stage: "repoint_terms",
    });
  }

  await releaseLock(supabase, booking, lockAt);
  return outcome;
}

/** Release the lock with a compare-and-set on our own timestamp. Never throws. */
async function releaseLock(supabase: AdminClient, booking: DirectBookingRow, lockAt: string): Promise<void> {
  const report = (detail: string) =>
    captureAPIError(
      new Error(
        `re-point lock on ${booking.reslab_reservation_number} not released (${detail}) — it goes stale in 5 min and the booking then counts as possibly told`
      ),
      { endpoint: ENDPOINT, method: "POST", stage: "repoint_release" }
    );
  try {
    const { data, error } = await supabase
      .from("bookings")
      .update({ lot_notice_claimed_at: null })
      .eq("id", booking.id)
      .eq("lot_notice_claimed_at", lockAt)
      .select("id")
      .abortSignal(dbSignal())
      .maybeSingle();
    if (error) report(error.message);
    else if (!data) report("the claim no longer carries our timestamp");
  } catch (err) {
    report(err instanceof Error ? err.message : String(err));
  }
}
