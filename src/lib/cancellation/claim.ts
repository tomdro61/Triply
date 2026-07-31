import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";

/**
 * Idempotency claim for the self-cancel path — the concurrency core.
 *
 * Mirrors the pending-row mutex in create-booking.ts: a stale-reclaim window and
 * TWO atomic single-condition UPDATEs, deliberately NOT one `.or()` UPDATE. Real
 * PostgREST rejects `.or()` on an UPDATE ("column ... does not exist") even
 * though it parses on a SELECT — the original booking mutex shipped that way and
 * matched ZERO rows, stalling every booking. Never reintroduce it here.
 *
 * The claim is what makes a double-click / retry / admin-vs-customer race unable
 * to double-refund: only one caller can flip a confirmed booking to `claimed`.
 */

/**
 * A claim older than this whose owner died can be re-driven. MUST exceed the
 * route `maxDuration` (60s) so a healthy in-flight request is never stolen
 * mid-cancel (same constant as the booking engine's STALE_CLAIM_MS).
 */
export const CANCEL_STALE_CLAIM_MS = 90_000;

/**
 * The finite set of `cancel_state` values — the single source of truth, mirroring
 * migration 017's CHECK constraint. Every write of `cancel_state` (here and in
 * perform.ts) is typed against this, so a typo is a COMPILE error rather than a
 * runtime CHECK rejection on the money path — a rejected write only gets logged
 * while the customer still receives a 202, and the reconciliation cron (which
 * filters on `cancel_state`) would never see the stranded row. Keep in sync with
 * `supabase/migrations/017_booking_cancel_claim.sql`.
 */
export type CancelState =
  | "claimed"
  | "held_reslab_ambiguous"
  | "reslab_cancelled_refund_pending"
  | "refund_issued"
  | "admin_claimed";

export class CancelClaimError extends Error {
  constructor(where: string, detail: string) {
    super(`cancel claim ${where}: ${detail}`);
    this.name = "CancelClaimError";
  }
}

export type ClaimResult =
  | { claimed: true; ownedAt: string }
  | { claimed: false; reason: "already_terminal" | "in_progress" };

/**
 * Atomically claim a confirmed booking for cancellation: set `cancel_claimed_at`
 * + `cancel_state = 'claimed'` iff the row is `confirmed` AND either unclaimed OR
 * its claim is stale AND still `'claimed'` (owner died before finishing — a
 * deliberate HOLD like `held_reslab_ambiguous` is left for the reconciliation
 * cron, never stolen).
 *
 * Returns `ownedAt` (the timestamp written) so the later release can pin to it.
 * Throws `CancelClaimError` on a DB fault — the caller maps that to a 500 and
 * performs NO side effects.
 */
export async function claimForCancel(
  reservationNumber: string,
  now: number = Date.now(),
): Promise<ClaimResult> {
  const supabase = await createAdminClient();
  const nowIso = new Date(now).toISOString();
  const staleBefore = new Date(now - CANCEL_STALE_CLAIM_MS).toISOString();
  const claim: { cancel_claimed_at: string; cancel_state: CancelState } = {
    cancel_claimed_at: nowIso,
    cancel_state: "claimed",
  };

  // 1. Fresh claim (unclaimed confirmed row). Disjoint from (2): Postgres
  //    serializes concurrent claimers under a row lock; only one matches
  //    `cancel_claimed_at IS NULL`.
  const fresh = await supabase
    .from("bookings")
    .update(claim)
    .eq("reslab_reservation_number", reservationNumber)
    .eq("status", "confirmed")
    .is("cancel_claimed_at", null)
    .select("id")
    .maybeSingle();
  if (fresh.error) throw new CancelClaimError("fresh", fresh.error.message);
  if (fresh.data) return { claimed: true, ownedAt: nowIso };

  // 2. Steal a stale ABANDONED claim (still `'claimed'`, not a deliberate HOLD).
  //    The first stealer sets cancel_claimed_at=now, so a second racer's
  //    `< staleBefore` no longer holds and it matches nothing.
  const stolen = await supabase
    .from("bookings")
    .update(claim)
    .eq("reslab_reservation_number", reservationNumber)
    .eq("status", "confirmed")
    .eq("cancel_state", "claimed")
    .lt("cancel_claimed_at", staleBefore)
    .select("id")
    .maybeSingle();
  if (stolen.error) throw new CancelClaimError("stale", stolen.error.message);
  if (stolen.data) return { claimed: true, ownedAt: nowIso };

  // 3. Couldn't claim — classify why for the caller's HTTP response.
  const { data: row, error } = await supabase
    .from("bookings")
    .select("status")
    .eq("reslab_reservation_number", reservationNumber)
    .maybeSingle();
  if (error) throw new CancelClaimError("reread", error.message);
  if (!row) throw new CancelClaimError("reread", "booking not found");
  const status = (row as { status?: string }).status;
  if (status === "cancelled" || status === "refunded") {
    return { claimed: false, reason: "already_terminal" };
  }
  // Confirmed, but a fresh (< stale) claim OR a deliberate HOLD is in flight.
  return { claimed: false, reason: "in_progress" };
}

/**
 * Release OUR claim on a pre-money abort, PINNED to `ownedAt`. If a slow request
 * was stale-stolen and a new owner claimed, the pin no longer matches and this
 * is a no-op — so a resuming stale request can never wipe the new owner's claim
 * (the FIRS-3 fix). Only used before any money moves; a deliberate HOLD keeps
 * its claim instead of releasing.
 */
export async function releaseClaim(
  reservationNumber: string,
  ownedAt: string,
): Promise<void> {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from("bookings")
    .update({ cancel_claimed_at: null, cancel_state: null })
    .eq("reslab_reservation_number", reservationNumber)
    .eq("status", "confirmed")
    .eq("cancel_claimed_at", ownedAt);
  if (error) throw new CancelClaimError("release", error.message);
}

/** The two HOLD states a cancel can be parked in for the reconciliation cron. */
export type HoldState = Extract<
  CancelState,
  "held_reslab_ambiguous" | "reslab_cancelled_refund_pending"
>;

/**
 * Move a claimed row into a HOLD `cancel_state`, PINNED to `ownedAt` so a request
 * whose claim was stale-stolen can't overwrite the new owner's state. Keeps
 * `cancel_claimed_at` as-is so the reconciliation cron still finds the row.
 * Shared by the customer handler (ambiguous-ResLab HOLD) and the finalize core
 * (refund-failed-after-cancel). `endpoint` scopes the Sentry context to the
 * caller (route vs cron). A write failure is logged, not thrown — the row simply
 * stays in its prior state for the next cron pass.
 */
export async function markCancelState(
  reservationNumber: string,
  ownedAt: string,
  state: HoldState,
  endpoint: string,
): Promise<void> {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from("bookings")
    .update({ cancel_state: state })
    .eq("reslab_reservation_number", reservationNumber)
    .eq("cancel_claimed_at", ownedAt);
  if (error) {
    captureAPIError(
      new Error(
        `cancel: failed to mark ${state} for ${reservationNumber}: ${error.message}`,
      ),
      { endpoint, method: "POST", statusCode: 500 },
    );
  }
}

export type AdminClaimResult =
  | { claimed: true }
  | { claimed: false; reason: "in_progress" | "not_confirmed" };

/**
 * Claim a confirmed booking for an ADMIN cancel using the distinct `admin_claimed`
 * state — which the reconciliation cron's scan EXCLUDES, so the cron never
 * auto-refunds a booking an admin is mid-cancel on. It blocks (and is blocked by)
 * a customer self-cancel claim/HOLD, so the admin and customer paths can never
 * both refund the same booking — they use different refund policies + keys, so a
 * race would genuinely double-refund.
 *
 * Re-entrant for a retry of a partially-failed admin cancel (re-claims an existing
 * `admin_claimed`), but refuses when a CUSTOMER claim/HOLD is in progress. Two
 * atomic single-condition UPDATEs, never `.or()` (see claimForCancel).
 */
export async function adminClaim(
  reservationNumber: string,
  now: number = Date.now(),
): Promise<AdminClaimResult> {
  const supabase = await createAdminClient();
  const claim = {
    cancel_claimed_at: new Date(now).toISOString(),
    cancel_state: "admin_claimed" satisfies CancelState,
  };

  // 1. Fresh: no cancel in progress on this row.
  const fresh = await supabase
    .from("bookings")
    .update(claim)
    .eq("reslab_reservation_number", reservationNumber)
    .eq("status", "confirmed")
    .is("cancel_claimed_at", null)
    .select("id")
    .maybeSingle();
  if (fresh.error) throw new CancelClaimError("admin-fresh", fresh.error.message);
  if (fresh.data) return { claimed: true };

  // 2. Re-claim our OWN prior admin attempt (retry after a partial failure). Only
  //    matches `admin_claimed` — never a customer 'claimed'/HOLD.
  const own = await supabase
    .from("bookings")
    .update(claim)
    .eq("reslab_reservation_number", reservationNumber)
    .eq("status", "confirmed")
    .eq("cancel_state", "admin_claimed")
    .select("id")
    .maybeSingle();
  if (own.error) throw new CancelClaimError("admin-reclaim", own.error.message);
  if (own.data) return { claimed: true };

  // 3. Couldn't claim — classify why for the caller's HTTP response.
  const { data: row, error } = await supabase
    .from("bookings")
    .select("status")
    .eq("reslab_reservation_number", reservationNumber)
    .maybeSingle();
  if (error) throw new CancelClaimError("admin-reread", error.message);
  const status = (row as { status?: string } | null)?.status;
  if (status !== "confirmed") return { claimed: false, reason: "not_confirmed" };
  // Confirmed, but a customer self-cancel claim / HOLD is in progress.
  return { claimed: false, reason: "in_progress" };
}
