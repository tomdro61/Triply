-- Migration 023: booking attribution + promo usage counter
-- (see notes/2026-09-17-booking-attribution-plan.md)
--
-- Additive and nullable — safe to apply BEFORE the code deploys. In-flight
-- checkouts staged before deploy fulfil with attribution = NULL, channel = NULL.
--
-- 1. attribution JSONB on pending_bookings (captured at stage time from the
--    triply_attr cookie, server-side) and on bookings (copied at fulfilment).
-- 2. bookings.channel — derived at fulfilment by the TypeScript classifier.
--    Deliberately NO CHECK constraint: a 23514 from a marketing column would
--    abort the money-committed insert after the card was captured.
-- 3. promo_codes.current_uses has never incremented (all rows 0) and was
--    nullable (NULL + 1 = NULL would make a code unlimited forever). Zero the
--    NULLs, make it NOT NULL, and bump it from an AFTER INSERT trigger on
--    bookings — atomic with the insert, exactly-once (stripe_payment_intent_id
--    is UNIQUE, so a retry hits 23505 and the trigger does not fire).
--
-- ROLLBACK (separately runnable — the trigger is the only piece on a money path
-- and the first time max_uses is actually enforced):
--   DROP TRIGGER IF EXISTS bookings_bump_promo_use ON public.bookings;

ALTER TABLE public.pending_bookings ADD COLUMN IF NOT EXISTS attribution JSONB;
ALTER TABLE public.bookings         ADD COLUMN IF NOT EXISTS attribution JSONB;
ALTER TABLE public.bookings         ADD COLUMN IF NOT EXISTS channel TEXT;
CREATE INDEX IF NOT EXISTS idx_bookings_channel ON public.bookings (channel);

COMMENT ON COLUMN public.bookings.attribution IS
  'Parsed triply_attr cookie at stage time (first/last touch, apt, ga_client_id) or {"v":null,"invalid":true}. NULL = cookie absent.';
COMMENT ON COLUMN public.bookings.channel IS
  'Derived at fulfilment from attribution (first touch): paid_search|paid_social|email|partner|referral|organic_search|organic_social|direct. NULL = unknown/invalid. Enforced in TS only.';

UPDATE public.promo_codes SET current_uses = 0 WHERE current_uses IS NULL;
ALTER TABLE public.promo_codes
  ALTER COLUMN current_uses SET DEFAULT 0,
  ALTER COLUMN current_uses SET NOT NULL;

CREATE OR REPLACE FUNCTION public.bump_promo_use() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
  -- WHEN OTHERS does NOT catch QUERY_CANCELED (57014). A long wait on the promo
  -- row lock could hit statement_timeout, escape the handler and abort the
  -- money-committed INSERT. lock_timeout surfaces that wait as 55P03 first,
  -- which IS caught below.
  SET lock_timeout = '2s'
AS $$
BEGIN
  -- DELIBERATE SWALLOW. This runs inside the bookings INSERT's transaction,
  -- AFTER the customer's payment has been captured (create-booking.ts step 10).
  -- Letting a marketing counter abort that INSERT would leave a charged
  -- customer with a live ResLab reservation and no booking row. A 0-row UPDATE
  -- is fine (unknown/renamed code) and is surfaced by the admin byPromo table,
  -- which shows current_uses next to the derived booking count. The WARNING
  -- lands in the Supabase Postgres logs only (filter: "bump_promo_use failed").
  BEGIN
    UPDATE public.promo_codes
       SET current_uses = COALESCE(current_uses, 0) + 1
     WHERE code = NEW.promo_code;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'bump_promo_use failed for booking % code %: %',
      NEW.id, NEW.promo_code, SQLERRM;
  END;
  RETURN NEW;
END
$$;
-- No SECURITY DEFINER: the only role that inserts into bookings is service_role,
-- which already has UPDATE on promo_codes (migration 019) and bypasses RLS.

DROP TRIGGER IF EXISTS bookings_bump_promo_use ON public.bookings;
CREATE TRIGGER bookings_bump_promo_use
  AFTER INSERT ON public.bookings
  FOR EACH ROW
  WHEN (NEW.promo_code IS NOT NULL AND NEW.discount_amount > 0)
  EXECUTE FUNCTION public.bump_promo_use();

-- PostgREST caches the schema; without this the pending route's insert of the
-- new column returns PGRST204 until the cache reloads (documented for 021 at
-- create-booking.ts ~L448).
NOTIFY pgrst, 'reload schema';
