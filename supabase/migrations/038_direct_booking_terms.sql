-- Migration 038: direct lots — partner/tax terms off the customer-readable bookings row.
-- Plan: notes/2026-10-10-direct-lots-phase4b-plan.md §2.1 + §9 M-C/M-D + §10 F-4/F-5/F-7.
-- (Numbered 038 because 037 is taken by the open post-trip-review PR #76.)
--
-- WHY: bookings is customer-readable through RLS ("Users can view own bookings",
-- 001) with no column restriction. Migration 034 put the lot's revenue share and
-- tax terms ON bookings and required them for direct rows, and lot_snapshot v1
-- carried the lot's notification emails — so every direct customer could read
-- the lot's deal and contacts over PostgREST. Nothing has leaked: 0 direct rows.
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod (shared by staging + prod)
-- as ONE transaction, BEFORE the 4b-1 deploy. Refuses to run if any direct row
-- exists (the DROPs below are only safe with none). Re-run-safe.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL search_path = public;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM bookings WHERE inventory_source = 'direct')
     OR EXISTS (SELECT 1 FROM pending_bookings WHERE inventory_source = 'direct') THEN
    RAISE EXCEPTION '038: direct rows already exist — this migration assumes none';
  END IF;
END $$;

-- direct_booking_terms -------------------------------------------------------
-- One row per direct PaymentIntent, written by the staging route BEFORE the
-- card is confirmed (so it never depends on the booking insert). Read only by
-- server code, joined from bookings by stripe_payment_intent_id. Service role
-- only: RLS on, no policies.
CREATE TABLE IF NOT EXISTS direct_booking_terms (
  stripe_payment_intent_id   TEXT PRIMARY KEY,
  direct_lot_id              TEXT NOT NULL,
  livemode                   BOOLEAN NOT NULL,
  partner_share_percent      NUMERIC(5,2) NOT NULL CHECK (partner_share_percent BETWEEN 0 AND 100),
  tax_rate_percent           NUMERIC(6,3) NOT NULL CHECK (tax_rate_percent >= 0),
  tax_collected_by           TEXT NOT NULL CHECK (tax_collected_by IN ('triply', 'lot')),
  -- At least one recipient and no NULL element (a NULL address would reach Resend
  -- as an empty "to" and fail the lot notice).
  lot_recipients             TEXT[] NOT NULL CHECK (cardinality(lot_recipients) >= 1
                                                    AND array_position(lot_recipients, NULL) IS NULL),
  lot_notice_email_id        TEXT,
  lot_notice_recipients      TEXT[],
  lot_cancel_notice_email_id TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE direct_booking_terms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON direct_booking_terms FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON direct_booking_terms TO service_role;
-- updated_at maintenance (update_updated_at_column() is defined in 001; its
-- search_path was pinned in 020). Notice-id stamps UPDATE this row.
DROP TRIGGER IF EXISTS update_direct_booking_terms_updated_at ON direct_booking_terms;
CREATE TRIGGER update_direct_booking_terms_updated_at
  BEFORE UPDATE ON direct_booking_terms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- bookings --------------------------------------------------------------------
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_direct_fields_check;
ALTER TABLE bookings
  DROP COLUMN IF EXISTS direct_partner_share_percent,
  DROP COLUMN IF EXISTS direct_tax_rate_percent,
  DROP COLUMN IF EXISTS direct_tax_collected_by,
  -- Atomic claims for the two lot notices (plan §9 M-D): a sender sets the claim
  -- with a guarded UPDATE … RETURNING, stamps *_notified_at only after Resend
  -- accepted the email, and clears the claim on failure so a retry can take it.
  ADD COLUMN IF NOT EXISTS lot_notice_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lot_cancel_notice_claimed_at TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.bookings'::regclass AND conname = 'bookings_direct_fields_check_v2') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_direct_fields_check_v2
      -- A direct row carries its Stripe mode and a CUSTOMER-SAFE lot snapshot:
      -- the lot's recipients live in direct_booking_terms, never here.
      CHECK (inventory_source <> 'direct' OR (
        livemode IS NOT NULL
        AND lot_snapshot IS NOT NULL
        AND NOT (lot_snapshot ? 'notificationEmails')));
  END IF;
END $$;

-- pending_bookings -------------------------------------------------------------
-- Bounded retries for a transient capture failure on a direct booking (plan §10 F-4).
ALTER TABLE pending_bookings
  ADD COLUMN IF NOT EXISTS capture_attempts INT NOT NULL DEFAULT 0;

COMMENT ON TABLE direct_booking_terms IS
  'Direct-lot payout + notice terms per PaymentIntent (migration 038). Service role only — never customer-readable.';

-- PostgREST caches the schema: without a reload the new table/columns 404 or
-- PGRST204 until the next cache refresh (see 023's note). 034/035/036 do the same.
NOTIFY pgrst, 'reload schema';
COMMIT;

-- Verify (expect: table with RLS and no policies; the three columns gone; v2 check present):
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'direct_booking_terms';
--   SELECT count(*) FROM pg_policies WHERE tablename = 'direct_booking_terms';            -- 0
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'bookings'
--     AND column_name LIKE 'direct_%';                                                    -- direct_lot_id only
--   SELECT conname FROM pg_constraint WHERE conname LIKE 'bookings_direct_fields_check%';  -- _v2 only
--   SELECT has_table_privilege('authenticated', 'direct_booking_terms', 'SELECT');        -- false
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.direct_booking_terms'::regclass
--     AND NOT tgisinternal;                                     -- update_direct_booking_terms_updated_at
--
-- Rollback (only while 0 direct rows exist):
--   ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_direct_fields_check_v2,
--     DROP COLUMN IF EXISTS lot_notice_claimed_at, DROP COLUMN IF EXISTS lot_cancel_notice_claimed_at;
--   ALTER TABLE pending_bookings DROP COLUMN IF EXISTS capture_attempts;
--   DROP TRIGGER IF EXISTS update_direct_booking_terms_updated_at ON direct_booking_terms;
--   DROP TABLE IF EXISTS direct_booking_terms;
--   NOTIFY pgrst, 'reload schema';
--   (then re-run the 034 bookings block to restore the three columns + the v1 check)
