import { z } from "zod";

/**
 * Cancellation reason codes (migration 032) — PURE, no server imports, so the
 * client cancel dialog and the admin pages can import it. The DB writes live in
 * ./reason.ts.
 */

/** The full set — mirrors migration 032's CHECK constraint. Keep in sync. */
export const CANCELLATION_REASONS = [
  "plans_changed",
  "found_cheaper",
  "lot_turned_away",
  "lot_sold_out",
  "duplicate_booking",
  "payment_issue",
  "other",
  "unknown",
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/** Mirrors migration 032's `cancelled_by` CHECK. */
export const CANCELLED_BY = ["customer", "admin", "system"] as const;
export type CancelledBy = (typeof CANCELLED_BY)[number];

/**
 * The only reasons a customer can pick. The lot-side reasons can't apply to a
 * self-cancel (it closes 24h before check-in), and `unknown` is what skipping
 * the dropdown means — so it isn't offered.
 */
export const CUSTOMER_CANCELLATION_REASONS = [
  "plans_changed",
  "found_cheaper",
  "duplicate_booking",
  "other",
] as const satisfies readonly CancellationReason[];
export type CustomerCancellationReason = (typeof CUSTOMER_CANCELLATION_REASONS)[number];

/** What an admin must choose from. `unknown` is not a choice — pick `other` + a note. */
export const ADMIN_CANCELLATION_REASONS = [
  "plans_changed",
  "found_cheaper",
  "lot_turned_away",
  "lot_sold_out",
  "duplicate_booking",
  "payment_issue",
  "other",
] as const satisfies readonly CancellationReason[];
export type AdminCancellationReason = (typeof ADMIN_CANCELLATION_REASONS)[number];

export const CANCELLATION_REASON_LABELS: Record<CancellationReason, string> = {
  plans_changed: "Plans changed",
  found_cheaper: "Found a cheaper option",
  lot_turned_away: "Lot turned customer away",
  lot_sold_out: "Lot sold out / overbooked",
  duplicate_booking: "Duplicate booking",
  payment_issue: "Payment issue",
  other: "Other",
  unknown: "Unknown / not given",
};

/** Customer-facing wording (the admin labels are written for staff). */
export const CUSTOMER_REASON_LABELS: Record<CustomerCancellationReason, string> = {
  plans_changed: "My plans changed",
  found_cheaper: "I found a cheaper option",
  duplicate_booking: "I booked twice by mistake",
  other: "Something else",
};

export const customerReasonSchema = z.enum(CUSTOMER_CANCELLATION_REASONS);
export const adminReasonSchema = z.enum(ADMIN_CANCELLATION_REASONS);
/** Admin-only free text. Trimmed; empty becomes null. */
export const cancellationNoteSchema = z
  .string()
  .trim()
  .max(500, "Note must be 500 characters or fewer")
  .transform((s) => (s.length > 0 ? s : null));

/** Self-cancel body. Anything that isn't a known reason collapses to null. */
const customerCancelBodySchema = z.object({
  reason: customerReasonSchema.nullish().catch(null).transform((r) => r ?? null),
});

/**
 * Parse the OPTIONAL customer reason from a self-cancel request body. Never
 * throws and never rejects: an absent, empty, malformed or unknown value is
 * simply "no reason given" (null) — the cancel must not depend on it.
 */
export function parseCustomerReason(body: unknown): CustomerCancellationReason | null {
  const parsed = customerCancelBodySchema.safeParse(body);
  return parsed.success ? parsed.data.reason : null;
}
