-- Fix booking time storage so the customer-picked time displays correctly
-- across admin, partner, and customer-facing surfaces regardless of viewer
-- timezone.
--
-- Background: The booking flow sends raw strings like "2026-05-10 08:00:00"
-- to Postgres. The original TIMESTAMPTZ columns interpreted these as UTC at
-- write time, then the Supabase JS client returned them with offset, causing
-- viewer-tz shifting on display. A customer who picked 8:00 AM at a SAN lot
-- would appear as 4:00 AM in an Eastern-time admin browser.
--
-- Fix: Convert columns to TIMESTAMP (without time zone). For existing rows,
-- AT TIME ZONE 'UTC' extracts the wall-clock representation in UTC, which is
-- exactly the literal value the customer originally typed. New inserts skip
-- the UTC interpretation entirely — Postgres stores the string as-is.

ALTER TABLE bookings
  ALTER COLUMN check_in  TYPE TIMESTAMP USING (check_in  AT TIME ZONE 'UTC'),
  ALTER COLUMN check_out TYPE TIMESTAMP USING (check_out AT TIME ZONE 'UTC');
