import { toCents, type CostBreakdownResult, type FallbackDue } from "@/lib/booking/cost-breakdown";

export type { FallbackDue };

/**
 * What the booking emails state when the cost breakdown was attempted and did
 * NOT add up but the card charge is known (cost-breakdown plan §2, review
 * rounds 1–3): the charge itself — never a total re-added from the parts the
 * breakdown just rejected — and only what else can be stated. Whether a due
 * amount can be stated is decided by the core `fallbackDue` (bounds + refusal
 * class), never here.
 */
export interface AnchoredFallback {
  /** What Stripe charged (`pi.amount`), in cents. */
  chargedCents: number;
  /** ResLab: due at the location. Direct: the at-lot surcharge estimate. */
  due: FallbackDue;
  /** "Plan A" … and the premium charged, in cents. */
  protection: { label: string; premiumCents: number } | null;
  /** Why the breakdown was withheld (admin email only). */
  reason: string;
}

/**
 * The anchored fallback for an `ok: false` breakdown with a known charge;
 * undefined otherwise (an ok breakdown renders itself; an unknown charge keeps
 * the legacy layout — scripts/resend-confirmation.ts and the dev path).
 */
export function anchoredFallback(
  breakdown: CostBreakdownResult,
  chargedCents: number | null,
  due: (refusal: string) => FallbackDue,
  protection: { code: string; premium: number } | null
): AnchoredFallback | undefined {
  if (breakdown.ok || chargedCents === null || !Number.isSafeInteger(chargedCents)) return undefined;
  const premiumCents = protection ? toCents(protection.premium) : null;
  return {
    chargedCents,
    due: due(breakdown.reason),
    protection: protection && premiumCents !== null && premiumCents > 0 ? { label: `Plan ${protection.code}`, premiumCents } : null,
    reason: breakdown.reason,
  };
}
