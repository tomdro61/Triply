-- Migration 027: search_events — the per-search HEADER row
--
-- WHY THIS EXISTS
-- We have never measured stay-length or lead-time demand. Every search
-- computes checkin/checkout and therefore stay length and lead time, and
-- throws them away once the response is sent. This writes them down so that
-- question is finally answerable ("how far out do JFK searchers book, and for
-- how many days?") without waiting for a booking to happen — most searches
-- never convert, so the search itself is the only record of that intent.
--
-- DESIGN: ONE HEADER ROW PER SEARCH, JOINED TO availability_log
-- This table was originally a route-handler-only insert with its own
-- disconnected id, UTC-day lead_days, and no env tag — a shape that could
-- never be reconciled with availability_log (migration 025, hardened in a
-- follow-up) once both existed. It is now written from the SAME place
-- (searchParking, src/lib/reslab/search.ts), on the SAME call, sharing:
--   - search_id: the identifier searchParking generates once per search and
--     passes to both loggers. `SELECT * FROM search_events se JOIN
--     availability_log al USING (search_id)` is how a header joins to its
--     own per-lot rows (one search_events row : N availability_log rows,
--     one per lot near the airport).
--   - env: identical resolveEnv() rule as availability_log — see 025 for the
--     full ENV SCOPING rationale. A missing/blank env here would silently
--     mix dev/preview traffic into a "production" read.
--   - lead_days: localToday(airport.timezone), NOT UTC "today" — a 9pm
--     Eastern search is already "tomorrow" in UTC, which under-counted
--     lead_days by a day for every US evening search in the original design.
--   - source: the same call-site enum as availability_log.source
--     ('search' | 'chat' | 'airport-page'), plus 'homepage-featured' for the
--     homepage's automated featured-parking widget (see below) — a
--     distinction search_events needs that availability_log does not, so it
--     is NOT added to availability_log's own CHECK.
--
-- ONE ROW PER ORIGIN SEARCH, NOT PER CUSTOMER SEARCH
-- /api/search is CDN-cached (s-maxage=300 for a clean result, 60s for a stale
-- one). This table is written once per searchParking() CALL, i.e. once per
-- CDN MISS — not once per person who typed dates and hit search. A popular
-- airport/date combination is therefore systematically UNDER-represented
-- relative to a rare one, in proportion to its cache hit rate. Read
-- results_count/lead_days/stay_days distributions with that in mind; do not
-- read origin-search volume as customer-search volume (same caveat as
-- availability_daily.origin_searches in 025).
--
-- dates_defaulted / homepage-featured — DO NOT COUNT THESE AS TYPED DATES
-- /api/search defaults checkin/checkout to tomorrow/+7 when the caller omits
-- them (a pricing-only estimate — see route.ts). `dates_defaulted` is true
-- for those rows: without it, that fallback becomes the mode of the
-- stay/lead-time distribution, indistinguishable from someone who actually
-- chose a 7-night trip starting tomorrow.
-- Separately, the homepage's FeaturedParking widget (src/components/shared/
-- featured-parking.tsx) fires a REAL /api/search request, with EXPLICIT
-- tomorrow/+7 dates (so dates_defaulted is false for it), on every homepage
-- view and every airport-tab click — a fixed background poll, not a person
-- choosing dates. It is tagged source = 'homepage-featured' so it can be
-- excluded from demand reads the same way availability_daily already
-- excludes 'airport-page' by default.
--
-- BEST-EFFORT WRITE
-- The logger (src/lib/search-events/log.ts) is fire-and-forget and swallows
-- every error, including PGRST205 (this table not found — pre-migration) and
-- PGRST204 (an unknown column — a later schema drift), reporting to Sentry at
-- most once per process-hour (see search_events_writer_health below for how
-- to notice a dead writer). Nothing on the search response path awaits this
-- insert; a failure here must never cost a search. See migration 025
-- (availability_log) for the identical pattern.
--
-- DEGRADED RESULTS ARE NOT CLEAN OBSERVATIONS
-- `degraded`/`stale` mirror SearchParkingResult.degraded/.stale. A degraded
-- result (partial ResLab pricing failure, or a thin location-list build)
-- logs cheapest_price_cents as NULL, never a "cheapest" computed from
-- whatever survived the outage — and because a degraded/empty result is
-- served no-store, degraded searches are systematically OVER-represented in
-- this table relative to their real share of traffic (the same result gets
-- re-originated on every request instead of being absorbed by the CDN).
--
-- ATTRIBUTION / JOIN KEY
-- utm_source/utm_medium/utm_campaign and ga_client_id mirror the first-touch
-- fields the `triply_attr` cookie already carries onto bookings (migration
-- 023, src/lib/attribution/schema.ts Touch.src/med/cmp) so a search row can
-- later be joined to a booking by (ga_client_id) or by (airport_code, dates,
-- attribution) as a fuzzy fallback. Named utm_* (not source/medium/campaign)
-- specifically so `source` unambiguously means CALL SITE here, matching
-- availability_log — the original column names collided with that meaning.
-- No PII: no raw IP, no email, no cookie value beyond the already-
-- first-party-scoped UTM/click fields.
--
-- RETENTION
-- Tom scrubs attribution data at 26 months elsewhere in the stack (see the
-- attribution cookie's own retention policy); this table carries the same
-- fields, so it is scrubbed on the same 26-month schedule below, guarded for
-- environments without pg_cron (local/CI Supabase) the same way 025 is.
--
-- DEPLOY CONSTRAINT — READ BEFORE APPLYING
-- This migration is self-contained and idempotent (CREATE ... IF NOT EXISTS/
-- OR REPLACE throughout; safe to re-run). It DEPENDS ON migration 025
-- (availability_log) only insofar as the code that writes both tables
-- (searchParking) is one unit — there is no SQL-level foreign key, so 027 can
-- be applied independently of 025's presence. Supabase migrations in this
-- project are applied BY HAND (see scripts/apply-migration-023.ts-style
-- tooling and CLAUDE.md); apply this ONE STATEMENT/BLOCK AT A TIME against
-- Triply-prod (SQL editor) BEFORE the branch carrying the code that calls
-- logSearchEvent() is deployed, exactly as 025's own header warns for
-- availability_log — deploying the code first just means every insert
-- 404s as PGRST205 until this is applied (silently, by contract; see
-- search_events_writer_health to confirm the writer is healthy afterward).

CREATE TABLE IF NOT EXISTS search_events (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Shared with the availability_log rows this same search wrote (see
  -- DESIGN above) — the join key. One search_events row per search_id.
  search_id             uuid        NOT NULL,
  -- See ENV SCOPING in migration 025; identical rule (resolveEnv()).
  env                   text        NOT NULL DEFAULT 'unknown',
  -- ResLab lookup always uppercases; the raw query string does not
  -- (?airport=jfk). Enforce here so a lowercase row can never slip in and
  -- silently split one airport's demand across two GROUP BY buckets.
  airport_code          text        NOT NULL CHECK (airport_code = upper(airport_code)),
  check_in              date        NOT NULL,
  check_out             date        NOT NULL,
  stay_days             int         NOT NULL,
  -- From localToday(airport.timezone) — see DESIGN above. Matches
  -- availability_log's own CHECK bound.
  lead_days             int         NOT NULL,
  -- True when checkin/checkout were NOT supplied by the caller and the route
  -- substituted its tomorrow/+7 pricing-estimate fallback. See DESIGN above.
  dates_defaulted       boolean     NOT NULL DEFAULT false,
  results_count         int         NOT NULL DEFAULT 0,
  -- Cheapest grand_total across the priced, non-degraded results, in cents.
  -- NULL when nothing priced OR the result is degraded (see DESIGN above) —
  -- never a fabricated 0 and never a "cheapest" from a partial response.
  cheapest_price_cents  int         NULL,
  -- Count of lots ResLab reported sold_out = true for this search, computed
  -- from the same per-lot pricing pass availability_log's rows are built
  -- from (src/lib/reslab/search.ts). NULL when nothing priced.
  sold_out_count        int         NULL,
  -- Mirrors SearchParkingResult.degraded/.stale — see DESIGN above.
  degraded              boolean     NOT NULL DEFAULT false,
  stale                 boolean     NOT NULL DEFAULT false,
  -- Call site. Same three values as availability_log.source, plus
  -- 'homepage-featured' — see DESIGN above for why that value exists only
  -- here and not on availability_log.
  source                text        NOT NULL
    CHECK (source IN ('search', 'chat', 'airport-page', 'homepage-featured')),
  -- First-touch attribution, mirrored from the triply_attr cookie
  -- (src/lib/attribution/schema.ts Touch). Nullable: absent for a
  -- pre-cookie/no-JS/bot search, or any call site with no Request to read a
  -- cookie from (chat, airport-page), same as bookings.attribution.
  utm_source            text        NULL,
  utm_medium            text        NULL,
  utm_campaign          text        NULL,
  ga_client_id          text        NULL,
  -- Mirrored in the logger's contract (a bad value here means the whole
  -- header row is dropped, not silently coerced): keep the two in sync.
  CHECK (stay_days >= 0),
  CHECK (lead_days >= -1)
);

-- CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists (an
-- earlier revision of this migration applied to a dev DB during review), which
-- would silently skip a CHECK added since. Add the ones introduced by this
-- revision (lead_days, airport_code) idempotently — mirrors 025's own pattern.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'search_events'::regclass
       AND conname = 'search_events_lead_days_check'
  ) THEN
    ALTER TABLE search_events
      ADD CONSTRAINT search_events_lead_days_check CHECK (lead_days >= -1);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'search_events'::regclass
       AND conname = 'search_events_airport_code_upper_check'
  ) THEN
    ALTER TABLE search_events
      ADD CONSTRAINT search_events_airport_code_upper_check
      CHECK (airport_code = upper(airport_code));
  END IF;
END $$;

-- The join to availability_log — "what did the lots near this search look
-- like" — is the primary reason search_id is NOT NULL.
CREATE INDEX IF NOT EXISTS idx_search_events_search_id
  ON search_events (search_id);

-- "how did <airport> trend over time" — the primary demand read.
CREATE INDEX IF NOT EXISTS idx_search_events_airport_created_at
  ON search_events (airport_code, created_at);

-- "how many searches, any airport, in this window" — the volume read.
CREATE INDEX IF NOT EXISTS idx_search_events_created_at
  ON search_events (created_at);

-- The stated join key to a booking (see ATTRIBUTION / JOIN KEY above).
-- Partial: most rows have no GA client id (pre-cookie/no-JS/bot/opted-out),
-- and this index only needs to serve the ones that do.
CREATE INDEX IF NOT EXISTS idx_search_events_ga_client_id
  ON search_events (ga_client_id) WHERE ga_client_id IS NOT NULL;

-- =============================================
-- RLS — service role only (pattern from migrations 019/020/025/026)
-- =============================================
-- Every write goes through createAdminClient() in src/lib/search-events/log.ts
-- (service role, which bypasses RLS). There is no browser/anon read or write,
-- so the policy is scoped TO service_role rather than left permissive.

ALTER TABLE search_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage search events" ON search_events;
CREATE POLICY "Service role can manage search events"
  ON search_events FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- Retention: scrub at 26 months, matching Tom's attribution-data retention
-- policy elsewhere in the stack. pg_cron is not available on every Postgres
-- instance (e.g. local/CI Supabase), and this migration must not fail there
-- — but it must not be SILENT there either (same reasoning as 025).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'search_events_retention',
      '0 4 * * 0', -- Sundays 04:00
      $sql$DELETE FROM search_events WHERE created_at < now() - interval '26 months'$sql$
    );
    RAISE NOTICE 'search_events_retention scheduled (weekly, 26 months)';
  ELSE
    RAISE WARNING 'pg_cron is not installed: search_events has NO retention job. Enable the extension and re-run the retention block of migration 027.';
  END IF;
END $$;

-- Writer health: is anything being written at all, under which env tag, and
-- from which call site? Deliberately NOT filtered by env — this is how an
-- empty table is distinguished from a logger that stopped, or one writing
-- every row as 'unknown'/'preview' because the production deployment lost
-- its env var. Mirrors availability_writer_health in 025 exactly, including
-- the 7-day window and security_invoker so the view inherits this table's
-- RLS instead of running as its definer.
DROP VIEW IF EXISTS search_events_writer_health;
CREATE VIEW search_events_writer_health
WITH (security_invoker = true) AS
SELECT
  env,
  source,
  max(created_at)                                                        AS last_row_at,
  count(*) FILTER (WHERE created_at > now() - interval '24 hours')       AS rows_24h,
  count(*)                                                               AS rows_7d
FROM search_events
WHERE created_at > now() - interval '7 days'
GROUP BY env, source;

-- PostgREST caches the schema; without this, inserts against this table
-- 404 as PGRST205 ("table not found in schema cache") until the cache reloads
-- on its own (pattern from 023/025/026).
NOTIFY pgrst, 'reload schema';

-- Post-apply checklist (Triply-prod, SQL editor):
--   SELECT jobname, schedule FROM cron.job;                        -- retention present?
--   SELECT * FROM search_events_writer_health;                     -- within 1h of deploy
-- Expect (production, search), (production, chat), (production, airport-page)
-- and (production, homepage-featured) rows. Only 'unknown'/'preview' → the
-- production deployment's env var is wrong. Nothing at all → kill switch
-- (SEARCH_EVENTS_LOG_DISABLED), insert failures (Sentry
-- search_events.insert), or migration 027 not applied yet (PGRST205 in the
-- console, swallowed by contract — this view is the only way to notice).
