-- Migration 032: record WHY a booking was cancelled, and WHO cancelled it.
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod BEFORE deploying the code
-- that writes these columns (Triply-prod is shared by staging + prod). Strictly
-- additive: two nullable columns + CHECKs on bookings, and one new table for the
-- admin's free-text note. Existing code never references any of it, so applying
-- ahead of the code is safe. Re-run-safe.
--
-- If the code ships first anyway: every reason/note write is a separate
-- best-effort statement (src/lib/cancellation/reason.ts), so cancels and refunds
-- still work — the reason is just lost and Sentry logs "cancellation reason not
-- recorded" (and the admin bookings list logs one "notes fetch failed" event per
-- load until the table exists — noisy, not harmful).
--
-- Existing cancelled/refunded rows stay NULL, which the admin report reads as
-- "unknown". No backfill: there is no record of why they were cancelled.
--
-- Locking: ADD COLUMN / ADD CONSTRAINT take an ACCESS EXCLUSIVE lock on bookings
-- for the length of this transaction. There is no table rewrite (nullable, no
-- default) and the CHECK scans are microseconds at this table size, so the lock
-- itself is brief. The real risk is QUEUEING: with no lock_timeout the ALTER
-- would wait behind any open transaction on bookings, and every live checkout
-- INSERT / cancel UPDATE would queue behind the ALTER. So: fail fast instead,
-- and simply re-run (the whole file is one transaction, so a failure leaves
-- nothing half-applied). Apply at a quiet hour.
SET lock_timeout = '3s';

ALTER TABLE bookings
  -- The constrained reason. NULL = unknown (all pre-032 rows, and a customer who
  -- skipped the optional dropdown).
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  -- customer = self-cancel (incl. the reconcile-cancellations cron finishing
  -- one), admin = /api/admin/bookings/cancel, system = an automated path (a full
  -- refund seen only via the Stripe charge.refunded webhook, e.g. issued from
  -- the Stripe dashboard).
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT;

-- Plain ADD CONSTRAINT: the columns are brand new and all-NULL, so the
-- validation scan cannot fail, and a NOT VALID + VALIDATE split inside the same
-- transaction would hold exactly the same lock for exactly as long.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_cancellation_reason_check'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_cancellation_reason_check
      CHECK (cancellation_reason IS NULL OR cancellation_reason IN (
        'plans_changed',
        'found_cheaper',
        'lot_turned_away',
        'lot_sold_out',
        'duplicate_booking',
        'payment_issue',
        'other',
        'unknown'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_cancelled_by_check'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_cancelled_by_check
      CHECK (cancelled_by IS NULL OR cancelled_by IN ('customer', 'admin', 'system'));
  END IF;
END $$;

-- The admin's free-text note lives in its OWN table, never on bookings.
-- bookings has a row-level SELECT policy for customers ("Users can view own
-- bookings", 001) with no column restriction, so anything added to bookings is
-- readable by a signed-in customer through PostgREST with the public anon key.
-- A staff note ("suspected chargeback abuse") must not be. This table has RLS on
-- and no grant to anon/authenticated at all (same pattern as 028/029): only the
-- server's service-role client can read or write it.
CREATE TABLE IF NOT EXISTS booking_cancellation_notes (
  booking_id  UUID PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  note        TEXT NOT NULL CHECK (char_length(note) BETWEEN 1 AND 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE booking_cancellation_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE booking_cancellation_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE booking_cancellation_notes TO service_role;

-- An earlier draft of this migration put the note ON bookings
-- (`cancellation_note`). It was never applied to Triply-prod (verified
-- 2026-09-29: no such column), so this block is a no-op there — but if it ever
-- had been, move any notes into the private table and drop the exposed column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'cancellation_note'
  ) THEN
    INSERT INTO booking_cancellation_notes (booking_id, note)
      SELECT id, cancellation_note FROM bookings
       WHERE cancellation_note IS NOT NULL AND char_length(cancellation_note) BETWEEN 1 AND 500
      ON CONFLICT (booking_id) DO NOTHING;
    ALTER TABLE bookings
      DROP CONSTRAINT IF EXISTS bookings_cancellation_note_length_check,
      DROP COLUMN IF EXISTS cancellation_note;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- Verify after applying — three queries:
--   1. exactly TWO constraints (reason + cancelled_by), both convalidated = true:
--   SELECT conname, convalidated, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'bookings'::regclass AND conname LIKE 'bookings_cancel%'
--      AND conname <> 'bookings_cancel_state_check';
--   2. both columns present, text, nullable — and NO cancellation_note column:
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'bookings'
--      AND column_name IN ('cancellation_reason', 'cancelled_by', 'cancellation_note');
--   3. the notes table is service_role-only:
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name = 'booking_cancellation_notes';
--
-- Rollback (reporting data only; no code path depends on these for money).
-- NOTE: dropping the columns/table permanently discards every recorded reason
-- and note.
--   DROP TABLE IF EXISTS booking_cancellation_notes;
--   ALTER TABLE bookings
--     DROP CONSTRAINT IF EXISTS bookings_cancellation_reason_check,
--     DROP CONSTRAINT IF EXISTS bookings_cancelled_by_check,
--     DROP COLUMN IF EXISTS cancellation_reason,
--     DROP COLUMN IF EXISTS cancelled_by;
--   NOTIFY pgrst, 'reload schema';
