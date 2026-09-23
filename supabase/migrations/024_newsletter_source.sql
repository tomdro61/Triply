-- =============================================
-- Newsletter signup attribution
-- =============================================
-- Records WHERE a subscriber signed up, so the email capture at the end of
-- every blog article can be measured against the homepage form:
--   source       'blog' | 'homepage' | ... (short slug, [a-z0-9_-])
--   airport_code the article's airport, when it is one we can sell
--   page         the article slug the signup came from
--
-- Deploy order: /api/newsletter writes source/airport_code/page in a
-- separate best-effort UPDATE that tolerates 42703/PGRST204 (column not
-- found) and is console.warn'ed and swallowed, so signups keep working if
-- this migration runs AFTER the code deploys.
--
-- welcome_sent_at is NOT the same story: it is read in the route's main
-- subscriber SELECT, and an unknown column fails that whole query, not just
-- one write. The route retries that SELECT once without the column on
-- 42703/PGRST204, so signups keep working in that window — but it does NOT
-- behave the way it will once this migration lands, and the earlier claim
-- here that it "degrades safely either order" was wrong:
--   * welcome_sent_at cannot be READ, so the 7-day cooldown cannot be
--     evaluated, and it cannot be WRITTEN either, so it could never arm.
--   * The route therefore treats an unreadable cooldown as ACTIVE for that
--     request: an already-subscribed address still gets the usual 200, but
--     no welcome email is resent and no code re-minted until this migration
--     is applied. Reading it as "never sent" instead is what would turn the
--     endpoint into an on-demand mailer for any known address for the length
--     of the deploy window, bounded only by the per-IP limiters.
-- Apply this migration BEFORE deploying the code that depends on it. That
-- order needs no tolerance at all and is the only one with full behaviour.
--
-- welcome_sent_at: when the welcome email (with the live promo code) was last
-- sent to this address. Pass 2 review (PR #23): re-minting a fresh code on
-- every resubmission made the one-time 10% code renewable forever and turned
-- the endpoint into an on-demand mailer for any address. The route now only
-- re-mints an expired/inactive code that has never been redeemed
-- (current_uses = 0), and refuses to mint/send again at all while
-- welcome_sent_at is inside a 7-day cooldown.

ALTER TABLE newsletter_subscribers
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS airport_code TEXT,
  ADD COLUMN IF NOT EXISTS page TEXT,
  ADD COLUMN IF NOT EXISTS welcome_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_source
  ON newsletter_subscribers(source);

-- The homepage form now sends source: "homepage" going forward; backfill
-- pre-existing rows (all NULL) so the blog-vs-homepage comparison this table
-- exists for isn't polluted by rows that predate attribution.
UPDATE newsletter_subscribers SET source = 'legacy' WHERE source IS NULL;

-- PostgREST caches the schema; without this, the first write of these new
-- columns after deploy returns PGRST204 ("column not found in schema cache")
-- until the cache reloads on its own — see 023 and route.ts's deploy-window
-- handling.
NOTIFY pgrst, 'reload schema';
