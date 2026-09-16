-- =============================================
-- Newsletter signup attribution
-- =============================================
-- Records WHERE a subscriber signed up, so the email capture at the end of
-- every blog article can be measured against the homepage form:
--   source       'blog' | 'homepage' | ... (short slug, [a-z0-9_-])
--   airport_code the article's airport, when it is one we can sell
--   page         the article slug the signup came from
--
-- Safe to apply in either deploy order: /api/newsletter writes these columns
-- in a separate best-effort UPDATE that is console.warn'ed and swallowed if
-- the columns do not exist yet, so signups keep working before this runs.

ALTER TABLE newsletter_subscribers
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS airport_code TEXT,
  ADD COLUMN IF NOT EXISTS page TEXT;

CREATE INDEX IF NOT EXISTS idx_newsletter_subscribers_source
  ON newsletter_subscribers(source);
