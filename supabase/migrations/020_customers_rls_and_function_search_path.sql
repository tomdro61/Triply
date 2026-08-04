-- Migration 020: Scope customers INSERT to service_role + pin function search_path
--
-- Closes the last two Supabase Security Advisor items after 018/019.
--
-- 1. customers "Anyone can create customer record" [INSERT] was the final
--    permissive-to-public write policy (WITH CHECK (true), no TO clause). The
--    old note assumed it was needed for client-side guest checkout, but verified
--    2026-08-04 that ALL customer writes are server-side / admin client:
--      INSERT -> src/app/api/user/profile/route.ts:150, src/lib/booking/fulfill.ts:190
--      UPDATE -> src/lib/booking/fulfill.ts:180
--    and there is NO browser/anon insert, NO auth.users signup trigger, and NO
--    function that writes customers. So scoping to service_role is safe (service
--    role bypasses RLS; the own-record SELECT/UPDATE policies are untouched, so
--    signed-in users still read/update their own row). Renamed to match reality.
--
-- 2. update_updated_at_column() had a mutable search_path (advisor:
--    function_search_path_mutable). Its body is only `NEW.updated_at = NOW();
--    RETURN NEW;` — NEW plus the NOW() builtin (pg_catalog, always in path) — so
--    an empty search_path is safe and removes the injection surface.
--
-- Applied to prod (mhpurhtctlbjbprfbatb) 2026-08-04; re-audit: ZERO permissive-
-- to-public write policies remain across the public schema.

DROP POLICY IF EXISTS "Anyone can create customer record" ON customers;
CREATE POLICY "Service role can insert customers"
  ON customers FOR INSERT TO service_role WITH CHECK (true);

ALTER FUNCTION public.update_updated_at_column() SET search_path = '';
