-- Migration 019: Scope remaining permissive write policies to service_role
--
-- Follow-up to 018 (partners) and 012 (bookings UPDATE). A full audit of every
-- public-schema policy (2026-08-04) found the SAME misnamed-permissive-policy
-- bug on four more tables: write policies with USING/WITH CHECK (true) and no
-- `TO` clause, so they apply to {public} (anon + authenticated). Since these
-- tables have RLS ON, reads were already scoped, but the WRITE side was open to
-- anyone with the public anon key via PostgREST.
--
-- Highest risk: promo_codes — anyone could INSERT a 100%-off code or UPDATE an
-- existing one (free money). bookings could take junk INSERTs; chat_sessions and
-- newsletter_subscribers had [ALL]-to-public policies (read/modify/delete every
-- row, incl. dumping the whole subscriber list).
--
-- Safety: verified every app WRITE to these tables goes through createAdminClient
-- (service role, which bypasses RLS):
--   promo_codes INSERT       -> src/app/api/newsletter/route.ts (no UPDATE exists)
--   bookings INSERT          -> src/lib/booking/fulfill.ts
--   chat_sessions upsert     -> src/app/api/chat/route.ts (logChatSession)
--   newsletter INSERT/UPDATE -> src/app/api/newsletter/route.ts
-- So scoping the policies TO service_role removes only anon/user REST write
-- access and does not touch any app flow. Own-record SELECT policies
-- (chat_sessions "Users can read own chat sessions", bookings "Users can view
-- own bookings", promo_codes "Allow read promo codes") are left untouched.
--
-- NOT included: customers "Anyone can create customer record" [INSERT]. Its
-- inserts are ALSO server-side now (api/user/profile + lib/booking/fulfill, both
-- admin client), so it is likewise closeable — deferred pending an explicit call
-- because customers is the checkout money-path and was previously kept on purpose.
--
-- Applied to prod (mhpurhtctlbjbprfbatb) 2026-08-04; re-audit shows the whole
-- permissive-write class gone except the deferred customers INSERT.

-- promo_codes
DROP POLICY IF EXISTS "Allow insert promo codes" ON promo_codes;
CREATE POLICY "Allow insert promo codes"
  ON promo_codes FOR INSERT TO service_role WITH CHECK (true);
DROP POLICY IF EXISTS "Allow update promo codes" ON promo_codes;
CREATE POLICY "Allow update promo codes"
  ON promo_codes FOR UPDATE TO service_role USING (true);

-- bookings (INSERT; UPDATE was already scoped in 012)
DROP POLICY IF EXISTS "Service role can insert bookings" ON bookings;
CREATE POLICY "Service role can insert bookings"
  ON bookings FOR INSERT TO service_role WITH CHECK (true);

-- chat_sessions (the [ALL]-to-public policy; own-record SELECT policy untouched)
DROP POLICY IF EXISTS "Service role can manage all chat sessions" ON chat_sessions;
CREATE POLICY "Service role can manage all chat sessions"
  ON chat_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- newsletter_subscribers (the [ALL]-to-public policy)
DROP POLICY IF EXISTS "Service role can manage newsletter subscribers" ON newsletter_subscribers;
CREATE POLICY "Service role can manage newsletter subscribers"
  ON newsletter_subscribers FOR ALL TO service_role USING (true) WITH CHECK (true);
