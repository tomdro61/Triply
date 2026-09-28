-- Abandoned-checkout recovery email (src/app/api/cron/checkout-recovery).
--
-- checkout_recovery_emails is the send ledger. The cron INSERTs a 'claimed'
-- row BEFORE calling Resend; the UNIQUE on stripe_payment_intent_id makes a
-- retried or overlapping run fail with 23505 and skip, so one abandoned
-- checkout can never be emailed twice. (email, created_at) serves the
-- one-email-per-address-per-7-days cap. The row id is the unsubscribe token's
-- subject (/api/checkout-recovery/unsubscribe).
--
-- checkout_recovery_optouts is the address-level opt-out list for this email.
--
-- Emails are stored lowercased (CHECK), matching booking_waitlist, so equality
-- lookups are complete. Both tables are server-only: RLS on, no policies —
-- only the service role reads or writes them. Strictly additive.

CREATE TABLE IF NOT EXISTS checkout_recovery_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_payment_intent_id TEXT NOT NULL,
  email TEXT NOT NULL,
  livemode BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT checkout_recovery_emails_pi_unique UNIQUE (stripe_payment_intent_id),
  CONSTRAINT checkout_recovery_emails_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT checkout_recovery_emails_status_check CHECK (status IN ('claimed', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_checkout_recovery_emails_email_created
  ON checkout_recovery_emails (email, created_at);

ALTER TABLE checkout_recovery_emails ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS checkout_recovery_optouts (
  email TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT checkout_recovery_optouts_email_lowercase CHECK (email = lower(email))
);

ALTER TABLE checkout_recovery_optouts ENABLE ROW LEVEL SECURITY;
