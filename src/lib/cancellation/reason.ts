import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import type { CancellationReason, CancelledBy } from "./reason-codes";

/**
 * Why a booking was cancelled, and who cancelled it (migration 032).
 *
 * Every write here is BEST-EFFORT and runs as its OWN UPDATE — never folded into
 * the claim / terminal-status writes. A reason is reporting data: a failed write
 * (including "column does not exist" if the code ships before 032 is applied)
 * is Sentry-logged and the cancellation carries on. It must never block, delay
 * or fail a cancel or a refund.
 *
 * NULL reason = unknown. Every row cancelled before 032 stays NULL.
 */

export * from "./reason-codes";

/**
 * Every write here is bounded. "Best-effort" only holds if the catch block is
 * reached: a Supabase call that hangs would run the cancel into its function
 * timeout instead — the customer sees a network error, nothing is refunded and
 * the claim stays held for its stale window. (Rule from the PR #49 review: a
 * fail-open that depends on a catch block does not fail open on a timeout.)
 */
const DB_TIMEOUT_MS = 3_000;

export interface RecordReasonInput {
  /** Row key. Exactly one of these is used: reservation number, else booking id. */
  reservationNumber?: string;
  bookingId?: string;
  cancelledBy: CancelledBy;
  reason: CancellationReason | null;
  /** Pin to the cancel claim, so a stale request can't relabel a new owner's cancel. */
  ownedAt?: string;
  /** Only write when no one has attributed this row yet (`cancelled_by IS NULL`). */
  onlyIfUnset?: boolean;
  /** Sentry endpoint tag. */
  endpoint: string;
}

/**
 * Record who cancelled and why. Best-effort: returns false (and logs) on any
 * failure, never throws.
 */
export async function recordCancellationReason(input: RecordReasonInput): Promise<boolean> {
  const key = input.reservationNumber ?? input.bookingId ?? "(none)";
  try {
    const supabase = await createAdminClient();
    let q = supabase.from("bookings").update({
      cancellation_reason: input.reason,
      cancelled_by: input.cancelledBy,
    });
    if (input.reservationNumber) {
      q = q.eq("reslab_reservation_number", input.reservationNumber);
    } else if (input.bookingId) {
      q = q.eq("id", input.bookingId);
    } else {
      throw new Error("recordCancellationReason: no row key");
    }
    if (input.ownedAt) q = q.eq("cancel_claimed_at", input.ownedAt);
    if (input.onlyIfUnset) q = q.is("cancelled_by", null);

    const { error } = await q.abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    if (error) throw new Error(error.message);
    return true;
  } catch (error) {
    captureAPIError(
      new Error(
        `cancellation reason not recorded for ${key} (by=${input.cancelledBy}, reason=${input.reason ?? "null"}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
      { endpoint: input.endpoint, method: "POST", statusCode: 200 },
    );
    return false;
  }
}

/**
 * The admin's free-text note. Stored in `booking_cancellation_notes`, NOT on
 * `bookings`: customers can read every column of their own booking row through
 * PostgREST (RLS row policy, no column restriction), and this table has no
 * grant to anon/authenticated at all — so the note really is staff-only.
 * One row per booking; a re-cancel attempt on the same booking overwrites.
 * Best-effort like the reason: returns false (and logs) on failure, never throws.
 */
export async function recordCancellationNote(
  bookingId: string,
  note: string,
  endpoint: string,
): Promise<boolean> {
  try {
    const supabase = await createAdminClient();
    const { error } = await supabase
      .from("booking_cancellation_notes")
      .upsert(
        { booking_id: bookingId, note, updated_at: new Date().toISOString() },
        { onConflict: "booking_id" },
      )
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    if (error) throw new Error(error.message);
    return true;
  } catch (error) {
    // Only the error message is logged — never the note text.
    captureAPIError(
      new Error(
        `cancellation note not recorded for booking ${bookingId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
      { endpoint, method: "POST", statusCode: 200 },
    );
    return false;
  }
}

/**
 * Undo a reason recorded at claim time when the cancel did NOT happen (the
 * claim was released and the booking stays confirmed). Pinned to the claim and
 * to `status = confirmed`; best-effort like the write.
 */
export async function clearCancellationReason(
  reservationNumber: string,
  ownedAt: string,
  endpoint: string,
): Promise<void> {
  try {
    const supabase = await createAdminClient();
    const { error } = await supabase
      .from("bookings")
      .update({ cancellation_reason: null, cancelled_by: null })
      .eq("reslab_reservation_number", reservationNumber)
      .eq("status", "confirmed")
      .eq("cancel_claimed_at", ownedAt)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    if (error) throw new Error(error.message);
  } catch (error) {
    captureAPIError(
      new Error(
        `cancellation reason not cleared for ${reservationNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
      { endpoint, method: "POST", statusCode: 200 },
    );
  }
}
