-- Migration 015: pending_bookings + cart_claims
-- Payment<->booking atomicity fix
-- (see notes/2026-07-17-payment-booking-atomicity-plan.md §9.A / §9.B).
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod BEFORE deploying the
-- atomicity code. Triply-prod is SHARED by staging + prod, so this affects both
-- environments at once. "Staging-first" is impossible for schema on a shared
-- instance -- gate the CODE, not the table. This migration is strictly additive
-- (CREATE TABLE + CREATE INDEX + ENABLE RLS only); it alters no existing table
-- and is safe to apply ahead of the code that reads it.
--
-- WHY THIS EXISTS
-- Booking creation currently depends on the customer's browser surviving the
-- moment between stripe.confirmPayment() and the client's POST /api/reservations.
-- Any deviation -- a 3-D Secure redirect, a BNPL redirect, a reload, a crash, a
-- ResLab timeout -- takes the money and creates no booking. Confirmed orphans:
-- yb3246 (2026-07-16, ResLab timeout), Jordan (3DS card redirect), Nadia (paid
-- twice, no booking, lost as a customer). pending_bookings makes the booking
-- intent DURABLE before the charge, so a server-side webhook can complete the
-- booking even when the browser never comes back.

-- =============================================
-- pending_bookings
-- One row per PaymentIntent, staged by the client immediately BEFORE
-- confirmPayment. Holds the complete fulfillment payload -- the PI metadata
-- alone cannot reconstruct a ResLab reservation (no vehicle, name, or phone),
-- so this row is the sole mandatory source for those fields.
--
-- Keyed by stripe_payment_intent_id so it doubles as the idempotency mutex:
-- the client, the /checkout/complete return page, and the Stripe webhook all
-- race to claim the same row via a single atomic UPDATE ... RETURNING.
-- =============================================
CREATE TABLE IF NOT EXISTS pending_bookings (
  stripe_payment_intent_id TEXT PRIMARY KEY,

  -- --- Fulfillment payload (mirrors reservationSchema) ---
  location_id INTEGER NOT NULL,
  costs_token TEXT,
  -- TEXT, not TIMESTAMP. These are LITERAL airport-local wall-clock strings
  -- ("2026-08-14 10:00:00") exactly as the customer picked them. Migration 007
  -- converted bookings.check_in/check_out off TIMESTAMPTZ for this same reason:
  -- a tz-aware column reinterprets the literal as UTC and shifts the displayed
  -- day. Never apply date math to these.
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  parking_type_id INTEGER NOT NULL,

  customer JSONB NOT NULL,            -- { firstName, lastName, email, phone }
  vehicle JSONB NOT NULL,             -- { make, model, color, licensePlate, state }
  extra_fields JSONB,                 -- ResLab per-location custom fields
  confirmation_params JSONB,          -- query params to rebuild the /confirmation URL

  location_name TEXT,
  location_address TEXT,
  airport_code TEXT,

  subtotal DECIMAL(10,2),
  tax_total DECIMAL(10,2),
  fees_total DECIMAL(10,2),
  grand_total DECIMAL(10,2),
  triply_service_fee DECIMAL(10,2),

  user_id UUID,                       -- no FK: survives account deletion
  has_protection_plan BOOLEAN NOT NULL DEFAULT false,

  -- --- Lifecycle ---
  -- 13 values spanning BOTH capture modes. Under automatic capture money is
  -- already taken, so teardown REFUNDS (refunded_*). Under manual capture the
  -- card is only authorized, so teardown CANCELS the hold (released_*) and the
  -- customer is never charged at all. Wallet methods may auto-capture even when
  -- cards are manual, which is why refunded_after_capture coexists.
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',                 -- staged, PI not yet confirmed
    'processing',              -- a caller holds the mutex and is fulfilling
    'completed',               -- booking created, money settled
    'expired',                 -- PI never succeeded (abandoned/declined checkout)
    'failed',                  -- terminal failure, no money retained
    'suspected_duplicate',     -- lost the cart_claims race; not fulfilled
    'needs_reconciliation',    -- MONEY RETAINED, booking state UNKNOWN -- manual ops
    'capture_ambiguous',       -- capture result unknown; reservation + hold left live
    'refunded_sold_out',       -- captured, inventory gone -> refunded
    'refunded_failed',         -- captured, ResLab definitively rejected -> refunded
    'refunded_after_capture',  -- captured (wallet auto-capture) -> refunded
    'released_sold_out',       -- authorized only, inventory gone -> hold cancelled
    'released_failed'          -- authorized only, ResLab rejected -> hold cancelled
  )),

  reslab_reservation_number TEXT,     -- set the INSTANT ResLab returns; closes the crash window
  reslab_attempt_started_at TIMESTAMPTZ,  -- B4: bounds the ambiguous-timeout window
  claimed_at TIMESTAMPTZ,             -- mutex timestamp; a stale claim may be stolen
  last_error TEXT,

  -- Confirmation email is fire-and-forget today with no record that it sent, so
  -- a crash between INSERT and send loses it permanently (booking-by-PI
  -- idempotency then skips the resend). This flag makes the send re-drivable.
  email_sent BOOLEAN NOT NULL DEFAULT false,

  -- PaymentIntent ids do NOT encode test vs live mode, and Triply-prod is shared
  -- by staging (Stripe TEST) and prod (Stripe LIVE). Every monitor and sweep
  -- MUST filter on this or staging traffic pollutes production alerting.
  livemode BOOLEAN NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sweep/monitor access path: find rows stuck mid-fulfilment. Partial index --
-- completed rows are the overwhelming majority and are never swept.
CREATE INDEX IF NOT EXISTS idx_pending_bookings_stuck
  ON pending_bookings (status, claimed_at)
  WHERE status IN ('pending', 'processing');

-- Ops lookup for the manual-reconciliation queue (the ResLab-timeout class).
CREATE INDEX IF NOT EXISTS idx_pending_bookings_reconcile
  ON pending_bookings (status, created_at)
  WHERE status IN ('needs_reconciliation', 'capture_ambiguous');

CREATE TRIGGER update_pending_bookings_updated_at
  BEFORE UPDATE ON pending_bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- cart_claims
-- The pending_bookings PRIMARY KEY is a per-PAYMENT-INTENT mutex. It does NOT
-- stop a customer generating TWO PaymentIntents for ONE cart -- which is exactly
-- what a failed 3DS attempt followed by a retry produces. Without this table the
-- webhook faithfully fulfils BOTH PIs into two real ResLab reservations and two
-- charges (the Nadia/Jordan double-charge pattern).
--
-- Identity is email + location + dates + parking type. Deliberately NOT amount:
-- toggling Park Guard or a ResLab price refresh between attempts changes the
-- amount while the cart is plainly the same cart.
-- =============================================
CREATE TABLE IF NOT EXISTS cart_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- lower(email) | location_id | from_date | to_date | parking_type_id
  cart_key TEXT NOT NULL,
  stripe_payment_intent_id TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,            -- set on terminal outcome; frees a legit re-book
  livemode BOOLEAN NOT NULL
);

-- Only ONE live claim per cart. The winner proceeds to createReservation; the
-- loser is refunded (or its auth cancelled) and marked suspected_duplicate.
--
-- Time-scoping is done in application code, NOT in this predicate: now() is not
-- IMMUTABLE and cannot appear in an index. Before claiming, the caller releases
-- claims older than ~30 minutes, so a customer legitimately re-booking the same
-- lot and dates later is never blocked.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_claims_live
  ON cart_claims (cart_key)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cart_claims_pi
  ON cart_claims (stripe_payment_intent_id);

-- Service-role only. RLS enabled with NO policies => anon/authenticated are
-- denied all access; the service_role key (server-side admin client) bypasses
-- RLS. Same posture as migration 014.
--
-- These tables hold customer PII (name, email, phone, vehicle, plate) for
-- in-flight checkouts, so a permissive policy here would be worse than on
-- bookings. After applying, VERIFY with the anon key that PostgREST returns
-- zero rows / permission denied for both tables.
ALTER TABLE pending_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_claims ENABLE ROW LEVEL SECURITY;
