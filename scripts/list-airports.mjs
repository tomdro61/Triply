import { config } from 'dotenv';
config({ path: '.env.local' });

const API_URL = process.env.RESLAB_API_URL || 'https://api.reservationslab.com/v1';
const API_KEY = process.env.RESLAB_API_KEY;
const DOMAIN = process.env.RESLAB_API_DOMAIN || 'triplypro.com';

const authRes = await fetch(`${API_URL}/authenticate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: API_KEY, domain: DOMAIN }),
});
const { token } = await authRes.json();

let page = 1;
let allLocations = [];
while (true) {
  const res = await fetch(`${API_URL}/locations?page=${page}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  allLocations = allLocations.concat(data.data);
  if (page >= data.last_page) break;
  page++;
}

const airportCodes = new Map();
for (const loc of allLocations) {
  if (loc.name.startsWith('TEST')) continue;
  const match = loc.name.match(/\(([A-Z]{3})\)/);
  if (!match) continue;
  const code = match[1];
  if (!airportCodes.has(code)) {
    airportCodes.set(code, {
      code,
      city: loc.city,
      state: loc.state?.name,
      stateCode: loc.state?.code,
      country: loc.country?.name,
      lat: loc.latitude,
      lng: loc.longitude,
      count: 1,
    });
  } else {
    airportCodes.get(code).count++;
  }
}

const sorted = [...airportCodes.values()].sort((a, b) => a.code.localeCompare(b.code));
sorted.forEach((a) => console.log(JSON.stringify(a)));
console.log('Total unique airports:', sorted.length);
