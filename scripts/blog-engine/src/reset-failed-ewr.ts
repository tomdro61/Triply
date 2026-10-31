import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })
const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }
const r = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=EWR&where[status][equals]=error&limit=50&depth=0`, { headers: h })
const d = await r.json()
for (const item of d.docs || []) {
  await fetch(`${CMS}/api/content-queue/${item.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ status: 'queued', errorMessage: '' }) })
  console.log(`  ✓ Reset ${item.slug}`)
}
console.log(`\nReset ${d.docs?.length || 0} items`)
