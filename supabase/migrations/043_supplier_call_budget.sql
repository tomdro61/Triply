-- 043: daily supplier-call budget (Park & Stay plan v2 §5, notes/2026-09-18-park-and-stay-plan-v2.md)
--
-- ONE row per {UTC day, provider, mode}. Every metered LiteAPI request takes
-- one call from today's budget BEFORE it is sent; once the budget is spent the
-- caller gets a refusal and /api/park-stay/search answers 503 (never an empty
-- "no hotels" body). The per-IP limiter in src/lib/attribution/limiter.ts is a
-- per-lambda brake; this row is the boundary, shared by every instance.
--
-- `mode` keeps the two environments apart on the SHARED database: staging and
-- local dev run the sandbox key, production the live key (src/lib/hotels/
-- liteapi/env.ts derives it from the Stripe key). A staging soak can never
-- spend production's budget, and vice versa.
--
-- Booking / cancel calls are NOT metered here: a search budget must never be
-- able to block a cancellation.

CREATE TABLE IF NOT EXISTS supplier_call_budget (
  -- DATE of the UTC day (a calendar key, not a booking wall-clock time).
  day        DATE NOT NULL,
  provider   TEXT NOT NULL CHECK (provider IN ('liteapi')),
  mode       TEXT NOT NULL CHECK (mode IN ('live', 'sandbox')),
  calls      INT  NOT NULL DEFAULT 0 CHECK (calls >= 0),
  -- Refused takes; the app reports to Sentry on a ladder of this count (1, 10, 100, every 1,000).
  denied     INT  NOT NULL DEFAULT 0 CHECK (denied >= 0),
  -- TIMESTAMPTZ is correct: a real instant, for "when did we last call".
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, provider, mode)
);

-- RLS on, no policy, and a hard REVOKE: nothing but the service role may read
-- or write this table (same pattern as 028).
ALTER TABLE supplier_call_budget ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE supplier_call_budget FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE supplier_call_budget TO service_role;

-- The only write path. Atomic under concurrency: the INSERT … ON CONFLICT
-- takes the row lock, so two instances can never both take the last call.
--   allowed = true  → `calls` is today's count INCLUDING this take
--   allowed = false → nothing was taken; `denied` is today's refusal count
--                     including this one (exactly one caller sees each value)
-- A non-positive limit refuses everything (a deliberate "off" switch).
CREATE OR REPLACE FUNCTION supplier_call_budget_take(
  p_provider text,
  p_mode     text,
  p_limit    int
) RETURNS TABLE (allowed boolean, calls int, denied int)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_day   date := (now() AT TIME ZONE 'UTC')::date;
  v_calls int;
  v_denied int;
BEGIN
  IF p_limit IS NULL THEN
    RAISE EXCEPTION 'supplier_call_budget_take: p_limit is required';
  END IF;

  IF p_limit > 0 THEN
    INSERT INTO supplier_call_budget AS b (day, provider, mode, calls, updated_at)
    VALUES (v_day, p_provider, p_mode, 1, now())
    ON CONFLICT (day, provider, mode) DO UPDATE
      SET calls = b.calls + 1, updated_at = now()
      WHERE b.calls < p_limit
    RETURNING b.calls, b.denied INTO v_calls, v_denied;

    IF FOUND THEN
      RETURN QUERY SELECT true, v_calls, v_denied;
      RETURN;
    END IF;
  END IF;

  -- Refused: record it (the row may not exist yet when p_limit <= 0).
  INSERT INTO supplier_call_budget AS b (day, provider, mode, calls, denied, updated_at)
  VALUES (v_day, p_provider, p_mode, 0, 1, now())
  ON CONFLICT (day, provider, mode) DO UPDATE
    SET denied = b.denied + 1, updated_at = now()
  RETURNING b.calls, b.denied INTO v_calls, v_denied;

  RETURN QUERY SELECT false, v_calls, v_denied;
END
$$;

REVOKE ALL ON FUNCTION supplier_call_budget_take(text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION supplier_call_budget_take(text, text, int) TO service_role;

-- Verification (run as service role):
--   SELECT * FROM supplier_call_budget_take('liteapi', 'sandbox', 1000);  -- allowed, calls = n
--   SELECT * FROM supplier_call_budget ORDER BY day DESC LIMIT 5;
-- As anon: `select * from supplier_call_budget` must ERROR (permission denied).

NOTIFY pgrst, 'reload schema';
