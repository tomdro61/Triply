-- Triply: Park Guard sync state column
-- Migration 010

-- Phase J's "missing required address fields" branch in /api/reservations
-- captures a Sentry alert with statusCode -3 (MISSING_DATA) and skips the
-- POST. But the booking row still has protection_plan set + pg_identifier
-- null, which is identical to a transient outage — meaning a future
-- reconciliation job would retry these forever. Add a persistent state
-- column so reconciliation queries can filter MISSING_DATA out, and admin
-- UI can render distinct copy for each state.
--
-- States:
--   NULL / "pending"      → in-flight or transient failure, reconciler should retry
--   "synced"              → pg_identifier set, no work needed (also implied by pg_identifier IS NOT NULL)
--   "skipped_missing_data" → permanent skip; ops fixes the lot record manually

ALTER TABLE bookings
  ADD COLUMN pg_sync_status TEXT
    CHECK (pg_sync_status IS NULL OR pg_sync_status IN ('pending', 'synced', 'skipped_missing_data'));

-- Replace the reconciliation index with one that excludes the permanent-skip rows.
DROP INDEX IF EXISTS idx_bookings_pg_pending;

CREATE INDEX idx_bookings_pg_pending
  ON bookings(created_at)
  WHERE protection_plan IS NOT NULL
    AND pg_identifier IS NULL
    AND (pg_sync_status IS NULL OR pg_sync_status = 'pending');
