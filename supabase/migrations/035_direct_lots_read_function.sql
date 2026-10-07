-- Migration 035: the main app's read path for direct lots (plan B2 → gate: a
-- late-bound SECURITY INVOKER function, not a view).
--
-- Direct lots are edited in the Payload CMS and stored in the `payload` schema of
-- THIS database (payload.config.ts: schemaName 'payload'). The app reads them
-- here, through the service role, instead of over HTTP to cms.triplypro.com —
-- so the CMS and its API key are off every request path. A plpgsql function is
-- late-bound: Payload's own migrations can alter these tables without being
-- blocked by a dependent view (and drizzle's DROP … CASCADE cannot silently
-- remove it). If Payload renames a column, this function errors at CALL time
-- and the app's `direct/store.ts` integration test catches it.
--
-- Apply AFTER the CMS migration 20261005_add_lots (the tables must exist),
-- BEFORE the app code that calls it. Re-run-safe. NOTE: a RETURNS TABLE signature
-- cannot be changed by CREATE OR REPLACE — adding a column later means DROP +
-- CREATE + re-GRANT, with a window where rpc() 404s. Hence the full column set
-- (incl. content/SEO) is returned from the start.
SET lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.direct_lots(TEXT, INTEGER);

GRANT USAGE ON SCHEMA payload TO service_role;
GRANT SELECT ON payload.lots, payload.lots_rels, payload.lots_notification_emails,
                payload.lots_gallery, payload.lots_faqs, payload.lot_amenities, payload.media
  TO service_role;

CREATE OR REPLACE FUNCTION public.direct_lots(p_airport_code TEXT DEFAULT NULL, p_id INTEGER DEFAULT NULL)
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
  updated_at TIMESTAMPTZ
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
    l.updated_at
  FROM payload.lots l
  LEFT JOIN payload.media fm ON fm.id = l.featured_image_id
  WHERE (p_airport_code IS NULL OR l.airport_code = p_airport_code)
    AND (p_id IS NULL OR l.id = p_id)
  ORDER BY l.name;
END;
$$;

-- Only the server (service role) may call it. The function body runs with the
-- caller's rights (SECURITY INVOKER), so anon/authenticated could not read the
-- payload tables even if they could call it — and they cannot call it.
REVOKE ALL ON FUNCTION public.direct_lots(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.direct_lots(TEXT, INTEGER) TO service_role;

NOTIFY pgrst, 'reload schema';

-- media.url is a RELATIVE CMS path (/api/media/file/<name>) served through
-- cms.triplypro.com with Media read public (A-13): the store resolves it with
-- resolveCmsImageUrl. PostgREST returns numeric columns as JSON numbers.
-- Verify:
--   SELECT count(*) FROM public.direct_lots();                       -- 0 until the first lot
--   SELECT has_function_privilege('anon', 'public.direct_lots(text,integer)', 'EXECUTE');          -- false
--   SELECT has_function_privilege('service_role', 'public.direct_lots(text,integer)', 'EXECUTE');  -- true
-- Rollback: DROP FUNCTION IF EXISTS public.direct_lots(TEXT, INTEGER);  (grants on payload.* can stay)
