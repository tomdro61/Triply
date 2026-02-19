import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const cmsUrl = process.env.PAYLOAD_CMS_URL
const apiKey = process.env.PAYLOAD_API_KEY
const headers = {
  'Content-Type': 'application/json',
  Authorization: `users API-Key ${apiKey}`,
}

// List all posts
const res = await fetch(`${cmsUrl}/api/posts?limit=10`, { headers })
const data = await res.json()
console.log(`Total posts: ${data.totalDocs}`)

for (const post of data.docs || []) {
  console.log(`  Post #${post.id}: "${post.slug}" (${post.status})`)
}

if (data.totalDocs > 0) {
  // Delete all posts (old drafts)
  for (const post of data.docs) {
    console.log(`\nDeleting post #${post.id} "${post.slug}"...`)
    const del = await fetch(`${cmsUrl}/api/posts/${post.id}`, {
      method: 'DELETE',
      headers,
    })
    console.log(`  Status: ${del.status}`)
  }
  console.log('\nDone — all old posts deleted.')
} else {
  console.log('No posts to delete.')
}
