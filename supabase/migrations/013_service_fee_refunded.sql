-- Migration 013: track full refunds that returned the Triply service fee.
--
-- Background: the admin cancel-and-refund flow retains the Triply service fee
-- by default (refund = Stripe amount_received − triply_service_fee). Because of
-- that, refunded bookings still count the service fee as Triply revenue in
-- lib/accounting/reconcile.ts (see the "service fee retained" branch).
--
-- A new "Cancel & Full Refund" admin path returns the service fee too — used
-- when a lot is full and turns the customer away, so Triply eats its own fee as
-- goodwill. This flag marks those bookings so the accounting reconciler excludes
-- the fee from kept revenue for them.
--
-- Defaults false so every existing row keeps the current "fee retained"
-- semantics and no historical accounting number moves.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS service_fee_refunded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN bookings.service_fee_refunded IS
  'True when the Triply service fee was returned to the customer as part of a full refund (e.g. lot-full cancellation). Accounting (reconcile.ts) excludes the fee from kept revenue for these rows.';
