import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const url = `${process.env.PAYLOAD_CMS_URL}/api/content-queue?limit=1&where[status][equals]=queued&where[articleType][equals]=hub`
console.log('Fetching:', url)

const res = await fetch(url, {
  headers: {
    'Content-Type': 'application/json',
    Authorization: `users API-Key ${process.env.PAYLOAD_API_KEY}`,
  },
})

console.log('Status:', res.status)
const body = await res.text()
console.log('Response:', body.slice(0, 1000))
