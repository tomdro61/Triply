-- 050: customers rows are written by the server only.
--
-- Every writer uses the service-role client, which bypasses RLS and keeps its grants: fulfilment
-- (src/lib/booking/fulfill.ts upsertCustomer), the profile route (PUT /api/user/profile), the claim flow
-- (POST /api/user/link-bookings) and the operator scripts. No browser code writes the table. Signed-in
-- users keep READING their own row (profile GET, My Reservations, self-cancel, and the bookings
-- "view own" policy, whose subquery reads customers as the caller).
--
-- Server code treats customers.email and customers.user_id as trusted, so the table stays server-written.
-- Pattern of 032 / 048: REVOKE ALL from the client roles, then grant back only what they need (here, SELECT).
--
-- lock_timeout: DROP POLICY takes a brief ACCESS EXCLUSIVE lock on a table fulfilment reads after the
-- card is captured (and every signed-in bookings read, through the "view own" policy). If the lock isn't
-- granted within 3 s the migration fails (nothing applied) and is simply re-run.
--
-- ROLLBACK: fix forward — move a failing writer to the service-role client. Never grant writes back to
-- anon/authenticated wholesale.

SET LOCAL lock_timeout = '3s';

DROP POLICY IF EXISTS "Users can update own customer record" ON public.customers;
REVOKE ALL ON TABLE public.customers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.customers TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customers TO service_role;

NOTIFY pgrst, 'reload schema';
