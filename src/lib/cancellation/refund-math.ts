/**
 * Self-service cancellation refund math — computed in integer CENTS.
 *
 * Locked policy: on a >24h self-cancel the customer is refunded EVERYTHING they
 * paid online (parking + tax + Triply service fee + Park Guard premium) MINUS
 * only the Park Guard wholesale, which PG never returns to Triply. A booking
 * without Park Guard gets 100% back; the Triply service fee is NOT withheld.
 *
 * The wholesale is PER ROW (`bookings.protection_plan_wholesale`, migration
 * 021): $6 / $4 / $2 for Plan A / B / C, snapshotted at fulfilment. Mirrors the
 * admin cancel route's formula (`min(rowWholesale, pgPremium)`) so the two
 * cancel paths withhold the identical amount — and never a literal or the live
 * `PROTECTION_PLANS` constant, which would misprice a booking sold under an
 * earlier contract.
 *
 * ⚠️ CENTS in, CENTS out. Do NOT pass the result to the dollars-based
 * `createRefund` (it ×100s internally → a 100× over-refund). Use
 * `createRefundCents`.
 */

import { parseMoneyColumn, pgWholesaleWithheld } from "@/lib/utils/money";

export interface RefundComputationInput {
  /** Stripe PaymentIntent `amount_received`, integer CENTS. */
  amountReceivedCents: number;
  /** `latest_charge.amount_refunded` (integer CENTS); 0 if none. */
  priorRefundedCents?: number;
  /** `bookings.protection_plan` — truthy when Park Guard was purchased. */
  protectionPlan: string | null | undefined;
  /**
   * `bookings.protection_plan_price` — the PG premium actually charged, in
   * DOLLARS. Typed loosely on purpose: PostgREST returns Postgres `numeric`
   * columns as strings, `float8`/`int` as numbers, and null for a no-PG booking.
   */
  protectionPlanPriceDollars: string | number | null | undefined;
  /**
   * `bookings.protection_plan_wholesale` — the PG wholesale that applied to
   * THIS booking, in DOLLARS (same loose typing). null/garbage on a PG row →
   * withhold NOTHING: Triply eats the wholesale rather than over-withhold on
   * bad data. Callers Sentry-flag that case (see planTeardown / admin cancel).
   */
  protectionPlanWholesaleDollars: string | number | null | undefined;
}

export interface RefundComputation {
  /** Amount to refund the customer, integer CENTS. Never negative. */
  refundCents: number;
  /** The unavoidable Park Guard wholesale withheld, integer CENTS. */
  pgWholesaleCents: number;
}

/**
 * The Park Guard wholesale a booking row carries, and whether it is MISSING on
 * a row that has a plan (a deploy-window row written before migration 022's
 * repair). Callers on money paths Sentry-flag `missing` with the booking id;
 * read-only callers (the cancel preview) do not.
 */
export function pgWholesaleForRow(row: {
  protection_plan: string | null | undefined;
  protection_plan_wholesale: string | number | null | undefined;
}): { wholesaleDollars: number; missing: boolean } {
  const wholesaleDollars = parseMoneyColumn(row.protection_plan_wholesale);
  return {
    wholesaleDollars,
    missing: !!row.protection_plan && !(wholesaleDollars > 0),
  };
}

export function computeCancellationRefund(
  input: RefundComputationInput,
): RefundComputation {
  const { amountReceivedCents, protectionPlan } = input;
  const priorRefundedCents = input.priorRefundedCents ?? 0;

  const pgPremium = parseMoneyColumn(input.protectionPlanPriceDollars);
  const pgWholesale = parseMoneyColumn(input.protectionPlanWholesaleDollars);

  // Never more than the customer paid for PG (dirty row / sub-wholesale
  // premium), never negative. A null/garbage price OR wholesale → 0 →
  // withhold nothing (Triply eats the wholesale rather than over-withhold on
  // bad data) — the same helper the admin cancel uses.
  const pgWholesaleCents = protectionPlan
    ? Math.round(pgWholesaleWithheld(pgPremium, pgWholesale) * 100)
    : 0;

  const refundCents = Math.max(
    0,
    amountReceivedCents - pgWholesaleCents - priorRefundedCents,
  );

  // Math.max(0, NaN) === NaN — the clamp does NOT defend against NaN. A
  // non-finite refund must NEVER reach Stripe (amount: NaN); surface loudly.
  if (!Number.isFinite(refundCents)) {
    throw new Error(
      `computeCancellationRefund produced a non-finite refund ` +
        `(amountReceivedCents=${amountReceivedCents}, pgWholesaleCents=${pgWholesaleCents}, priorRefundedCents=${priorRefundedCents})`,
    );
  }

  return { refundCents, pgWholesaleCents };
}
