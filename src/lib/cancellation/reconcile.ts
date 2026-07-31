import { createAdminClient } from "@/lib/supabase/server";
import { reslab } from "@/lib/reslab/client";
import { stripe } from "@/lib/stripe/client";
import { captureAPIError } from "@/lib/sentry";
import { releaseClaim, type HoldState } from "./claim";
import { classifyCancelOutcome } from "./reslab-cancel";
import {
  planTeardown,
  finalizeCancelledReservation,
  type CancelBookingRow,
} from "./finalize";

/**
 * The reconciliation-cron recovery for cancellations that got interrupted between
 * ResLab, Stripe, and our DB (the multi-system saga has no cross-service
 * transaction). It finishes the small number of half-done cancels the customer
 * request couldn't complete — issuing the stuck refund, re-verifying an ambiguous
 * ResLab cancel, and writing the terminal status.
 *
 * Money-safety comes from reusing the SAME shared core as the customer path
 * (`planTeardown` + `finalizeCancelledReservation`, incl. the `selfcancel:<pi>`
 * idempotency key), plus an atomic per-row re-claim so overlapping cron runs
 * can't both process a row. It gates STRICTLY on the customer-set HOLD states —
 * never the bare claim predicate — and the scan excludes `admin_claimed`
 * (reserved in migration 017).
 *
 * ⚠️ PHASE-5 PREREQUISITE, NOT YET TRUE: the admin cancel route does NOT yet
 * write `admin_claimed` or join the claim, so today it can still cancel a booking
 * that is mid self-cancel using its OWN refund policy + no idempotency key. That
 * is only safe because ENABLE_SELF_SERVE_CANCEL is OFF (no customer cancels → no
 * race). Before the flag is flipped, the admin route MUST participate in the
 * claim (or route through this shared core), or a concurrent admin+customer cancel
 * of the same booking can double-refund. See the launch gate in the plan §9.A.
 */

const CRON_ENDPOINT = "/api/cron/reconcile-cancellations";

/**
 * A row is safe to recover only after it has sat this long — comfortably beyond
 * the route maxDuration (60s), so no in-flight customer request is still writing
 * when the cron takes over. HOLD states are never touched by a customer
 * stale-steal (that only re-drives 'claimed'), so the cron is their only finisher.
 */
export const CRON_CANCEL_GRACE_MS = 3 * 60_000;
/** Cap per run so a backlog can't blow the 60s budget; surfaced via `capped`. */
export const MAX_RECOVER_PER_RUN = 20;

const HOLD_STATES: HoldState[] = [
  "held_reslab_ambiguous",
  "reslab_cancelled_refund_pending",
];

const SCAN_COLUMNS =
  "id, reslab_reservation_number, status, customer_id, location_name, location_address, check_in, check_out, location_timezone, protection_plan, protection_plan_price, pg_identifier, stripe_payment_intent_id, cancel_state, cancel_claimed_at";

interface ScanBookingRow {
  id: string;
  reslab_reservation_number: string;
  status: string;
  customer_id: string;
  location_name: string | null;
  location_address: string | null;
  check_in: string;
  check_out: string;
  location_timezone: string | null;
  protection_plan: string | null;
  protection_plan_price: string | number | null;
  pg_identifier: string | null;
  stripe_payment_intent_id: string | null;
  cancel_state: string;
  cancel_claimed_at: string;
}

export interface StalledCancel {
  reservationNumber: string;
  cancelState: string;
  reason: string;
}

export interface CancelReconcileReport {
  scanned: number;
  recovered: number;
  stalled: StalledCancel[];
  /** Stale bare 'claimed' rows — NOT auto-recovered (the cron gates on HOLD
   *  states only); surfaced for human review. */
  leakedClaims: number;
  /** True if the scan hit the per-run cap — more rows await the next run. */
  capped: boolean;
}

export async function reconcileStuckCancellations(
  now: number = Date.now(),
  /** Absolute epoch-ms wall-clock deadline. The row loop bails out before this so
   *  a backlog can't run the function past its maxDuration and get killed
   *  mid-recovery; the unprocessed rows are reported via `capped`. Omitted in
   *  tests (no deadline). */
  deadlineMs?: number,
): Promise<CancelReconcileReport> {
  const admin = await createAdminClient();
  const graceBefore = new Date(now - CRON_CANCEL_GRACE_MS).toISOString();

  // Recovery scan — customer HOLD states only, past the grace window. Explicit
  // IN excludes 'admin_claimed', bare 'claimed', and NULL (no three-valued-logic
  // surprise).
  const { data, error } = await admin
    .from("bookings")
    .select(SCAN_COLUMNS)
    .eq("status", "confirmed")
    .in("cancel_state", HOLD_STATES)
    .lt("cancel_claimed_at", graceBefore)
    .limit(MAX_RECOVER_PER_RUN);
  if (error) {
    throw new Error(`cancel reconcile scan failed: ${error.message}`);
  }
  const rows: ScanBookingRow[] = data ?? [];

  // Leaked/stuck-claim scan — a stale bare 'claimed' (a customer request that died
  // before reaching a HOLD, or a terminal-write-failed row) OR a stale
  // 'admin_claimed' (an admin cancel whose terminal write failed — status stuck
  // 'confirmed' with money possibly already moved). Alert ONLY; the cron never
  // auto-refunds these (a customer 'claimed' self-heals via stale-steal or a
  // human; an admin row must use the admin's own refund policy). A scan error must
  // NOT masquerade as "0 leaked" — throw so the cron alerts.
  const { data: leaked, error: leakedErr } = await admin
    .from("bookings")
    .select("id")
    .eq("status", "confirmed")
    .in("cancel_state", ["claimed", "admin_claimed"])
    .lt("cancel_claimed_at", graceBefore)
    .limit(MAX_RECOVER_PER_RUN);
  if (leakedErr) {
    throw new Error(`cancel reconcile leaked-claim scan failed: ${leakedErr.message}`);
  }
  const leakedClaims: number = (leaked ?? []).length;

  const stalled: StalledCancel[] = [];
  let recovered = 0;
  let deadlineHit = false;
  for (const row of rows) {
    // Bail before the wall-clock deadline so the function isn't killed mid-row;
    // the rest is reported via `capped` and picked up next run.
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      deadlineHit = true;
      break;
    }
    const outcome = await recoverOne(admin, row, now);
    if (outcome === "recovered") {
      recovered++;
    } else if (outcome !== "skipped") {
      stalled.push({
        reservationNumber: row.reslab_reservation_number,
        cancelState: row.cancel_state,
        reason: outcome,
      });
    }
  }

  return {
    scanned: rows.length,
    recovered,
    stalled,
    leakedClaims,
    // Either the scan filled to the cap, or we stopped early on the deadline —
    // both mean more stuck rows remain for the next run.
    capped: deadlineHit || rows.length >= MAX_RECOVER_PER_RUN,
  };
}

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>;

/**
 * Recover a single stuck row. Returns "recovered", "skipped" (another run took
 * it), or a stall reason. Re-claims atomically first so only one runner ever
 * finalizes a given row.
 */
// Exported for direct testing of the atomic re-claim skip (there's no seam to
// mutate cancel_claimed_at between the scan and the re-claim through the top-level
// function).
export async function recoverOne(
  admin: AdminClient,
  row: ScanBookingRow,
  now: number,
): Promise<"recovered" | "skipped" | string> {
  const reservationNumber = row.reslab_reservation_number;
  const holdState = row.cancel_state as HoldState;
  const oldClaimedAt = row.cancel_claimed_at;
  const ownedAt = new Date(now).toISOString();

  // Atomic re-claim: advance cancel_claimed_at to now, PINNED to the old value +
  // the hold state, so a concurrent cron run matches nothing and skips.
  const { data: reclaimed, error: reclaimErr } = await admin
    .from("bookings")
    .update({ cancel_claimed_at: ownedAt })
    .eq("reslab_reservation_number", reservationNumber)
    .eq("status", "confirmed")
    .eq("cancel_state", holdState)
    .eq("cancel_claimed_at", oldClaimedAt)
    .select("id")
    .maybeSingle();
  if (reclaimErr) {
    captureAPIError(
      new Error(`cancel reconcile: reclaim failed for ${reservationNumber}: ${reclaimErr.message}`),
      { endpoint: CRON_ENDPOINT, method: "POST", statusCode: 500 },
    );
    return "reclaim_failed";
  }
  if (!reclaimed) return "skipped";

  const booking = await toCancelBookingRow(admin, row);

  // For an ambiguous HOLD, re-establish the ResLab state (the original cancel
  // call timed out / 5xx'd — did it apply?). classifyCancelOutcome probes on a
  // 4xx, so 'proceed' means genuinely cancelled.
  if (holdState === "held_reslab_ambiguous") {
    let cancelResult:
      | { ok: true; reservation: Awaited<ReturnType<typeof reslab.cancelReservation>> }
      | { ok: false; error: unknown };
    try {
      const reservation = await reslab.cancelReservation(reservationNumber);
      cancelResult = { ok: true, reservation };
    } catch (error) {
      cancelResult = { ok: false, error };
    }
    const outcome = await classifyCancelOutcome(reservationNumber, cancelResult);
    if (outcome.outcome === "refuse") {
      // Can't cancel (started/checked-in) — no money moved. Revert to a clean
      // confirmed booking and alert; this cancel can't complete online.
      await releaseClaim(reservationNumber, ownedAt).catch(() => {});
      return "reslab_refused";
    }
    if (outcome.outcome === "hold") {
      // Still ambiguous — leave HELD (claim kept, timestamp advanced) for a later
      // run; alert so a persistent ResLab problem is visible.
      return "still_ambiguous";
    }
    // proceed → ResLab confirmed cancelled → finalize below.
  }
  // reslab_cancelled_refund_pending → ResLab already cancelled → finalize below.

  const piId = booking.stripe_payment_intent_id;
  if (!piId) return "no_pi";
  let pi;
  try {
    pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
  } catch {
    return "pi_lookup_failed";
  }
  const plan = planTeardown(pi, booking);
  if (!plan.ok) return plan.reason;

  const result = await finalizeCancelledReservation({
    booking,
    piId,
    teardown: plan.teardown,
    priorRefundedCents: plan.priorRefundedCents,
    pgWholesaleCents: plan.pgWholesaleCents,
    ownedAt,
    endpoint: CRON_ENDPOINT,
  });
  return result.kind === "refund_pending" ? "refund_failed" : "recovered";
}

async function toCancelBookingRow(
  admin: AdminClient,
  row: ScanBookingRow,
): Promise<CancelBookingRow> {
  const { data: cust, error: custErr } = await admin
    .from("customers")
    .select("email, first_name, last_name")
    .eq("id", row.customer_id)
    .maybeSingle();
  if (custErr) {
    // Don't fail the money recovery over a customer lookup — but surface that the
    // confirmation email will be skipped, so it isn't a silent gap. (The refund +
    // terminal write still happen; the customer just isn't emailed this run.)
    captureAPIError(
      new Error(
        `cancel reconcile: customer lookup failed for ${row.reslab_reservation_number} (customer ${row.customer_id}): ${custErr.message}`,
      ),
      { endpoint: CRON_ENDPOINT, method: "POST", statusCode: 200 },
    );
  }
  const c = cust as
    | { email: string | null; first_name: string | null; last_name: string | null }
    | null;
  return {
    id: row.id,
    status: row.status,
    reslab_reservation_number: row.reslab_reservation_number,
    location_name: row.location_name,
    location_address: row.location_address,
    check_in: row.check_in,
    check_out: row.check_out,
    location_timezone: row.location_timezone,
    protection_plan: row.protection_plan,
    protection_plan_price: row.protection_plan_price,
    pg_identifier: row.pg_identifier,
    stripe_payment_intent_id: row.stripe_payment_intent_id,
    customers: c
      ? { email: c.email, first_name: c.first_name, last_name: c.last_name }
      : null,
  };
}
