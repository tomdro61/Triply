-- Migration 036: direct lots — oversized-vehicle surcharge (plan
-- notes/2026-10-09-direct-lots-vehicle-surcharge-plan.md §1.2/§1.3 + review R3/R9).
--
-- 1. public.direct_lots_v2(): the 035 read function PLUS `vehicle_surcharges`.
--    A NEW function, not a change to direct_lots(): the app parses each row with
--    a .strict() schema, so an extra column on the live function would make every
--    lot unreadable until the new code ships (and a RETURNS TABLE change needs
--    DROP + CREATE, a window where rpc() 404s). The app switches to v2 in the
--    Phase 3 PR; direct_lots() is dropped by a later cleanup migration.
-- 2. vehicle_* columns on pending_bookings + bookings. The surcharge is PAID AT
--    THE LOT and is an estimate from the customer's declaration, so it is kept
--    OUT of every money column (subtotal / tax_total / grand_total /
--    due_at_location keep their meaning: the online sale). NULL on ResLab rows.
--    These columns are customer-readable through the bookings RLS policy —
--    acceptable: it is the customer's own declaration (not private staff data).
--
-- Apply AFTER the CMS migration 20261009_add_lot_vehicle_surcharges (the payload
-- table must exist), BEFORE the app code that calls direct_lots_v2(). Precondition
-- for the VALID CHECKs: no direct rows exist yet —
--   SELECT (SELECT count(*) FROM bookings WHERE inventory_source = 'direct')
--        + (SELECT count(*) FROM pending_bookings WHERE inventory_source = 'direct');  -- 0
-- Re-run-safe.
BEGIN;
SET LOCAL lock_timeout = '3s';

-- 1. Read function ------------------------------------------------------------
GRANT SELECT ON payload.lots_vehicle_surcharges TO service_role;

DROP FUNCTION IF EXISTS public.direct_lots_v2(TEXT, INTEGER);

CREATE FUNCTION public.direct_lots_v2(p_airport_code TEXT DEFAULT NULL, p_id INTEGER DEFAULT NULL)
RETURNS TABLE (
  id INTEGER,
  name TEXT,
  slug TEXT,
  airport_code TEXT,
  reslab_location_id INTEGER,
  description_short TEXT,
  content JSONB,
  seo_meta_title TEXT,
  seo_meta_description TEXT,
  featured_image_url TEXT,
  featured_image_alt TEXT,
  gallery_urls TEXT[],
  distance_to_terminal_minutes NUMERIC,
  shuttle_details TEXT,
  shuttle_phone TEXT,
  address_street TEXT,
  address_city TEXT,
  address_state TEXT,
  address_zip TEXT,
  lat NUMERIC,
  lng NUMERIC,
  booking_instructions JSONB,
  faqs JSONB,
  amenities JSONB,
  is_active BOOLEAN,
  visibility TEXT,
  min_stay_days NUMERIC,
  min_lead_hours NUMERIC,
  base_daily_rate NUMERIC,
  tax_rate_percent NUMERIC,
  tax_collected_by TEXT,
  partner_share_percent NUMERIC,
  notification_emails TEXT[],
  status TEXT,
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  vehicle_surcharges JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, payload
AS $$
BEGIN
  RETURN QUERY
  SELECT
    l.id,
    l.name::text,
    l.slug::text,
    l.airport_code::text,
    l.reslab_location_id::integer,
    l.description_short::text,
    l.content,
    l.seo_meta_title::text,
    l.seo_meta_description::text,
    fm.url::text,
    fm.alt::text,
    COALESCE((
      SELECT array_agg(gm.url::text ORDER BY g._order)
        FROM payload.lots_gallery g
        JOIN payload.media gm ON gm.id = g.image_id
       WHERE g._parent_id = l.id AND gm.url IS NOT NULL  -- a media row mid-upload must not blank the gallery
    ), ARRAY[]::text[]),
    l.distance_to_terminal_minutes,
    l.shuttle_details::text,
    l.shuttle_phone::text,
    l.address_street::text,
    l.address_city::text,
    l.address_state::text,
    l.address_zip::text,
    l.coordinates_lat,
    l.coordinates_lng,
    jsonb_build_object(
      'beforeArrival',    l.booking_instructions_before_arrival,
      'whenYouArrive',    l.booking_instructions_when_you_arrive,
      'importantNotes',   l.booking_instructions_important_notes,
      'whenYouReturn',    l.booking_instructions_when_you_return,
      'gettingToAirport', l.booking_instructions_getting_to_airport
    ),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('question', f.question, 'answer', f.answer) ORDER BY f._order)
        FROM payload.lots_faqs f WHERE f._parent_id = l.id
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'icon', a.icon) ORDER BY r."order")
        FROM payload.lots_rels r
        JOIN payload.lot_amenities a ON a.id = r.lot_amenities_id
       WHERE r.parent_id = l.id AND r.path = 'amenities'
    ), '[]'::jsonb),
    COALESCE(l.is_active, false),
    l.visibility::text,
    l.min_stay_days,
    l.min_lead_hours,
    ROUND(l.base_daily_rate, 2),
    l.tax_rate_percent,
    l.tax_collected_by::text,
    l.partner_share_percent,
    COALESCE((
      SELECT array_agg(e.email::text ORDER BY e._order)
        FROM payload.lots_notification_emails e WHERE e._parent_id = l.id
    ), ARRAY[]::text[]),
    l.status::text,
    l.published_at,
    l.updated_at,
    -- Raw values (no ROUND): the app's strict parser decides what is valid, and a
    -- bad row must make the lot unreadable, never be silently "fixed" here.
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('code', s.code, 'label', s.label, 'dailyRate', s.daily_rate) ORDER BY s._order)
        FROM payload.lots_vehicle_surcharges s WHERE s._parent_id = l.id
    ), '[]'::jsonb)
  FROM payload.lots l
  LEFT JOIN payload.media fm ON fm.id = l.featured_image_id
  WHERE (p_airport_code IS NULL OR l.airport_code = p_airport_code)
    AND (p_id IS NULL OR l.id = p_id)
  ORDER BY l.name;
END;
$$;

REVOKE ALL ON FUNCTION public.direct_lots_v2(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.direct_lots_v2(TEXT, INTEGER) TO service_role;

-- 2. Booking columns ------------------------------------------------------------
-- vehicle_size: the lot's surcharge code, or 'none' ("No oversized vehicle").
-- vehicle_size_label: the label the customer saw (snapshot).
-- vehicle_surcharge_cents / _tax_cents: the at-lot ESTIMATE, computed server-side
--   from the PaymentIntent metadata rates (review R5) × the billed days.
-- vehicle_size_source: where the customer made the choice — 'modal' (Reserve
--   pop-up) or 'checkout' (picked on the checkout page, e.g. an old link) (R8).
ALTER TABLE pending_bookings
  ADD COLUMN IF NOT EXISTS vehicle_size TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_size_label TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_surcharge_cents INTEGER,
  ADD COLUMN IF NOT EXISTS vehicle_surcharge_tax_cents INTEGER,
  ADD COLUMN IF NOT EXISTS vehicle_size_source TEXT;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS vehicle_size TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_size_label TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_surcharge_cents INTEGER,
  ADD COLUMN IF NOT EXISTS vehicle_surcharge_tax_cents INTEGER,
  ADD COLUMN IF NOT EXISTS vehicle_size_source TEXT;

-- One CHECK per table, added VALID (R9). Every predicate carries IS NOT NULL
-- where it matters: in a CHECK, NULL counts as PASS.
--   ResLab rows: every vehicle_* column NULL.
--   Direct rows: every column set; code format; 'none' ⇔ 0 + 0; any other size
--   ⇔ a positive surcharge; tax never negative; source is modal | checkout.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pending_bookings'::regclass AND conname = 'pending_bookings_vehicle_size_check') THEN
    ALTER TABLE pending_bookings ADD CONSTRAINT pending_bookings_vehicle_size_check CHECK (
      (inventory_source = 'reslab'
        AND vehicle_size IS NULL AND vehicle_size_label IS NULL
        AND vehicle_surcharge_cents IS NULL AND vehicle_surcharge_tax_cents IS NULL
        AND vehicle_size_source IS NULL)
      OR
      (inventory_source = 'direct'
        AND vehicle_size IS NOT NULL AND vehicle_size ~ '^[a-z0-9_]{1,32}$'
        AND vehicle_size_label IS NOT NULL AND length(vehicle_size_label) BETWEEN 1 AND 60
        AND vehicle_surcharge_cents IS NOT NULL AND vehicle_surcharge_tax_cents IS NOT NULL
        AND vehicle_surcharge_tax_cents >= 0
        AND vehicle_size_source IS NOT NULL AND vehicle_size_source IN ('modal', 'checkout')
        AND ((vehicle_size = 'none' AND vehicle_surcharge_cents = 0 AND vehicle_surcharge_tax_cents = 0)
          OR (vehicle_size <> 'none' AND vehicle_surcharge_cents > 0)))
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.bookings'::regclass AND conname = 'bookings_vehicle_size_check') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_vehicle_size_check CHECK (
      (inventory_source = 'reslab'
        AND vehicle_size IS NULL AND vehicle_size_label IS NULL
        AND vehicle_surcharge_cents IS NULL AND vehicle_surcharge_tax_cents IS NULL
        AND vehicle_size_source IS NULL)
      OR
      (inventory_source = 'direct'
        AND vehicle_size IS NOT NULL AND vehicle_size ~ '^[a-z0-9_]{1,32}$'
        AND vehicle_size_label IS NOT NULL AND length(vehicle_size_label) BETWEEN 1 AND 60
        AND vehicle_surcharge_cents IS NOT NULL AND vehicle_surcharge_tax_cents IS NOT NULL
        AND vehicle_surcharge_tax_cents >= 0
        AND vehicle_size_source IS NOT NULL AND vehicle_size_source IN ('modal', 'checkout')
        AND ((vehicle_size = 'none' AND vehicle_surcharge_cents = 0 AND vehicle_surcharge_tax_cents = 0)
          OR (vehicle_size <> 'none' AND vehicle_surcharge_cents > 0)))
    );
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- Verify:
--   SELECT count(*) FROM public.direct_lots_v2();                                   -- = count(*) FROM public.direct_lots()
--   SELECT id, vehicle_surcharges FROM public.direct_lots_v2();                      -- lot 1: [] until the CMS rows exist
--   SELECT has_function_privilege('anon', 'public.direct_lots_v2(text,integer)', 'EXECUTE');          -- false
--   SELECT has_function_privilege('authenticated', 'public.direct_lots_v2(text,integer)', 'EXECUTE'); -- false
--   SELECT has_function_privilege('service_role', 'public.direct_lots_v2(text,integer)', 'EXECUTE');  -- true
--   SELECT conname, convalidated FROM pg_constraint
--    WHERE conname IN ('pending_bookings_vehicle_size_check', 'bookings_vehicle_size_check');         -- 2 rows, both true
-- Rollback (nothing reads these until the Phase 3 app code ships):
--   ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_vehicle_size_check;
--   ALTER TABLE pending_bookings DROP CONSTRAINT IF EXISTS pending_bookings_vehicle_size_check;
--   ALTER TABLE bookings DROP COLUMN IF EXISTS vehicle_size, DROP COLUMN IF EXISTS vehicle_size_label,
--     DROP COLUMN IF EXISTS vehicle_surcharge_cents, DROP COLUMN IF EXISTS vehicle_surcharge_tax_cents,
--     DROP COLUMN IF EXISTS vehicle_size_source;   (same for pending_bookings)
--   DROP FUNCTION IF EXISTS public.direct_lots_v2(TEXT, INTEGER);
