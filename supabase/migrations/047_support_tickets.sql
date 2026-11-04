-- Migration 047: support_tickets — every /contact and /partners submission
-- becomes a ticket the team works from /admin/support.
--
-- APPLY with the one-transaction apply script (or the Supabase MCP
-- apply_migration) against Triply-prod (shared by staging + prod), BEFORE
-- setting ENABLE_SUPPORT_INBOX=true. Additive: one new table, no change to any
-- existing table. Re-run-safe (IF NOT EXISTS throughout). No BEGIN/COMMIT.
--
-- With the flag off, /api/contact behaves exactly as before and never touches
-- this table. With it on, a failed insert (e.g. the migration was skipped) is
-- reported to Sentry and the submission still goes out by email — a message is
-- never lost to the ticket store.
--
-- Writes come only from the server (service_role): the public route inserts,
-- the admin API (ADMIN_EMAILS-gated) reads and updates. No DELETE: a ticket is
-- closed ('done'), never removed.
--
-- ROLLBACK (drops every ticket — export first if any matter):
--   DROP TABLE IF EXISTS support_tickets;

SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = public;

CREATE TABLE IF NOT EXISTS support_tickets (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The short number the customer sees ("Triply #1042") and replies quote.
  ticket_number      BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 1001) UNIQUE,

  -- What was submitted (escaped at render time, stored as typed).
  name               TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  email              TEXT NOT NULL CHECK (length(btrim(email)) > 0),
  subject            TEXT NOT NULL CHECK (length(btrim(subject)) > 0),
  message            TEXT NOT NULL,
  -- Normalised (upper-case, no spaces/#) as typed; NULL when none was given.
  reservation_number TEXT,

  -- The booking, ONLY when the reservation number exists AND its customer
  -- email equals the submitter's (case-insensitive). booking_match records why
  -- it is NULL otherwise, so the team can tell "typo" from "someone else's".
  -- SET NULL: deleting a booking (or test fixture) keeps the ticket, drops the link.
  booking_id         UUID REFERENCES bookings (id) ON DELETE SET NULL,
  -- 'lookup_failed' = the DB read errored; the number was given but not checked.
  booking_match      TEXT NOT NULL DEFAULT 'none'
                       CHECK (booking_match IN ('matched', 'email_mismatch', 'not_found', 'lookup_failed', 'none')),

  -- Rule-based triage (src/lib/support/triage.ts) — no AI involved.
  priority           TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent', 'high', 'normal')),
  -- Sort key for the inbox (urgent first) so ordering + paging stay in SQL.
  priority_rank      SMALLINT GENERATED ALWAYS AS (
                       CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END
                     ) STORED,
  reasons            TEXT[] NOT NULL DEFAULT '{}',
  auto_reply_kind    TEXT NOT NULL,
  auto_reply_sent    BOOLEAN NOT NULL DEFAULT false,
  -- NULL until a Discord alert was accepted (urgent tickets only).
  alerted_at         TIMESTAMPTZ,

  -- Workflow.
  status             TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'open', 'waiting', 'done')),
  assigned_to        TEXT,
  first_response_at  TIMESTAMPTZ,
  resolved_at        TIMESTAMPTZ,
  notes              TEXT NOT NULL DEFAULT '',

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_queue ON support_tickets (status, priority_rank, created_at);
CREATE INDEX IF NOT EXISTS idx_support_tickets_booking ON support_tickets (booking_id) WHERE booking_id IS NOT NULL;

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON support_tickets FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON support_tickets TO service_role;
