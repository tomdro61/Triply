import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })
const CMS = process.env.PAYLOAD_CMS_URL!
const KEY = process.env.PAYLOAD_API_KEY!
const h = { 'Content-Type': 'application/json', Authorization: `users API-Key ${KEY}` }

const TARGET_SLUG = process.argv[2]
if (!TARGET_SLUG) { console.error('Usage: tsx retry-failed.ts <slug>'); process.exit(1) }

async function main() {
  const r = await fetch(`${CMS}/api/content-queue?where[slug][equals]=${TARGET_SLUG}&limit=5&depth=0`, { headers: h })
  const d = await r.json()
  if (!d.docs?.length) { console.error(`No queue item found for slug: ${TARGET_SLUG}`); process.exit(1) }
  for (const item of d.docs) {
    console.log(`Found: id=${item.id} slug=${item.slug} status=${item.status} keyword="${item.keyword}"`)
    if (item.status === 'queued') { console.log('  Already queued, no change needed.'); continue }
    const upd = await fetch(`${CMS}/api/content-queue/${item.id}`, {
      method: 'PATCH', headers: h, body: JSON.stringify({ status: 'queued' })
    })
    if (!upd.ok) { console.error(`  ✗ Failed to update: ${upd.status} ${await upd.text()}`); continue }
    console.log(`  ✓ Reset to status=queued`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
