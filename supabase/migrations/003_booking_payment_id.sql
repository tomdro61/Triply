-- Triply Pre-Launch: Add Stripe PaymentIntent ID to bookings
-- Migration 003

-- Add stripe_payment_intent_id column for payment verification and replay prevention
ALTER TABLE bookings
  ADD COLUMN stripe_payment_intent_id TEXT UNIQUE;

CREATE INDEX idx_bookings_stripe_pi ON bookings(stripe_payment_intent_id);

-- Expand status check constraint to include payment_failed, disputed, refunded
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_status_check;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('confirmed', 'cancelled', 'completed', 'payment_failed', 'disputed', 'refunded'));
