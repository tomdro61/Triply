-- Migration 045: dispute ledger.
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod (shared by staging +
-- prod). Additive: one new table, no change to bookings. Re-run-safe.
--
-- One row per Stripe dispute, written by the Stripe webhook on
-- charge.dispute.created / .updated / .closed. Before this the only trace of a
-- dispute was bookings.status = 'disputed' plus a Sentry event — no deadline,
-- no outcome, no record of whether evidence was ever prepared. This table is
-- what the alert email, the evidence draft, and the win-rate count read.
--
-- booking_id is NULL when the disputed charge has no booking (a manual Payment
-- Link, an orphan charge) — the dispute still has to be answered.
--
-- Service-role only: RLS on, no policies.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS disputes;

CREATE TABLE IF NOT EXISTS disputes (
  stripe_dispute_id   TEXT PRIMARY KEY,
  booking_id          UUID REFERENCES bookings(id) ON DELETE SET NULL,
  payment_intent_id   TEXT,
  charge_id           TEXT,
  amount_cents        INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  reason              TEXT NOT NULL,
  status              TEXT NOT NULL,
  evidence_due_by     TIMESTAMPTZ,
  livemode            BOOLEAN NOT NULL,
  -- The booking's status BEFORE the webhook flipped it to 'disputed' — the
  -- evidence must say whether it was cancelled, not that it is disputed.
  booking_status_at_dispute TEXT,
  -- Claim column: the evidence draft is attempted once, set NULL → now() by a
  -- conditional UPDATE. Stripe delivers events concurrently and out of order,
  -- so row existence alone can't gate it.
  draft_attempted_at  TIMESTAMPTZ,
  -- The alert email's lease: held only while a delivery sends, released on a
  -- failed send, and taken over once older than 2 minutes (the route can't
  -- run past 60 s). alert_sent_at is written only AFTER Resend accepted the
  -- email, so a delivery that dies mid-send can't mark it sent.
  alert_claimed_at    TIMESTAMPTZ,
  alert_sent_at       TIMESTAMPTZ,
  -- Set once the webhook saved an evidence draft to Stripe (never submitted —
  -- a person reviews and submits in the Stripe dashboard).
  evidence_drafted_at TIMESTAMPTZ,
  evidence_draft_error TEXT,
  -- won / lost / warning_closed / prevented — Stripe's terminal status, copied
  -- on close. closed_at doubles as the claim for the one outcome email.
  outcome             TEXT,
  closed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Added in review after the first draft of this file: a table created from
-- that draft lacks the lease column, and CREATE TABLE IF NOT EXISTS would
-- skip it. Without it every alert lease fails and Stripe retries for days.
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS alert_claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS disputes_booking_id_idx ON disputes (booking_id);
CREATE INDEX IF NOT EXISTS disputes_open_due_idx ON disputes (evidence_due_by) WHERE closed_at IS NULL;

ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
-- Belt and braces on top of RLS, as 029: no client role touches this table.
REVOKE ALL ON TABLE disputes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE disputes TO service_role;

DROP TRIGGER IF EXISTS update_disputes_updated_at ON disputes;
CREATE TRIGGER update_disputes_updated_at
  BEFORE UPDATE ON disputes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
