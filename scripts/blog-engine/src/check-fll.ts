import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })
const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

async function main() {
  const code = 'FLL'
  const counts: Record<string, number> = {}
  for (const status of ['queued','generating','draft','review','published','error']) {
    const r = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=${code}&where[status][equals]=${status}&limit=0&depth=0`, { headers: h })
    const d = await r.json()
    if (d.totalDocs > 0) counts[status] = d.totalDocs
  }
  const total = Object.values(counts).reduce((a: number, b: number) => a + b, 0)
  console.log(`${code}: ${total} total — ${Object.entries(counts).map(([s,n])=>`${n} ${s}`).join(', ')}`)

  // Show what's in each non-queued status by article type
  for (const status of ['published','draft','error','generating']) {
    const r = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=${code}&where[status][equals]=${status}&limit=300&depth=0`, { headers: h })
    const d = await r.json()
    if (!d.docs?.length) continue
    console.log(`\n--- ${status.toUpperCase()} (${d.docs.length}) ---`)
    for (const it of d.docs) {
      console.log(`  #${it.id} [${it.articleType}] ${it.slug}`)
    }
  }

  // Show next 5 queued by priority
  const r = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=${code}&where[status][equals]=queued&sort=priority,id&limit=10&depth=0`, { headers: h })
  const d = await r.json()
  console.log(`\n--- NEXT 10 QUEUED ---`)
  for (const it of d.docs || []) {
    console.log(`  #${it.id} [${it.articleType}] [${it.priority}] ${it.slug}`)
  }
}

main().catch((e)=>{console.error(e); process.exit(1)})
