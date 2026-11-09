-- 051: attempt limits for opening a booking without signing in
--
-- A guest opens /confirmation/{n} either with the signed booking key from
-- their confirmation link, or with the checkout email. The email path takes
-- one try from three buckets BEFORE the booking is looked up: the caller's
-- network address, the email, and the confirmation number (charged for every
-- number, whether or not it is a booking of ours). A try is given back when
-- the email matches, or when the answer could not be decided.
-- src/lib/confirmation/guest-lookup-limit.ts is the only caller; it also keeps
-- a per-instance brake in front of this table.
--
-- One row per bucket. `key_hash` is a keyed hash (HMAC-SHA256 with
-- BOOKING_LINK_SIGNING_SECRET, base64url) of the bucket's kind and value: no
-- email or address is stored, and each environment's secret gives it its own
-- rows on the shared database.

CREATE TABLE IF NOT EXISTS guest_lookup_attempts (
  key_hash          TEXT PRIMARY KEY CHECK (key_hash ~ '^[A-Za-z0-9_-]{43}$'),
  kind              TEXT NOT NULL CHECK (kind IN ('ip', 'email', 'number')),
  attempts          INT  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Refused takes in this window; the app reports to Sentry on a ladder of it (1, 10, 100, every 1,000).
  refused           INT  NOT NULL DEFAULT 0 CHECK (refused >= 0),
  -- TIMESTAMPTZ is correct: a real instant (the window's start), not a booking wall-clock time.
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS guest_lookup_attempts_window_idx
  ON guest_lookup_attempts (window_started_at);

-- RLS on, no policy, and a hard REVOKE: only the service role may touch it
-- (the 028 / 043 pattern). DELETE is granted for the cleanup inside the take.
ALTER TABLE guest_lookup_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE guest_lookup_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE guest_lookup_attempts TO service_role;

-- Take one try from every bucket, or from none.
--   p_keys / p_kinds / p_limits: one entry per bucket, paired by position.
--   allowed = true  → every bucket was charged one try.
--   allowed = false → nothing was charged; each full bucket's `refused` went
--                     up by one. retry_after_seconds = until the LAST of the
--                     full buckets' windows ends; refused = the highest
--                     refusal count among them; blocked_kinds = their kinds.
-- Rows are locked in key order by one INSERT … ON CONFLICT statement, so two
-- takes can't deadlock, and each row keeps its own kind and limit.
CREATE OR REPLACE FUNCTION guest_lookup_take(
  p_keys           text[],
  p_kinds          text[],
  p_limits         int[],
  p_window_seconds int
) RETURNS TABLE (allowed boolean, retry_after_seconds int, refused int, blocked_kinds text[])
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_n      int := coalesce(array_length(p_keys, 1), 0);
  v_window interval;
  v_locked int;
  v_full   int;
  v_retry  int;
  v_refused int;
  v_kinds  text[];
BEGIN
  IF v_n = 0 OR v_n > 10
     OR v_n <> coalesce(array_length(p_kinds, 1), 0)
     OR v_n <> coalesce(array_length(p_limits, 1), 0) THEN
    RAISE EXCEPTION 'guest_lookup_take: keys, kinds and limits must hold 1 to 10 entries each, the same number';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds <= 0 THEN
    RAISE EXCEPTION 'guest_lookup_take: p_window_seconds must be positive';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_limits) AS l(v) WHERE l.v IS NULL OR l.v <= 0) THEN
    RAISE EXCEPTION 'guest_lookup_take: every limit must be positive';
  END IF;
  IF (SELECT count(DISTINCT k.v) FROM unnest(p_keys) AS k(v)) <> v_n
     OR EXISTS (SELECT 1 FROM unnest(p_keys) AS k(v) WHERE k.v IS NULL) THEN
    RAISE EXCEPTION 'guest_lookup_take: keys must be distinct and not null';
  END IF;
  v_window := make_interval(secs => p_window_seconds);

  -- 1. Create or lock every row, in key order.
  WITH up AS (
    INSERT INTO guest_lookup_attempts AS g (key_hash, kind)
    SELECT u.k, u.kd
      FROM unnest(p_keys, p_kinds) AS u(k, kd)
     ORDER BY u.k
    ON CONFLICT (key_hash) DO UPDATE SET key_hash = EXCLUDED.key_hash
    RETURNING g.key_hash
  )
  SELECT count(*) INTO v_locked FROM up;
  IF v_locked <> v_n THEN
    RAISE EXCEPTION 'guest_lookup_take: locked % rows for % keys', v_locked, v_n;
  END IF;

  -- 2. A window that has ended starts again.
  UPDATE guest_lookup_attempts AS g
     SET attempts = 0, refused = 0, window_started_at = now()
   WHERE g.key_hash = ANY (p_keys)
     AND g.window_started_at <= now() - v_window;

  -- 3. Any bucket at its limit refuses the whole take.
  SELECT count(*),
         max(ceil(extract(epoch FROM (g.window_started_at + v_window - now()))))::int,
         array_agg(DISTINCT g.kind ORDER BY g.kind)
    INTO v_full, v_retry, v_kinds
    FROM guest_lookup_attempts AS g
    JOIN unnest(p_keys, p_limits) AS u(k, lim) ON u.k = g.key_hash
   WHERE g.attempts >= u.lim;

  IF v_full > 0 THEN
    WITH bumped AS (
      UPDATE guest_lookup_attempts AS g
         SET refused = g.refused + 1
        FROM unnest(p_keys, p_limits) AS u(k, lim)
       WHERE u.k = g.key_hash AND g.attempts >= u.lim
      RETURNING g.refused
    )
    SELECT max(b.refused) INTO v_refused FROM bumped AS b;
  ELSE
    UPDATE guest_lookup_attempts AS g
       SET attempts = g.attempts + 1
     WHERE g.key_hash = ANY (p_keys);
  END IF;

  -- 4. Clean up: up to 100 rows whose window ended, never the caller's own.
  -- SKIP LOCKED, so it never waits on (or deadlocks with) another take. The
  -- cut-off is never shorter than 24 hours, whatever window this caller asked
  -- for, so a short-window caller (a verification probe, a deploy changing the
  -- window) can't delete buckets that are still live.
  DELETE FROM guest_lookup_attempts AS g
   WHERE g.key_hash IN (
     SELECT c.key_hash
       FROM guest_lookup_attempts AS c
      WHERE c.window_started_at < now() - greatest(v_window, interval '24 hours')
        AND NOT (c.key_hash = ANY (p_keys))
      ORDER BY c.window_started_at
      LIMIT 100
      FOR UPDATE SKIP LOCKED
   );

  IF v_full > 0 THEN
    RETURN QUERY SELECT false, greatest(v_retry, 1), v_refused, v_kinds;
  ELSE
    RETURN QUERY SELECT true, 0, 0, ARRAY[]::text[];
  END IF;
END
$$;

-- Give one try back to every bucket whose window is still open (never below
-- 0). Rows are locked in key order first, as in the take. Returns the number
-- of rows given back.
CREATE OR REPLACE FUNCTION guest_lookup_release(
  p_keys           text[],
  p_window_seconds int
) RETURNS int
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_released int;
BEGIN
  IF coalesce(array_length(p_keys, 1), 0) = 0 OR array_length(p_keys, 1) > 10 THEN
    RAISE EXCEPTION 'guest_lookup_release: keys must hold 1 to 10 entries';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds <= 0 THEN
    RAISE EXCEPTION 'guest_lookup_release: p_window_seconds must be positive';
  END IF;

  PERFORM 1
     FROM guest_lookup_attempts AS g
    WHERE g.key_hash = ANY (p_keys)
    ORDER BY g.key_hash
      FOR UPDATE;

  UPDATE guest_lookup_attempts AS g
     SET attempts = g.attempts - 1
   WHERE g.key_hash = ANY (p_keys)
     AND g.attempts > 0
     AND g.window_started_at > now() - make_interval(secs => p_window_seconds);
  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END
$$;

REVOKE ALL ON FUNCTION guest_lookup_take(text[], text[], int[], int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION guest_lookup_take(text[], text[], int[], int) TO service_role;
REVOKE ALL ON FUNCTION guest_lookup_release(text[], int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION guest_lookup_release(text[], int) TO service_role;

-- Verification (as the service role):
--   SELECT * FROM guest_lookup_take(ARRAY['<43-char key>'], ARRAY['number'], ARRAY[5], 86400);
--   SELECT guest_lookup_release(ARRAY['<43-char key>'], 86400);
-- As anon or authenticated, selecting from the table or executing either
-- function must ERROR (permission denied).

NOTIFY pgrst, 'reload schema';
