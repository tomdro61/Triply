-- 049 — fixed-amount promo codes ($5 off), the schema half.
-- Plan: notes/2026-11-06-promo-fixed-amount-plan.md, Part 2 (Tom's notes).
--
-- A code is EITHER a percent (discount_percent) OR a dollar amount
-- (discount_amount), never both and never neither. min_subtotal is the least
-- parking (in dollars) the code needs; NULL = no minimum.
--
-- NOTE: promo_codes.discount_amount is the CODE'S value ("$5 off"). It is NOT
-- bookings.discount_amount, which is what one booking actually got.
--
-- Safe to apply before the code that writes fixed codes (PR 2): every existing
-- row is a percent code, and nothing inserts a fixed one until PR 2's
-- PROMO_FIXED_ENABLED kill switch is on. No grant, RLS or trigger changes:
-- 048 made the table service-role only, and the 023 trigger reads
-- bookings.promo_code / bookings.discount_amount only.

ALTER TABLE public.promo_codes ALTER COLUMN discount_percent DROP NOT NULL;
-- 002's CHECK (discount_percent > 0 AND discount_percent <= 100) passes NULL.

ALTER TABLE public.promo_codes ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(10,2)
  CONSTRAINT promo_codes_discount_amount_range CHECK (discount_amount > 0 AND discount_amount <= 20);
-- <= $20 guards a typo (500 for 5.00); raise it deliberately if an offer needs more.

ALTER TABLE public.promo_codes ADD COLUMN IF NOT EXISTS min_subtotal DECIMAL(10,2)
  CONSTRAINT promo_codes_min_subtotal_nonneg CHECK (min_subtotal >= 0);

ALTER TABLE public.promo_codes ADD CONSTRAINT promo_codes_one_kind
  CHECK (num_nonnulls(discount_percent, discount_amount) = 1);

-- Lookups normalise with upper(btrim(...)); every stored code must already be
-- in that form (WELCOME-* and the airport codes are).
ALTER TABLE public.promo_codes ADD CONSTRAINT promo_codes_code_normalised
  CHECK (code = upper(btrim(code)));

NOTIFY pgrst, 'reload schema';
