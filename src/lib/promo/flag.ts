/**
 * PROMO_FIXED_ENABLED — the kill switch for FIXED-amount promo codes ("$5 off",
 * promo plan notes/2026-11-06-promo-fixed-amount-plan.md, Part 2). Anything
 * but "true" makes /api/promo/validate and the checkout POST treat a fixed code
 * as not available; percent codes are never gated by it.
 *
 * Gates only NEW PaymentIntents: one already stamped with `discountCents` is
 * read the same way flag or no flag (the PR 1 readers never consult it), so
 * turning it off never strands a payment.
 * Rollback: switch the fixed codes off (`active = false`), then set this false
 * AND redeploy — env changes do not reach running deployments.
 * Server-side only (env is not in the browser bundle).
 */
export function isFixedPromoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PROMO_FIXED_ENABLED ?? "").trim().toLowerCase() === "true";
}
