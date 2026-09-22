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
-- Indexed with airport_code so a future job can ask "who opens today?".
--
-- notified_at is written by GET /api/cron/waitlist-notify once the "opens
-- today" email actually sends (see that route). unsubscribed_at is set by
-- GET /api/waitlist/unsubscribe and excludes a row from that send.
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
  page TEXT
);

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

-- PostgREST caches the schema; without this, inserts/selects against this new
-- table 404 as PGRST205 ("table not found in schema cache") until the cache
-- reloads on its own (pattern from 023).
NOTIFY pgrst, 'reload schema';
