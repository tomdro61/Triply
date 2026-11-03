// Chart redraw, step 6 — CMS WRITES. Swaps approved October standard charts for the new dated ones (out/plan.json,
// action 'swap'). Dry run by default; every --apply run needs Tom's OK on the exact list the dry run prints.
//   npx tsx reports/chart-redraw/publish.mts DFW JFK [--limit 3] [--only slug1,slug2] [--apply] [--reupload]
//   npx tsx reports/chart-redraw/publish.mts --verify   reports/chart-redraw/out/publish-<…>.json
//   npx tsx reports/chart-redraw/publish.mts --rollback reports/chart-redraw/out/publish-<…>.json [--apply]
//
// Charts: ONE new media record per airport and kind (alt = the dated caption), reused by every post at that airport and
//   recorded in out/uploaded-<asOf>.json with the PNG's sha1 and the alt. A record is reused only while both still
//   match the rendered chart; if the chart was redrawn since, the run stops unless --reupload (posts already swapped
//   keep the earlier image until they are swapped again). A media file with the chart's name that the record doesn't
//   know (an earlier run, a duplicate) stops the run too. Old media records are never deleted here.
// Posts (the run stops on any failed check; a post the CMS refuses with 400 is skipped, nothing written):
//   1. Read it (depth 0, cache-busted; a CDN-cached answer stops the run). Skip it if it changed since the inventory,
//      or if a block to change is no longer an upload of the expected old media.
//   2. Back it up to out/backups/<asOf>/<id>-<slug>-<updatedAt>.json — one file per version read, so a rollback never
//      restores an older version than the one this run overwrote.
//   3. Conditional PATCH: only if the post's updatedAt is still the one read (`where` id + updatedAt), body { content }
//      with only those upload nodes' `value` changed. Title, SEO, status and contentUpdatedAt are not sent. This narrows
//      the read→write race to the CMS's own find→update (a few hundred ms, mostly covered by Payload's admin document
//      lock); it is not a true compare-and-swap. A PATCH whose outcome is unknown (timeout, 5xx, a 400 from the bulk
//      endpoint) is settled by re-reading the post, and the run stops.
//   4. Re-read and check: the changed blocks point at the new media, every other block and every other field unchanged.
//   5. The run log (out/publish-<asOf>-<airports>-<time>.json) is rewritten after every post, so a crash leaves a log
//      a rollback can use. IndexNow is pinged at the end.
// --verify re-reads every post a log patched (a later admin save could have put the old chart back).
// --rollback restores each patched post from its backup, only if nobody edited it after our write.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { env } from '../../src/config.js'
import { uploadMedia } from '../../src/payload.js'
import { postUrlFor, submitUrls } from '../../src/indexnow.js'
import type { Chart, Decision } from './render.mts'

const OUT = 'reports/chart-redraw/out'
const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

type Json = Record<string, unknown>
interface Node { type?: string; value?: unknown; [k: string]: unknown }
interface Post extends Json { id: number; slug: string; status: string; updatedAt: string; contentUpdatedAt?: string | null; content: { root: Json & { children: Node[] } } }
interface Change { block: number; oldMedia: number; newMedia: number; kind: string }
interface Result { post_id: number; slug: string; code: string; changes: Change[]; backup?: string; attempted?: boolean; patched?: boolean; updatedAtBefore?: string; updatedAtAfter?: string; result: string }

// ── CMS access (reads cache-busted; the write conditional on updatedAt) ──
const H = { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` }
class CmsError extends Error { constructor(public status: number, msg: string) { super(msg) } }
async function cmsGet(p: string): Promise<Json> {
  const res = await fetch(`${env.PAYLOAD_CMS_URL}/api${p}${p.includes('?') ? '&' : '?'}_=${Date.now()}`, { headers: H, cache: 'no-store', signal: AbortSignal.timeout(30_000) })
  const cached = res.headers.get('x-vercel-cache')
  if (cached === 'HIT' || cached === 'STALE') throw new CmsError(0, `GET ${p} came from the CDN cache (${cached}) — not safe to compare`)
  if (!res.ok) throw new CmsError(res.status, `GET ${p} → ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json() as Promise<Json>
}
const getPost = async (id: number) => (await cmsGet(`/posts/${id}?depth=0`)) as Post
/** PATCH the post only if its updatedAt is still `updatedAt`; returns the saved doc, or null if it had changed. */
async function patchIfUnchanged(id: number, updatedAt: string, body: Json): Promise<Post | null> {
  const q = new URLSearchParams({ 'where[and][0][id][equals]': String(id), 'where[and][1][updatedAt][equals]': updatedAt, depth: '0' })
  const res = await fetch(`${env.PAYLOAD_CMS_URL}/api/posts?${q}`, { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new CmsError(res.status, `PATCH post ${id} → ${res.status} ${(await res.text()).slice(0, 300)}`)
  const out = (await res.json()) as { docs?: Post[]; errors?: unknown[] }
  if (out.errors?.length) throw new CmsError(400, `PATCH post ${id} refused: ${JSON.stringify(out.errors).slice(0, 300)}`)
  return out.docs?.[0] ?? null
}

const mediaIdOf = (n: Node | undefined): number | null => {
  if (!n || n.type !== 'upload') return null
  const v = n.value
  const id = typeof v === 'object' && v !== null ? (v as Json).id : v
  return typeof id === 'number' ? id : typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : null
}
/** Everything but content.root.children (the root's own attributes stay in). */
const outside = (p: Post) => JSON.stringify({ ...p, updatedAt: undefined, content: { ...p.content, root: { ...p.content.root, children: undefined } } })
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const readLog = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8')) as { results: Result[] }

// ── Verify ──
if (args.includes('--verify')) {
  const log = readLog(arg('--verify')!)
  let bad = 0
  for (const r of log.results.filter((x) => x.patched)) {
    const live = await getPost(r.post_id)
    const wrong = r.changes.filter((c) => mediaIdOf(live.content.root.children[c.block]) !== c.newMedia)
    if (wrong.length) bad++
    console.log(`  ${wrong.length ? '✗' : '✓'} ${r.code} ${r.slug}${wrong.length ? `: block ${wrong.map((c) => `${c.block} is media ${mediaIdOf(live.content.root.children[c.block])}`).join(', ')}` : ''}`)
  }
  console.log(bad ? `${bad} post(s) no longer show the new chart` : 'every patched post still shows the new charts')
  process.exit(bad ? 1 : 0)
}

// ── Rollback ──
if (args.includes('--rollback')) {
  const logFile = arg('--rollback')!
  const log = readLog(logFile)
  const patched = log.results.filter((r) => r.patched)
  console.log(`${APPLY ? 'Rolling back' : 'Would roll back'} ${patched.length} posts from ${logFile}`)
  const restored: Result[] = []
  const rbLog = `${OUT}/rollback-${stamp()}.json`
  let failed = false
  for (const r of patched) {
    try {
      if (!r.updatedAtAfter || !r.backup) { console.log(`  SKIP ${r.slug}: no record of the post after our write; restore by hand from ${r.backup ?? '(no backup)'}`); continue }
      const backup = JSON.parse(fs.readFileSync(r.backup, 'utf-8')) as Post
      const live = await getPost(r.post_id)
      if (JSON.stringify(live.content.root.children) === JSON.stringify(backup.content.root.children)) { console.log(`  = ${r.slug}: already back to the backup`); restored.push({ ...r, result: 'already restored' }); continue }
      // Only undo our own write: an edit after it would be lost by restoring the older content.
      if (Date.parse(live.updatedAt) !== Date.parse(r.updatedAtAfter)) { console.log(`  SKIP ${r.slug}: edited since the swap (${live.updatedAt}); restore by hand from ${r.backup}`); restored.push({ ...r, result: 'skipped: edited since swap' }); continue }
      if (!APPLY) { console.log(`  ${r.slug}: would restore content from ${r.backup}`); continue }
      const saved = await patchIfUnchanged(r.post_id, live.updatedAt, { content: backup.content })
      const ok = !!saved && JSON.stringify(saved.content.root.children) === JSON.stringify(backup.content.root.children) && saved.status === backup.status
      console.log(`  ${ok ? '✓' : '✗'} ${r.slug}`)
      restored.push({ ...r, result: ok ? 'restored' : saved ? 'RESTORE CHECK FAILED' : 'skipped: changed during rollback' })
      if (!ok) { failed = true; break }
    } catch (e) {
      console.log(`  ✗ ${r.slug}: ${(e as Error).message.slice(0, 200)} — re-read it before anything else`)
      restored.push({ ...r, result: `ERROR: ${(e as Error).message.slice(0, 200)}` })
      failed = true
      break
    } finally {
      if (APPLY) fs.writeFileSync(rbLog, JSON.stringify({ from: logFile, restored }, null, 1))
    }
  }
  process.exit(failed ? 1 : 0)
}

// ── Plan ──
const plan = JSON.parse(fs.readFileSync(`${OUT}/plan.json`, 'utf-8')) as { asOf: string; charts: Chart[]; decisions: Decision[] }
const inv = JSON.parse(fs.readFileSync(`${OUT}/inventory.json`, 'utf-8')) as { items: { uses: { post_id: number; updated_at: string }[] }[] }
const invUpdatedAt = new Map<number, string>()
for (const i of inv.items) for (const u of i.uses) invUpdatedAt.set(u.post_id, u.updated_at)

const codes = args.filter((a) => /^[A-Z]{3}$/.test(a))
if (!codes.length) throw new Error('name the airports to swap, e.g. DFW JFK (the pilot is a handful of posts per airport: --limit 3)')
const only = arg('--only')?.split(',')
const limit = arg('--limit') ? Number(arg('--limit')) : Infinity

const byPost = new Map<number, Decision[]>()
for (const d of plan.decisions) {
  if (d.action !== 'swap' || !d.kind || !codes.includes(d.code) || (only && !only.includes(d.slug))) continue
  byPost.set(d.post_id, [...(byPost.get(d.post_id) ?? []), d])
}
// Per airport: posts with both chart kinds first (the pilot tests both), then by slug — up to --limit posts.
const chosen: Decision[][] = []
for (const code of codes) {
  chosen.push(...[...byPost.values()].filter((ds) => ds[0].code === code).sort((a, b) => b.length - a.length || a[0].slug.localeCompare(b[0].slug)).slice(0, limit))
}
const chartFor = (code: string, kind: string): Chart => {
  const c = plan.charts.find((x) => x.code === code && x.kind === kind)
  if (!c) throw new Error(`no ${kind} chart for ${code} in plan.json`)
  return c
}

// ── Charts: upload new, or reuse only an identical earlier upload ──
const uploadedFile = `${OUT}/uploaded-${plan.asOf}.json`
type Upload = { id: number; filename: string; sha1: string; alt: string }
const uploaded: Record<string, Upload> = fs.existsSync(uploadedFile) ? JSON.parse(fs.readFileSync(uploadedFile, 'utf-8')) : {}
const keys = [...new Set(chosen.flat().map((d) => `${d.code}-${d.kind}`))]
const sha = (f: string) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')
console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'}: ${chosen.length} posts, ${chosen.flat().length} charts, prices as of ${plan.asOf}\n`)
for (const key of keys) {
  const [code, kind] = key.split('-'), c = chartFor(code, kind), s = sha(`${OUT}/${c.file}`), u = uploaded[key]
  const same = u && u.sha1 === s && u.alt === c.alt
  console.log(`  ${key}: ${same ? `reuse media ${u.id}` : u ? `CHANGED since media ${u.id} was uploaded${args.includes('--reupload') ? ' → upload new' : ' (stops the run: --reupload)'}` : 'upload new'} · ${c.mediaName} · sha1 ${s.slice(0, 10)}\n      caption: ${c.alt}`)
}
console.log('')
for (const ds of chosen) {
  console.log(`  ${ds[0].code} ${ds[0].slug} (post ${ds[0].post_id})`)
  for (const d of ds) console.log(`      block ${d.block}: media ${d.media_id} → ${d.kind} chart`)
}
if (!APPLY) { console.log('\nNothing written. Re-run with --apply after Tom OKs this list.'); process.exit(0) }

for (const key of keys) {
  const [code, kind] = key.split('-'), c = chartFor(code, kind), s = sha(`${OUT}/${c.file}`), u = uploaded[key]
  if (u && u.sha1 === s && u.alt === c.alt) {
    const m = await cmsGet(`/media/${u.id}?depth=0`) // still there, still the one we uploaded
    if (m.filename !== u.filename || m.alt !== u.alt) throw new Error(`media ${u.id} is not the ${key} chart we uploaded (${String(m.filename)})`)
    continue
  }
  if (u) {
    // Posts already swapped to the earlier upload keep it; this run can't reach them (they changed since the inventory).
    const onOld = fs.readdirSync(OUT).filter((f) => /^publish-.*\.json$/.test(f)).flatMap((f) => readLog(`${OUT}/${f}`).results)
      .filter((x) => x.patched && x.changes.some((c) => c.newMedia === u.id)).map((x) => x.slug)
    console.log(`  ${key}: ${onOld.length} post(s) already show media ${u.id}: ${onOld.join(', ') || 'none'} — they need a fresh inventory to get the new chart`)
    if (!args.includes('--reupload')) throw new Error(`${key} chart changed since media ${u.id} was uploaded — re-run with --reupload`)
  }
  const existing = (await cmsGet(`/media?where[filename][equals]=${encodeURIComponent(c.mediaName)}&depth=0&limit=5`)).docs as Json[]
  if (existing.length && !u) throw new Error(`a media file named ${c.mediaName} already exists (id ${existing.map((e) => e.id).join(', ')}) but no upload record knows it — check it before uploading again`)
  const res = (await uploadMedia(fs.readFileSync(`${OUT}/${c.file}`), c.mediaName, c.alt)) as { doc?: Json } & Json
  const doc = (res.doc ?? res) as Json
  if (typeof doc.id !== 'number') throw new Error(`upload of ${c.mediaName} returned no media id`)
  uploaded[key] = { id: doc.id, filename: String(doc.filename), sha1: s, alt: c.alt }
  fs.writeFileSync(uploadedFile, JSON.stringify(uploaded, null, 1)) // after every upload: a crash never orphans one
  console.log(`  uploaded ${key} → media ${doc.id} (${String(doc.filename)})`)
  // An upload retried after a late 5xx can store two copies: report it (the extra one is harmless and unused).
  const copies = (await cmsGet(`/media?where[filename][like]=${encodeURIComponent(c.mediaName.replace(/\.png$/, ''))}&depth=0&limit=10`)).docs as Json[]
  if (copies.length > 1) console.log(`  ⚠ ${copies.length} media files named like ${c.mediaName}: ${copies.map((x) => x.id).join(', ')} — only ${doc.id} is used`)
}

// ── Swap, post by post ──
const backupDir = `${OUT}/backups/${plan.asOf}`
fs.mkdirSync(backupDir, { recursive: true })
const log = `${OUT}/publish-${plan.asOf}-${codes.join('-')}-${stamp()}.json`
const results: Result[] = []
const saveLog = () => fs.writeFileSync(log, JSON.stringify({ asOf: plan.asOf, uploaded, results }, null, 1))
const urls: string[] = []
let stopped = ''
for (const ds of chosen) {
  const { post_id, slug, code } = ds[0]
  const r: Result = { post_id, slug, code, changes: ds.map((d) => ({ block: d.block, oldMedia: d.media_id, newMedia: uploaded[`${d.code}-${d.kind}`].id, kind: d.kind! })), result: 'started' }
  results.push(r)
  saveLog()
  try {
    const live = await getPost(post_id)
    r.updatedAtBefore = live.updatedAt
    const since = invUpdatedAt.get(post_id)
    if (!since || Date.parse(live.updatedAt) !== Date.parse(since)) { r.result = `skipped: changed since the inventory (${since} → ${live.updatedAt})`; continue }
    const blocks = live.content.root.children
    const wrong = r.changes.find((c) => mediaIdOf(blocks[c.block]) !== c.oldMedia)
    if (wrong) { r.result = `skipped: block ${wrong.block} is media ${mediaIdOf(blocks[wrong.block])}, not ${wrong.oldMedia}`; continue }

    const backup = path.resolve(backupDir, `${post_id}-${slug}-${live.updatedAt.replace(/[:.]/g, '-')}.json`)
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(live))
    r.backup = backup

    const content = JSON.parse(JSON.stringify(live.content)) as Post['content']
    for (const c of r.changes) content.root.children[c.block] = { ...content.root.children[c.block], value: c.newMedia }
    let saved: Post | null
    r.attempted = true
    saveLog()
    try {
      saved = await patchIfUnchanged(post_id, live.updatedAt, { content })
    } catch (e) {
      // The outcome is unknown: a timeout or 5xx can come after the CMS committed, and the bulk endpoint can commit
      // and still answer 400. Re-read to find out what is live.
      const now = await getPost(post_id)
      if (Date.parse(now.updatedAt) === Date.parse(live.updatedAt)) {
        if (e instanceof CmsError && e.status === 400) { r.result = `skipped: CMS refused the update, nothing written (${e.message.slice(0, 200)})`; continue }
        throw e // nothing was written; stop on the transport error
      }
      if (JSON.stringify(now.content.root.children) === JSON.stringify(content.root.children)) {
        r.patched = true
        r.updatedAtAfter = now.updatedAt
        r.result = `WRITTEN despite an error (${(e as Error).message.slice(0, 120)}) — check it, then --verify`
      } else {
        r.result = `UNKNOWN WRITE: the post changed (${now.updatedAt}) but not to our content — restore by hand from ${backup}`
      }
      stopped = slug
      break
    }
    if (!saved) { r.result = 'skipped: changed between our read and our write (nothing written)'; continue }
    r.patched = true
    r.updatedAtAfter = saved.updatedAt
    saveLog()

    const after = await getPost(post_id)
    if (Date.parse(after.updatedAt) !== Date.parse(saved.updatedAt)) { r.result = `CHANGED RIGHT AFTER OUR WRITE (${after.updatedAt}) — check by hand`; stopped = slug; break }
    const changed = new Set(r.changes.map((c) => c.block))
    const problems = [
      after.content.root.children.length !== blocks.length ? `block count ${blocks.length} → ${after.content.root.children.length}` : '',
      ...r.changes.filter((c) => mediaIdOf(after.content.root.children[c.block]) !== c.newMedia).map((c) => `block ${c.block} is not media ${c.newMedia}`),
      ...blocks.map((b, i) => (!changed.has(i) && JSON.stringify(after.content.root.children[i]) !== JSON.stringify(b) ? `block ${i} changed` : '')).filter(Boolean).slice(0, 3),
      outside(after) !== outside(live) ? 'a field outside the content changed' : '',
    ].filter(Boolean)
    if (problems.length) { r.result = `POST-SAVE CHECK FAILED: ${problems.join('; ')} — roll back with --rollback ${log}`; stopped = slug; break }
    r.result = 'swapped'
    urls.push(postUrlFor(slug))
    console.log(`  ✓ ${code} ${slug}`)
  } catch (e) {
    r.result = `ERROR${r.patched ? ' AFTER THE WRITE' : ''}: ${(e as Error).message.slice(0, 300)}`
    stopped = slug
    break
  } finally {
    saveLog()
  }
}

for (const r of results.filter((x) => x.result !== 'swapped')) console.log(`  ${r.result.startsWith('skipped') ? '–' : '✗'} ${r.code} ${r.slug}: ${r.result}`)
console.log(`\n${results.filter((r) => r.result === 'swapped').length} swapped, ${results.filter((r) => r.result.startsWith('skipped')).length} skipped${stopped ? `, STOPPED at ${stopped}` : ''}. Log: ${log}`)
if (urls.length) console.log(`IndexNow: ${JSON.stringify(await submitUrls(urls))}`)
if (stopped) process.exit(1)
