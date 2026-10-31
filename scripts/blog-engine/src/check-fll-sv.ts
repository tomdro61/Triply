import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })
const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

async function main() {
  // Fetch all queued FLL items with all fields we need
  const r = await fetch(`${CMS}/api/content-queue?where[airportCode][equals]=FLL&where[status][equals]=queued&limit=500&depth=0`, { headers: h })
  const d = await r.json()
  const items: { id: number; slug: string; articleType: string; searchVolume?: number; seoDifficulty?: number }[] = d.docs || []

  const withSV = items.filter(i => (i.searchVolume || 0) > 0)
  const zeroSV = items.filter(i => (i.searchVolume || 0) === 0)

  console.log(`Total queued: ${items.length}`)
  console.log(`  With search volume > 0: ${withSV.length}`)
  console.log(`  Zero search volume:     ${zeroSV.length}`)

  // Bucket by SV tier
  const tiers = { '1000+': 0, '500-999': 0, '100-499': 0, '50-99': 0, '10-49': 0, '1-9': 0 }
  let svSum = 0
  for (const it of withSV) {
    const sv = it.searchVolume || 0
    svSum += sv
    if (sv >= 1000) tiers['1000+']++
    else if (sv >= 500) tiers['500-999']++
    else if (sv >= 100) tiers['100-499']++
    else if (sv >= 50) tiers['50-99']++
    else if (sv >= 10) tiers['10-49']++
    else tiers['1-9']++
  }
  console.log('\nSearch volume buckets (of the non-zero):')
  for (const [k, v] of Object.entries(tiers)) console.log(`  ${k.padEnd(10)} ${v}`)
  console.log(`\nTotal monthly search volume across queued: ${svSum.toLocaleString()}`)

  // Top 20
  const sorted = [...withSV].sort((a, b) => (b.searchVolume || 0) - (a.searchVolume || 0))
  console.log('\nTop 20 remaining by search volume:')
  for (const it of sorted.slice(0, 20)) {
    console.log(`  ${String(it.searchVolume).padStart(5)} [${it.articleType}] ${it.slug}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
