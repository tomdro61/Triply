-- Migration 025: availability_log — record which airports sell out, and when
--
-- WHY THIS EXISTS
-- Every parking search already computes the sold-out signal and then throws it
-- away. searchParking() (src/lib/reslab/search.ts) calls ResLab getMinPrice per
-- lot, reads reservation.sold_out / available_spots, and immediately FILTERS the
-- unavailable lots out of the response. Nothing persists it. ResLab exposes no
-- history endpoint, so this cannot be backfilled: a day we did not record is a
-- day we can never know about. That is the whole argument for writing it down
-- now, cheaply, before we know exactly how we'll use it.
--
-- WHAT IT FEEDS
--   1. the sold-out ad gate — stop paying for clicks into an airport/date where
--      we have nothing left to sell, and bid up the ones where we do;
--   2. the "book by" calendar — "LAS was >50% sold out 18 days ahead last
--      Thanksgiving" is an evidence-backed urgency claim, not a growth-hack
--      banner, and it is only sayable if we logged last Thanksgiving;
--   3. the sold-out alert — email the customer when the date they searched is
--      filling up.
--
-- BEST-EFFORT WRITE
-- The logger (src/lib/availability/log.ts) is fire-and-forget and swallows every
-- error, including "relation does not exist" and "column does not exist". The
-- site therefore works identically BEFORE this migration is applied, and keeps
-- working if the table is later dropped or altered. Nothing on the customer path
-- awaits this insert; a failure here must never cost a search. It is also a
-- no-op during `next build` (NEXT_PHASE=phase-production-build) — the airport
-- pages are prerendered via generateStaticParams and every Vercel build of
-- every branch, including previews, has the service-role key injected, so
-- without that guard every build would write rows.
--
-- ENV SCOPING
-- Runtime preview/staging deployments (not just `next build`) also render the
-- airport pages via ISR and would otherwise write rows indistinguishable from
-- production traffic. Every row carries `env` (from NEXT_PUBLIC_APP_ENV) and
-- availability_daily below only aggregates 'production' rows.
--
-- VOLUME
-- One row per priced lot per search. /api/search is CDN-cached 300s, so origin
-- searches are far fewer than page views. If this ever needs throttling, sample
-- in the logger (there is a marked spot) rather than adding triggers here.

CREATE TABLE IF NOT EXISTS availability_log (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Transaction timestamp: every row of one search's multi-row INSERT shares
  -- it, kept for the time-series index below. count(DISTINCT search_id) — not
  -- count(DISTINCT searched_at) — is what the view counts as "searches", since
  -- search_id is unique per call even if a retry ever produces two
  -- transactions with the same timestamp.
  searched_at         timestamptz NOT NULL DEFAULT now(),
  -- One id per logAvailability() call (one crypto.randomUUID() per search),
  -- shared by every row that search writes.
  search_id           uuid        NOT NULL,
  -- development | staging | production, from NEXT_PUBLIC_APP_ENV. Every build
  -- of every branch and every preview/staging deployment writes here too —
  -- this is what lets the read side scope to real production traffic only.
  env                 text        NOT NULL DEFAULT 'unknown',
  airport_code        text        NOT NULL,
  check_in            date        NOT NULL,
  check_out           date        NOT NULL,
  -- check_in minus the search date in the airport's own local timezone.
  -- Precomputed so "how far ahead does this airport sell out?" is a GROUP BY,
  -- not a per-row date subtraction.
  lead_days           int         NOT NULL,
  stay_days           int         NOT NULL,
  reslab_location_id  int         NOT NULL,
  -- ResLab reservation.sold_out — the exact flag the site acts on when it drops
  -- a lot from search results. Nullable: ResLab omits it on some responses, and
  -- a NULL is honest where a fabricated `false` is not.
  sold_out            boolean     NULL,
  -- ResLab reservation.available_spots. NULL when ResLab omitted it.
  available_spots     int         NULL,
  -- reservation.grand_total in cents, NULL when the lot did not price.
  grand_total_cents   int         NULL,
  source              text        NOT NULL
    CHECK (source IN ('search', 'chat', 'airport-page')),
  CHECK (lead_days >= -1)
);

-- "what did <airport> look like over the last N days" — the time-series read.
CREATE INDEX IF NOT EXISTS availability_log_airport_searched_idx
  ON availability_log (airport_code, searched_at);

-- "what does <airport> look like for <travel date>" — the ad-gate / calendar read.
CREATE INDEX IF NOT EXISTS availability_log_airport_checkin_idx
  ON availability_log (airport_code, check_in);

-- Matches the availability_daily view's day expression + airport_code so the
-- read path (route filters `.gte("day", …)`) can use an index instead of
-- scanning every row every request. `searched_at AT TIME ZONE 'UTC'` is
-- deliberate: date_trunc on a timestamptz depends on the session timezone and
-- is therefore STABLE, not IMMUTABLE, and Postgres refuses it in an index
-- expression. Converting to a UTC-naive timestamp first makes it immutable;
-- the view below uses the identical expression so the planner can match it.
CREATE INDEX IF NOT EXISTS availability_log_day_airport_idx
  ON availability_log (date_trunc('day', searched_at AT TIME ZONE 'UTC'), airport_code);

-- RLS: service-role only, following 019/020. This table is pure internal
-- telemetry — nothing in the browser reads or writes it, and the logger and the
-- admin route both go through createAdminClient() (service role bypasses RLS).
-- Writing the policy TO service_role rather than leaving it permissive keeps
-- the whole class of "misnamed permissive policy" bugs 018–020 closed out.
ALTER TABLE availability_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage availability log" ON availability_log;
CREATE POLICY "Service role can manage availability log"
  ON availability_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Retention: this is high-volume telemetry, not a booking record — keep 18
-- months (covers two Thanksgivings/Christmases for the "book by" calendar) and
-- drop the rest. Guarded: pg_cron is not available on every Postgres instance
-- (e.g. local/CI Supabase), and this migration must not fail there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'availability_log_retention',
      '0 3 * * 0', -- Sundays 03:00
      $sql$DELETE FROM availability_log WHERE searched_at < now() - interval '18 months'$sql$
    );
  END IF;
END $$;

-- Daily rollup so "which airports were >50% sold out for which dates" is one
-- SELECT instead of a hand-rolled aggregate at every call site:
--
--   SELECT * FROM availability_daily
--    WHERE pct_sold_out > 50 AND check_in BETWEEN ... ORDER BY check_in;
--
-- Grouped by source too: an airport-page row is a fixed +1d/+8d ISR render
-- that happens on a schedule whether or not anyone visits, and dominates
-- count(*) if it isn't kept separate from real search/chat demand — the route
-- defaults to search+chat only and callers opt into airport-page explicitly.
--
-- Scoped to env = 'production': every build of every branch, and every
-- preview/staging ISR render, also writes rows (see the ENV SCOPING note
-- above) — this view must not count them as real traffic.
--
-- security_invoker so the view inherits availability_log's RLS instead of
-- running as its definer (a definer view would hand anon a read-around of the
-- service-role-only policy above, and is what Supabase's advisor flags).
CREATE OR REPLACE VIEW availability_daily
WITH (security_invoker = true) AS
SELECT
  airport_code,
  check_in,
  -- Same expression as availability_log_day_airport_idx (UTC day, naive).
  date_trunc('day', searched_at AT TIME ZONE 'UTC')    AS day,
  source,
  count(DISTINCT search_id)                            AS searches,
  count(*)                                              AS lots_seen,
  count(*) FILTER (WHERE sold_out)                      AS lots_sold_out,
  round(
    100.0 * count(*) FILTER (WHERE sold_out) / NULLIF(count(*), 0),
    1
  )                                                     AS pct_sold_out
FROM availability_log
WHERE env = 'production'
GROUP BY airport_code, check_in, date_trunc('day', searched_at AT TIME ZONE 'UTC'), source;
