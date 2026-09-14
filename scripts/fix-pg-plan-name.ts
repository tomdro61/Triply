/**
 * Cleanup tool: PATCH a Park Guard record so its `protection_plan`
 * field reads the tier code ("Plan A" / "Plan B" / "Plan C") instead of a
 * display name. Used to retroactively fix records captured before the
 * May 11 2026 pgPlanCode change, or to correct a mis-tiered capture.
 * Only the PG record changes — no DB writes.
 *
 * Run from triply/ root:
 *   npx tsx --env-file=.env.local scripts/fix-pg-plan-name.ts <booking_uuid> <A|B|C>
 *
 * The tier is REQUIRED — read it from bookings.protection_plan_code first.
 * There is deliberately no default: the pre-tier era was all Plan A, but a
 * wrong PATCH here changes what Park Guard will pay out on a claim.
 */

import {
  parkGuard,
  PROTECTION_PLANS,
  isProtectionPlanCode,
} from "../src/lib/parkguard/client";

const BOOKING_ID = process.argv[2];
const TIER = process.argv[3];
if (!BOOKING_ID || !isProtectionPlanCode(TIER)) {
  console.error(
    "Usage: npx tsx --env-file=.env.local scripts/fix-pg-plan-name.ts <booking_uuid> <A|B|C>\n" +
      "  (tier = bookings.protection_plan_code for that booking)"
  );
  process.exit(1);
}
const plan = PROTECTION_PLANS[TIER];

async function main() {
  console.log(
    `Patching Park Guard record for reservation_id=${BOOKING_ID} ` +
      `→ protection_plan=${plan.pgPlanCode}`
  );
  const res = await parkGuard.updateReservation(BOOKING_ID, {
    protection_plan: plan.pgPlanCode,
  });
  console.log("Park Guard response:", res);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
