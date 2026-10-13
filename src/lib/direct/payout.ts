import { checkInInstantMs } from "@/lib/cancellation/eligibility";
import { toCents, type MoneyInput } from "@/lib/booking/cost-breakdown";

/**
 * What Triply owes a direct lot for ONE booking (direct lots Phase 6a — plan
 * notes/2026-10-12-direct-lots-phase6-plan.md §3). Pure: no I/O, integer cents.
 *
 * Rules (Tom, binding): the lot is paid its share (80 %) of the LIST-PRICE
 * parking subtotal — Triply absorbs promo discounts; when the lot collects the
 * tax (`tax_collected_by = "lot"`) the tax Triply charged is passed through; the
 * oversized-vehicle surcharge is paid at the lot and is never in this figure.
 *
 * Classes:
 *   payable  confirmed, no cancellation, Stripe read and shows the charge
 *            succeeded with nothing refunded, the terms snapshot matches the
 *            booking → share × subtotal (+ tax when the lot collects it).
 *   zero     cancelled before check-in by one of the two real cancel paths
 *            (status cancelled/refunded AND cancel_state refund_issued or
 *            admin_claimed), and Stripe shows the parking + tax portion fully
 *            refunded → $0.
 *   manual   anything else — a partial refund on a stay, a dispute (our row
 *            OR Stripe's own flag), a cancel after check-in, a refund made
 *            outside the cancel paths, an unreadable figure. Never paid
 *            automatically; unknown is never $0.
 */

export interface PayoutTerms {
  directLotId: string;
  livemode: boolean;
  /** NUMERIC(5,2) as stored, e.g. "80.00". */
  sharePercent: MoneyInput;
  /** 'triply' | 'lot' by the 038 CHECK; anything else is routed to a person. */
  taxCollectedBy: string;
}

export interface PayoutStripe {
  /** Non-null when the read failed. */
  error: string | null;
  /** null = unknown (never read, or no charge). */
  amountReceivedCents: number | null;
  amountRefundedCents: number | null;
  piStatus: string | null;
  /** Stripe's own dispute flag on the charge; null = unknown. */
  disputed: boolean | null;
  /**
   * The charge's disputes as "id:status:amount", sorted and comma-joined; "" =
   * none; null = unknown. The flag above stays true after a dispute is WON, so a
   * decision bound to the flag alone would never be raised again.
   */
  disputes: string | null;
}

export interface PayoutBookingInput {
  stripePaymentIntentId: string;
  reservationNumber: string;
  directLotId: string;
  livemode: boolean;
  status: string;
  cancelState: string | null;
  /** When the cancellation was claimed (ISO instant), if any. */
  cancelClaimedAt: string | null;
  /** Literal airport-local wall clock, "YYYY-MM-DD HH:MM:SS" (or with a "T"). */
  checkIn: string;
  checkOut: string;
  /** IANA zone of the lot (bookings.location_timezone / the snapshot). */
  timezone: string | null;
  /** Dollars as stored (NUMERIC strings or numbers). */
  subtotal: MoneyInput;
  taxTotal: MoneyInput;
  serviceFee: MoneyInput;
  /** Park Guard wholesale Triply keeps on a cancel (0 / null = none). */
  pgWholesale: MoneyInput;
  terms: PayoutTerms | null;
  stripe: PayoutStripe | null;
}

/**
 * Everything the class and amount were worked out from. Stored on the ledger
 * line (camelCase keys); a booking a PERSON decided is not raised again while
 * its current basis equals the stored one (`adjustmentCandidate`).
 */
export interface PayoutBasis {
  subtotalCents: number | null;
  taxCents: number | null;
  shareBp: number | null;
  taxCollectedBy: string | null;
  amountReceivedCents: number | null;
  amountRefundedCents: number | null;
  piStatus: string | null;
  stripeDisputed: boolean | null;
  stripeDisputes: string | null;
  serviceFeeCents: number | null;
  pgWholesaleCents: number | null;
  status: string;
  cancelState: string | null;
  cancelClaimedAt: string | null;
  checkIn: string;
  checkOut: string;
  /** The zone "before check-in" was judged in (location_timezone, else the lot snapshot's). */
  timezone: string | null;
}

export const PAYOUT_BASIS_KEYS = [
  "subtotalCents", "taxCents", "shareBp", "taxCollectedBy", "amountReceivedCents", "amountRefundedCents",
  "piStatus", "stripeDisputed", "stripeDisputes", "serviceFeeCents", "pgWholesaleCents", "status", "cancelState", "cancelClaimedAt",
  "checkIn", "checkOut", "timezone",
] as const satisfies ReadonlyArray<keyof PayoutBasis>;

export type PayoutClass =
  | { kind: "payable"; amountCents: number; basis: PayoutBasis }
  | { kind: "zero"; amountCents: 0; basis: PayoutBasis }
  | { kind: "manual"; reason: string; basis: PayoutBasis };

/**
 * A cancellation is finished when the row's STATUS says so — that is the last
 * write of both cancel paths. `cancel_state` is only a hint (migration 017): the
 * self-cancel ends at "refund_issued", but an admin cancel leaves
 * "admin_claimed" on a finished row. Mid-flight states keep status "confirmed".
 */
const FINISHED_CANCEL_STATUSES = new Set(["cancelled", "refunded"]);
/**
 * The end states of the two cancel paths. A refund made any other way (the
 * Stripe dashboard, the charge.refunded webhook) on a row with a leaked
 * self-cancel claim keeps "claimed" — its claim time says nothing about whether
 * the customer parked, so it goes to a person.
 */
const CANCEL_PATH_END_STATES = new Set(["refund_issued", "admin_claimed"]);

export function classifyPayout(b: PayoutBookingInput): PayoutClass {
  const subtotalCents = toCents(b.subtotal);
  const taxCents = toCents(b.taxTotal);
  // A percent stored with two decimals reads as basis points through the same
  // decimal parser ("80.00" → 8000) — no float maths anywhere.
  const shareBp = b.terms ? toCents(b.terms.sharePercent) : null;
  const basis: PayoutBasis = {
    subtotalCents,
    taxCents,
    shareBp,
    taxCollectedBy: b.terms?.taxCollectedBy ?? null,
    amountReceivedCents: b.stripe?.amountReceivedCents ?? null,
    amountRefundedCents: b.stripe?.amountRefundedCents ?? null,
    piStatus: b.stripe?.piStatus ?? null,
    stripeDisputed: b.stripe?.disputed ?? null,
    stripeDisputes: b.stripe?.disputes ?? null,
    serviceFeeCents: toCents(b.serviceFee ?? 0),
    pgWholesaleCents: toCents(b.pgWholesale ?? 0),
    status: b.status,
    cancelState: b.cancelState,
    cancelClaimedAt: b.cancelClaimedAt,
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    timezone: b.timezone,
  };
  const manual = (reason: string): PayoutClass => ({ kind: "manual", reason, basis });

  if (!b.terms) return manual("no terms snapshot for this booking");
  if (b.terms.directLotId !== b.directLotId) return manual("terms belong to another lot");
  if (b.terms.livemode !== b.livemode) return manual("terms are from the other Stripe mode");
  if (shareBp === null || shareBp > 10_000) return manual("share unreadable");
  if (b.terms.taxCollectedBy !== "lot" && b.terms.taxCollectedBy !== "triply") return manual("tax collector unreadable");
  if (subtotalCents === null) return manual("subtotal unreadable");
  if (taxCents === null) return manual("tax unreadable");

  const s = b.stripe;
  if (!s || s.error !== null) return manual(`Stripe could not be read${s?.error ? ` (${s.error})` : ""}`);
  if (s.amountReceivedCents === null || s.amountRefundedCents === null || s.piStatus === null) {
    return manual("Stripe figures unknown");
  }
  // Our row stays "disputed" after a win; Stripe's dispute status is what tells the admin what changed.
  if (b.status === "disputed") return manual(`disputed${disputeStatuses(s.disputes)}`);
  // The webhook that marks a row disputed is best-effort; Stripe's flag is not.
  if (s.disputed !== false) return manual(s.disputed === true ? `disputed (Stripe${disputeStatuses(s.disputes)})` : "dispute state unknown");

  const lotShare = Math.round((subtotalCents * shareBp) / 10_000);
  const taxPassThrough = b.terms.taxCollectedBy === "lot" ? taxCents : 0;

  // A confirmed row with any cancel_state is mid-cancellation (or a held
  // claim) — decided by hand, never paid automatically.
  if (b.status === "confirmed" && b.cancelState === null) {
    if (s.piStatus !== "succeeded") return manual(`payment not settled (${s.piStatus})`);
    if (s.amountReceivedCents <= 0) return manual("nothing received");
    if (s.amountRefundedCents > 0) return manual("partially refunded while still confirmed");
    return { kind: "payable", amountCents: lotShare + taxPassThrough, basis };
  }

  if (FINISHED_CANCEL_STATUSES.has(b.status)) {
    if (b.cancelState === null || !CANCEL_PATH_END_STATES.has(b.cancelState)) {
      return manual(`${b.status} outside the cancel flow (${b.cancelState ?? "no cancel state"})`);
    }
    const before = cancelledBeforeCheckIn(b);
    if (before === null) return manual("cancellation time unknown");
    if (!before) return manual("cancelled after check-in");
    const serviceFeeCents = basis.serviceFeeCents;
    const pgCents = basis.pgWholesaleCents;
    if (serviceFeeCents === null || pgCents === null) return manual("kept fees unreadable");
    // The parking + tax portion is fully refunded when everything except what
    // Triply may keep (service fee, Park Guard wholesale) went back.
    const parkingAndTaxRefunded = s.amountRefundedCents >= s.amountReceivedCents - serviceFeeCents - pgCents;
    if (!parkingAndTaxRefunded) return manual("cancelled but the parking was not fully refunded");
    return { kind: "zero", amountCents: 0, basis };
  }

  return manual(`status ${b.status}${b.cancelState ? ` / ${b.cancelState}` : ""}`);
}

/** ": won, needs_response" from "id:status:amount,…" — for the admin's reason text. */
function disputeStatuses(disputes: string | null): string {
  if (!disputes) return "";
  return `: ${disputes.split(",").map((d) => d.split(":")[1] ?? "?").join(", ")}`;
}

/** null = cannot tell (missing timestamp, bad zone or wall clock). */
function cancelledBeforeCheckIn(b: PayoutBookingInput): boolean | null {
  if (!b.cancelClaimedAt || !b.timezone) return null;
  const cancelledAt = Date.parse(b.cancelClaimedAt);
  const checkInMs = checkInInstantMs(b.checkIn.replace("T", " ").slice(0, 19), b.timezone);
  if (!Number.isFinite(cancelledAt) || checkInMs === null) return null;
  return cancelledAt < checkInMs;
}

/** Current basis equals a stored one (stored = a ledger line's `basis` JSON; extra keys ignored). */
export function sameBasis(current: PayoutBasis, stored: Record<string, unknown>): boolean {
  return PAYOUT_BASIS_KEYS.every((k) => stored[k] === current[k]);
}

/**
 * A booking that already has ledger lines: what is due NOW vs what was paid.
 * Nothing is raised while the booking's latest line was a PERSON's decision
 * and the basis has not changed since (the decision is bound to its basis).
 * Otherwise any difference — or a current state only a person can decide — is
 * an adjustment candidate, always a manual decision (never netted automatically).
 */
export function adjustmentCandidate(
  current: PayoutClass,
  paidSoFarCents: number,
  lastPersonBasis: Record<string, unknown> | null
): { deltaCents: number | null; reason: string } | null {
  if (lastPersonBasis && sameBasis(current.basis, lastPersonBasis)) return null;
  if (current.kind === "manual") return { deltaCents: null, reason: `needs review since payment: ${current.reason}` };
  const delta = current.amountCents - paidSoFarCents;
  if (delta === 0) return null;
  return { deltaCents: delta, reason: delta < 0 ? "refunded or cancelled after payment" : "now owes more than was paid" };
}
