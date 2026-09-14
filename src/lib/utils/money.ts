/**
 * Money-column helpers shared by every path that reads a DECIMAL column off a
 * booking row and turns it into dollars.
 *
 * PostgREST returns Postgres `numeric` columns as strings, `float8`/`int` as
 * numbers, and null when absent — so the same column arrives typed three ways
 * across the codebase. Parse it in ONE place: the cancel refund math, the admin
 * cancel route and its confirm dialog, admin stats, and the accounting
 * reconciler all previously had their own `parseFloat(x ?? "") || 0` variant.
 *
 * NOT for `pending_bookings` reads in the booking engine — those must
 * distinguish "absent" (undefined) from "zero" and Sentry-flag garbage rather
 * than coerce to 0 (see `num()` in src/lib/booking/create-booking.ts).
 */

/**
 * Dollars from a loosely-typed numeric column. null / undefined / "" / garbage /
 * NaN → 0. `typeof NaN === "number"`, so the number branch requires FINITE and
 * otherwise falls through to the string path (`parseFloat("NaN") || 0 === 0`).
 */
export function parseMoneyColumn(v: string | number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v)
    ? v
    : parseFloat(String(v ?? "0")) || 0;
}

/**
 * Park Guard wholesale withheld from a STANDARD cancellation refund, in dollars:
 * the row's wholesale, never more than the premium the customer actually paid
 * for protection, never negative. Identical on the self-cancel and admin-cancel
 * paths by construction. A missing/garbage wholesale (0) withholds nothing —
 * Triply eats it rather than guess a tier from the price.
 */
export function pgWholesaleWithheld(
  premiumDollars: number,
  wholesaleDollars: number
): number {
  return Math.max(0, Math.min(wholesaleDollars, premiumDollars));
}
