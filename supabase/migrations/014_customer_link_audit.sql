-- Migration 014: customer_link_audit
-- Part of the reservations-account-linking fix
-- (see notes/2026-07-16-reservations-account-linking-plan.md §9).
--
-- APPLY IN THE SUPABASE SQL EDITOR against Triply-prod BEFORE deploying the
-- Phase 1a code. Triply-prod is SHARED by staging + prod, so this affects both
-- environments at once. The Phase 1a claim route writes to customer_link_audit,
-- so the table must exist first or that write 500s.
--
-- NOTE: the account-deletion soft-anonymize trigger (plan B3a) was intentionally
-- pulled OUT of this migration. There is no customer self-serve account-deletion
-- feature yet, and an unconditional BEFORE DELETE trigger on auth.users would
-- scrub the email of a customer who still holds an ACTIVE booking, breaking the
-- ?email= confirmation deep-link + QR/lot-entry access. B3a will ship WITH the
-- account-deletion feature, guarded on booking status and paired with a
-- token-based recovery path. Until then the recycled-email residual is covered
-- (per plan §9.6) by the one-click claim confirmation + this audit table + the
-- ENABLE_EMAIL_BOOKING_FALLBACK kill-switch.

-- =============================================
-- customer_link_audit
-- Immutable record of every time a customer row's user_id is set by an
-- email-match auto-link (the claim button now; login/bulk backfill later).
-- Lets a bad linkage be detected and bulk-reverted (the kill-switch stops NEW
-- links; this table lets you UNDO committed ones). Deliberately has NO FK on
-- old/new_user_id so the audit trail survives account deletion.
-- =============================================
CREATE TABLE IF NOT EXISTS customer_link_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  old_user_id UUID,                    -- user_id before the link (usually NULL)
  new_user_id UUID NOT NULL,           -- user_id the row was linked to
  matched_email TEXT NOT NULL,         -- the verified email that matched (lowercased)
  source TEXT NOT NULL CHECK (source IN ('claim', 'login-backfill', 'bulk-backfill')),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_link_audit_customer ON customer_link_audit(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_link_audit_new_user ON customer_link_audit(new_user_id);

-- Service-role only. RLS enabled with NO policies => anon/authenticated are
-- denied all access; the service_role key (server-side admin client) bypasses
-- RLS. Same posture as migration 012 for sensitive tables.
ALTER TABLE customer_link_audit ENABLE ROW LEVEL SECURITY;
