/**
 * One-off: PATCH the existing Park Guard record for booking
 * 1fd4cb08-3915-4cfd-8af6-56e47022a892 (synced 2026-05-09 via the
 * reconciliation script with the wrong `protection_plan` value).
 *
 * Park Guard rejected "$1,000 Protection" as the protection_plan value
 * and asked for the code "Plan A" instead (2026-05-11). This script
 * sends `PATCH /api/update-reservation-data/<reservation_id>` with the
 * correct code.
 *
 * Run from triply/ root:
 *   npx tsx --env-file=.env.local scripts/fix-pg-plan-name.ts
 *
 * No DB writes — only the PG record changes.
 */

import { parkGuard, PROTECTION_PLAN } from "../src/lib/parkguard/client";

const BOOKING_ID = "1fd4cb08-3915-4cfd-8af6-56e47022a892";

async function main() {
  console.log(
    `Patching Park Guard record for reservation_id=${BOOKING_ID} ` +
      `→ protection_plan=${PROTECTION_PLAN.pgPlanCode}`
  );
  const res = await parkGuard.updateReservation(BOOKING_ID, {
    protection_plan: PROTECTION_PLAN.pgPlanCode,
  });
  console.log("Park Guard response:", res);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
