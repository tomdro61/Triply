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
