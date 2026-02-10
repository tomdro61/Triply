-- Triply Pre-Launch: Promo Codes + Newsletter Subscribers
-- Migration 002

-- =============================================
-- PROMO_CODES TABLE
-- Server-side promo code validation (replaces client-side hardcoded codes)
-- =============================================
CREATE TABLE promo_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  discount_percent INTEGER NOT NULL CHECK (discount_percent > 0 AND discount_percent <= 100),
  active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,  -- null = never expires
  max_uses INTEGER,        -- null = unlimited
  current_uses INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_promo_codes_code ON promo_codes(code);

-- Seed initial promo codes (migrated from client-side hardcoded values)
INSERT INTO promo_codes (code, discount_percent, active) VALUES
  ('SAVE10', 10, true),
  ('SAVE20', 20, true),
  ('TRIPLY', 15, true);

-- =============================================
-- NEWSLETTER_SUBSCRIBERS TABLE
-- =============================================
CREATE TABLE newsletter_subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  promo_code_id UUID REFERENCES promo_codes(id) ON DELETE SET NULL,
  subscribed_at TIMESTAMPTZ DEFAULT NOW(),
  unsubscribed_at TIMESTAMPTZ
);

CREATE INDEX idx_newsletter_subscribers_email ON newsletter_subscribers(email);

-- =============================================
-- RLS for promo_codes (read-only for anon, full access for service role)
-- =============================================
ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;

-- Allow read access for validation lookups (service role bypasses RLS anyway)
CREATE POLICY "Allow read promo codes"
  ON promo_codes FOR SELECT
  USING (true);

-- =============================================
-- RLS for newsletter_subscribers
-- =============================================
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage newsletter subscribers"
  ON newsletter_subscribers FOR ALL
  USING (true)
  WITH CHECK (true);
