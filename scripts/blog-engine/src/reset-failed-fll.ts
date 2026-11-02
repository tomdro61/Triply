import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

let resetCount = 0
for (const status of ['error', 'generating']) {
  const r = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=FLL&where[status][equals]=${status}&limit=100&depth=0`, { headers: h })
  const d = await r.json()
  const items = d.docs || []
  if (items.length === 0) continue

  console.log(`Found ${items.length} FLL items in ${status} status:\n`)
  for (const item of items) {
    console.log(`  ${item.slug} (ID: ${item.id})`)
    const p = await fetch(`${CMS}/api/content-queue/${item.id}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ status: 'queued', errorMessage: '' }),
    })
    const pd = await p.json()
    console.log(`    ✓ Reset to: ${pd.doc?.status}`)
    resetCount++
  }
}

const r2 = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=FLL&where[status][equals]=queued&limit=0&depth=0`, { headers: h })
const d2 = await r2.json()
console.log(`\nReset ${resetCount} item(s). ${d2.totalDocs} FLL items now in queued status.`)
