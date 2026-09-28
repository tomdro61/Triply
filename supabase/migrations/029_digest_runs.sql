-- 029: daily digest run log (plan: notes/2026-09-28-daily-digest-plan-v2.md §4)
-- Apply AFTER 028 (reslab_location_snapshot, PR #40).
--
-- One row per ET digest date. Gives the cron idempotence (Vercel cron delivery
-- is at-least-once) and lets the digest print "last posted N days ago" so a
-- gap is visible inside the artifact even if the Sentry monitor is misconfigured.

CREATE TABLE IF NOT EXISTS digest_runs (
  digest_date      DATE PRIMARY KEY,
  posted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome          TEXT NOT NULL CHECK (outcome IN ('posted', 'posted_partial', 'could_not_run', 'post_failed')),
  sections_failed  INT NOT NULL DEFAULT 0,
  message_chars    INT,
  model_read       TEXT NOT NULL CHECK (model_read IN ('ok', 'withheld', 'unavailable', 'skipped'))
);

ALTER TABLE digest_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE digest_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE digest_runs TO service_role;

-- bookings.triply_service_fee was added by hand in the SQL editor in 2026 and has
-- no migration of its own (verified 2026-09-28). This documents it; on production
-- the column already exists and this is a no-op. ~40 read sites depend on it.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS triply_service_fee DECIMAL(10,2);

NOTIFY pgrst, 'reload schema';
