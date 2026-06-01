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
