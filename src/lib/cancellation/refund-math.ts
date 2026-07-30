import { PROTECTION_PLAN } from "@/lib/parkguard/client";

/**
 * Self-service cancellation refund math — computed in integer CENTS.
 *
 * Locked policy: on a >24h self-cancel the customer is refunded EVERYTHING they
 * paid online (parking + tax + Triply service fee + Park Guard premium) MINUS
 * only the $6 Park Guard wholesale, which PG never returns to Triply. A booking
 * without Park Guard gets 100% back; the Triply service fee is NOT withheld.
 *
 * Mirrors the admin cancel route's proven wholesale formula
 * (`min(PROTECTION_PLAN.wholesalePrice, pgPremium)`) so the two cancel paths
 * withhold the identical amount, and sources the $6 from the shared
 * `PROTECTION_PLAN` constant — never a literal.
 *
 * ⚠️ CENTS in, CENTS out. Do NOT pass the result to the dollars-based
 * `createRefund` (it ×100s internally → a 100× over-refund). Use
 * `createRefundCents`.
 */

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
}

export interface RefundComputation {
  /** Amount to refund the customer, integer CENTS. Never negative. */
  refundCents: number;
  /** The unavoidable Park Guard wholesale withheld, integer CENTS. */
  pgWholesaleCents: number;
}

export function computeCancellationRefund(
  input: RefundComputationInput,
): RefundComputation {
  const { amountReceivedCents, protectionPlan, protectionPlanPriceDollars } =
    input;
  const priorRefundedCents = input.priorRefundedCents ?? 0;

  // `typeof NaN === "number"`, so a NaN number would bypass the `|| 0` guard and
  // poison the math — require the number branch to be FINITE, else coerce via
  // the string path (parseFloat("NaN") || 0 === 0).
  const pgPremium =
    typeof protectionPlanPriceDollars === "number" &&
    Number.isFinite(protectionPlanPriceDollars)
      ? protectionPlanPriceDollars
      : parseFloat(String(protectionPlanPriceDollars ?? "0")) || 0;

  // `min` guards against withholding more than the customer paid for PG (dirty
  // row / sub-$6 premium). A null/garbage price → 0 → withhold nothing (Triply
  // eats the wholesale rather than over-withhold on bad data) — identical to admin.
  const pgWholesaleCents = protectionPlan
    ? Math.round(Math.min(PROTECTION_PLAN.wholesalePrice, pgPremium) * 100)
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
