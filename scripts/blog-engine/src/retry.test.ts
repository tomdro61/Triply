// Unit tests for the shared retry wrapper. Run with: npm test
// Uses Node's built-in test runner (node:test) via tsx — no extra deps.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withRetry, isRetryableError, CreditBalanceError } from './retry.js'

// ── isRetryableError classification ───────────────────────────────────────────

test('CreditBalanceError is never retryable', () => {
  assert.equal(isRetryableError(new CreditBalanceError('out of credits')), false)
})

test('transient HTTP statuses are retryable', () => {
  for (const status of [429, 500, 502, 503, 504, 529]) {
    assert.equal(isRetryableError({ status }), true, `status ${status} should retry`)
  }
})

test('terminal HTTP statuses are NOT retryable', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetryableError({ status }), false, `status ${status} should not retry`)
  }
})

test('network error codes are retryable', () => {
  for (const code of ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']) {
    assert.equal(isRetryableError({ code }), true, `code ${code} should retry`)
    // also when nested under .cause (undici shape)
    assert.equal(isRetryableError({ cause: { code } }), true, `cause.code ${code} should retry`)
  }
})

test('AbortError (timeout) is retryable', () => {
  const e = new Error('aborted')
  e.name = 'AbortError'
  assert.equal(isRetryableError(e), true)
})

test('fetch-failed TypeError is retryable', () => {
  assert.equal(isRetryableError(new TypeError('fetch failed')), true)
})

test('the media-upload "No files were uploaded" 400 is retryable by message', () => {
  // 400 alone is terminal, but this specific transient glitch must retry.
  assert.equal(isRetryableError(new Error('Payload API error 400 on /media: No files were uploaded')), true)
})

test('a plain terminal error is not retryable', () => {
  assert.equal(isRetryableError(new Error('validation failed')), false)
})

// ── withRetry behavior ────────────────────────────────────────────────────────

test('withRetry returns on first success without retrying', async () => {
  let calls = 0
  const out = await withRetry(async () => { calls++; return 'ok' }, { tries: 4, baseDelayMs: 1 })
  assert.equal(out, 'ok')
  assert.equal(calls, 1)
})

test('withRetry retries a transient error then succeeds', async () => {
  let calls = 0
  const out = await withRetry(async () => {
    calls++
    if (calls < 3) throw { status: 503 }
    return 'recovered'
  }, { tries: 4, baseDelayMs: 1 })
  assert.equal(out, 'recovered')
  assert.equal(calls, 3)
})

test('withRetry rethrows a non-retryable error immediately (no retries)', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(async () => { calls++; throw new CreditBalanceError('402') }, { tries: 4, baseDelayMs: 1 }),
    (e) => e instanceof CreditBalanceError,
  )
  assert.equal(calls, 1)
})

test('withRetry stops after `tries` attempts and rethrows the last error', async () => {
  let calls = 0
  await assert.rejects(
    withRetry(async () => { calls++; throw { status: 500, message: 'always down' } }, { tries: 3, baseDelayMs: 1 }),
    (e) => (e as { status?: number }).status === 500,
  )
  assert.equal(calls, 3) // 1 initial + 2 retries
})
