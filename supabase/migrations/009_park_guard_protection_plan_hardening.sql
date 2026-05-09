-- Triply: Park Guard hardening follow-up to migration 008
-- Migration 009

-- 1. Explicit UPDATE policy on bookings. Service-role already bypasses RLS, so
--    the pg_identifier write-back works today, but a future caller using the
--    anon/user client would fail SILENTLY (PostgREST returns count=0, not an
--    error). Make the intent explicit.
CREATE POLICY "Service role can update bookings"
  ON bookings FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- 2. Park Guard treats pg_identifier as unique on their side. Mirror that
--    invariant on ours so a duplicate write-back can't associate two Triply
--    bookings with the same Park Guard record. NULLs are not equal in
--    Postgres, so this is safe with a nullable column (most rows null).
ALTER TABLE bookings
  ADD CONSTRAINT bookings_pg_identifier_unique UNIQUE (pg_identifier);

-- 3. Reconciliation index: find bookings opted-in but not yet synced to
--    Park Guard. The migration-008 partial index serves the inverse query
--    ("look up by pg_identifier"); this one serves the operationally-
--    important "what needs reconciliation" query.
CREATE INDEX idx_bookings_pg_pending
  ON bookings(created_at)
  WHERE protection_plan IS NOT NULL AND pg_identifier IS NULL;
