import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const cmsUrl = process.env.PAYLOAD_CMS_URL
const apiKey = process.env.PAYLOAD_API_KEY

console.log('CMS URL:', cmsUrl)
console.log('API Key length:', apiKey?.length)
console.log('API Key (first 8 chars):', apiKey?.slice(0, 8) + '...')
console.log('API Key has whitespace:', apiKey !== apiKey?.trim() ? 'YES (problem!)' : 'No')
console.log('Auth header:', `users API-Key ${apiKey?.slice(0, 8)}...`)

// Test 1: /api/users/me with API key
console.log('\n--- Test 1: /api/users/me (with API key) ---')
const res1 = await fetch(`${cmsUrl}/api/users/me`, {
  headers: {
    Authorization: `users API-Key ${apiKey}`,
  },
})
console.log('Status:', res1.status)
const body1 = await res1.text()
console.log('Response:', body1.slice(0, 500))

// Test 2: List all users (open access) to see what users exist
console.log('\n--- Test 2: /api/users (list users) ---')
const res2 = await fetch(`${cmsUrl}/api/users?limit=5`, {
  headers: {
    Authorization: `users API-Key ${apiKey}`,
  },
})
console.log('Status:', res2.status)
const body2 = await res2.json()
console.log('Total users:', body2.totalDocs)
if (body2.docs) {
  for (const user of body2.docs) {
    console.log(`  User: ${user.email} | Role: ${user.role} | API Key enabled: ${user.enableAPIKey} | Has API key: ${!!user.apiKey}`)
  }
}

// Test 3: Content queue (requires auth)
console.log('\n--- Test 3: /api/content-queue (requires auth) ---')
const res3 = await fetch(`${cmsUrl}/api/content-queue?limit=1`, {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `users API-Key ${apiKey}`,
  },
})
console.log('Status:', res3.status)
const body3 = await res3.text()
console.log('Response:', body3.slice(0, 300))
