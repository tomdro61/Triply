-- Triply: Split booking total into what was charged online vs owed at the lot
-- Migration 006

-- Some ResLab lots only charge a portion of the total online (service fee +
-- taxes + a deposit) and collect the rest when the customer arrives. Without
-- this column, the admin dashboard can't tell what Stripe actually captured
-- and mislabels the full booking amount as "Total charged".
ALTER TABLE bookings
  ADD COLUMN due_at_location DECIMAL(10, 2) DEFAULT 0 NOT NULL;
