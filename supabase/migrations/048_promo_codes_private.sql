-- 048: promo_codes is server-only.
--
-- 002 created `CREATE POLICY "Allow read promo codes" ON promo_codes FOR SELECT USING (true)` with no TO clause,
-- and 019 (which scoped the WRITE policies to service_role) left it in place. Checked live on 2026-11-06: the public
-- anon key — shipped in every browser bundle — listed all 179 codes over PostgREST, including the active single-use
-- WELCOME-xxxx newsletter codes (10% off each).
--
-- Every reader uses the service-role client, which bypasses RLS and keeps its grants: /api/promo/validate,
-- /api/checkout/lot, /api/newsletter, /api/admin/stats, the daily digest (src/lib/digest/collect.ts). The 023 trigger
-- bump_promo_use runs as the inserting role (service_role; no SECURITY DEFINER). Nothing in the browser reads the table.
--
-- Same shape as 032 (booking_cancellation_notes): RLS on, no policies, no privileges for anon/authenticated.
-- ROLLBACK (only if a reader turns out to use the anon key):
--   GRANT SELECT ON TABLE public.promo_codes TO anon, authenticated;
--   CREATE POLICY "Allow read promo codes" ON public.promo_codes FOR SELECT USING (true);

DROP POLICY IF EXISTS "Allow read promo codes" ON public.promo_codes;
ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.promo_codes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.promo_codes TO service_role;

NOTIFY pgrst, 'reload schema';
