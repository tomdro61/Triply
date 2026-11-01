import { test } from 'node:test'
import assert from 'node:assert/strict'
import { settleFailedPatch } from './settle-patch.js'
import { editIsLive } from './perf-apply.js'
import type { ArticlePerfRecord, PerfChange } from './perf-snapshot.js'

function fixture() {
  const change: PerfChange = { at: '2026-10-30T00:00:00Z', type: 'quick-answer', summary: 'add answer', baselineMetrics: { clicks: 0, impressions: 0, position: 0 }, preEdit: { title: 'old' } }
  const record = { slug: 'x', changes: [change] } as unknown as ArticlePerfRecord
  const saved: ArticlePerfRecord[] = []
  const warned: string[] = []
  const deps = { save: (r: ArticlePerfRecord) => { saved.push(r) }, warn: (m: string) => { warned.push(m) }, log: () => {} }
  return { change, record, saved, warned, deps }
}
const err = Object.assign(new Error('Payload API error 429'), { status: 429 })

test('edit present on re-read (an earlier attempt committed): entry stays, caller continues', async () => {
  const f = fixture()
  const ok = await settleFailedPatch('x', f.record, f.change, (live) => live.title === 'new', err, { ...f.deps, readPost: async () => ({ title: 'new' }) })
  assert.equal(ok, true)
  assert.equal(f.record.changes.length, 1)
  assert.equal(f.change.patchUnverified, undefined)
})

test('edit absent on re-read (nothing committed, even after a 4xx on the last retry): entry removed, error rethrown', async () => {
  const f = fixture()
  await assert.rejects(() => settleFailedPatch('x', f.record, f.change, (live) => live.title === 'new', err, { ...f.deps, readPost: async () => ({ title: 'old' }) }), /429/)
  assert.equal(f.record.changes.length, 0)
  assert.equal(f.saved.length, 1)
})

test('post vanished (null): entry removed, error rethrown', async () => {
  const f = fixture()
  await assert.rejects(() => settleFailedPatch('x', f.record, f.change, () => true, err, { ...f.deps, readPost: async () => null }))
  assert.equal(f.record.changes.length, 0)
})

test('re-read failed: entry kept and flagged patchUnverified, operator warned, error rethrown', async () => {
  const f = fixture()
  await assert.rejects(() => settleFailedPatch('x', f.record, f.change, () => true, err, { ...f.deps, readPost: async () => { throw new Error('ECONNRESET') } }))
  assert.equal(f.record.changes.length, 1)
  assert.equal(f.change.patchUnverified, true)
  assert.match(f.change.summary, /^\[PATCH outcome unknown/)
  assert.equal(f.warned.length, 1)
  assert.match(f.warned[0], /perf revert --slug x/)
})

test('editIsLive compares only the fields the edit set', () => {
  const live = { title: 'T', seo: { metaTitle: 'MT', metaDescription: 'MD' }, faqItems: [{ id: 'a', question: 'Q1', answer: 'A1' }], content: { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Rates $18/day.' }] }] } } }
  assert.equal(editIsLive(live, { title: 'T' }), true)
  assert.equal(editIsLive(live, { title: 'U' }), false)
  assert.equal(editIsLive(live, { seo: { metaTitle: 'MT', metaDescription: 'MD' } }), true)
  assert.equal(editIsLive(live, { seo: { metaTitle: 'MT', metaDescription: 'other' } }), false)
  assert.equal(editIsLive(live, { faqItems: [{ question: 'Q1', answer: 'A1' }] }), true, 'Payload adds ids; questions by index are what we compare')
  assert.equal(editIsLive(live, { faqItems: [{ question: 'Q1', answer: 'A1' }, { question: 'Q2', answer: 'A2' }] }), false)
  assert.equal(editIsLive(live, { content: { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Rates $18/day.' }] }] } } }), true)
  assert.equal(editIsLive(live, { content: { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Rates $19/day.' }] }] } } }), false)
})
