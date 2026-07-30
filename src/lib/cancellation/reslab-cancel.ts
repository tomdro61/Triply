import { reslab, ReslabError } from "@/lib/reslab/client";
import type { ReslabReservation } from "@/lib/reslab/client";

/**
 * Classify the outcome of a ResLab cancel attempt into a money decision. This is
 * the inverse of the create-side classifier and it must NOT reuse it: on the
 * create side a definitive 4xx means "nothing was created, safe to release the
 * money"; on the CANCEL side a 4xx is ambiguous between:
 *   - "already cancelled"  → safe to refund
 *   - "can't cancel (reservation started / checked in / policy)" → the spot is
 *     STILL live and billable, so refunding would pay out on a reservation we
 *     still owe the lot.
 * Those are opposite decisions, so we never trust the 4xx — we GET the
 * reservation and branch on its real `cancelled` flag (prod returns it as the
 * number `1`, hence truthy checks, not `=== true`).
 */

export type CancelOutcome =
  /** Cancellation confirmed (fresh or already-cancelled) → issue the refund. */
  | { outcome: "proceed" }
  /** Reservation is still active / cancel was rejected → do NOT refund; release
   *  the claim and return 409. */
  | { outcome: "refuse"; detail: string }
  /** We cannot determine whether the spot was released (timeout / 5xx / probe
   *  failed) → keep the claim, HOLD, and let the reconciliation cron finish it.
   *  Never refund into this uncertainty. */
  | { outcome: "hold"; detail: string };

function describe(err: unknown): string {
  if (err instanceof ReslabError) return `ReslabError ${err.statusCode}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 200);
  return String(err).slice(0, 200);
}

/** Timeout/abort or a 5xx/429: ResLab may or may not have applied the cancel. */
function isAmbiguous(err: unknown): boolean {
  if (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  ) {
    return true;
  }
  return (
    err instanceof ReslabError &&
    (err.statusCode >= 500 || err.statusCode === 429)
  );
}

/**
 * @param reservationNumber the ResLab reservation being cancelled
 * @param result the outcome of `reslab.cancelReservation(...)` — either the
 *   returned reservation (2xx) or the thrown error.
 */
export async function classifyCancelOutcome(
  reservationNumber: string,
  result:
    | { ok: true; reservation: ReslabReservation }
    | { ok: false; error: unknown },
): Promise<CancelOutcome> {
  // 2xx: trust the returned flag. A 2xx with cancelled falsy means the cancel
  // did not actually apply — do NOT refund.
  if (result.ok) {
    return result.reservation.cancelled
      ? { outcome: "proceed" }
      : {
          outcome: "refuse",
          detail: "ResLab returned success but reservation.cancelled is falsy",
        };
  }

  // Timeout / 5xx / 429 → genuinely ambiguous → HOLD.
  if (isAmbiguous(result.error)) {
    return { outcome: "hold", detail: describe(result.error) };
  }

  // Definitive failure (4xx, or an unexpected error): don't trust it — read the
  // reservation's ACTUAL state to decide.
  try {
    const res = await reslab.getReservation(reservationNumber);
    return res.cancelled
      ? { outcome: "proceed" } // it IS cancelled (idempotent success) → refund
      : {
          outcome: "refuse",
          detail: `cancel rejected (${describe(result.error)}) and reservation is still active`,
        };
  } catch (probeErr) {
    // Couldn't confirm state → never refund a possibly-live reservation.
    return {
      outcome: "hold",
      detail: `cancel failed (${describe(result.error)}) and state probe failed (${describe(probeErr)})`,
    };
  }
}
