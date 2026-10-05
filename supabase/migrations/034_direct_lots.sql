-- Migration 034: direct (non-ResLab) lots — booking + staging columns.
-- Plan: notes/2026-10-02-direct-lots-plan-v1.md §9.5; SQL per the review synthesis
-- (notes/2026-10-02-direct-lots-plan-review.md §3 "Corrected migration 034").
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod (shared by staging + prod)
-- as ONE transaction, at a quiet hour, BEFORE any code that writes a direct row.
-- Strictly additive. Every existing row satisfies every CHECK, so they are added
-- VALID. Re-run-safe (per-table guards). Numbering: 031 = PR #44, 033 = PR #48.
--
-- Column semantics for inventory_source = 'direct':
--   reslab_reservation_number  holds the Triply-issued TRP-XXXXXXXX number (D3) —
--                              the column name is a misnomer for direct rows; a
--                              rename is a separate mechanical PR after go-live.
--   reslab_location_id         NULL;  direct_lot_id = payload.lots.id as text.
--   grand_total                parking subtotal + tax (excludes service fee / PG),
--                              same meaning every existing reader assumes.
--   due_at_location            0 (paid in full online).
--   livemode                   Stripe mode of the PaymentIntent — NOT NULL for
--                              direct rows; it is the ONLY staging/prod marker
--                              on this shared table (test exclusion = livemode=false).
SET lock_timeout = '3s';

-- bookings ------------------------------------------------------------------
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS inventory_source TEXT NOT NULL DEFAULT 'reslab',
  ADD COLUMN IF NOT EXISTS direct_lot_id TEXT,
  ADD COLUMN IF NOT EXISTS livemode BOOLEAN,
  ADD COLUMN IF NOT EXISTS lot_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS direct_partner_share_percent NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS direct_tax_rate_percent NUMERIC(6,3),
  ADD COLUMN IF NOT EXISTS direct_tax_collected_by TEXT,
  ADD COLUMN IF NOT EXISTS lot_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lot_cancel_notified_at TIMESTAMPTZ,
  ALTER COLUMN reslab_location_id DROP NOT NULL;

-- Backfill livemode for every post-015 row from its staged payment; pre-015
-- rows stay NULL, which every reader treats as live (they are all ResLab rows,
-- still filtered by isAtTestLot).
UPDATE bookings b SET livemode = p.livemode
  FROM pending_bookings p
 WHERE p.stripe_payment_intent_id = b.stripe_payment_intent_id
   AND b.livemode IS NULL
   AND p.livemode IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.bookings'::regclass AND conname = 'bookings_inventory_source_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_inventory_source_check
      CHECK (inventory_source IN ('reslab', 'direct'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.bookings'::regclass AND conname = 'bookings_inventory_source_ids_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_inventory_source_ids_check
      CHECK ((inventory_source = 'reslab' AND reslab_location_id IS NOT NULL AND direct_lot_id IS NULL)
          OR (inventory_source = 'direct' AND direct_lot_id IS NOT NULL AND reslab_location_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.bookings'::regclass AND conname = 'bookings_direct_fields_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_direct_fields_check
      CHECK (inventory_source <> 'direct' OR (
        livemode IS NOT NULL
        AND lot_snapshot IS NOT NULL
        AND direct_partner_share_percent BETWEEN 0 AND 100
        AND direct_tax_rate_percent >= 0
        AND direct_tax_collected_by IN ('triply', 'lot')));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bookings_direct_lot_live
  ON bookings (direct_lot_id, check_in) WHERE inventory_source = 'direct';
CREATE INDEX IF NOT EXISTS idx_bookings_direct_unnotified
  ON bookings (check_in) WHERE inventory_source = 'direct' AND lot_notified_at IS NULL;

-- pending_bookings ------------------------------------------------------------
ALTER TABLE pending_bookings
  ADD COLUMN IF NOT EXISTS inventory_source TEXT NOT NULL DEFAULT 'reslab',
  ADD COLUMN IF NOT EXISTS direct_lot_id TEXT,
  ADD COLUMN IF NOT EXISTS lot_snapshot JSONB,
  ALTER COLUMN location_id DROP NOT NULL,
  ALTER COLUMN parking_type_id DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pending_bookings'::regclass AND conname = 'pending_bookings_inventory_source_check') THEN
    ALTER TABLE pending_bookings ADD CONSTRAINT pending_bookings_inventory_source_check
      CHECK (inventory_source IN ('reslab', 'direct'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pending_bookings'::regclass AND conname = 'pending_bookings_inventory_source_ids_check') THEN
    ALTER TABLE pending_bookings ADD CONSTRAINT pending_bookings_inventory_source_ids_check
      CHECK ((inventory_source = 'reslab' AND location_id IS NOT NULL AND parking_type_id IS NOT NULL AND direct_lot_id IS NULL)
          OR (inventory_source = 'direct' AND direct_lot_id IS NOT NULL AND lot_snapshot IS NOT NULL
              AND location_id IS NULL AND parking_type_id IS NULL));
  END IF;
END $$;

-- Confirmation-number uniqueness BEFORE capture (plan failure mode 5, as actually
-- implementable: without this a collision only surfaced on the bookings INSERT,
-- after the card was captured, and fulfill.ts treats any 23505 as a duplicate).
-- Pre-check (must return 0 rows, else the whole transaction fails):
--   SELECT reslab_reservation_number, count(*) FROM pending_bookings
--    WHERE reslab_reservation_number IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS pending_bookings_reservation_number_uq
  ON pending_bookings (reslab_reservation_number) WHERE reslab_reservation_number IS NOT NULL;

-- Search telemetry for the direct branch (NULL = flag off / pre-migration).
ALTER TABLE search_events
  ADD COLUMN IF NOT EXISTS direct_results_count INT,
  ADD COLUMN IF NOT EXISTS direct_skipped BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN bookings.reslab_reservation_number IS
  'ResLab RTL… number for inventory_source=reslab; Triply-issued TRP-XXXXXXXX for inventory_source=direct (migration 034, plan D3).';
COMMENT ON COLUMN bookings.livemode IS
  'Stripe livemode of the PaymentIntent. NOT NULL for direct rows; NULL on pre-015 ResLab rows (= live).';

NOTIFY pgrst, 'reload schema';

-- Verify:
--   SELECT conrelid::regclass, conname, convalidated FROM pg_constraint
--    WHERE conname LIKE '%inventory_source%' OR conname = 'bookings_direct_fields_check';  -- 5 rows, all true
--   SELECT count(*) FILTER (WHERE livemode IS NULL) AS legacy_null, count(*) FROM bookings;  -- NULLs = pre-015 only
--   SELECT indexname FROM pg_indexes WHERE indexname = 'pending_bookings_reservation_number_uq';
--
-- Rollback: code = ENABLE_DIRECT_LOTS=false + redeploy. The schema is additive and
-- STAYS once Phase 3/4 code writes inventory_source. `reslab_location_id SET NOT NULL`
-- is restorable only while no direct row exists on either table.
