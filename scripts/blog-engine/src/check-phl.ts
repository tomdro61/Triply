import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })
const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

async function main() {
  const counts: Record<string, number> = {}
  for (const status of ['queued', 'generating', 'draft', 'review', 'published', 'error']) {
    const r = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=PHL&where[status][equals]=${status}&limit=0&depth=0`, { headers: h })
    const d = await r.json()
    if (d.totalDocs > 0) counts[status] = d.totalDocs
  }
  const total = Object.values(counts).reduce((a: number, b: number) => a + b, 0)
  console.log(`PHL: ${total} total — ${Object.entries(counts).map(([s,n])=>`${n} ${s}`).join(', ')}`)
}
main().catch((e)=>{console.error(e); process.exit(1)})
