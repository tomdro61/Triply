import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

const hub = {
  keyword: 'seattle airport parking',
  airportCode: 'SEA',
  slug: 'seattle-airport-parking',
  articleType: 'hub',
  priority: 'S1',
  status: 'queued',
  searchVolume: 5400,
  seoDifficulty: 54,
  targetWords: 4500,
  notes: 'Main hub page — comprehensive guide to Seattle-Tacoma International Airport (SEA/SeaTac) parking. Cover all garage terminal levels, general parking, off-site (WallyPark, MasterPark, Doug Fox), hotel park-and-fly, and link to all sub-pillars once defined.',
}

const r = await fetch(`${CMS}/api/content-queue`, { method: 'POST', headers: h, body: JSON.stringify(hub) })
if (!r.ok) {
  const body = await r.text()
  if (body.includes('duplicate') || body.includes('unique')) {
    console.log(`Hub already exists. Skipping.`)
  } else {
    console.error(`Failed: ${r.status} ${body}`)
    process.exit(1)
  }
} else {
  const d = await r.json()
  console.log(`✓ Created SEA hub "${hub.slug}" → id: ${d.doc?.id}`)
}
