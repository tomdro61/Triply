-- =============================================
-- Newsletter signup attribution
-- =============================================
-- Records WHERE a subscriber signed up, so the email capture at the end of
-- every blog article can be measured against the homepage form:
--   source       'blog' | 'homepage' | ... (short slug, [a-z0-9_-])
--   airport_code the article's airport, when it is one we can sell
--   page         the article slug the signup came from
--
-- Safe to apply in either deploy order: /api/newsletter writes source/
-- airport_code/page in a separate best-effort UPDATE that is console.warn'ed
-- and swallowed if the columns do not exist yet, so signups keep working
-- before this runs.
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
