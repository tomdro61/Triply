// Admin allowlist for /admin pages and admin-only API routes. Membership here
// grants authentication access — NOT test-booking exclusion. Keep tight.
export const ADMIN_EMAILS = (
  process.env.ADMIN_EMAILS ||
  "vin@triplypro.com,john@triplypro.com,tom@triplypro.com,tomjdigregorio@gmail.com"
)
  .split(",")
  .map((e) => e.trim().toLowerCase());

// Test ResLab location IDs. Bookings against these lots are always test
// regardless of customer email. Kept in sync with the `isTest: true`
// entries in src/config/airports.ts.
export const TEST_RESLAB_LOCATION_IDS = new Set<number>([194, 195, 196, 197]);

export function isAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

/**
 * True iff the booking is against a TEST ResLab lot. Used to exclude test
 * traffic from revenue/accounting reports. Email is deliberately NOT
 * consulted — admin/staff bookings at REAL airport lots are real revenue,
 * not test data. (An earlier version conflated the two, hiding real
 * bookings from monthly reports. See pass-1 finding C2.)
 */
export function isAtTestLot(reslabLocationId: number | null | undefined): boolean {
  return reslabLocationId != null && TEST_RESLAB_LOCATION_IDS.has(reslabLocationId);
}

/**
 * True iff a bookings row is NOT real revenue: a booking at a test ResLab lot,
 * or one paid in Stripe TEST mode (`livemode === false` — staging shares this
 * database). `livemode` NULL means live: every pre-015 row is a real ResLab
 * booking. Email is never consulted (see isAtTestLot).
 */
export function isTestBooking(row: {
  // Exactly the column types, so a TYPED caller that drops a column fails to
  // compile. The Supabase clients are untyped, so a select string that omits
  // `livemode` still reads `undefined` here (treated as live) — every caller
  // must select both columns.
  reslab_location_id: number | null;
  livemode: boolean | null;
}): boolean {
  return isAtTestLot(row.reslab_location_id) || row.livemode === false;
}

/**
 * The same rule as a PostgREST filter, for queries that count or sum bookings:
 * (no lot id OR not a test lot) AND (livemode NULL OR true). Two `.or()` calls
 * on one query are ANDed by PostgREST (verified against Triply-prod 2026-10-10:
 * 414 rows either way). A plain `.not("reslab_location_id","in",…)` would drop
 * every direct row (NULL lot id); `.eq("livemode", true)` would drop the
 * pre-015 live rows (NULL).
 */
export function excludeTestBookings<T extends { or(filter: string): T }>(query: T): T {
  const ids = [...TEST_RESLAB_LOCATION_IDS];
  const lot = ids.length > 0
    ? query.or(`reslab_location_id.is.null,reslab_location_id.not.in.(${ids.join(",")})`)
    : query;
  return lot.or("livemode.is.null,livemode.eq.true");
}

