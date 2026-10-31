import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })
const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

async function main() {
  // Get total queued docs with searchVolume > 0
  const all = await fetch(`${CMS}/api/content-queue?where[status][equals]=queued&where[searchVolume][greater_than]=0&limit=200&depth=0`, { headers: h })
  const d = await all.json()
  console.log(`Queued items with searchVolume > 0: ${d.totalDocs}`)
  if (d.totalDocs > 0) {
    const items: any[] = d.docs || []
    const sorted = items.sort((a,b)=> (b.searchVolume||0) - (a.searchVolume||0))
    console.log('\nTop 30 queued by search volume:')
    for (const i of sorted.slice(0,30)) {
      console.log(`  ${String(i.searchVolume).padStart(5)} [${i.airportCode}] [${i.articleType}] ${i.keyword}`)
    }
  }
  // Also check across ALL statuses just to see if SV is anywhere
  const any = await fetch(`${CMS}/api/content-queue?where[searchVolume][greater_than]=0&limit=0&depth=0`, { headers: h })
  const dd = await any.json()
  console.log(`\nTotal items (any status) with searchVolume > 0: ${dd.totalDocs}`)
}
main().catch((e)=>{console.error(e); process.exit(1)})
