-- 052 — TRIP5: $5 off, the Minty Recover pilot offer (CC task 7346cabe).
-- Minty emails this static code to matched visitors who left without giving
-- us an email. One code per booking and no stacking are already how checkout
-- works (one promo_code per booking). No minimum, no expiry, no use cap: the
-- pilot is 4 weeks; set active = false to end it.
--
-- Needs 049 (fixed-amount columns) and PROMO_FIXED_ENABLED=true in prod, or
-- /api/promo/validate answers "not available" for every fixed code.
-- Re-runnable: an existing TRIP5 row is left as it is, but the check below
-- fails the migration unless that row is an active $5 fixed code.
--
-- Attribution for the pilot read-out: bookings.promo_code = 'TRIP5'.

INSERT INTO public.promo_codes (code, discount_percent, discount_amount, min_subtotal, active)
VALUES ('TRIP5', NULL, 5.00, NULL, true)
ON CONFLICT (code) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.promo_codes
    WHERE code = 'TRIP5'
      AND active IS TRUE
      AND discount_percent IS NULL
      AND discount_amount = 5.00
  ) THEN
    RAISE EXCEPTION 'TRIP5 exists but is not an active $5 fixed code; fix that row by hand';
  END IF;
END $$;
