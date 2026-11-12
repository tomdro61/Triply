/**
 * The welcome offer: what POST /api/newsletter mints for a new subscriber and
 * what both signup boxes (<Newsletter />, <ArticleEmailCapture />) promise.
 * One place, so the box and the code can't drift apart.
 *
 * Since Nov 11, 2026 it is $5 off the parking with a $25 parking minimum, the
 * same rule as the `<IATA>5` airport codes (src/lib/promo/discount.ts:
 * below the minimum → refused; less than $5 paid online, i.e. pay-at-the-lot
 * → refused). Before that it was 10% off; codes minted then stay 10%, and the
 * welcome email words every code from its own row, never from this file.
 *
 * Browser-safe and import-free on purpose: the homepage box reads it, and
 * pulling in discount.ts would add zod to the homepage bundle.
 */
export const WELCOME_OFFER = {
  /** promo_codes.discount_amount, in dollars. */
  amountDollars: 5,
  /** promo_codes.min_subtotal: the least parking (dollars) the code needs. */
  minParkingDollars: 25,
  /** Days from mint until promo_codes.expires_at. */
  validDays: 30,
} as const;

/**
 * What a code is minted as while PROMO_FIXED_ENABLED is off (a rollback,
 * runbook § 41): checkout refuses fixed codes then, so the route mints the old
 * percent code instead of emailing a code that can't be used.
 */
export const WELCOME_FALLBACK_PERCENT = 10;

/** "$5" — the amount alone (buttons: "Get $5 Off"). */
export const WELCOME_OFFER_AMOUNT = `$${WELCOME_OFFER.amountDollars}`;

/** "$25" — the least parking the code needs. */
export const WELCOME_OFFER_MINIMUM = `$${WELCOME_OFFER.minParkingDollars}`;
