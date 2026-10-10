import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

const resNum = process.argv[2];
if (!resNum) {
  console.error('Usage: node scripts/inspect-booking.mjs <RES_NUMBER>');
  process.exit(1);
}
// Supabase-only (no ResLab call), so a direct-lot booking is read like any other.
// Say so, because the ResLab-side scripts refuse these numbers.
if (/^TRP-/i.test(resNum.trim())) {
  console.error(`Note: ${resNum} is a Triply direct-lot booking — no ResLab reservation exists (the ResLab scripts refuse it); see OPERATIONS_RUNBOOK direct-lots section.`);
}

const { data, error } = await supabase
  .from('bookings')
  .select('*')
  .eq('reslab_reservation_number', resNum)
  .single();

if (error) {
  console.error(error);
  process.exit(1);
}

console.log(JSON.stringify(data, null, 2));
