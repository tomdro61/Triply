/**
 * Once-per-customer promo redemptions (migration 033).
 *
 * `promo_redemptions` is the AUTHORITATIVE record. The booking engine claims a
 * row BEFORE the ResLab reservation and BEFORE capture (create-booking.ts step
 * 8.5), so a refusal only ever cancels an authorization — no money has moved.
 * The partial unique index (promo_code_id, email_lower, livemode) WHERE
 * released_at IS NULL is what makes two concurrent checkouts race-safe: both
 * INSERT, exactly one wins.
 *
 * /api/promo/validate and /api/checkout/lot POST use `hasRedeemed` as an EARLY,
 * advisory check so the customer sees the message before they ever enter a
 * card. They are not the guarantee.
 *
 * Every helper THROWS PromoRedemptionError on a database fault rather than
 * returning a verdict: "no row" and "query failed" look identical in
 * Supabase's return shape, and reading a fault as "not redeemed" or "taken"
 * would be a silent decision on a money path.
 */
import type { createAdminClient } from "@/lib/supabase/server";

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>;

/** Mirrors promo_codes_source_check in migration 033. */
export const PROMO_SOURCES = [
  "blog",
  "lot_staff",
  "referral",
  "corporate",
  "email",
  "paid",
  "other",
] as const;
export type PromoSource = (typeof PROMO_SOURCES)[number];

export const ALREADY_USED_MESSAGE = "This code has already been used with this email";

export class PromoRedemptionError extends Error {
  constructor(operation: string, cause: string) {
    super(`promo_redemptions ${operation} failed: ${cause}`);
    this.name = "PromoRedemptionError";
  }
}

/** The one normalisation used for every comparison. Matches the CHECK on
 *  promo_redemptions.email_lower (lower(btrim(x))). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Whether this deployment's Stripe key is LIVE. Used only by the advisory
 * checks, which have no PaymentIntent to read `livemode` from. The booking
 * engine always uses `pi.livemode`.
 */
export function isLiveStripeKey(key: string | undefined = process.env.STRIPE_SECRET_KEY): boolean {
  return !!key && (key.startsWith("sk_live_") || key.startsWith("rk_live_"));
}

/**
 * pending_bookings statuses under which the claim's owner may still redeem
 * (or already has). Anything else — a released/refunded/expired/duplicate row,
 * or no row at all — means that PaymentIntent will never use the code, so its
 * claim is dead and may be released. A status added later falls on the
 * "dead" side, which frees the code rather than blocking a customer.
 */
const OWNER_HOLDS = new Set([
  "pending",
  "processing",
  "completed",
  "needs_reconciliation",
  "capture_ambiguous",
]);

interface ClaimKey {
  promoCodeId: string;
  email: string;
  livemode: boolean;
}

interface LiveClaim {
  id: string;
  stripe_payment_intent_id: string;
}

async function liveClaim(supabase: AdminClient, key: ClaimKey): Promise<LiveClaim | null> {
  const { data, error } = await supabase
    .from("promo_redemptions")
    .select("id, stripe_payment_intent_id")
    .eq("promo_code_id", key.promoCodeId)
    .eq("email_lower", normalizeEmail(key.email))
    .eq("livemode", key.livemode)
    .is("released_at", null)
    .maybeSingle();
  if (error) throw new PromoRedemptionError("live-claim read", error.message);
  return (data as LiveClaim | null) ?? null;
}

async function ownerHolds(supabase: AdminClient, pi: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("pending_bookings")
    .select("status")
    .eq("stripe_payment_intent_id", pi)
    .maybeSingle();
  if (error) throw new PromoRedemptionError("owner lookup", error.message);
  const status = (data as { status?: string } | null)?.status;
  return !!status && OWNER_HOLDS.has(status);
}

async function releaseClaimById(supabase: AdminClient, id: string): Promise<void> {
  const { error } = await supabase
    .from("promo_redemptions")
    .update({ released_at: new Date().toISOString() })
    .eq("id", id)
    .is("released_at", null);
  if (error) throw new PromoRedemptionError("dead-claim release", error.message);
}

/**
 * Advisory: has this email already used this code? A claim whose owner will
 * never redeem does not count (it is released lazily by the next real claim).
 */
export async function hasRedeemed(supabase: AdminClient, key: ClaimKey): Promise<boolean> {
  const claim = await liveClaim(supabase, key);
  if (!claim) return false;
  return ownerHolds(supabase, claim.stripe_payment_intent_id);
}

export type ClaimResult =
  /** This PaymentIntent now holds (or already held) the redemption. */
  | { kind: "claimed" }
  /** Another PaymentIntent that still holds it used this code with this email. */
  | { kind: "taken"; ownerPaymentIntentId: string };

/**
 * AUTHORITATIVE claim. Idempotent for the same PaymentIntent (a re-drive finds
 * its own claim). Race-safe via the partial unique index: of two concurrent
 * claims for the same code + email, the database lets exactly one INSERT land.
 */
export async function claimRedemption(
  supabase: AdminClient,
  key: ClaimKey & { code: string; paymentIntentId: string }
): Promise<ClaimResult> {
  const row = {
    promo_code_id: key.promoCodeId,
    code: key.code,
    email_lower: normalizeEmail(key.email),
    stripe_payment_intent_id: key.paymentIntentId,
    livemode: key.livemode,
  };

  // Two attempts: the second runs only after a DEAD claim (owner will never
  // redeem) was released out of the way.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await supabase.from("promo_redemptions").insert(row);
    if (!error) return { kind: "claimed" };

    if ((error as { code?: string }).code !== "23505") {
      throw new PromoRedemptionError("claim insert", error.message);
    }

    const existing = await liveClaim(supabase, key);
    if (!existing) {
      // The conflict was not on (code, email): this PI already holds a live
      // claim under another key, or the winning claim was released between our
      // INSERT and this read. Either way we cannot decide — retry the booking.
      if (attempt === 0) continue;
      throw new PromoRedemptionError(
        "claim",
        `unique violation for ${key.paymentIntentId} with no live claim on this code + email`
      );
    }
    if (existing.stripe_payment_intent_id === key.paymentIntentId) {
      return { kind: "claimed" };
    }
    if (await ownerHolds(supabase, existing.stripe_payment_intent_id)) {
      return { kind: "taken", ownerPaymentIntentId: existing.stripe_payment_intent_id };
    }
    await releaseClaimById(supabase, existing.id);
  }
  throw new PromoRedemptionError("claim", `could not claim for ${key.paymentIntentId} after releasing a dead claim`);
}

/**
 * Hand a claim back because its booking failed BEFORE the money moved, so the
 * customer can use the code on their next attempt. Throws on a DB fault; the
 * caller decides whether that is fatal (it never is on a failure path — a
 * stuck claim is also cleared lazily, because its owner row is terminal).
 */
export async function releaseRedemption(supabase: AdminClient, paymentIntentId: string): Promise<void> {
  const { error } = await supabase
    .from("promo_redemptions")
    .update({ released_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", paymentIntentId)
    .is("released_at", null);
  if (error) throw new PromoRedemptionError("release", error.message);
}
