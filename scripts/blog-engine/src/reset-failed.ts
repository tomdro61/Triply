import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

// Find all LGA items in error status
const r = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=LGA&where[status][equals]=error&limit=50&depth=0`, { headers: h })
const d = await r.json()
const items = d.docs || []

console.log(`Found ${items.length} failed LGA queue items:\n`)

for (const item of items) {
  console.log(`  ${item.slug} (ID: ${item.id})`)
  const p = await fetch(`${CMS}/api/content-queue/${item.id}`, {
    method: 'PATCH',
    headers: h,
    body: JSON.stringify({ status: 'queued', errorMessage: '' }),
  })
  const pd = await p.json()
  console.log(`    ✓ Reset to: ${pd.doc?.status}`)
}

// Also check for any still queued
const r2 = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=LGA&where[status][equals]=queued&limit=50&depth=0`, { headers: h })
const d2 = await r2.json()
console.log(`\n${d2.totalDocs} LGA items now in queued status`)
