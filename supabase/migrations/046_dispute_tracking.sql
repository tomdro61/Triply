-- Migration 046: dispute tracking + early fraud warnings.
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod (shared by staging +
-- prod), AFTER 045. Additive only. Re-run-safe.
--
-- disputes: who submitted the evidence.
--   submitted_at / submitted_by  set from /admin/disputes after a person
--                       submits the evidence in Stripe (Stripe has no event
--                       for "evidence submitted" we act on, so it's manual)
--
-- fraud_warnings: one row per Stripe Radar early fraud warning (the card
-- network's heads-up that a dispute is likely). Refunding before it becomes a
-- dispute avoids the dispute fee; a person decides.
--
-- Service-role only: RLS on, no policies.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS fraud_warnings;
--   ALTER TABLE disputes DROP COLUMN IF EXISTS submitted_at,
--     DROP COLUMN IF EXISTS submitted_by;

ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_by TEXT;

CREATE TABLE IF NOT EXISTS fraud_warnings (
  stripe_warning_id  TEXT PRIMARY KEY,
  charge_id          TEXT,
  payment_intent_id  TEXT,
  booking_id         UUID REFERENCES bookings(id) ON DELETE SET NULL,
  fraud_type         TEXT NOT NULL,
  actionable         BOOLEAN NOT NULL,
  livemode           BOOLEAN NOT NULL,
  -- The alert email's lease, as on disputes (045): held only while a delivery
  -- sends, taken over once older than 2 minutes; alert_sent_at is written
  -- only AFTER Resend accepted the email.
  alert_claimed_at   TIMESTAMPTZ,
  alert_sent_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A table made from an earlier draft of this file lacks the lease column.
ALTER TABLE fraud_warnings ADD COLUMN IF NOT EXISTS alert_claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS fraud_warnings_booking_id_idx ON fraud_warnings (booking_id);

ALTER TABLE fraud_warnings ENABLE ROW LEVEL SECURITY;
-- Belt and braces on top of RLS, as 029 / 045: no client role touches this table.
REVOKE ALL ON TABLE fraud_warnings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE fraud_warnings TO service_role;
