import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const API_URL = process.env.RESLAB_API_URL || 'https://api.reservationslab.com/v1';
const API_KEY = process.env.RESLAB_API_KEY;
const API_DOMAIN = process.env.RESLAB_API_DOMAIN || 'triplypro.com';

const resNum = process.argv[2];
if (!resNum) {
  console.error('Usage: node scripts/inspect-reslab.mjs <RES_NUMBER>');
  process.exit(1);
}

const authRes = await fetch(`${API_URL}/authenticate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: API_KEY, domain: API_DOMAIN }),
});
const { token } = await authRes.json();

const res = await fetch(`${API_URL}/reservations/${resNum}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const data = await res.json();
const h = data.history?.[0];
console.log('History[0] (most recent):');
console.log(JSON.stringify({
  reserved_for: h?.reserved_for,
  subtotal: h?.subtotal,
  tax_total: h?.tax_total,
  fees_total: h?.fees_total,
  grand_total: h?.grand_total,
  dates: h?.dates,
}, null, 2));
