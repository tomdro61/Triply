/**
 * Cleanup tool: PATCH a Park Guard record so its `protection_plan`
 * field reads the tier code ("Plan A") instead of the display name.
 * Used to retroactively fix records captured before the May 11 2026
 * pgPlanCode change. Only the PG record changes — no DB writes.
 *
 * Run from triply/ root:
 *   npx tsx --env-file=.env.local scripts/fix-pg-plan-name.ts <booking_uuid>
 */

import { parkGuard, PROTECTION_PLAN } from "../src/lib/parkguard/client";

const BOOKING_ID = process.argv[2];
if (!BOOKING_ID) {
  console.error(
    "Usage: npx tsx --env-file=.env.local scripts/fix-pg-plan-name.ts <booking_uuid>"
  );
  process.exit(1);
}

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
