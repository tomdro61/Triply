-- Migration 016: record the promo code + discount on the booking
-- (see REVIEW-FINDINGS.md 2026-07-22 — promo discount was charged to Stripe but
-- never stored, so admin "Paid online" overstated what the customer actually paid).
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod BEFORE deploying the code
-- that writes these columns. Triply-prod is SHARED by staging + prod, so this
-- affects both at once. Strictly additive (two nullable/defaulted columns) — the
-- existing code never references them, so applying ahead of the code is safe.
--
-- WHY: `/api/checkout/lot` applies `discount = sub_total × percent/100` and creates
-- the Stripe PaymentIntent for the DISCOUNTED amount (Stripe charges correctly),
-- but the booking row stored ResLab's FULL grand_total + full service fee with no
-- discount. The admin then computed "Paid online" from the full total → overstated
-- by the discount. These columns let us store what was actually discounted and show
-- the real amount paid + which code was used.

ALTER TABLE bookings
  -- The promo code the customer redeemed (uppercased, matching promo_codes.code).
  -- NULL when no promo was applied.
  ADD COLUMN IF NOT EXISTS promo_code TEXT,
  -- Dollars taken off the parking subtotal by the promo. 0 when none. This is the
  -- amount already reflected in the Stripe charge; "Paid online" = booking total
  -- − due_at_location − discount_amount reconciles to Stripe's amount_received.
  ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(10,2) NOT NULL DEFAULT 0;

-- Partial index so "which bookings used a promo" is a cheap admin/reporting query
-- (the overwhelming majority have no promo and are skipped).
CREATE INDEX IF NOT EXISTS idx_bookings_promo_code
  ON bookings (promo_code)
  WHERE promo_code IS NOT NULL;
</content>
