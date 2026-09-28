-- 028: shared ResLab location-list snapshot (plan: notes/2026-09-27-reslab-location-snapshot-plan-v3.md)
--
-- ONE row per {environment, ResLab account} holding the whole verified-complete
-- location list, gzip+base64. Written ONLY by /api/cron/refresh-reslab-locations
-- (Production). Read by every cold instance before it sweeps ResLab's 40 pages.
--
-- 2026-08-10 measurement, kept here so nobody "simplifies" the plausibility check:
--   last_page 54 · total 533 · rows fetched 533 · UNIQUE 381
-- ResLab repeats ids across pages. The writer compares rows_fetched (PRE-dedupe)
-- to paginator_total. NEVER compare location_count to paginator_total — that
-- would reject every healthy snapshot and take search down site-wide.

CREATE TABLE IF NOT EXISTS reslab_location_snapshot (
  env_key          TEXT PRIMARY KEY,          -- `${env}:${sha256(RESLAB_API_KEY) prefix}`
  key_fingerprint  TEXT NOT NULL,             -- the same prefix; the reader re-checks it
  schema_version   INT  NOT NULL,             -- bump on ANY change to what is stored
  -- TIMESTAMPTZ is CORRECT here: a real instant (sweep start), not a booking wall-clock time.
  built_at         TIMESTAMPTZ NOT NULL CHECK (built_at <= now() + interval '5 minutes'),
  rows_fetched     INT NOT NULL,              -- pre-dedupe
  location_count   INT NOT NULL CHECK (location_count >= 100),
  paginator_total  INT NOT NULL,
  payload_gzip_b64 TEXT NOT NULL,
  written_by       TEXT NOT NULL CHECK (written_by IN ('cron')),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (rows_fetched >= location_count)
);

-- Additive so a re-run (or a DB where an earlier draft of 028 ran) cannot
-- silently skip these — a missing wire_bytes makes every metadata read 42703.
-- Stored so the admin page / heartbeat / cron can read the size WITHOUT
-- downloading the payload (Supabase egress is this project's most expensive
-- recurring incident; the spend cap is off).
ALTER TABLE reslab_location_snapshot
  ADD COLUMN IF NOT EXISTS wire_bytes INT GENERATED ALWAYS AS (length(payload_gzip_b64)) STORED;
DO $$ BEGIN
  -- IF NOT EXISTS matches on NAME only: a plain INT wire_bytes from an earlier
  -- draft would be kept and stay NULL forever (admin line "0 KB", no error).
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'reslab_location_snapshot'::regclass
      AND attname = 'wire_bytes' AND attgenerated = 's'
  ) THEN
    RAISE EXCEPTION 'wire_bytes exists but is not a STORED generated column — drop it and re-run 028';
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE reslab_location_snapshot
    ADD CONSTRAINT reslab_location_snapshot_payload_size_check CHECK (length(payload_gzip_b64) <= 512000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS on, and NO policy for anon/authenticated: denied. service_role bypasses
-- RLS (rolbypassrls, verified 2026-08-04). A public dump of every location
-- (addresses, phones, photo URLs) is the 2026-06-25 CMS-scraping lesson again.
ALTER TABLE reslab_location_snapshot ENABLE ROW LEVEL SECURITY;
-- With RLS on and no policy, anon would get an EMPTY result, not an error
-- (Supabase's default privileges GRANT SELECT on public tables). Make it a
-- hard denial: nothing but the service role may touch this table.
REVOKE ALL ON TABLE reslab_location_snapshot FROM PUBLIC, anon, authenticated;
-- Explicit, for the same reason as the function grant below: the REVOKE above
-- must never be able to take the service role's own access away. The RPC is
-- SECURITY INVOKER, so the write path needs these AS service_role (rolbypassrls
-- bypasses RLS, not GRANTs).
GRANT SELECT, INSERT, UPDATE ON TABLE reslab_location_snapshot TO service_role;

-- The only write path. `ON CONFLICT … DO UPDATE … WHERE` cannot be expressed
-- through supabase-js .upsert(), and every approximation of it fails silently
-- (a read-compare-write races; an upsert that updates zero rows returns no
-- error). Returns TRUE when the row was written, FALSE when a newer (or
-- equal-within-skew) snapshot already exists — the caller logs that as a
-- distinguishable no-op, never as success.
CREATE OR REPLACE FUNCTION reslab_snapshot_upsert(
  p_env_key          text,
  p_key_fingerprint  text,
  p_schema_version   int,
  p_built_at         timestamptz,
  p_rows_fetched     int,
  p_location_count   int,
  p_paginator_total  int,
  p_payload_gzip_b64 text,
  p_written_by       text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  INSERT INTO reslab_location_snapshot (
    env_key, key_fingerprint, schema_version, built_at, rows_fetched,
    location_count, paginator_total, payload_gzip_b64, written_by, updated_at
  ) VALUES (
    p_env_key, p_key_fingerprint, p_schema_version, p_built_at, p_rows_fetched,
    p_location_count, p_paginator_total, p_payload_gzip_b64, p_written_by, now()
  )
  ON CONFLICT (env_key) DO UPDATE SET
    key_fingerprint  = excluded.key_fingerprint,
    schema_version   = excluded.schema_version,
    built_at         = excluded.built_at,
    rows_fetched     = excluded.rows_fetched,
    location_count   = excluded.location_count,
    paginator_total  = excluded.paginator_total,
    payload_gzip_b64 = excluded.payload_gzip_b64,
    written_by       = excluded.written_by,
    updated_at       = now()
  -- 60 s skew margin: writers are different machines (NTP-synced, ±1 s realistic).
  WHERE excluded.built_at > reslab_location_snapshot.built_at + interval '60 seconds';
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION reslab_snapshot_upsert(text, text, int, timestamptz, int, int, int, text, text) FROM PUBLIC, anon, authenticated;
-- No migration in this repo has ever relied on an implicit EXECUTE grant; make
-- the service role's right explicit so the REVOKE above cannot take it away.
GRANT EXECUTE ON FUNCTION reslab_snapshot_upsert(text, text, int, timestamptz, int, int, int, text, text) TO service_role;

-- Verification (run as service role):
--   SELECT env_key, built_at, rows_fetched, location_count, paginator_total,
--          wire_bytes, written_by
--   FROM reslab_location_snapshot;
-- As anon: `select * from reslab_location_snapshot` must ERROR (permission denied),
-- not return 0 rows.

NOTIFY pgrst, 'reload schema';
