import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const CMS_URL = process.env.PAYLOAD_CMS_URL!
const API_KEY = process.env.PAYLOAD_API_KEY!

const headers = {
  'Content-Type': 'application/json',
  Authorization: `users API-Key ${API_KEY}`,
}

async function main() {
  console.log(`CMS: ${CMS_URL}`)

  // Get all draft LGA posts
  const res = await fetch(`${CMS_URL}/api/posts?where[status][equals]=draft&where[airportCode][equals]=LGA&limit=50&depth=0`, { headers })
  const data = await res.json()
  const posts = data.docs || []

  console.log(`Found ${posts.length} draft LGA posts\n`)

  const today = new Date().toISOString()

  for (const post of posts) {
    console.log(`  ${post.slug} (Post ID: ${post.id})`)
    try {
      const patchRes = await fetch(`${CMS_URL}/api/posts/${post.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: 'published', publishedAt: today }),
      })
      if (patchRes.ok) {
        console.log(`    ✓ Published`)
      } else {
        const err = await patchRes.text()
        console.log(`    ✗ Failed: ${err.substring(0, 200)}`)
      }
    } catch (err) {
      console.log(`    ✗ Error: ${err}`)
    }
  }

  // Also update queue items
  const qRes = await fetch(`${CMS_URL}/api/content-queue?where[airportCode][equals]=LGA&where[status][equals]=draft&limit=50&depth=0`, { headers })
  const qData = await qRes.json()
  const qItems = qData.docs || []

  console.log(`\nUpdating ${qItems.length} queue items to published...`)
  for (const item of qItems) {
    await fetch(`${CMS_URL}/api/content-queue/${item.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'published' }),
    })
    console.log(`  ✓ ${item.slug}`)
  }

  console.log('\nDone!')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
