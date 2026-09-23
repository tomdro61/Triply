-- =============================================
-- Booking waitlist — capture demand beyond the 60-day supplier wall
-- =============================================
-- ResLab refuses any reservation whose check-in is more than 60 days out
-- (HTTP 422, see src/lib/booking-window.ts), so our date pickers are capped and
-- a traveller planning further ahead simply cannot buy. Today they get no
-- explanation and leave — and we learn nothing. These are the people worth
-- catching most: the longest-lead trips are the holiday and vacation bookings,
-- the highest-value stays, and the only demand signal that exists BEFORE the
-- supplier's own inventory system can see it. This table is that record.
--
-- opens_on = wanted_checkin - 60 days: the first day their trip falls inside
-- ResLab's window, i.e. the day we can email them and they can actually book.
-- Indexed as a partial index on opens_on alone (see
-- idx_booking_waitlist_pending_opens_on below) — the cron's select has no
-- airport_code predicate, so airport_code was dropped from the index rather
-- than kept as a non-selective leading column.
--
-- notified_at is written by GET /api/cron/waitlist-notify once the "opens
-- today" email actually sends (see that route). unsubscribed_at is set by
-- POST /api/waitlist/unsubscribe (the GET only renders a confirm page — see
-- that route's header) and excludes EVERY row for that email address, not
-- just the one the link was minted for, from all future sends.
--
-- notify_attempts / last_notify_error: a send or a notified_at write can fail
-- (bad address, transient Resend/Supabase error) — without a counter, that
-- row retries forever, once a day, consuming one of the cron's bounded slots
-- indefinitely. The cron gives up on a row once notify_attempts reaches 5
-- (see MAX_NOTIFY_ATTEMPTS in that route) and alarms once, rather than
-- silently dropping it or retrying it forever.
--
-- The unique key is (lower(email), airport_code, wanted_checkin) so a traveller
-- who submits the same trip twice does not create a second row — repeat
-- submissions are idempotent, and the API treats the unique violation as
-- success without sending a second confirmation email.

CREATE TABLE IF NOT EXISTS booking_waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  airport_code TEXT NOT NULL,
  wanted_checkin DATE NOT NULL,
  wanted_checkout DATE,
  opens_on DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  notified_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'search',
  page TEXT,
  notify_attempts INT NOT NULL DEFAULT 0,
  last_notify_error TEXT
);

-- Both columns are additive — safe to run even if the table already exists
-- from an earlier apply of this migration (e.g. pass-2, before this pass-3
-- fix added them).
ALTER TABLE booking_waitlist ADD COLUMN IF NOT EXISTS notify_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE booking_waitlist ADD COLUMN IF NOT EXISTS last_notify_error TEXT;

-- One row per traveller per airport per trip start.
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_waitlist_unique_request
  ON booking_waitlist (lower(email), airport_code, wanted_checkin);

-- The cron's actual select is `opens_on <= today AND notified_at IS NULL AND
-- unsubscribed_at IS NULL` with no airport_code predicate, so a plain
-- (airport_code, opens_on) index can't serve it (airport_code isn't a
-- selective leading column for that query). A partial index scoped to the
-- rows the cron ever looks at — still-pending, not-opted-out — stays small
-- forever even as notified/unsubscribed rows accumulate.
DROP INDEX IF EXISTS idx_booking_waitlist_airport_opens_on;
CREATE INDEX IF NOT EXISTS idx_booking_waitlist_pending_opens_on
  ON booking_waitlist (opens_on)
  WHERE notified_at IS NULL AND unsubscribed_at IS NULL;

-- The per-email send cap and unsubscribe-suppression checks in /api/waitlist
-- both do `.eq("email", email)` (email is already lowercased at insert, see
-- the zod transform in the route), not `.eq("lower(email)", ...)` — so the
-- index has to be on the plain column to be usable, not lower(email).
--
-- Same NAME as the pass-2 index, but a DIFFERENT definition (that one was
-- `(lower(email), created_at)`) — `CREATE INDEX IF NOT EXISTS` is a no-op
-- against an index that already exists under this name, so anywhere pass-2
-- already ran, this would silently keep the lower(email) index and leave
-- every one of these lookups doing a sequential scan. Drop by name first so
-- the new definition actually replaces it.
DROP INDEX IF EXISTS idx_booking_waitlist_email_created_at;
CREATE INDEX IF NOT EXISTS idx_booking_waitlist_email_created_at
  ON booking_waitlist (email, created_at);

-- =============================================
-- RLS — service role only (pattern from migrations 019/020)
-- =============================================
-- Every write goes through createAdminClient() in src/app/api/waitlist/route.ts
-- (service role, which bypasses RLS). There is no browser/anon read or write, so
-- the policy is scoped TO service_role rather than left permissive to {public} —
-- this is a list of customer email addresses plus their travel dates, and an
-- untargeted policy would expose the whole table via the public anon key.

ALTER TABLE booking_waitlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage booking waitlist" ON booking_waitlist;
CREATE POLICY "Service role can manage booking waitlist"
  ON booking_waitlist FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- =============================================
-- Runbook — re-subscribing an address (no admin UI, no route: see review
-- pass 3, item 9)
-- =============================================
-- POST /api/waitlist/unsubscribe is a permanent, address-level opt-out with
-- no self-serve way back in — by design, the same HMAC token that proves
-- "the sender minted this link" says nothing about the CURRENT date, so it
-- can't double as a signed "re-subscribe me" link without either expiring
-- (defeating List-Unsubscribe, which must keep working indefinitely per
-- RFC 8058) or being replayable forever to re-subscribe someone who meant to
-- stay out. Scoping this to sends only (rather than a hard delete) was also
-- ruled out: /api/waitlist's fail-closed history check reads unsubscribed_at
-- specifically to refuse resurrecting a suppressed address (see that route),
-- so "soft" would need its own new flag anyway. Support runs this by hand,
-- with the customer's email confirmed some other way (reply-to on the
-- original support thread, etc.) — never from the unsubscribe link itself:
--
--   UPDATE booking_waitlist
--   SET unsubscribed_at = NULL
--   WHERE lower(email) = lower('customer@example.com');
--
-- To check the current state instead of changing it:
--
--   SELECT id, airport_code, wanted_checkin, unsubscribed_at
--   FROM booking_waitlist
--   WHERE lower(email) = lower('customer@example.com');

-- PostgREST caches the schema; without this, inserts/selects against this new
-- table 404 as PGRST205 ("table not found in schema cache") until the cache
-- reloads on its own (pattern from 023).
NOTIFY pgrst, 'reload schema';
