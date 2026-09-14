-- Migration 022: Park Guard tier invariant — repair, then constrain
--
-- !! APPLY ONLY AFTER the plan-tier code (feat/pg-plan-tiers) is LIVE in prod !!
--
-- Until that deploy, the old code inserts bookings with protection_plan set and
-- neither protection_plan_code nor protection_plan_wholesale. After the deploy,
-- every opt-in write carries all three fields, so the only rows missing the tier
-- are the ones the old code wrote between applying 021 and the deploy — and they
-- can only be Plan A ($6.00 wholesale), the single tier that existed.
--
-- The REPAIR RUNS IN THE SAME TRANSACTION, BEFORE the constraint, on purpose.
-- Postgres `NOT VALID` skips the initial scan of existing rows but enforces the
-- CHECK on every INSERT and UPDATE from the moment it is added — evaluated
-- against the whole post-update row, whichever columns the UPDATE touched. With
-- an unrepaired deploy-window row still present, the next money write on it
-- (webhook `charge.refunded` setting status, the self-cancel terminal write, the
-- admin cancel clearing pg_identifier) would fail with 23514 AFTER the Stripe
-- refund had already been issued. Repairing first makes that impossible.
--
-- Re-run-safe: the UPDATE only touches rows still missing a tier; the ADD
-- CONSTRAINT is guarded.

BEGIN;

-- Fill only what is missing: a present tier code is kept, and the wholesale
-- follows the (possibly just-filled) code. In practice every such row is Plan A
-- — the app writes both columns in one insert — but the repair must not be able
-- to rewrite a tier.
UPDATE bookings
SET protection_plan_code = COALESCE(protection_plan_code, 'A'),
    protection_plan_wholesale = COALESCE(
      protection_plan_wholesale,
      CASE COALESCE(protection_plan_code, 'A')
        WHEN 'A' THEN 6.00
        WHEN 'B' THEN 4.00
        WHEN 'C' THEN 2.00
      END
    )
WHERE protection_plan IS NOT NULL
  AND (protection_plan_code IS NULL OR protection_plan_wholesale IS NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bookings_protection_plan_requires_tier'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_protection_plan_requires_tier
      CHECK (
        protection_plan IS NULL
        OR (protection_plan_code IS NOT NULL AND protection_plan_wholesale IS NOT NULL)
      )
      NOT VALID;
  END IF;
END $$;

COMMIT;

-- Validation (the full-table scan) can run any time afterwards, as its own
-- statement; nothing money-related depends on it:
--   ALTER TABLE bookings VALIDATE CONSTRAINT bookings_protection_plan_requires_tier;
