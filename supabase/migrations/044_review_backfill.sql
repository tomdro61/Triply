-- Migration 044: one-time review ask to past customers ("backfill").
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod (shared by staging +
-- prod) AFTER 037, and BEFORE the first `?backfill=send` run of
-- /api/cron/post-trip-review. Additive: widens one CHECK, no data change.
-- Re-run-safe (DROP ... IF EXISTS, then ADD).
--
-- review_emails.kind gains 'backfill': the single review ask sent to a
-- customer whose trip ended before the post-trip email existed. The ledger
-- rules are unchanged — UNIQUE (booking_id, kind) still makes a second
-- backfill send for the same booking fail with 23505 — and the selector
-- (src/lib/reviews/backfill.ts) additionally skips any ADDRESS that already
-- has a review_emails row of any kind or a review, so a customer is asked at
-- most once, ever.
--
-- ROLLBACK (only while no 'backfill' rows exist):
--   ALTER TABLE review_emails DROP CONSTRAINT IF EXISTS review_emails_kind_check;
--   ALTER TABLE review_emails ADD CONSTRAINT review_emails_kind_check
--     CHECK (kind IN ('initial', 'reminder'));

ALTER TABLE review_emails DROP CONSTRAINT IF EXISTS review_emails_kind_check;
ALTER TABLE review_emails ADD CONSTRAINT review_emails_kind_check
  CHECK (kind IN ('initial', 'reminder', 'backfill'));
