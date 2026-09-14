-- Migration 021: Park Guard plan tiers (Plan A / B / C)
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod BEFORE deploying the code
-- that writes these columns. Triply-prod is SHARED by staging + prod, so this
-- affects both at once. Strictly additive (nullable columns + a backfill) —
-- existing code never references them, so applying ahead of the code is safe.
-- Re-run-safe (IF NOT EXISTS; the backfills only touch NULLs).
--
-- WHY: until now Triply sold a single Park Guard tier (Plan A, $1,000). The
-- checkout now offers Plan A / Plan B ($500) / Plan C ($250), each with its own
-- retail price AND its own wholesale (what PG bills Triply: $6 / $4 / $2).
--
--   protection_plan_code       which tier — 'A' | 'B' | 'C'. `protection_plan`
--                              keeps holding the customer-facing display name
--                              ("$500 Protection") that emails and pages render.
--   protection_plan_wholesale  the PG wholesale that applied to THIS booking,
--                              snapshotted at fulfilment. The standard admin
--                              cancel and the self-service cancel withhold
--                              exactly this amount, and accounting sums it —
--                              all read the ROW, never a live constant. Mirrors
--                              the existing per-row protection_plan_price
--                              pattern, so a future contract change never
--                              rewrites history.
--
-- Backfill: every opt-in before this migration was Plan A at a $6.00 wholesale
-- (the only tier that existed), so both columns are filled for existing rows.
-- That is a data fact about the past, not a default for new writes — the
-- fulfilment code always writes both explicitly.
--
-- NO CHECK constraint tying protection_plan <-> protection_plan_code here, on
-- purpose: between applying this migration and the deploy, the OLD code still
-- inserts bookings with protection_plan set and no code. A constraint would
-- make those inserts FAIL for a customer who has already been charged. The
-- invariant lives in migration 022, which must be applied only AFTER the deploy.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS protection_plan_code TEXT
    CHECK (protection_plan_code IS NULL OR protection_plan_code IN ('A', 'B', 'C')),
  ADD COLUMN IF NOT EXISTS protection_plan_wholesale DECIMAL(10, 2)
    CHECK (protection_plan_wholesale IS NULL OR protection_plan_wholesale >= 0);

UPDATE bookings
SET protection_plan_code = 'A',
    protection_plan_wholesale = 6.00
WHERE protection_plan IS NOT NULL
  AND protection_plan_code IS NULL;

-- Same tier marker on the staged payload, so the dead-browser fulfilment paths
-- (Stripe webhook / sweep cron / /checkout/complete) know WHICH tier to charge,
-- name, and enrol. `has_protection_plan` stays for the rows staged before the
-- tier deploy; the new writers set both (code IS NOT NULL <=> true). No
-- constraint enforces that mirror, and it does not hold for rows the old code
-- keeps staging between this migration and the deploy — the booking engine
-- treats "true with no code" as Plan A (the only tier that existed).
ALTER TABLE pending_bookings
  ADD COLUMN IF NOT EXISTS protection_plan_code TEXT
    CHECK (protection_plan_code IS NULL OR protection_plan_code IN ('A', 'B', 'C'));

UPDATE pending_bookings
SET protection_plan_code = 'A'
WHERE has_protection_plan = true
  AND protection_plan_code IS NULL;

COMMENT ON COLUMN bookings.protection_plan_code IS
  'Park Guard tier: A ($1,000) | B ($500) | C ($250). protection_plan holds the customer-facing display name.';
COMMENT ON COLUMN bookings.protection_plan_wholesale IS
  'PG wholesale (dollars) that applied to this booking at fulfilment. Cancel withholding and accounting read this, never a constant.';
COMMENT ON COLUMN pending_bookings.protection_plan_code IS
  'Park Guard tier the customer picked (A | B | C); NULL = declined. New writers keep has_protection_plan = (code IS NOT NULL); rows staged before the tier deploy have has_protection_plan = true and NULL code (= Plan A). Advisory: fulfilment books the tier on the PaymentIntent metadata.';
