-- Migration 012: Scope the bookings UPDATE policy to service_role only
--
-- Migration 009 added:
--   CREATE POLICY "Service role can update bookings"
--     ON bookings FOR UPDATE
--     USING (true)
--     WITH CHECK (true);
--
-- The policy NAME implied it was scoped to service_role but the body has no
-- `TO service_role` clause. In Postgres/Supabase RLS, omitting `TO <role>`
-- applies the policy to ALL roles — including `authenticated` and `anon`.
-- Combined with `USING (true) WITH CHECK (true)`, any authenticated user
-- could UPDATE any booking row (pg_identifier, pg_sync_status,
-- protection_plan_price, status) via PostgREST.
--
-- Service role bypasses RLS entirely, so all current server-side writes
-- (using createAdminClient with the service-role key) are unaffected by
-- this change. The fix prevents any future user-client UPDATE access.

DROP POLICY IF EXISTS "Service role can update bookings" ON bookings;

CREATE POLICY "Service role can update bookings"
  ON bookings FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);
