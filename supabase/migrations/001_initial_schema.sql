-- Triply MVP Database Schema
-- Run this in Supabase SQL Editor

-- =============================================
-- CUSTOMERS TABLE
-- Stores customer info for both guests and registered users
-- =============================================
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for looking up customers by email (for linking guest bookings later)
CREATE INDEX idx_customers_email ON customers(email);

-- Index for looking up customers by user_id (for logged-in users)
CREATE INDEX idx_customers_user_id ON customers(user_id);

-- =============================================
-- BOOKINGS TABLE
-- Stores all reservations (guest and logged-in)
-- =============================================
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,

  -- ResLab reference
  reslab_reservation_number TEXT UNIQUE NOT NULL,
  reslab_location_id INTEGER NOT NULL,

  -- Location info (denormalized for history)
  location_name TEXT NOT NULL,
  location_address TEXT,
  airport_code TEXT,

  -- Booking dates
  check_in TIMESTAMPTZ NOT NULL,
  check_out TIMESTAMPTZ NOT NULL,

  -- Pricing (stored at time of booking)
  subtotal DECIMAL(10, 2),
  tax_total DECIMAL(10, 2),
  fees_total DECIMAL(10, 2),
  grand_total DECIMAL(10, 2) NOT NULL,

  -- Vehicle info (stored as JSON)
  vehicle_info JSONB,

  -- Status
  status TEXT DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed')),

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for looking up bookings by customer
CREATE INDEX idx_bookings_customer_id ON bookings(customer_id);

-- Index for looking up bookings by ResLab number
CREATE INDEX idx_bookings_reslab_number ON bookings(reslab_reservation_number);

-- Index for looking up bookings by status
CREATE INDEX idx_bookings_status ON bookings(status);

-- Index for recent bookings
CREATE INDEX idx_bookings_created_at ON bookings(created_at DESC);

-- =============================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================

-- Enable RLS on both tables
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- Customers: Users can only see their own customer record
CREATE POLICY "Users can view own customer record"
  ON customers FOR SELECT
  USING (auth.uid() = user_id);

-- Customers: Allow insert for anyone (guest checkout)
CREATE POLICY "Anyone can create customer record"
  ON customers FOR INSERT
  WITH CHECK (true);

-- Customers: Users can update their own record
CREATE POLICY "Users can update own customer record"
  ON customers FOR UPDATE
  USING (auth.uid() = user_id);

-- Bookings: Users can view their own bookings (via customer link)
CREATE POLICY "Users can view own bookings"
  ON bookings FOR SELECT
  USING (
    customer_id IN (
      SELECT id FROM customers WHERE user_id = auth.uid()
    )
  );

-- Bookings: Allow insert for anyone (guest checkout uses service role)
CREATE POLICY "Service role can insert bookings"
  ON bookings FOR INSERT
  WITH CHECK (true);

-- =============================================
-- UPDATED_AT TRIGGER
-- =============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for customers
CREATE TRIGGER update_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Trigger for bookings
CREATE TRIGGER update_bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- DONE
-- =============================================
-- Tables created:
--   - customers (stores guest + registered user info)
--   - bookings (stores all reservations)
--
-- Next steps:
--   1. Enable Email auth in Supabase Auth settings
--   2. Enable Google OAuth in Supabase Auth settings
