-- 052: the currency ResLab prices a booking's lot in, and the exchange rate
-- the booking was converted with
--
-- ResLab prices our Canadian lots (Toronto, Montreal, Calgary, Ottawa) in
-- Canadian dollars. Checkout charges in US dollars, so for those lots every
-- ResLab figure is converted at ONE rate, fixed when the PaymentIntent is
-- created and stamped on it (src/lib/fx/cad-usd.ts). These two columns keep
-- that rate with the booking, so the confirmation page converts ResLab's live
-- (Canadian-dollar) figures with the rate the customer was charged at, never
-- with today's. (Accounting does not read them yet.)
--
--   reslab_currency  NULL  = no conversion: a lot priced in US dollars, or one
--                            of the five pre-052 Canadian bookings not yet
--                            marked (see fx_rate).
--                    'CAD' = the money columns on this row are US dollars,
--                            converted from Canadian dollars at fx_rate.
--   fx_rate          US dollars per one Canadian dollar, exactly as stamped
--                    (six decimals). 1.000000 is allowed only so the five
--                    bookings charged one-for-one before November 3, 2026 can
--                    be marked truthfully (a separate, reviewed data fix).
--
-- Additive and nullable. The app writes the columns only for a converted lot
-- (a conditional spread), so a US booking's insert is unchanged, and every
-- reader treats NULL as "no conversion".
--
-- MUST be applied BEFORE the code ships anywhere, a PR preview included
-- (previews read the production database): /api/reservations/[id] selects
-- these columns, and a select naming a missing column fails for EVERY booking.
-- No backfill here.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reslab_currency TEXT,
  ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(10, 6);

-- Both or neither; a known currency; a sane rate (also refuses a rate entered
-- upside down, which would be above 1). `reslab_currency IS NOT NULL` is spelled
-- out on purpose: a CHECK passes when it evaluates to NULL, and without it a
-- row with a rate but no currency (NULL = 'CAD' is NULL) would be accepted.
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_reslab_currency_fx_rate_check;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_reslab_currency_fx_rate_check CHECK (
    (reslab_currency IS NULL AND fx_rate IS NULL)
    OR (reslab_currency IS NOT NULL AND reslab_currency = 'CAD' AND fx_rate IS NOT NULL AND fx_rate > 0.5 AND fx_rate <= 1)
  );

COMMENT ON COLUMN bookings.reslab_currency IS
  'Currency ResLab prices the lot in when it is not USD (''CAD''). NULL = no conversion (a USD lot, or a pre-052 booking not yet marked). Migration 052.';
COMMENT ON COLUMN bookings.fx_rate IS
  'US dollars per one unit of reslab_currency, as stamped on the PaymentIntent at checkout. 1.000000 = charged one-for-one before conversion existed (not stamped). NULL when reslab_currency is NULL. Migration 052.';
