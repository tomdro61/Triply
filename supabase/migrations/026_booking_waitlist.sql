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

-- The send query: "which waitlisted trips open today, at which airport?"
CREATE INDEX IF NOT EXISTS idx_booking_waitlist_airport_opens_on
  ON booking_waitlist (airport_code, opens_on);

-- The per-email send cap in /api/waitlist ("how many confirmations has this
-- address triggered in the last 24h?") — without this it's a sequential scan
-- of the whole table on every submission.
CREATE INDEX IF NOT EXISTS idx_booking_waitlist_email_created_at
  ON booking_waitlist (lower(email), created_at);

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
