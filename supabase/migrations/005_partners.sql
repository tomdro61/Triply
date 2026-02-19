-- Partners Table
-- Stores partner (lot operator) accounts for the partner dashboard
-- Run this in Supabase SQL Editor

-- =============================================
-- PARTNERS TABLE
-- =============================================
CREATE TABLE partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  reslab_location_id INTEGER UNIQUE NOT NULL,
  location_name TEXT NOT NULL,
  company_name TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE UNIQUE INDEX idx_partners_user_id ON partners(user_id);
CREATE UNIQUE INDEX idx_partners_reslab_location_id ON partners(reslab_location_id);
CREATE INDEX idx_partners_email ON partners(email);

-- Index on bookings.reslab_location_id for partner queries
CREATE INDEX idx_bookings_reslab_location_id ON bookings(reslab_location_id);

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================
ALTER TABLE partners ENABLE ROW LEVEL SECURITY;

-- Partners can view their own record
CREATE POLICY "Partners can view own record"
  ON partners FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies — only service role can modify

-- =============================================
-- UPDATED_AT TRIGGER
-- =============================================
CREATE TRIGGER update_partners_updated_at
  BEFORE UPDATE ON partners
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
