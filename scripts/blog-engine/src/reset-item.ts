import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const url = `${process.env.PAYLOAD_CMS_URL}/api/content-queue/1`
const res = await fetch(url, {
  method: 'PATCH',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `users API-Key ${process.env.PAYLOAD_API_KEY}`,
  },
  body: JSON.stringify({ status: 'queued', errorMessage: '' }),
})

console.log('Status:', res.status)
const body = await res.json()
console.log('Reset hub queue item to "queued":', body.doc?.status)
