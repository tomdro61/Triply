-- Migration 032: record WHY a booking was cancelled, and WHO cancelled it.
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod BEFORE deploying the code
-- that writes these columns (Triply-prod is shared by staging + prod). Strictly
-- additive: three nullable columns + guarded CHECKs. Existing code never
-- references them, so applying ahead of the code is safe. Re-run-safe.
--
-- If the code ships first anyway: every reason write is a separate best-effort
-- UPDATE (src/lib/cancellation/reason.ts), so cancels and refunds still work —
-- the reason is just lost and Sentry logs "cancellation reason not recorded".
--
-- Existing cancelled/refunded rows stay NULL, which the admin report reads as
-- "unknown". No backfill: there is no record of why they were cancelled.

ALTER TABLE bookings
  -- The constrained reason. NULL = unknown (all pre-032 rows, and a customer who
  -- skipped the optional dropdown).
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  -- Free text, written ONLY by the admin cancel route. Customers never get a
  -- free-text box (nothing customer-typed is stored here).
  ADD COLUMN IF NOT EXISTS cancellation_note TEXT,
  -- customer = self-cancel (incl. the reconcile-cancellations cron finishing
  -- one), admin = /api/admin/bookings/cancel, system = an automated path (a full
  -- refund seen only via the Stripe charge.refunded webhook, e.g. issued from
  -- the Stripe dashboard).
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT;

-- NOT VALID then VALIDATE (same pattern as 017): no ACCESS EXCLUSIVE full-table
-- scan-lock on the live bookings table. The columns are new and all-NULL, so
-- VALIDATE cannot fail.
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
      )) NOT VALID;
    ALTER TABLE bookings VALIDATE CONSTRAINT bookings_cancellation_reason_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_cancelled_by_check'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_cancelled_by_check
      CHECK (cancelled_by IS NULL OR cancelled_by IN ('customer', 'admin', 'system')) NOT VALID;
    ALTER TABLE bookings VALIDATE CONSTRAINT bookings_cancelled_by_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_cancellation_note_length_check'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_cancellation_note_length_check
      CHECK (cancellation_note IS NULL OR char_length(cancellation_note) <= 500) NOT VALID;
    ALTER TABLE bookings VALIDATE CONSTRAINT bookings_cancellation_note_length_check;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- Rollback (reporting data only; no code path depends on these for money):
--   ALTER TABLE bookings
--     DROP CONSTRAINT IF EXISTS bookings_cancellation_reason_check,
--     DROP CONSTRAINT IF EXISTS bookings_cancelled_by_check,
--     DROP CONSTRAINT IF EXISTS bookings_cancellation_note_length_check,
--     DROP COLUMN IF EXISTS cancellation_reason,
--     DROP COLUMN IF EXISTS cancellation_note,
--     DROP COLUMN IF EXISTS cancelled_by;
--   NOTIFY pgrst, 'reload schema';
