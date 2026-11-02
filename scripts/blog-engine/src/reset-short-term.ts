import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

// Find the short-term queue item
const r = await fetch(`${CMS}/api/content-queue?where[slug][equals]=laguardia-airport-parking-short-term&depth=0`, { headers: h })
const d = await r.json()
const item = d.docs?.[0]

if (!item) {
  console.log('Queue item not found')
  process.exit(1)
}

console.log(`Found: ID ${item.id} | Status: ${item.status} | Keyword: ${item.keyword}`)

// Reset to queued
const p = await fetch(`${CMS}/api/content-queue/${item.id}`, {
  method: 'PATCH',
  headers: h,
  body: JSON.stringify({ status: 'queued', errorMessage: '' }),
})
const pd = await p.json()
console.log(`Reset to: ${pd.doc?.status}`)
