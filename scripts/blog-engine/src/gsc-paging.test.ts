// Unit tests for GSC startRow paging (2026-10-01).
//
// fetchQueryPagePairs() used to stop at 25,000 rows while GSC holds ~486k query↔page
// pairs over 90 days, so the cannibalization audit saw ~5% of the data. These pin the
// paging rule: keep requesting 25k pages until a short page, unless a rowLimit says stop.
//
// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paginateRows, GSC_PAGE_SIZE } from './gsc.js'

/** Fake GSC: `total` rows, served in startRow/pageSize windows; records each request. */
function fakeGsc(total: number) {
  const calls: Array<{ startRow: number; pageSize: number }> = []
  const fetchPage = async (startRow: number, pageSize: number) => {
    calls.push({ startRow, pageSize })
    const n = Math.max(0, Math.min(pageSize, total - startRow))
    return Array.from({ length: n }, (_, i) => startRow + i)
  }
  return { calls, fetchPage }
}

test('rowLimit Infinity reads every row across many pages', async () => {
  const g = fakeGsc(486_336)
  const rows = await paginateRows(g.fetchPage, Infinity)
  assert.equal(rows.length, 486_336)
  assert.equal(rows[rows.length - 1], 486_335)
  assert.equal(g.calls.length, 20) // 19 full pages + 1 short page
  assert.deepEqual(g.calls.slice(0, 2), [{ startRow: 0, pageSize: GSC_PAGE_SIZE }, { startRow: GSC_PAGE_SIZE, pageSize: GSC_PAGE_SIZE }])
})

test('exact multiple of the page size stops on the empty page', async () => {
  const g = fakeGsc(50_000)
  const rows = await paginateRows(g.fetchPage, Infinity)
  assert.equal(rows.length, 50_000)
  assert.equal(g.calls.length, 3)
})

test('a finite rowLimit still caps (old 25k behaviour is opt-in)', async () => {
  const g = fakeGsc(486_336)
  const rows = await paginateRows(g.fetchPage, 25_000)
  assert.equal(rows.length, 25_000)
  assert.equal(g.calls.length, 1)
})

test('rowLimit smaller than a page asks for only that many', async () => {
  const g = fakeGsc(100)
  const rows = await paginateRows(g.fetchPage, 10)
  assert.equal(rows.length, 10)
  assert.deepEqual(g.calls, [{ startRow: 0, pageSize: 10 }])
})
