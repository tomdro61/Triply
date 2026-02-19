import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

import { getAirportPhoto } from './unsplash.js'
import { uploadMedia } from './payload.js'

async function main() {
  console.log('1. Searching Unsplash for "JFK airport parking"...')
  const photo = await getAirportPhoto('JFK')

  if (!photo) {
    console.log('No photo found. Check UNSPLASH_ACCESS_KEY.')
    return
  }

  console.log(`   Found: ${photo.filename} (${photo.buffer.length} bytes)`)
  console.log(`   Alt: ${photo.alt}`)

  console.log('\n2. Uploading to CMS...')
  try {
    const result = await uploadMedia(photo.buffer, photo.filename, photo.alt)
    const id = result.doc?.id || result.id
    console.log(`   ✓ Uploaded! Media ID: ${id}`)
    console.log(`   URL: ${result.doc?.url || result.url || 'N/A'}`)
  } catch (err) {
    console.error(`   ✗ Upload failed:`, err instanceof Error ? err.message : err)
  }
}

main()
