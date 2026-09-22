-- Migration 027: search_events — one row per airport-parking search
--
-- WHY THIS EXISTS
-- We have never measured stay-length or lead-time demand. Every search
-- computes checkin/checkout and therefore stay length and lead time, and
-- throws them away once the response is sent. This writes them down so that
-- question is finally answerable ("how far out do JFK searchers book, and for
-- how many days?") without waiting for a booking to happen — most searches
-- never convert, so the search itself is the only record of that intent.
--
-- BEST-EFFORT WRITE
-- The logger (src/lib/search-events/log.ts) is fire-and-forget and swallows
-- every error, including PGRST205 (this table not found — pre-migration) and
-- PGRST204 (an unknown column — a later schema drift). Nothing on the search
-- response path awaits this insert; a failure here must never cost a search.
-- See migration 025 (availability_log) for the same pattern.
--
-- ATTRIBUTION / JOIN KEY
-- source/medium/campaign and ga_client_id mirror the first-touch fields the
-- `triply_attr` cookie already carries onto bookings (migration 023,
-- src/lib/attribution/schema.ts Touch.src/med/cmp) so a search row can later
-- be joined to a booking by (ga_client_id) or by (airport_code, dates,
-- attribution) as a fuzzy fallback. No PII: no raw IP, no email, no cookie
-- value beyond the already-first-party-scoped UTM/click fields.
--
-- RETENTION
-- Tom scrubs attribution data at 26 months elsewhere in the stack (see the
-- attribution cookie's own retention policy); this table carries the same
-- fields, so it is scrubbed on the same 26-month schedule below, guarded for
-- environments without pg_cron (local/CI Supabase) the same way 025 is.

CREATE TABLE IF NOT EXISTS search_events (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  airport_code          text        NOT NULL,
  check_in              date        NOT NULL,
  check_out             date        NOT NULL,
  -- Derived in the app (src/lib/search-events/derive.ts) from check_in/
  -- check_out and the search timestamp — stored, not generated, because
  -- lead_days needs "today" at search time, which Postgres GENERATED columns
  -- (immutable-only) cannot express.
  stay_days             int         NOT NULL,
  lead_days             int         NOT NULL,
  results_count         int         NOT NULL DEFAULT 0,
  -- Cheapest grand_total across the priced results, in cents. NULL when
  -- nothing priced (empty/degraded result) rather than a fabricated 0.
  cheapest_price_cents  int         NULL,
  -- Reserved for when searchParking() exposes a cheap sold-out count at the
  -- route level (today it only returns the AVAILABLE lots — see
  -- src/lib/reslab/search.ts availableLots). NULL, not 0, until populated.
  sold_out_count        int         NULL,
  -- First-touch attribution, mirrored from the triply_attr cookie
  -- (src/lib/attribution/schema.ts Touch). Nullable: absent for a
  -- pre-cookie/no-JS/bot search, same as bookings.attribution.
  source                text        NULL,
  medium                text        NULL,
  campaign              text        NULL,
  ga_client_id          text        NULL,
  CHECK (stay_days >= 0)
);

-- "how did <airport> trend over time" — the primary read.
CREATE INDEX IF NOT EXISTS idx_search_events_airport_created_at
  ON search_events (airport_code, created_at);

-- "how many searches, any airport, in this window" — the volume read.
CREATE INDEX IF NOT EXISTS idx_search_events_created_at
  ON search_events (created_at);

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
-- instance (e.g. local/CI Supabase), and this migration must not fail there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'search_events_retention',
      '0 4 * * 0', -- Sundays 04:00
      $sql$DELETE FROM search_events WHERE created_at < now() - interval '26 months'$sql$
    );
  END IF;
END $$;

-- PostgREST caches the schema; without this, inserts against this new table
-- 404 as PGRST205 ("table not found in schema cache") until the cache reloads
-- on its own (pattern from 023/025/026).
NOTIFY pgrst, 'reload schema';
