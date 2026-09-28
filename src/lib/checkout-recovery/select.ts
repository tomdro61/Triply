import type Stripe from "stripe";
import { z } from "zod";
import { format } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { airports } from "@/config/airports";
import { convertTo24Hour } from "@/lib/utils/time";

/**
 * Picks the abandoned checkouts the recovery cron may email — PURE (no I/O),
 * so every rule here is unit-testable without Stripe or Supabase.
 *
 * "Abandoned" = a PaymentIntent created by POST /api/checkout/lot that is still
 * in `requires_payment_method`: the customer reached the payment step and never
 * got a card through. The PaymentIntent is the ONLY durable record of that
 * moment — pending_bookings is staged only when Pay Now is clicked (see
 * /api/reservations/pending), so a customer who never clicked it has no row.
 */

/** Old enough that the customer has plainly stopped (not mid-typing a card). */
export const RECOVERY_MIN_AGE_MS = 45 * 60_000;
/** Past a day the trip may already be booked elsewhere; one email, early. */
export const RECOVERY_MAX_AGE_MS = 24 * 60 * 60_000;
/** Never email about a check-in that starts within this long. */
export const RECOVERY_MIN_LEAD_MS = 60 * 60_000;

/** A PaymentIntent in any of these has money behind it (authorized, captured
 *  or settling) — i.e. the customer DID pay. Manual capture puts cards in
 *  `requires_capture`, so `succeeded` alone would miss most bookings. */
export const PAID_STATUSES: ReadonlySet<Stripe.PaymentIntent.Status> = new Set([
  "succeeded",
  "requires_capture",
  "processing",
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}\s[AP]M$/;

/** What /api/checkout/lot stamps on every PaymentIntent. Validated, never
 *  defaulted: a PaymentIntent missing any of these is skipped, not guessed. */
export const recoveryMetadataSchema = z.object({
  customerEmail: z.string().trim().toLowerCase().pipe(z.string().email()),
  lotId: z.string().min(1),
  locationId: z.string().regex(/^\d+$/).transform(Number),
  checkin: z.string().regex(DATE_RE),
  checkout: z.string().regex(DATE_RE),
  checkinTime: z.string().regex(TIME_RE),
  checkoutTime: z.string().regex(TIME_RE),
});

export type PaymentIntentLike = Pick<
  Stripe.PaymentIntent,
  "id" | "status" | "created" | "amount" | "livemode" | "metadata"
>;

export interface RecoveryCandidate {
  paymentIntentId: string;
  /** Lowercased + trimmed. */
  email: string;
  createdMs: number;
  amountCents: number;
  livemode: boolean;
  lotId: string;
  locationId: number;
  /** Literal airport-local strings exactly as the customer picked them. */
  checkin: string;
  checkout: string;
  checkinTime: string;
  checkoutTime: string;
}

export interface SelectionResult {
  candidates: RecoveryCandidate[];
  skipped: {
    tooYoung: number;
    tooOld: number;
    invalidMetadata: number;
    checkinPassed: number;
    paidSince: number;
    duplicateEmail: number;
  };
}

/**
 * The latest airport-local wall clock across every timezone we serve, as
 * "YYYY-MM-DD HH:mm". The lot's own airport is not known until a ResLab
 * lookup, so the check-in gate uses the timezone where it is LATEST — for a
 * west-coast lot that errs toward not emailing a few hours early, never toward
 * emailing after check-in. Only "now" is projected into a timezone; the
 * booking's check-in string is compared as the literal it is.
 */
export function latestLocalWallClock(nowMs: number): string {
  const zones = new Set(airports.map((a) => a.timezone).filter(Boolean));
  let latest = "";
  for (const tz of zones) {
    const local = format(new TZDate(nowMs, tz), "yyyy-MM-dd HH:mm");
    if (local > latest) latest = local;
  }
  return latest;
}

export function selectRecoveryCandidates(
  paymentIntents: readonly PaymentIntentLike[],
  nowMs: number
): SelectionResult {
  const skipped: SelectionResult["skipped"] = {
    tooYoung: 0,
    tooOld: 0,
    invalidMetadata: 0,
    checkinPassed: 0,
    paidSince: 0,
    duplicateEmail: 0,
  };

  // Latest creation time of a PAID PaymentIntent per (lowercased) email.
  const paidAt = new Map<string, number>();
  for (const pi of paymentIntents) {
    if (!PAID_STATUSES.has(pi.status)) continue;
    const raw = pi.metadata?.customerEmail;
    if (!raw) continue;
    const email = raw.trim().toLowerCase();
    const createdMs = pi.created * 1000;
    if ((paidAt.get(email) ?? 0) < createdMs) paidAt.set(email, createdMs);
  }

  const cutoffWallClock = latestLocalWallClock(nowMs + RECOVERY_MIN_LEAD_MS);
  const byEmail = new Map<string, RecoveryCandidate>();

  for (const pi of paymentIntents) {
    if (pi.status !== "requires_payment_method") continue;
    const createdMs = pi.created * 1000;
    const age = nowMs - createdMs;
    if (age < RECOVERY_MIN_AGE_MS) {
      skipped.tooYoung++;
      continue;
    }
    if (age > RECOVERY_MAX_AGE_MS) {
      skipped.tooOld++;
      continue;
    }

    const parsed = recoveryMetadataSchema.safeParse(pi.metadata ?? {});
    if (!parsed.success) {
      skipped.invalidMetadata++;
      continue;
    }
    const m = parsed.data;

    // String comparison of two "YYYY-MM-DD HH:mm" wall clocks — no Date math
    // on the booking time.
    const checkinWallClock = `${m.checkin} ${convertTo24Hour(m.checkinTime)}`;
    if (checkinWallClock <= cutoffWallClock) {
      skipped.checkinPassed++;
      continue;
    }

    // Paid on a PaymentIntent created at/after this one — the usual "declined,
    // tried again" or "came back and finished" shape. A paid PI created
    // BEFORE this one is a different, earlier trip and does not count; the
    // cron separately checks the bookings table for anything completed since.
    const paid = paidAt.get(m.customerEmail);
    if (paid !== undefined && paid >= createdMs) {
      skipped.paidSince++;
      continue;
    }

    const candidate: RecoveryCandidate = {
      paymentIntentId: pi.id,
      email: m.customerEmail,
      createdMs,
      amountCents: pi.amount,
      livemode: pi.livemode,
      lotId: m.lotId,
      locationId: m.locationId,
      checkin: m.checkin,
      checkout: m.checkout,
      checkinTime: m.checkinTime,
      checkoutTime: m.checkoutTime,
    };

    // One email per address per run: keep the most recent abandoned checkout.
    const existing = byEmail.get(m.customerEmail);
    if (existing) {
      skipped.duplicateEmail++;
      if (existing.createdMs >= createdMs) continue;
    }
    byEmail.set(m.customerEmail, candidate);
  }

  const candidates = [...byEmail.values()].sort((a, b) => a.createdMs - b.createdMs);
  return { candidates, skipped };
}
