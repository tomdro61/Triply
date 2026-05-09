-- Triply: Park Guard parking protection plan opt-in
-- Migration 008

-- Park Guard is a third-party parking-protection product (parkguard.com)
-- that customers can opt into at checkout for a flat fee. Park Guard
-- underwrites the protection and handles claims; Triply forwards the
-- reservation data via their capture-reservation-data API and stores
-- the returned identifier so admin/support can cross-reference records
-- and the customer can be sent a personalized claim link.

ALTER TABLE bookings
  ADD COLUMN protection_plan TEXT,
  ADD COLUMN protection_plan_price DECIMAL(10, 2),
  ADD COLUMN pg_identifier TEXT;

-- protection_plan_price is the customer-facing premium charged at checkout
-- (a flat $9.99 at launch). protection_plan stores the human-readable plan
-- name sent to Park Guard ("$1,000 Protection" at launch). pg_identifier
-- is the value Park Guard returns from POST /api/capture-reservation-data
-- and is null until that POST succeeds — bookings with protection_plan
-- set but pg_identifier still null after a few minutes are the targets
-- of background reconciliation.

CREATE INDEX idx_bookings_pg_identifier ON bookings(pg_identifier)
  WHERE pg_identifier IS NOT NULL;
