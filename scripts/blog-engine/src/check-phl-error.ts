import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })
const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

const r = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=PHL&where[status][equals]=error&limit=10&depth=0`, { headers: h })
const d = await r.json()
for (const it of d.docs || []) {
  console.log(`  #${it.id} [${it.articleType}] sv=${it.searchVolume} ${it.slug}`)
  if (it.errorMessage) console.log(`    err: ${it.errorMessage.slice(0, 120)}`)
}
