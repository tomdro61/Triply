-- Migration 039: direct lots Phase 6a — the payout ledger.
-- Plan: notes/2026-10-12-direct-lots-phase6-plan.md §3 (v2, approved 2026-10-12).
--
-- WHAT: a per-booking, append-only record of what Triply paid a direct lot.
--   direct_lot_statements   one row per (lot, check-out month, livemode) that was MARKED PAID —
--                           a row exists only once the month is paid (no drafts are stored; the
--                           UNIQUE key is what refuses a second payment of the month).
--   direct_lot_payout_lines the lines of a paid statement: a 'payout' line per booking (at most ONE per
--                           booking, enforced below) and signed 'adjustment' lines for later changes.
-- WHY per booking, not per month: a check-out date edited across months, a late fulfilment, a reversed
-- withhold or a refund after payment must never pay a booking twice or repeat a claw-back (plan review C2).
-- livemode in every key: staging and production share this database; a staging test must never lock a
-- production month or a production booking (plan review C1) — the composite foreign keys below tie each
-- line to its booking's terms row in the SAME lot and Stripe mode.
--
-- WRITES go only through mark_direct_lot_statement_paid (SECURITY DEFINER). service_role gets SELECT on
-- both tables and UPDATE on the statement email columns only. Supabase's default privileges grant every
-- table privilege to anon/authenticated/service_role on a new table (verified in pg_default_acl), so this
-- file REVOKEs ALL first and grants back; a trigger refuses UPDATE/DELETE/TRUNCATE on lines regardless.
-- Nothing here is customer-readable. Money in integer cents.
--
-- APPLY with the Supabase MCP apply_migration (not execute_sql) against Triply-prod (shared by staging +
-- prod), BEFORE the 6a deploy. Additive only; re-run-safe. No BEGIN/COMMIT (apply_migration wraps it).
SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = public;

-- Lets a line reference (booking, lot, mode) as one key. direct_booking_terms is tiny (direct checkout is
-- hidden in production); lock_timeout bounds the build.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_direct_booking_terms_pi_lot_mode
  ON direct_booking_terms (stripe_payment_intent_id, direct_lot_id, livemode);

CREATE TABLE IF NOT EXISTS direct_lot_statements (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  direct_lot_id          TEXT NOT NULL,
  -- The first day of the check-out month this statement pays.
  period_month           DATE NOT NULL CHECK (extract(day FROM period_month) = 1),
  livemode               BOOLEAN NOT NULL,
  -- Signed: a month of claw-backs can net below zero.
  total_cents            BIGINT NOT NULL,
  paid_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The admin who marked it paid (from the session, never the request body).
  paid_by                TEXT NOT NULL CHECK (length(btrim(paid_by)) > 0),
  note                   TEXT,
  -- The statement email is sent AFTER the lock, as its own retryable step.
  statement_email_id     TEXT,
  statement_attempts     INTEGER NOT NULL DEFAULT 0 CHECK (statement_attempts >= 0),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (direct_lot_id, period_month, livemode),
  -- Target of the lines' composite foreign key (a line's lot + mode = its statement's).
  UNIQUE (id, direct_lot_id, livemode)
);

CREATE TABLE IF NOT EXISTS direct_lot_payout_lines (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id             UUID NOT NULL,
  stripe_payment_intent_id TEXT NOT NULL,
  reservation_number       TEXT NOT NULL CHECK (length(btrim(reservation_number)) > 0),
  direct_lot_id            TEXT NOT NULL,
  livemode                 BOOLEAN NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN ('payout', 'adjustment')),
  -- Signed for adjustments: negative = a claw-back, positive = a reversed withhold.
  amount_cents             BIGINT NOT NULL,
  -- What the amount was computed from (camelCase keys of PayoutBasis in src/lib/direct/payout.ts:
  -- subtotalCents, taxCents, shareBp, taxCollectedBy, amountReceivedCents, amountRefundedCents, piStatus,
  -- stripeDisputed, serviceFeeCents, pgWholesaleCents, status, cancelState, cancelClaimedAt, checkOut; an
  -- adjustment also carries prior_lines_cents; also checkIn, timezone). A booking a person decided is not
  -- raised again while its current basis equals this one.
  basis                    JSONB NOT NULL CHECK (jsonb_typeof(basis) = 'object'),
  decision                 TEXT NOT NULL CHECK (decision IN ('auto', 'manual')),
  decided_by               TEXT,
  note                     TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind = 'adjustment' OR amount_cents >= 0),
  -- An adjustment is always a person's decision (a $0 one records "reviewed, the payout stands");
  -- a manual decision carries who and why.
  CHECK (kind = 'payout' OR decision = 'manual'),
  CHECK (decision = 'auto' OR (decided_by IS NOT NULL AND note IS NOT NULL AND length(btrim(note)) > 0)),
  FOREIGN KEY (statement_id, direct_lot_id, livemode)
    REFERENCES direct_lot_statements (id, direct_lot_id, livemode),
  -- The booking's own terms row, same lot and same Stripe mode: a staging call can never write a line
  -- for a live booking (or another lot's), and a paid booking's terms can't be re-pointed or deleted.
  FOREIGN KEY (stripe_payment_intent_id, direct_lot_id, livemode)
    REFERENCES direct_booking_terms (stripe_payment_intent_id, direct_lot_id, livemode)
);
-- The database refuses a second payout line for a booking — the "never paid twice" guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_direct_lot_payout_per_booking
  ON direct_lot_payout_lines (stripe_payment_intent_id) WHERE kind = 'payout';
CREATE INDEX IF NOT EXISTS idx_direct_lot_payout_lines_pi ON direct_lot_payout_lines (stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_direct_lot_payout_lines_statement ON direct_lot_payout_lines (statement_id);
CREATE INDEX IF NOT EXISTS idx_direct_lot_payout_lines_lot ON direct_lot_payout_lines (direct_lot_id, livemode, created_at);

ALTER TABLE direct_lot_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_lot_payout_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON direct_lot_statements FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON direct_lot_payout_lines FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON direct_lot_statements TO service_role;
-- The statement-email retry step only.
GRANT UPDATE (statement_email_id, statement_attempts) ON direct_lot_statements TO service_role;
GRANT SELECT ON direct_lot_payout_lines TO service_role;

DROP TRIGGER IF EXISTS update_direct_lot_statements_updated_at ON direct_lot_statements;
CREATE TRIGGER update_direct_lot_statements_updated_at
  BEFORE UPDATE ON direct_lot_statements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Append-only, whatever the grants (the owner bypasses grants; triggers it does not).
CREATE OR REPLACE FUNCTION direct_lot_payout_lines_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'direct_lot_payout_lines is append-only (% refused)', TG_OP;
END $$;
REVOKE ALL ON FUNCTION direct_lot_payout_lines_append_only() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS direct_lot_payout_lines_no_change ON direct_lot_payout_lines;
CREATE TRIGGER direct_lot_payout_lines_no_change BEFORE UPDATE OR DELETE ON direct_lot_payout_lines
  FOR EACH ROW EXECUTE FUNCTION direct_lot_payout_lines_append_only();
DROP TRIGGER IF EXISTS direct_lot_payout_lines_no_truncate ON direct_lot_payout_lines;
CREATE TRIGGER direct_lot_payout_lines_no_truncate BEFORE TRUNCATE ON direct_lot_payout_lines
  FOR EACH STATEMENT EXECUTE FUNCTION direct_lot_payout_lines_append_only();

-- Mark a month paid, atomically: the statement row and ALL its lines in one transaction, the total
-- checked against the lines, a second payment of the same month or of any booking refused by the
-- constraints above, an adjustment refused unless it was computed against the booking's CURRENT lines.
-- The caller (an admin route) has already verified the admin, recomputed the statement and matched it
-- to what the admin saw; this function trusts nothing it can check itself. decided_by on manual lines is
-- the paying admin (p_paid_by, from the session) — never a value from the request body.
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
  -- The adjustment check below relies on READ COMMITTED (each statement sees what other calls committed
  -- before this one took the lock). Under a snapshot isolation level it would read stale lines.
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
     OR (e.l->>'kind' = 'adjustment' AND jsonb_typeof(e.l->'prior_lines_cents') IS DISTINCT FROM 'number');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'malformed line(s) at position(s) %', v_bad;
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l
             GROUP BY l->>'stripe_payment_intent_id' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'a booking appears more than once in one statement';
  END IF;

  -- Serialise mark-paid per lot + mode: the adjustment check below reads lines a concurrent call could
  -- be writing. Under READ COMMITTED each statement after the lock sees lines other calls committed.
  PERFORM pg_advisory_xact_lock(hashtextextended('direct_lot_payout:' || p_direct_lot_id || ':' || p_livemode::text, 0));

  -- A concurrent change, not a bug: its own SQLSTATE (TP001) so the caller can say "reload".
  SELECT string_agg(l->>'stripe_payment_intent_id', ',') INTO v_bad
  FROM jsonb_array_elements(p_lines) l
  WHERE l->>'kind' = 'adjustment'
    AND (NOT EXISTS (SELECT 1 FROM direct_lot_payout_lines x
                     WHERE x.stripe_payment_intent_id = l->>'stripe_payment_intent_id' AND x.kind = 'payout')
         OR (l->>'prior_lines_cents')::BIGINT IS DISTINCT FROM
            (SELECT COALESCE(SUM(x.amount_cents), 0) FROM direct_lot_payout_lines x
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
              THEN l->'basis' || jsonb_build_object('prior_lines_cents', l->'prior_lines_cents')
              ELSE l->'basis' END,
         l->>'decision',
         CASE WHEN l->>'decision' = 'manual' THEN btrim(p_paid_by) END,
         NULLIF(btrim(l->>'note'), '')
  FROM jsonb_array_elements(p_lines) l;  -- a booking already paid raises unique_violation

  RETURN v_statement_id;
END;
$$;
REVOKE ALL ON FUNCTION mark_direct_lot_statement_paid(TEXT, DATE, BOOLEAN, BIGINT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mark_direct_lot_statement_paid(TEXT, DATE, BOOLEAN, BIGINT, JSONB, TEXT, TEXT) TO service_role;

COMMENT ON TABLE direct_lot_statements IS
  'Direct-lot payout statements, one per paid (lot, check-out month, livemode) — migration 039. Service role read-only; written by mark_direct_lot_statement_paid.';
COMMENT ON TABLE direct_lot_payout_lines IS
  'Append-only direct-lot payout ledger — migration 039. At most one payout line per booking.';

NOTIFY pgrst, 'reload schema';

-- VERIFY after applying:
--   SELECT table_name, grantee, string_agg(privilege_type, ',') FROM information_schema.role_table_grants
--    WHERE table_name IN ('direct_lot_statements','direct_lot_payout_lines') GROUP BY 1, 2;
--     → service_role SELECT only on lines; SELECT on statements (+ column UPDATE); no anon/authenticated
--   SELECT grantee, column_name, privilege_type FROM information_schema.column_privileges
--    WHERE table_name = 'direct_lot_statements' AND privilege_type = 'UPDATE';
--     → service_role on statement_email_id and statement_attempts only
--   SELECT has_function_privilege('anon', 'mark_direct_lot_statement_paid(text,date,boolean,bigint,jsonb,text,text)', 'EXECUTE'); → false
--   SELECT has_function_privilege('service_role', 'mark_direct_lot_statement_paid(text,date,boolean,bigint,jsonb,text,text)', 'EXECUTE'); → true
-- ROLLBACK (only while both tables are empty):
--   DROP FUNCTION mark_direct_lot_statement_paid(TEXT, DATE, BOOLEAN, BIGINT, JSONB, TEXT, TEXT);
--   DROP TABLE direct_lot_payout_lines; DROP TABLE direct_lot_statements;
--   DROP FUNCTION direct_lot_payout_lines_append_only(); DROP INDEX uniq_direct_booking_terms_pi_lot_mode;
