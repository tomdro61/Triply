-- Migration 033: promo code source + one-per-customer limit
-- (marketing plan rank 44: "Give every code a source, a cap and a
-- one-per-customer limit". The cap already works — migration 023's trigger
-- increments current_uses and max_uses is enforced.)
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod BEFORE deploying the
-- code. Triply-prod is SHARED by staging + prod. Strictly additive: two new
-- columns on promo_codes and one new table. No existing code's discount,
-- active flag, expiry or cap is touched.
--
-- 1. promo_codes.source — where a code is distributed. Constrained text, NULL
--    for existing codes (we do not know, and guessing would poison the report).
--    The CHECK is safe here, unlike bookings.channel (023): promo_codes is only
--    written by an admin (SQL editor) and by /api/newsletter, never inside a
--    money-committed transaction.
--
-- 2. promo_codes.once_per_customer — DEFAULT true for every NEW code.
--    EXISTING codes are set to FALSE explicitly: that is today's behaviour, so
--    applying this migration changes nothing for a code already in the wild.
--    (SAVE10 / SAVE20 / TRIPLY are shared public codes whose retirement is a
--    separate, deliberate step; newsletter welcome codes are max_uses = 1, so
--    the flag is moot for them.) Flip a code on with:
--      UPDATE promo_codes SET once_per_customer = true WHERE code = 'X';
--
-- 3. promo_redemptions — the AUTHORITATIVE once-per-customer record. A row is
--    claimed by the booking engine (create-booking.ts, step 8.5) BEFORE the
--    ResLab reservation and BEFORE capture, i.e. while the card is only
--    authorized. The partial unique index is what makes it race-safe: two
--    concurrent checkouts with the same code + email both try to INSERT and
--    exactly one wins; the loser's authorization is cancelled (never captured).
--    A claim is released (released_at set) when its booking fails before the
--    money moves, so a customer whose first attempt failed can use the code.
--
--    Why not a unique index on bookings(lower(email), promo_code)? The bookings
--    row is inserted AFTER capture (step 11). A violation there would fail a
--    booking the customer has already paid for.
--
--    livemode is part of the key: Triply-prod is shared by staging (Stripe
--    TEST) and production (Stripe LIVE); a staging test with a real customer's
--    email must never consume their code in production (same reason cart_key
--    carries livemode).
--
--    History starts at this migration: bookings made before it do not count
--    as redemptions. Every existing code is once_per_customer = false, so this
--    only matters if one is later flipped on.
--
-- ROLLBACK (the code treats a missing claim table as a DB fault → retryable,
-- so revert the code deploy first, then):
--   DROP TABLE IF EXISTS public.promo_redemptions;
--   ALTER TABLE public.promo_codes DROP COLUMN IF EXISTS once_per_customer;
--   ALTER TABLE public.promo_codes DROP CONSTRAINT IF EXISTS promo_codes_source_check;
--   ALTER TABLE public.promo_codes DROP COLUMN IF EXISTS source;

-- 1. source ------------------------------------------------------------------
ALTER TABLE public.promo_codes ADD COLUMN IF NOT EXISTS source TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'promo_codes_source_check'
       AND conrelid = 'public.promo_codes'::regclass
  ) THEN
    ALTER TABLE public.promo_codes
      ADD CONSTRAINT promo_codes_source_check CHECK (
        source IS NULL OR source IN (
          'blog', 'lot_staff', 'referral', 'corporate', 'email', 'paid', 'other'
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.promo_codes.source IS
  'Where the code is distributed: blog|lot_staff|referral|corporate|email|paid|other. NULL = unknown (codes created before migration 033). Mirrored by PROMO_SOURCES in src/lib/promo/redemption.ts.';

-- 2. once_per_customer ------------------------------------------------------
-- Guarded so a re-run cannot reset codes created after the first run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'promo_codes'
       AND column_name = 'once_per_customer'
  ) THEN
    ALTER TABLE public.promo_codes
      ADD COLUMN once_per_customer BOOLEAN NOT NULL DEFAULT true;
    -- Existing codes keep today's behaviour (no per-customer limit).
    UPDATE public.promo_codes SET once_per_customer = false;
  END IF;
END $$;

COMMENT ON COLUMN public.promo_codes.once_per_customer IS
  'true = one redemption per customer email (case-insensitive), enforced via promo_redemptions. Default true for new codes; codes existing at migration 033 were set false.';

-- 3. promo_redemptions -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.promo_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id UUID NOT NULL REFERENCES public.promo_codes(id) ON DELETE CASCADE,
  -- Denormalised for the admin view / SQL editor; promo_code_id is the key.
  code TEXT NOT NULL,
  email_lower TEXT NOT NULL CHECK (email_lower <> '' AND email_lower = lower(btrim(email_lower))),
  stripe_payment_intent_id TEXT NOT NULL,
  livemode BOOLEAN NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ
);

-- THE once-per-customer guarantee. Only live (unreleased) claims count.
CREATE UNIQUE INDEX IF NOT EXISTS promo_redemptions_one_per_customer
  ON public.promo_redemptions (promo_code_id, email_lower, livemode)
  WHERE released_at IS NULL;

-- One live claim per PaymentIntent (a PI carries at most one code).
CREATE UNIQUE INDEX IF NOT EXISTS promo_redemptions_one_per_pi
  ON public.promo_redemptions (stripe_payment_intent_id)
  WHERE released_at IS NULL;

-- RLS on, no policies: only the service role (which bypasses RLS) touches it.
ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
