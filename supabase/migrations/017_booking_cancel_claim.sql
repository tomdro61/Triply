-- Migration 017: self-service cancellation support
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod BEFORE deploying the code
-- that reads/writes these columns. Triply-prod is SHARED by staging + prod, so
-- this affects both at once. Strictly additive (three nullable columns + an
-- index + a superset CHECK) — existing code never references them, so applying
-- ahead of the code is safe. Re-run-safe (IF NOT EXISTS / guarded constraint).
--
-- See notes/2026-07-29-self-serve-cancellation-plan-v3.md.

ALTER TABLE bookings
  -- Idempotency claim for the cancel path. A machine EVENT timestamp (not a
  -- wall-clock booking time) → TIMESTAMPTZ is correct here (contrast
  -- check_in/check_out, which are TIMESTAMP per migration 007). NULL = the
  -- booking is not mid-cancellation.
  ADD COLUMN IF NOT EXISTS cancel_claimed_at TIMESTAMPTZ,
  -- Reason flag for the claim so the reconciliation cron + admin can tell an
  -- intended HOLD from a leaked claim. A HINT only — Stripe amount_refunded is
  -- the money authority, never this column.
  ADD COLUMN IF NOT EXISTS cancel_state TEXT,
  -- The lot's IANA timezone (e.g. 'America/New_York'), from ResLab's
  -- location.timezone.code. The self-cancel 24h gate is computed in THIS zone.
  -- airport_code is NOT usable for it ("RESLAB" on ~all bookings).
  ADD COLUMN IF NOT EXISTS location_timezone TEXT;

-- Superset CHECK on cancel_state from the start (harmless unused values), so no
-- value any cancel-path code writes can ever fall outside it. Guarded so the
-- migration is safe to re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_cancel_state_check'
  ) THEN
    -- Add NOT VALID (metadata-only, near-instant lock) then VALIDATE separately
    -- (SHARE UPDATE EXCLUSIVE — does NOT block concurrent SELECT/INSERT/UPDATE),
    -- so this never takes an ACCESS EXCLUSIVE full-table scan-lock on the live
    -- bookings table serving checkout traffic.
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_cancel_state_check
      CHECK (cancel_state IS NULL OR cancel_state IN (
        'claimed',
        'held_reslab_ambiguous',
        'reslab_cancelled_refund_pending',
        'refund_issued',
        'admin_claimed'
      )) NOT VALID;
    ALTER TABLE bookings VALIDATE CONSTRAINT bookings_cancel_state_check;
  END IF;
END $$;

-- Cheap scan for the reconciliation cron's "stuck cancel" query. The predicate
-- MATCHES the cron filter (both conditions) so the index stays bounded to the
-- tiny live-stuck set — cancel_claimed_at is NOT cleared on a successful cancel
-- (only status/cancel_state change), so a predicate on cancel_claimed_at alone
-- would accumulate one row per all-time cancellation.
CREATE INDEX IF NOT EXISTS idx_bookings_cancel_claimed
  ON bookings (cancel_claimed_at)
  WHERE cancel_claimed_at IS NOT NULL AND status = 'confirmed';
