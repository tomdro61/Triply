import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const API_URL = process.env.RESLAB_API_URL || 'https://api.reservationslab.com/v1';
const API_KEY = process.env.RESLAB_API_KEY;
const API_DOMAIN = process.env.RESLAB_API_DOMAIN || 'triplypro.com';

async function run() {
  const authRes = await fetch(API_URL + '/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: API_KEY, domain: API_DOMAIN })
  });
  const authData = await authRes.json();
  const token = authData.token;
  console.log('Auth OK\n');

  // Test multiple airports
  const airports = [
    { code: 'JFK', lat: 40.6413, lng: -73.7781 },
    { code: 'DFW', lat: 32.8998, lng: -97.0403 },
    { code: 'LAX', lat: 33.9416, lng: -118.4085 },
    { code: 'BOS', lat: 42.3656, lng: -71.0096 },
  ];

  for (const apt of airports) {
    const searchRes = await fetch(API_URL + '/locations?lat=' + apt.lat + '&lng=' + apt.lng, {
      headers: { Authorization: 'Bearer ' + token }
    });
    const locations = await searchRes.json();
    const count = Array.isArray(locations) ? locations.length : 0;
    console.log(apt.code + ': ' + count + ' locations');

    if (count > 0) {
      // Test pricing with May dates
      const loc = locations[0];
      try {
        const priceRes = await fetch(API_URL + '/locations/' + loc.id + '/min-price', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            items: [{
              type: 'parking',
              reservation_type: 'parking',
              from_date: '2026-05-21 10:00:00',
              to_date: '2026-05-24 14:00:00',
              number_of_spots: 1
            }]
          })
        });
        const priceData = await priceRes.json();
        console.log('  ' + loc.name + ' (May 21-24): $' + (priceData.reservation?.grand_total || 0));
      } catch (err) {
        console.log('  Price error:', err.message);
      }
    }
  }
}

run().catch(e => console.error(e));
