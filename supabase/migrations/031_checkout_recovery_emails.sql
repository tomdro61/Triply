-- Abandoned-checkout recovery email (src/app/api/cron/checkout-recovery).
--
-- checkout_recovery_emails is the send ledger. The cron INSERTs a 'claimed'
-- row BEFORE calling Resend; the UNIQUE on stripe_payment_intent_id makes a
-- retried or overlapping run fail with 23505 and skip, so one abandoned
-- checkout can never be emailed twice. A transient Resend failure parks the
-- row as 'retry' (never deleted — the email may have been delivered, and its
-- unsubscribe link must keep resolving); the next tick re-claims it with a
-- conditional UPDATE. send_started_at is set right before the Resend call:
-- a 'claimed' row that is old and has it NULL provably never reached Resend
-- and is removed by the cron; one that has it set is alarmed for a human.
-- (email, created_at) serves the one-email-per-address-per-7-days cap. The
-- unsubscribe token's subject is the Stripe PaymentIntent id, stable across
-- retries (/api/checkout-recovery/unsubscribe looks the row up by it).
--
-- checkout_recovery_optouts is the address-level opt-out list for this email.
--
-- Emails are stored lowercased (CHECK), matching booking_waitlist, so equality
-- lookups are complete. Both tables are server-only: RLS on, no policies, and
-- the 029/032 REVOKE/GRANT pair — only the service role reads or writes them.
-- Strictly additive.

CREATE TABLE IF NOT EXISTS checkout_recovery_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_payment_intent_id TEXT NOT NULL,
  email TEXT NOT NULL,
  livemode BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The most recent claim (first INSERT or a re-claim of a 'retry' row).
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set immediately before the Resend call; NULL = Resend was never reached.
  send_started_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  CONSTRAINT checkout_recovery_emails_pi_unique UNIQUE (stripe_payment_intent_id),
  CONSTRAINT checkout_recovery_emails_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT checkout_recovery_emails_status_check CHECK (status IN ('claimed', 'retry', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_checkout_recovery_emails_email_created
  ON checkout_recovery_emails (email, created_at);

-- The stale-claim scan (status = 'claimed' AND claimed_at < …) runs every tick.
CREATE INDEX IF NOT EXISTS idx_checkout_recovery_emails_claimed
  ON checkout_recovery_emails (claimed_at)
  WHERE status = 'claimed';

ALTER TABLE checkout_recovery_emails ENABLE ROW LEVEL SECURITY;
-- Server-only (the 029/032 pattern): RLS with no policies already denies the
-- API roles; the REVOKE is defence in depth for a table of customer emails.
REVOKE ALL ON TABLE checkout_recovery_emails FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE checkout_recovery_emails TO service_role;

CREATE TABLE IF NOT EXISTS checkout_recovery_optouts (
  email TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT checkout_recovery_optouts_email_lowercase CHECK (email = lower(email))
);

ALTER TABLE checkout_recovery_optouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE checkout_recovery_optouts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE checkout_recovery_optouts TO service_role;
