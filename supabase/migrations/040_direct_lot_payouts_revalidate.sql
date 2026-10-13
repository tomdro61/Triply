-- Migration 040: direct lots Phase 6a — mark_direct_lot_statement_paid re-checks what it pays against.
-- Follow-up to 039 (applied 2026-10-12, both tables still empty). Codex review findings, 2026-10-12:
--   1. The booking itself was never re-read inside the transaction: an admin cancellation landing between the
--      statement rebuild and the write would still get its automatic payout. Now every line's booking is
--      share-locked and its status + cancel_state must still equal the line's basis (a cancel claim UPDATEs the
--      row, so it either committed before the lock — and is seen — or waits until this payment commits).
--   2. A $0 adjustment ("reviewed, the payout stands") leaves the line SUM unchanged, so a concurrent stale
--      claw-back passed the sum check. An adjustment now also carries prior_lines_count, checked under the lock.
-- Only the function changes (CREATE OR REPLACE, same signature, same grants). Wire format: an adjustment line
-- now REQUIRES prior_lines_count — the matching app code sends it; deploy that code with/after this.
--
-- APPLY with the Supabase MCP apply_migration or the one-transaction apply script, against Triply-prod
-- (shared by staging + prod). No BEGIN/COMMIT. Re-run-safe.
SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = public;

CREATE OR REPLACE FUNCTION mark_direct_lot_statement_paid(
  p_direct_lot_id TEXT,
  p_period_month  DATE,
  p_livemode      BOOLEAN,
  p_total_cents   BIGINT,
  p_lines         JSONB,
  p_paid_by       TEXT,
  p_note          TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_statement_id UUID;
  v_sum          BIGINT;
  v_bad          TEXT;
BEGIN
  IF p_direct_lot_id IS NULL OR p_period_month IS NULL OR p_livemode IS NULL OR p_total_cents IS NULL THEN
    RAISE EXCEPTION 'lot, month, livemode and total are required';
  END IF;
  IF p_paid_by IS NULL OR length(btrim(p_paid_by)) = 0 THEN
    RAISE EXCEPTION 'paid_by is required';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'lines must be a non-empty JSON array';
  END IF;
  -- The checks below rely on READ COMMITTED (each statement sees what other calls committed before this one
  -- took its locks). Under a snapshot isolation level they would read stale rows.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'mark_direct_lot_statement_paid must run under READ COMMITTED';
  END IF;

  SELECT string_agg(e.ord::text, ',') INTO v_bad
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS e(l, ord)
  WHERE jsonb_typeof(e.l) IS DISTINCT FROM 'object'
     OR jsonb_typeof(e.l->'amount_cents') IS DISTINCT FROM 'number'
     OR jsonb_typeof(e.l->'basis') IS DISTINCT FROM 'object'
     OR jsonb_typeof(e.l->'stripe_payment_intent_id') IS DISTINCT FROM 'string'
     OR jsonb_typeof(e.l->'reservation_number') IS DISTINCT FROM 'string'
     OR jsonb_typeof(e.l->'kind') IS DISTINCT FROM 'string'
     OR jsonb_typeof(e.l->'decision') IS DISTINCT FROM 'string'
     OR (e.l->>'kind' = 'adjustment' AND jsonb_typeof(e.l->'prior_lines_cents') IS DISTINCT FROM 'number')
     OR (e.l->>'kind' = 'adjustment' AND jsonb_typeof(e.l->'prior_lines_count') IS DISTINCT FROM 'number');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'malformed line(s) at position(s) %', v_bad;
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
             GROUP BY l->>'stripe_payment_intent_id' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'a booking appears more than once in one statement';
  END IF;

  -- Serialise mark-paid per lot + mode: the ledger checks below read lines a concurrent call could be writing.
  PERFORM pg_advisory_xact_lock(hashtextextended('direct_lot_payout:' || p_direct_lot_id || ':' || p_livemode::text, 0));

  -- Hold every line's booking still until this payment commits: a cancellation claim (an UPDATE of the row)
  -- either committed before this lock — and the check below sees it — or waits for this transaction.
  PERFORM 1 FROM bookings b
   WHERE b.inventory_source = 'direct' AND b.direct_lot_id = p_direct_lot_id AND b.livemode = p_livemode
     AND b.stripe_payment_intent_id IN (SELECT l->>'stripe_payment_intent_id' FROM jsonb_array_elements(p_lines) l)
   FOR SHARE OF b;

  -- A concurrent change, not a bug: its own SQLSTATE (TP001) so the caller can say "reload".
  SELECT string_agg(l->>'stripe_payment_intent_id', ',') INTO v_bad
  FROM jsonb_array_elements(p_lines) l
  WHERE NOT EXISTS (
    SELECT 1 FROM bookings b
     WHERE b.stripe_payment_intent_id = l->>'stripe_payment_intent_id'
       AND b.inventory_source = 'direct' AND b.direct_lot_id = p_direct_lot_id AND b.livemode = p_livemode
       AND b.status IS NOT DISTINCT FROM l->'basis'->>'status'
       AND b.cancel_state IS NOT DISTINCT FROM l->'basis'->>'cancelState');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'booking(s) % changed (status or cancellation) since the statement was built', v_bad
      USING ERRCODE = 'TP001';
  END IF;

  -- An adjustment must have been computed against the booking's CURRENT lines: same sum AND same count (a $0
  -- review changes only the count, and must invalidate any other adjustment computed before it).
  SELECT string_agg(l->>'stripe_payment_intent_id', ',') INTO v_bad
  FROM jsonb_array_elements(p_lines) l
  WHERE l->>'kind' = 'adjustment'
    AND (NOT EXISTS (SELECT 1 FROM direct_lot_payout_lines x
                     WHERE x.stripe_payment_intent_id = l->>'stripe_payment_intent_id' AND x.kind = 'payout')
         -- Two scalar comparisons: a row IS DISTINCT FROM (subquery) is not a row comparison in Postgres
         -- (it fails at run time with 42601 — on every call, adjustments or not).
         OR (l->>'prior_lines_cents')::BIGINT IS DISTINCT FROM
            (SELECT COALESCE(SUM(x.amount_cents), 0) FROM direct_lot_payout_lines x
              WHERE x.stripe_payment_intent_id = l->>'stripe_payment_intent_id')
         OR (l->>'prior_lines_count')::BIGINT IS DISTINCT FROM
            (SELECT count(*) FROM direct_lot_payout_lines x
              WHERE x.stripe_payment_intent_id = l->>'stripe_payment_intent_id'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'adjustment(s) for % have no payout line or were computed against stale lines', v_bad
      USING ERRCODE = 'TP001';
  END IF;

  -- A claw-back never takes a booking below $0 in total (prior lines were just checked current).
  SELECT string_agg(l->>'stripe_payment_intent_id', ',') INTO v_bad
  FROM jsonb_array_elements(p_lines) l
  WHERE l->>'kind' = 'adjustment'
    AND (l->>'prior_lines_cents')::BIGINT + (l->>'amount_cents')::BIGINT < 0;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'adjustment(s) for % would take back more than was paid', v_bad;
  END IF;

  SELECT SUM((l->>'amount_cents')::BIGINT) INTO v_sum FROM jsonb_array_elements(p_lines) l;
  IF v_sum IS DISTINCT FROM p_total_cents THEN
    RAISE EXCEPTION 'statement total % does not equal the sum of its lines %', p_total_cents, v_sum;
  END IF;

  INSERT INTO direct_lot_statements (direct_lot_id, period_month, livemode, total_cents, paid_by, note)
  VALUES (p_direct_lot_id, p_period_month, p_livemode, p_total_cents, btrim(p_paid_by), p_note)
  RETURNING id INTO v_statement_id;  -- a second payment of the month raises unique_violation

  INSERT INTO direct_lot_payout_lines (
    statement_id, stripe_payment_intent_id, reservation_number, direct_lot_id, livemode,
    kind, amount_cents, basis, decision, decided_by, note)
  SELECT v_statement_id,
         l->>'stripe_payment_intent_id',
         l->>'reservation_number',
         p_direct_lot_id,
         p_livemode,
         l->>'kind',
         (l->>'amount_cents')::BIGINT,
         -- An adjustment's basis always records the baseline it was checked against.
         CASE WHEN l->>'kind' = 'adjustment'
              THEN l->'basis' || jsonb_build_object('prior_lines_cents', l->'prior_lines_cents',
                                                    'prior_lines_count', l->'prior_lines_count')
              ELSE l->'basis' END,
         l->>'decision',
         CASE WHEN l->>'decision' = 'manual' THEN btrim(p_paid_by) END,
         NULLIF(btrim(l->>'note'), '')
  FROM jsonb_array_elements(p_lines) l;  -- a booking already paid raises unique_violation

  RETURN v_statement_id;
END;
$$;
-- CREATE OR REPLACE keeps the existing ACL; restated so the file stands alone.
REVOKE ALL ON FUNCTION mark_direct_lot_statement_paid(TEXT, DATE, BOOLEAN, BIGINT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mark_direct_lot_statement_paid(TEXT, DATE, BOOLEAN, BIGINT, JSONB, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';

-- VERIFY after applying:
--   SELECT position('prior_lines_count' IN prosrc) > 0 AND position('FOR SHARE OF b' IN prosrc) > 0
--     FROM pg_proc WHERE proname = 'mark_direct_lot_statement_paid';                       → true
--   SELECT has_function_privilege('anon', 'mark_direct_lot_statement_paid(text,date,boolean,bigint,jsonb,text,text)', 'EXECUTE'); → false
-- ROLLBACK: re-run the function section of 039 (the previous body).
