-- Migration 042: direct lots Phase 6b review fixes — alerts can be resolved by a person; manifest run states tightened.
-- Follow-up to 041 (applied 2026-10-12). Review pass 1 (2026-10-13):
--   * A "phone the lot to cancel" alert, or a follow-up cancel that gave up, has no automatic way to clear: nothing
--     will ever email it. An admin marks it resolved ("lot phoned") — resolved_at / resolved_by — and the alerts cron
--     stops posting it. A follow-up alert stays open until resolved (no longer only for an hour).
--   * Run states the code relies on, now enforced: 'sent' always has sent_at; a 'failed' run never had a possibly
--     delivered attempt (had_unknown = false — such a run stays 'sending' until its follow-ups run).
-- direct_lot_manifest_runs is empty in production (crons run only there; no live direct bookings yet), so the new
-- CHECKs validate instantly. Also restates two 041 comments the review found too absolute.
--
-- APPLY with the one-transaction apply script against Triply-prod (shared by staging + prod), BEFORE the fix deploy.
-- Additive; re-run-safe. No BEGIN/COMMIT.
SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = public;

ALTER TABLE direct_lot_alerts
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE direct_lot_alerts DROP CONSTRAINT IF EXISTS direct_lot_alerts_resolved_check;
ALTER TABLE direct_lot_alerts ADD CONSTRAINT direct_lot_alerts_resolved_check
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL) AND (resolved_by IS NULL OR length(btrim(resolved_by)) > 0));

ALTER TABLE direct_lot_manifest_runs DROP CONSTRAINT IF EXISTS direct_lot_manifest_runs_sent_has_time;
ALTER TABLE direct_lot_manifest_runs ADD CONSTRAINT direct_lot_manifest_runs_sent_has_time
  CHECK (status <> 'sent' OR sent_at IS NOT NULL);
ALTER TABLE direct_lot_manifest_runs DROP CONSTRAINT IF EXISTS direct_lot_manifest_runs_failed_not_unknown;
ALTER TABLE direct_lot_manifest_runs ADD CONSTRAINT direct_lot_manifest_runs_failed_not_unknown
  CHECK (status <> 'failed' OR NOT had_unknown);

COMMENT ON COLUMN direct_lot_manifest_runs.had_unknown IS
  'Set just BEFORE an attempt is handed to Resend (and when an outcome was unknown): the attempt may have been '
  'delivered, so the run never moves to a new idempotency key and its follow-up cancels always run. Cleared only by '
  'a definite refusal of that first send. A deliberate force starts a new attempt.';
COMMENT ON TABLE direct_lot_resends IS
  'Admin re-sends and manifest follow-up cancels. UNIQUE (booking_id, kind, source) stops a follow-up looping and '
  'two admin re-sends that race on the same n; a later deliberate re-send is n+1 (a new email). Keyed by booking_id, '
  'which belongs to one Stripe mode.';

NOTIFY pgrst, 'reload schema';

-- VERIFY after applying:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'direct_lot_alerts' AND column_name IN ('resolved_at','resolved_by');          → 2 rows
--   SELECT conname FROM pg_constraint WHERE conname IN ('direct_lot_alerts_resolved_check',
--     'direct_lot_manifest_runs_sent_has_time','direct_lot_manifest_runs_failed_not_unknown');           → 3 rows
-- ROLLBACK:
--   ALTER TABLE direct_lot_manifest_runs DROP CONSTRAINT direct_lot_manifest_runs_failed_not_unknown,
--     DROP CONSTRAINT direct_lot_manifest_runs_sent_has_time;
--   ALTER TABLE direct_lot_alerts DROP CONSTRAINT direct_lot_alerts_resolved_check,
--     DROP COLUMN resolved_by, DROP COLUMN resolved_at;
