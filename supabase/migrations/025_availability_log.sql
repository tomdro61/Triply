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
-- The logger also drops any single row that would violate a CHECK below before
-- inserting (rowIsInsertable): Postgres rejects a multi-row INSERT as a whole,
-- and a replayed stale URL with a past check-in must cost one row, not the
-- whole search's observations.
--
-- ENV SCOPING
-- Runtime preview/staging deployments (not just `next build`) also render the
-- airport pages via ISR and would otherwise write rows indistinguishable from
-- production traffic. Every row carries `env` and availability_daily below only
-- aggregates 'production' rows. `env` is NEXT_PUBLIC_APP_ENV when set
-- (production | development | staging), else Vercel's own VERCEL_ENV
-- (production | preview | development), else 'unknown' — so a missing project
-- variable cannot tag production rows 'unknown' and silently empty the rollup.
-- availability_writer_health (below) is NOT env-filtered, precisely so an empty
-- rollup can be told apart from a writer that stopped.
--
-- UNKNOWNS ARE OBSERVATIONS
-- A lot whose pricing call failed is logged with sold_out NULL (and NULL price),
-- not skipped: during a ResLab pricing degradation a 1-of-12 sample must not
-- read like a 12-of-12 census. The rollup computes pct_sold_out over lots_known
-- (sold_out IS NOT NULL) and exposes lots_unknown, so the ad gate can see how
-- much of an airport it actually knows about.
--
-- VOLUME
-- One row per lot per origin search (priced or not). /api/search is CDN-cached
-- 300s, so origin searches are far fewer than page views. If this ever needs
-- throttling, sample in the logger (there is a marked spot) rather than adding
-- triggers here.

CREATE TABLE IF NOT EXISTS availability_log (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Transaction timestamp: every row of one search's multi-row INSERT shares
  -- it, kept for the time-series index below. count(DISTINCT search_id) — not
  -- count(DISTINCT searched_at) — is what the view counts as origin searches,
  -- since search_id is unique per call even if a retry ever produces two
  -- transactions with the same timestamp.
  searched_at         timestamptz NOT NULL DEFAULT now(),
  -- One id per logAvailability() call (one crypto.randomUUID() per search),
  -- shared by every row that search writes.
  search_id           uuid        NOT NULL,
  -- See ENV SCOPING above. Every build of every branch and every
  -- preview/staging deployment writes here too — this is what lets the read
  -- side scope to real production traffic only.
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
  -- a lot from search results. NULL when ResLab omitted it or the lot's pricing
  -- call failed: "we don't know" is honest where a fabricated `false` is not.
  sold_out            boolean     NULL,
  -- ResLab reservation.available_spots. NULL when ResLab omitted it.
  available_spots     int         NULL,
  -- reservation.grand_total in cents, NULL when the lot did not price (or
  -- priced at <= 0, which the site also hides).
  grand_total_cents   int         NULL,
  source              text        NOT NULL
    CHECK (source IN ('search', 'chat', 'airport-page')),
  -- Mirrored in rowIsInsertable() in the logger: keep the two in sync.
  CHECK (lead_days >= -1),
  CHECK (stay_days >= 0)
);

-- CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists (an
-- earlier revision of this migration applied to a dev DB during review), which
-- would silently skip the stay_days CHECK above. Add it idempotently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'availability_log'::regclass
       AND conname = 'availability_log_stay_days_check'
  ) THEN
    ALTER TABLE availability_log
      ADD CONSTRAINT availability_log_stay_days_check CHECK (stay_days >= 0);
  END IF;
END $$;

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

-- The writer-health view and the retention job both range over searched_at
-- alone.
CREATE INDEX IF NOT EXISTS availability_log_searched_at_idx
  ON availability_log (searched_at);

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
-- (e.g. local/CI Supabase), and this migration must not fail there — but it
-- must not be SILENT there either. pg_cron is not enabled by default on a
-- Supabase project: if you see the WARNING below when applying to Triply-prod,
-- enable it (Dashboard → Database → Extensions → pg_cron) and re-run this
-- block, then confirm with `SELECT jobname, schedule FROM cron.job`.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'availability_log_retention',
      '0 3 * * 0', -- Sundays 03:00
      $sql$DELETE FROM availability_log WHERE searched_at < now() - interval '18 months'$sql$
    );
    RAISE NOTICE 'availability_log_retention scheduled (weekly, 18 months)';
  ELSE
    RAISE WARNING 'pg_cron is not installed: availability_log has NO retention job. Enable the extension and re-run the retention block of migration 025.';
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
-- origin_searches counts ORIGIN executions of searchParking, not customer
-- searches: /api/search is CDN-cached 300s per URL per region, so this number
-- FALLS when the cache hit-rate improves. Do not read it as demand; the
-- per-lot columns are unaffected by caching and are the point of the table.
--
-- pct_sold_out is computed over lots_known (sold_out IS NOT NULL), never over
-- lots_seen — otherwise every "we don't know" row silently counts as "not sold
-- out" and pushes the metric toward "keep spending on ads" exactly when ResLab
-- is degraded. lots_unsellable is what the site actually hid from customers:
-- sold out OR no positive price (search.ts drops both).
--
-- security_invoker so the view inherits availability_log's RLS instead of
-- running as its definer (a definer view would hand anon a read-around of the
-- service-role-only policy above, and is what Supabase's advisor flags).
-- DROP first: CREATE OR REPLACE VIEW cannot rename or reorder columns, and an
-- earlier revision of this view (column `searches`) may exist on a dev DB.
DROP VIEW IF EXISTS availability_daily;
CREATE VIEW availability_daily
WITH (security_invoker = true) AS
SELECT
  airport_code,
  check_in,
  -- Same expression as availability_log_day_airport_idx (UTC day, naive).
  date_trunc('day', searched_at AT TIME ZONE 'UTC')                       AS day,
  source,
  count(DISTINCT search_id)                                               AS origin_searches,
  count(*)                                                                AS lots_seen,
  count(*) FILTER (WHERE sold_out IS NOT NULL)                            AS lots_known,
  count(*) FILTER (WHERE sold_out IS NULL)                                AS lots_unknown,
  count(*) FILTER (WHERE sold_out)                                        AS lots_sold_out,
  count(*) FILTER (WHERE sold_out OR grand_total_cents IS NULL)           AS lots_unsellable,
  round(
    100.0 * count(*) FILTER (WHERE sold_out)
      / NULLIF(count(*) FILTER (WHERE sold_out IS NOT NULL), 0),
    1
  )                                                                       AS pct_sold_out
FROM availability_log
WHERE env = 'production'
GROUP BY airport_code, check_in, date_trunc('day', searched_at AT TIME ZONE 'UTC'), source;

-- Writer health: is anything being written at all, under which env tag, and
-- from which call site? Deliberately NOT filtered by env — this is how an
-- empty availability_daily is distinguished from a logger that stopped, or one
-- writing every row as 'unknown'/'preview' because the production deployment
-- lost its env var. Grouped by source too: "only airport-page rows" means
-- /api/search is not reaching the logger, and an env-only view would call that
-- healthy. It is also the only read that shows anything on staging.
--
-- Window is 7 days (bounded by availability_log_searched_at_idx), so a writer
-- that died three days ago still reports its last_row_at instead of vanishing;
-- rows_24h / searches_24h are the recent-activity counts within that window.
DROP VIEW IF EXISTS availability_writer_health;
CREATE VIEW availability_writer_health
WITH (security_invoker = true) AS
SELECT
  env,
  source,
  max(searched_at)                                                        AS last_row_at,
  count(*) FILTER (WHERE searched_at > now() - interval '24 hours')       AS rows_24h,
  count(DISTINCT search_id)
    FILTER (WHERE searched_at > now() - interval '24 hours')              AS searches_24h,
  count(*)                                                                AS rows_7d
FROM availability_log
WHERE searched_at > now() - interval '7 days'
GROUP BY env, source;

-- PostgREST caches the schema. Without this, every logger insert and every
-- admin read fails with PGRST205 ("Could not find the table … in the schema
-- cache") until the cache reloads on its own — during exactly the window the
-- post-apply verification query runs. Same as 023.
NOTIFY pgrst, 'reload schema';

-- Post-apply checklist (Triply-prod, SQL editor):
--   SELECT jobname, schedule FROM cron.job;                      -- retention present?
--   SELECT * FROM availability_writer_health;                    -- within 1h of deploy
-- Expect (production, search) and (production, airport-page) rows. Only
-- 'unknown' or 'preview' → the production deployment's env var is wrong. Only
-- airport-page → /api/search is not reaching the logger. Nothing at all →
-- kill switch, insert failures (Sentry availability_log.insert), or rows
-- being dropped by the insertability guard (Sentry availability_log.guard).
-- Deploy order: apply this migration BEFORE the code that reads the new view
-- columns ships — the admin route 500s (correctly) on an old-shape view.
