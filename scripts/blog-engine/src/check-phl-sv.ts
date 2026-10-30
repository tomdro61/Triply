import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })
const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

async function main() {
  const r = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=PHL&where[status][equals]=queued&limit=500&depth=0`, { headers: h })
  const d = await r.json()
  const items: { searchVolume?: number }[] = d.docs || []
  const withSV = items.filter(i => (i.searchVolume || 0) > 0).length
  const zero = items.length - withSV
  console.log(`Queued: ${items.length} | SV>0: ${withSV} | SV=0: ${zero}`)
  const tiers = { '1000+': 0, '500-999': 0, '100-499': 0, '50-99': 0, '10-49': 0, '1-9': 0 }
  for (const it of items) {
    const sv = it.searchVolume || 0
    if (sv === 0) continue
    if (sv >= 1000) tiers['1000+']++
    else if (sv >= 500) tiers['500-999']++
    else if (sv >= 100) tiers['100-499']++
    else if (sv >= 50) tiers['50-99']++
    else if (sv >= 10) tiers['10-49']++
    else tiers['1-9']++
  }
  for (const [k, v] of Object.entries(tiers)) console.log(`  ${k.padEnd(10)} ${v}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
