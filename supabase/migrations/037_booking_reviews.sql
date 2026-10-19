-- Migration 037: post-trip review email + verified reviews.
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod (shared by staging +
-- prod) BEFORE enabling POST_TRIP_REVIEW_EMAILS_ENABLED. Strictly additive:
-- three new tables, no change to bookings. Re-run-safe (IF NOT EXISTS).
--
-- booking_reviews — one review per booking (UNIQUE booking_id), written only
-- through /api/reviews by a customer who opened the signed link from the
-- post-trip email AND pressed Save (nothing is written on page load, so mail
-- scanners can't create rows), so every row is a VERIFIED stay. The lot and
-- airport are copied from the booking at write time (bookings store the lot as
-- reslab_location_id OR direct_lot_id, plus the denormalised location_name),
-- so a review stays attributable to its lot whatever later happens to the
-- lot's ids. publish_consent = the customer agreed to publish the review on
-- Triply with their first name ("OK to publish my review (with my first
-- name)"); display_name is that first name, stored ONLY with that consent.
--
-- review_emails — the send ledger for the review email and its one reminder,
-- the checkout_recovery_emails (031) pattern: the cron INSERTs a 'claimed'
-- row BEFORE calling Resend; UNIQUE (booking_id, kind) makes a retried or
-- overlapping run fail with 23505 and skip, so a booking can never get the
-- same email twice. A rate-limited Resend call parks the row as 'retry'
-- (re-claimed by a later run with a conditional UPDATE). A send whose outcome
-- is unknown (timeout, Resend 5xx, idempotency conflict) is 'unconfirmed':
-- never retried, never reminded, alarmed — Resend keeps idempotency keys only
-- 24 h, so a next-day retry could email the customer twice. send_started_at
-- is stamped right before the Resend call: an old 'claimed' row with it NULL
-- provably never reached Resend and is removed by the cron; one with it set
-- is alarmed for a human. `email` is the address the email went to (the
-- booked guest), which the unsubscribe link resolves; `livemode` is the mode
-- of the deployment that sent it (only production sends live mail).
--
-- review_email_optouts — address-level opt-out for the review email (the
-- email's unsubscribe link and its List-Unsubscribe header). The cron also
-- skips addresses opted out of the recovery email, the newsletter or the
-- waitlist.
--
-- All three tables are server-only: RLS on, no policies, and the 029/031
-- REVOKE/GRANT pair — only the service role reads or writes them.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS review_email_optouts;
--   DROP TABLE IF EXISTS review_emails;
--   DROP TABLE IF EXISTS booking_reviews;

CREATE TABLE IF NOT EXISTS booking_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  -- Copied from the booking. airport_code can be NULL or the legacy "RESLAB"
  -- placeholder on pre-PR-#26 bookings, exactly as bookings.airport_code.
  airport_code TEXT,
  reslab_location_id INTEGER,
  direct_lot_id TEXT,
  location_name TEXT NOT NULL,
  rating SMALLINT NOT NULL,
  shuttle_wait TEXT,
  extra_charges BOOLEAN,
  comment TEXT,
  publish_consent BOOLEAN NOT NULL DEFAULT false,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT booking_reviews_booking_unique UNIQUE (booking_id),
  CONSTRAINT booking_reviews_rating_check CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT booking_reviews_shuttle_wait_check
    CHECK (shuttle_wait IS NULL OR shuttle_wait IN ('under_5', '5_15', 'over_15')),
  CONSTRAINT booking_reviews_comment_length CHECK (comment IS NULL OR char_length(comment) <= 500),
  -- A name is only ever shown with consent; never store one without it.
  CONSTRAINT booking_reviews_display_name_consent CHECK (display_name IS NULL OR publish_consent)
);

-- Per-lot / per-airport aggregation for showing reviews on pages later.
CREATE INDEX IF NOT EXISTS idx_booking_reviews_reslab_location
  ON booking_reviews (reslab_location_id) WHERE reslab_location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_reviews_direct_lot
  ON booking_reviews (direct_lot_id) WHERE direct_lot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_reviews_airport
  ON booking_reviews (airport_code);

ALTER TABLE booking_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE booking_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE booking_reviews TO service_role;

CREATE TABLE IF NOT EXISTS review_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  -- Lowercased recipient (the booked guest), for the unsubscribe link.
  email TEXT NOT NULL,
  livemode BOOLEAN NOT NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The most recent claim (first INSERT or a re-claim of a 'retry' row).
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set immediately before the Resend call; NULL = Resend was never reached.
  send_started_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  CONSTRAINT review_emails_booking_kind_unique UNIQUE (booking_id, kind),
  CONSTRAINT review_emails_kind_check CHECK (kind IN ('initial', 'reminder')),
  CONSTRAINT review_emails_status_check CHECK (status IN ('claimed', 'retry', 'sent', 'failed', 'unconfirmed')),
  CONSTRAINT review_emails_email_lowercase CHECK (email = lower(email))
);

-- The stale-claim scan (status = 'claimed' AND claimed_at < …) runs every run.
CREATE INDEX IF NOT EXISTS idx_review_emails_claimed
  ON review_emails (claimed_at)
  WHERE status = 'claimed';

-- The unsubscribe route resolves a booking's recipient address.
CREATE INDEX IF NOT EXISTS idx_review_emails_booking ON review_emails (booking_id);

ALTER TABLE review_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE review_emails FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE review_emails TO service_role;

CREATE TABLE IF NOT EXISTS review_email_optouts (
  email TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT review_email_optouts_email_lowercase CHECK (email = lower(email))
);

ALTER TABLE review_email_optouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE review_email_optouts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE review_email_optouts TO service_role;
