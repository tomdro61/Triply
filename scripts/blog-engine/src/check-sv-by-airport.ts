import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })
const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

const AIRPORTS = ['JFK','LGA','EWR','SFO','SAN','LAX','BOS','DCA','IAD','MIA','FLL','PHL','SEA']
const STATUSES = ['queued','draft','published','error']

async function main() {
  console.log('Airport  SV>0 Total  Queued  Draft  Published  Error  Sum-SV')
  console.log('-------  ---------  ------  -----  ---------  -----  ------')
  for (const code of AIRPORTS) {
    const counts: Record<string, number> = { queued:0, draft:0, published:0, error:0 }
    let sumSV = 0
    for (const status of STATUSES) {
      const r = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=${code}&where[status][equals]=${status}&where[searchVolume][greater_than]=0&limit=500&depth=0`, { headers: h })
      const d = await r.json()
      counts[status] = d.totalDocs || 0
      for (const it of (d.docs || [])) sumSV += (it.searchVolume || 0)
    }
    const total = Object.values(counts).reduce((a,b)=>a+b, 0)
    if (total > 0) {
      console.log(`${code.padEnd(7)}  ${String(total).padStart(9)}  ${String(counts.queued).padStart(6)}  ${String(counts.draft).padStart(5)}  ${String(counts.published).padStart(9)}  ${String(counts.error).padStart(5)}  ${String(sumSV).padStart(6)}`)
    }
  }
}
main().catch((e)=>{console.error(e); process.exit(1)})
