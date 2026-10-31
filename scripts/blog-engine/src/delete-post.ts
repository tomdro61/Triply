/**
 * delete-post.ts — delete ONE post, named explicitly. (W1.9: the old script deleted the first 10
 * posts of any status with no arguments.)
 *
 *   npx tsx src/delete-post.ts --slug <slug>            # dry run: shows the post
 *   npx tsx src/delete-post.ts --id <id> --yes          # deletes
 */
import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const args = process.argv.slice(2)
const val = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const id = val('--id'), slug = val('--slug'), yes = args.includes('--yes')
if ((!id && !slug) || (id && slug)) {
  console.error('Usage: tsx src/delete-post.ts (--id <id> | --slug <slug>) [--yes]')
  process.exit(1)
}

const cmsUrl = process.env.PAYLOAD_CMS_URL
const apiKey = process.env.PAYLOAD_API_KEY
if (!cmsUrl || !apiKey) { console.error('PAYLOAD_CMS_URL / PAYLOAD_API_KEY missing'); process.exit(1) }
const headers = { 'Content-Type': 'application/json', Authorization: `users API-Key ${apiKey}` }

const lookup = id ? `${cmsUrl}/api/posts/${encodeURIComponent(id)}?depth=0` : `${cmsUrl}/api/posts?where[slug][equals]=${encodeURIComponent(slug!)}&limit=1&depth=0`
const res = await fetch(lookup, { headers })
if (!res.ok) { console.error(`Lookup failed: ${res.status} ${await res.text()}`); process.exit(1) }
const data = await res.json()
const post = id ? data : data.docs?.[0]
if (!post?.id) { console.log('No such post.'); process.exit(0) }
console.log(`Post #${post.id} "${post.slug}" (${post.status}) at ${cmsUrl}`)
if (!yes) { console.log('Dry run. Re-run with --yes to delete this one post.'); process.exit(0) }
const del = await fetch(`${cmsUrl}/api/posts/${post.id}`, { method: 'DELETE', headers })
if (!del.ok) { console.error(`DELETE failed → ${del.status} ${(await del.text()).slice(0, 300)}`); process.exit(1) }
// Confirm by reading it back: a 2xx with the post still answering is not a deletion.
const check = await fetch(`${cmsUrl}/api/posts/${post.id}?depth=0`, { headers })
if (check.status !== 404) { console.error(`DELETE returned ${del.status} but the post still answers ${check.status} — NOT deleted`); process.exit(1) }
console.log(`Deleted post #${post.id} "${post.slug}" (confirmed 404).`)
