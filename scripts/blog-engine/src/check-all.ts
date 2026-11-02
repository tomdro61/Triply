import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })
const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

const AIRPORTS = ['JFK','LGA','EWR','SFO','SAN','LAX','BOS','DCA','IAD','MIA','FLL','PHL','SEA','DEN','ORD','BWI','TPA','CLT','MCO','MSP','PDX','PHX','AUS','SLC','LAS','BNA','ATL','DFW','DTW','IAH']
const STATUSES = ['queued','generating','draft','review','published','error']

async function main() {
  const totals: Record<string, number> = { queued:0, generating:0, draft:0, review:0, published:0, error:0 }
  console.log('Airport  Total  Queued  Generating  Draft  Published  Error')
  console.log('-------  -----  ------  ----------  -----  ---------  -----')
  for (const code of AIRPORTS) {
    const counts: Record<string, number> = { queued:0, generating:0, draft:0, review:0, published:0, error:0 }
    for (const status of STATUSES) {
      const r = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=${code}&where[status][equals]=${status}&limit=0&depth=0`, { headers: h })
      const d = await r.json()
      counts[status] = d.totalDocs || 0
      totals[status] += counts[status]
    }
    const total = Object.values(counts).reduce((a,b)=>a+b, 0)
    if (total > 0) {
      console.log(`${code.padEnd(7)}  ${String(total).padStart(5)}  ${String(counts.queued).padStart(6)}  ${String(counts.generating).padStart(10)}  ${String(counts.draft).padStart(5)}  ${String(counts.published).padStart(9)}  ${String(counts.error).padStart(5)}`)
    }
  }
  const grand = Object.values(totals).reduce((a,b)=>a+b, 0)
  console.log('-------  -----  ------  ----------  -----  ---------  -----')
  console.log(`TOTAL    ${String(grand).padStart(5)}  ${String(totals.queued).padStart(6)}  ${String(totals.generating).padStart(10)}  ${String(totals.draft).padStart(5)}  ${String(totals.published).padStart(9)}  ${String(totals.error).padStart(5)}`)
}
main().catch((e)=>{console.error(e); process.exit(1)})
