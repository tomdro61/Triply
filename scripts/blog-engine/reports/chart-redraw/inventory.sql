-- Chart redraw, step 1 (read-only): the chart images from October 2026 on, and every post block that shows one.
-- Run once against the CMS database in a READ ONLY transaction (the REST API cannot search inside post content:
-- `like` on content returns 500, and a JSON-path match compares the media id as a string). Save the rows as JSON to
-- reports/chart-redraw/out/inventory-raw.json, then run classify.mts. Returns ids and the posts' plain text (~30 MB),
-- not their Lexical JSON.
--
-- Scope: media created from October 2026 on that are one of the two chart families (`<code>-parking-rates-<hash>`,
-- written by reports/lot-rewrite/publish.mts; `<code>-infographic-<n>-<ms>`, written by the engine) or whose alt
-- (= the visible caption) mentions Triply / bookable / a 7-day figure. `context` = the text of the 3 blocks before
-- and after the image (for the excerpt Tom reads); `post_text` = the whole post, for the text check.
with scope as (
  select id, filename, alt, created_at from payload.media
  -- From October on, with no end date: until the engine change is merged, the old engine can still make undated
  -- `-infographic-` price charts; redrawn `-rate-chart-` images are included so the monthly re-run finds them.
  where created_at >= '2026-10-01'
    and (filename like '%-parking-rates-%' or filename like '%-infographic-%' or filename like '%-rate-chart-%'
         or alt ilike '%triply%' or alt ilike '%bookable%' or alt ilike '%7 days%' or alt ilike '%7-day%' or alt ilike '%7 nights%')
), ups as (
  select p.id as post_id, p.slug, p.status::text as status, p.airport_code, p.updated_at, (t.ord - 1)::int as block_index,
    case jsonb_typeof(t.c->'value')
      when 'number' then (t.c->>'value')::int
      when 'object' then case when (t.c->'value'->>'id') ~ '^[0-9]+$' then (t.c->'value'->>'id')::int end
      when 'string' then case when (t.c->>'value') ~ '^[0-9]+$' then (t.c->>'value')::int end
    end as media_id,
    p.content
  from payload.posts p, jsonb_array_elements(p.content->'root'->'children') with ordinality t(c, ord)
  where t.c->>'type' = 'upload'
), used as (
  select u.post_id, u.slug, u.status, u.airport_code, u.updated_at, u.block_index, u.media_id,
    (select string_agg(coalesce((select string_agg(x #>> '{}', ' ') from jsonb_path_query(b.c, 'strict $.**.text') x), ''), ' || ' order by b.ord)
       from jsonb_array_elements(u.content->'root'->'children') with ordinality b(c, ord)
       where (b.ord - 1) between u.block_index - 3 and u.block_index + 3 and (b.ord - 1) <> u.block_index) as context,
    -- The whole post's text (every block but images): the text check reads all of it — a ±3-block window ended just
    -- before "Here's a direct comparison:" tables in 72 of 173 proposed swaps (review pass 4).
    (select string_agg(coalesce((select string_agg(x #>> '{}', ' ') from jsonb_path_query(b.c, 'strict $.**.text') x), ''), ' || ' order by b.ord)
       from jsonb_array_elements(u.content->'root'->'children') with ordinality b(c, ord)
       where b.c->>'type' <> 'upload') as post_text
  from ups u join scope s on s.id = u.media_id
)
select s.id as media_id, s.filename, s.alt, s.created_at,
  coalesce(json_agg(json_build_object('post_id', u.post_id, 'slug', u.slug, 'status', u.status, 'airport', u.airport_code,
    'updated_at', u.updated_at, 'block', u.block_index, 'context', u.context, 'post_text', u.post_text) order by u.post_id, u.block_index)
    filter (where u.post_id is not null), '[]') as uses,
  (select json_agg(json_build_object('post_id', p.id, 'slug', p.slug, 'status', p.status::text)) from payload.posts p where p.featured_image_id = s.id) as featured_in
from scope s left join used u on u.media_id = s.id
group by s.id, s.filename, s.alt, s.created_at
order by s.id
