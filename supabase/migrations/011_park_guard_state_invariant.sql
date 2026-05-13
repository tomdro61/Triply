-- Migration 011: Park Guard state invariant CHECK constraints
--
-- Until now the bookings table allowed all 16 combinations of the 4 PG
-- columns (protection_plan, protection_plan_price, pg_identifier,
-- pg_sync_status). That admits malformed states that produced a real
-- customer-visible bug: a row with protection_plan set but
-- protection_plan_price NULL/0 rendered "Parking Protection Active … $0.00"
-- on the confirmation page. The API serializer at /api/reservations/[id]
-- now defensively suppresses the protection block in that case, but the
-- DB should reject the bad state at insert time so it never reaches the
-- API layer.
--
-- The two invariants:
--   1. If protection_plan is set, protection_plan_price MUST be > 0.
--      The customer paid for it; the price must reflect that.
--   2. If pg_identifier is set, protection_plan MUST also be set.
--      An identifier without a plan is an orphan that has no meaning.
--
-- Deliberately permissive on pg_sync_status and the partial-refund state
-- (pg_identifier=NULL with pg_sync_status='synced' is valid after a webhook
-- partial-refund cancel — see webhooks/stripe/route.ts charge.refunded).
--
-- NOT VALID is used so the migration applies without scanning existing
-- rows. Production has no PG-opted bookings yet (feature not launched),
-- so the constraint will succeed on validation. Staging may have rows
-- created during testing that violate the price constraint — those should
-- be cleaned up by ops before VALIDATE CONSTRAINT is run.

ALTER TABLE bookings
  ADD CONSTRAINT bookings_protection_plan_requires_price
  CHECK (protection_plan IS NULL OR (protection_plan_price IS NOT NULL AND protection_plan_price > 0))
  NOT VALID;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_pg_identifier_requires_plan
  CHECK (pg_identifier IS NULL OR protection_plan IS NOT NULL)
  NOT VALID;

-- Once staging data is clean, run manually:
--   ALTER TABLE bookings VALIDATE CONSTRAINT bookings_protection_plan_requires_price;
--   ALTER TABLE bookings VALIDATE CONSTRAINT bookings_pg_identifier_requires_plan;
