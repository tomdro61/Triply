-- Booking window 60 -> 100 days (ResLab, verified live 2026-09-17).
--
-- booking_waitlist.opens_on was stored at signup as wanted_checkin - 60 days.
-- With the window at 100 days those trips become bookable 40 days earlier, so
-- every row not yet emailed would be notified up to 40 days late. Recompute
-- them against the new window. Rows whose new opens_on is already past are
-- bookable today and are picked up by the next waitlist-notify run
-- (opens_on <= today AND notified_at IS NULL).
--
-- Rows already notified are left alone. Idempotent: re-running changes nothing.

UPDATE booking_waitlist
SET opens_on = wanted_checkin - 100
WHERE notified_at IS NULL
  AND opens_on <> wanted_checkin - 100;
