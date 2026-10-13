-- Migration 041: direct lots Phase 6b — daily manifest runs, ops alerts, admin re-send audit.
-- Plan: notes/2026-10-12-direct-lots-phase6b-build-plan.md (v3.2, approved by Tom 2026-10-12).
--
-- WHAT:
--   direct_lot_manifest_runs  one row per (lot, manifest date, Stripe mode, recipient set): the claim that
--                             makes the evening manifest (a REMINDER of bookings the lot was already emailed)
--                             go out once, its takeover state, and the bookings it listed.
--   direct_lot_alerts         one row per open problem (subject + kind + mode): when it was first/last seen
--                             and when Discord last accepted an alert for it.
--   direct_lot_resends        audit + once-only claim for admin re-sends and manifest follow-up cancels.
--   direct_booking_terms.recipients_rev  bumped when an admin re-points an UNSENT booking notice to the
--                             lot's corrected inbox; part of that notice's Resend idempotency key when > 0.
-- Nothing changes on bookings. livemode in every key: staging and production share this database, and a
-- staging run must never claim, alert or audit a production row.
--
-- Supabase's default privileges grant every privilege on a new table to anon/authenticated/service_role,
-- so each table REVOKEs ALL first and grants back exactly what the app uses. No DELETE anywhere: a run, an
-- alert or a re-send is never erased (a failed manifest is status 'failed', not a missing row).
--
-- APPLY with the one-transaction apply script (or the Supabase MCP apply_migration) against Triply-prod
-- (shared by staging + prod), BEFORE the 6b deploy. Additive only; re-run-safe. No BEGIN/COMMIT.
SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = public;

-- direct_booking_terms -------------------------------------------------------------------------------
ALTER TABLE direct_booking_terms
  ADD COLUMN IF NOT EXISTS recipients_rev INTEGER NOT NULL DEFAULT 0 CHECK (recipients_rev >= 0);

-- direct_lot_manifest_runs ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS direct_lot_manifest_runs (
  direct_lot_id     TEXT NOT NULL CHECK (direct_lot_id ~ '^[0-9]+$'),
  -- The lot-local date the manifest is FOR (tomorrow, as seen at send time).
  manifest_date     DATE NOT NULL,
  livemode          BOOLEAN NOT NULL,
  -- sha256 hex (first 16) of the sorted, lower-cased recipient set: one manifest per set (plan D2).
  recipients_hash   TEXT NOT NULL CHECK (recipients_hash ~ '^[0-9a-f]{16}$'),
  status            TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'checked', 'failed')),
  attempt           INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  -- Lease token: every takeover / status change is a compare-and-set on it.
  claimed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- An attempt's Resend outcome was unknown at least once: it may have been delivered, so the run never
  -- moves to a new idempotency key (plan §3.4 step 3).
  had_unknown       BOOLEAN NOT NULL DEFAULT false,
  -- The list of the current send (re-checked and rewritten before every send) and every booking this run
  -- ever sent or may have sent (the follow-up cancel covers all of them).
  booking_ids       UUID[] NOT NULL,
  ids_ever          UUID[] NOT NULL,
  recipients        TEXT[] NOT NULL CHECK (cardinality(recipients) >= 1),
  test              BOOLEAN NOT NULL,
  first_sent_at     TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  email_id          TEXT,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (direct_lot_id, manifest_date, livemode, recipients_hash),
  CHECK (status NOT IN ('sent', 'checked') OR sent_at IS NOT NULL OR had_unknown)
);
CREATE INDEX IF NOT EXISTS idx_direct_lot_manifest_runs_open
  ON direct_lot_manifest_runs (livemode, manifest_date) WHERE status IN ('sending', 'sent', 'failed');

-- direct_lot_alerts ----------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS direct_lot_alerts (
  -- A PaymentIntent id (booking alerts), "{lot}:{YYYY-MM-DD}" (manifest), "{lot}:tz" / "{lot}:cms" (config),
  -- "{bookingId}:{source}" (follow-up).
  subject        TEXT NOT NULL CHECK (length(btrim(subject)) > 0),
  kind           TEXT NOT NULL CHECK (kind IN ('lot_notice', 'cancel_notice', 'manifest', 'lot_config', 'followup')),
  livemode       BOOLEAN NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL until Discord accepted an alert for it; re-alert cadence counts from here.
  alerted_at     TIMESTAMPTZ,
  -- TRP number, urgency, short reason. Never names, phones or emails (it feeds Discord).
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject, kind, livemode)
);
CREATE INDEX IF NOT EXISTS idx_direct_lot_alerts_recent ON direct_lot_alerts (livemode, last_seen_at);

-- direct_lot_resends ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS direct_lot_resends (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id                UUID NOT NULL REFERENCES bookings (id),
  stripe_payment_intent_id  TEXT NOT NULL,
  livemode                  BOOLEAN NOT NULL,
  kind                      TEXT NOT NULL CHECK (kind IN ('lot_cancel_reminder', 'customer_confirmation', 'manifest_followup_cancel')),
  -- "admin:{n}" for an admin re-send; "manifest:{lot}:{date}:{hash}" for a follow-up cancel. The UNIQUE key
  -- below is the once-only claim: a follow-up can never loop, an admin re-send never double-fires.
  source                    TEXT NOT NULL CHECK (length(btrim(source)) > 0),
  attempts                  INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_by                   TEXT NOT NULL CHECK (length(btrim(sent_by)) > 0),
  recipients                TEXT[],
  outcome                   TEXT NOT NULL DEFAULT 'sending' CHECK (outcome IN ('sending', 'sent', 'failed', 'unknown')),
  email_id                  TEXT,
  last_error                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id, kind, source)
);
CREATE INDEX IF NOT EXISTS idx_direct_lot_resends_booking ON direct_lot_resends (booking_id, created_at);

-- Privileges -----------------------------------------------------------------------------------------
ALTER TABLE direct_lot_manifest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_lot_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_lot_resends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON direct_lot_manifest_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON direct_lot_alerts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON direct_lot_resends FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON direct_lot_manifest_runs TO service_role;
GRANT SELECT, INSERT, UPDATE ON direct_lot_alerts TO service_role;
GRANT SELECT, INSERT, UPDATE ON direct_lot_resends TO service_role;

DROP TRIGGER IF EXISTS update_direct_lot_manifest_runs_updated_at ON direct_lot_manifest_runs;
CREATE TRIGGER update_direct_lot_manifest_runs_updated_at
  BEFORE UPDATE ON direct_lot_manifest_runs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_direct_lot_alerts_updated_at ON direct_lot_alerts;
CREATE TRIGGER update_direct_lot_alerts_updated_at
  BEFORE UPDATE ON direct_lot_alerts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS update_direct_lot_resends_updated_at ON direct_lot_resends;
CREATE TRIGGER update_direct_lot_resends_updated_at
  BEFORE UPDATE ON direct_lot_resends FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

NOTIFY pgrst, 'reload schema';

-- VERIFY after applying:
--   SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type)
--     FROM information_schema.role_table_grants
--    WHERE table_name IN ('direct_lot_manifest_runs','direct_lot_alerts','direct_lot_resends') GROUP BY 1, 2;
--     → service_role INSERT,SELECT,UPDATE on each; no anon / authenticated rows
--   SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname IN ('direct_lot_manifest_runs','direct_lot_alerts','direct_lot_resends');   → all true
--   SELECT column_default FROM information_schema.columns
--    WHERE table_name = 'direct_booking_terms' AND column_name = 'recipients_rev';            → 0
-- ROLLBACK (only while the three tables are empty):
--   DROP TABLE direct_lot_resends; DROP TABLE direct_lot_alerts; DROP TABLE direct_lot_manifest_runs;
--   ALTER TABLE direct_booking_terms DROP COLUMN recipients_rev;
