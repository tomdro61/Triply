// Unit tests for the append-only spot-audit queue (atomicity + tolerance).
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAuditQueue, queueForAudit } from './perf-apply.js'

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'perf-audit-queue.json')
}

const entry = (slug: string) => ({ slug, type: 'title-meta', at: '2026-07-23T00:00:00Z', rationale: `why ${slug}` })

test('append then read round-trips entries', () => {
  const f = tmpFile()
  queueForAudit(entry('a'), f)
  queueForAudit(entry('b'), f)
  const q = readAuditQueue(f)
  assert.equal(q.length, 2)
  assert.deepEqual(q.map((e) => e.slug), ['a', 'b'])
  assert.equal(q.every((e) => e.reviewed === false), true)
})

test('appends are additive — no read-modify-write clobber (simulated interleave)', () => {
  const f = tmpFile()
  // Interleaved appends (what two concurrent `perf run`s would produce) never lose entries.
  for (let i = 0; i < 20; i++) queueForAudit(entry(`s${i}`), f)
  assert.equal(readAuditQueue(f).length, 20)
})

test('corrupt lines are skipped, not fatal', () => {
  const f = tmpFile()
  queueForAudit(entry('good1'), f)
  fs.appendFileSync(f, '{ this is not json\n')
  queueForAudit(entry('good2'), f)
  const q = readAuditQueue(f)
  assert.deepEqual(q.map((e) => e.slug), ['good1', 'good2'])
})

test('legacy JSON-array file is migrated to JSONL on first append', () => {
  const f = tmpFile()
  fs.writeFileSync(f, JSON.stringify([{ ...entry('old'), reviewed: false }], null, 2))
  queueForAudit(entry('new'), f)
  const raw = fs.readFileSync(f, 'utf-8')
  assert.equal(raw.trimStart()[0] !== '[', true, 'file should no longer be a JSON array')
  assert.deepEqual(readAuditQueue(f).map((e) => e.slug), ['old', 'new'])
})

test('legacy array is still readable before any append', () => {
  const f = tmpFile()
  fs.writeFileSync(f, JSON.stringify([entry('x'), entry('y')]))
  assert.deepEqual(readAuditQueue(f).map((e) => e.slug), ['x', 'y'])
})

test('missing / empty file reads as empty', () => {
  assert.deepEqual(readAuditQueue(path.join(os.tmpdir(), 'nope-does-not-exist.json')), [])
  const f = tmpFile()
  fs.writeFileSync(f, '')
  assert.deepEqual(readAuditQueue(f), [])
})
