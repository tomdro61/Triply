-- Migration 018: Re-enable RLS on partners + scope its write policies to service_role
--
-- Supabase Security Advisor flagged `partners` as `rls_disabled_in_public`
-- (CRITICAL) on 2026-08-03. RLS was OFF on the table (migration 005 created it
-- enabled, but it was disabled at some point since), so the default anon /
-- authenticated PostgREST grants let anyone with the public anon key
-- SELECT / INSERT / UPDATE / DELETE partner rows (email, company_name, user_id)
-- directly via the REST API. Verified: `anon` could read the row and delete it.
--
-- Same root cause as migration 012 (bookings): the write policies from 005
-- ("Service role can insert/update/delete partners") were written with
-- USING / WITH CHECK (true) and NO `TO` clause, so they apply to ALL roles.
-- Re-enabling RLS alone would still leave anon able to write through them, so
-- they must be scoped to service_role (which is what the names always implied).
--
-- Safety: service_role has rolbypassrls = true (verified), and EVERY app access
-- to partners goes through createAdminClient (service role) — src/config/partner.ts
-- and src/app/api/admin/partners/**. No FK, view, or function depends on partners.
-- So this purely removes anon/user REST access and does not affect the app. The
-- existing "Partners can view own record" SELECT policy (auth.uid() = user_id) is
-- correct — anon has no auth.uid() so it returns nothing — and is left as-is.
--
-- Applied to prod (mhpurhtctlbjbprfbatb) 2026-08-04; verified as anon:
-- SELECT count(*) => 0, INSERT => "new row violates row-level security policy".

-- 1. Re-scope the permissive write policies to service_role (mirrors 012).
DROP POLICY IF EXISTS "Service role can insert partners" ON partners;
CREATE POLICY "Service role can insert partners"
  ON partners FOR INSERT
  TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role can update partners" ON partners;
CREATE POLICY "Service role can update partners"
  ON partners FOR UPDATE
  TO service_role
  USING (true);

DROP POLICY IF EXISTS "Service role can delete partners" ON partners;
CREATE POLICY "Service role can delete partners"
  ON partners FOR DELETE
  TO service_role
  USING (true);

-- 2. Re-enable RLS (was disabled after 005 created it enabled).
ALTER TABLE partners ENABLE ROW LEVEL SECURITY;
