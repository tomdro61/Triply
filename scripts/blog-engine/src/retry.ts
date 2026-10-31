// Shared bounded-retry wrapper for the engine's network calls.
//
// Both the Anthropic client (claude.ts) and the Payload CMS client (payload.ts)
// hit transient failures during long batch runs: rate limits, 5xx blips, DNS
// hiccups, and the recurring `media-upload-400 "No files were uploaded"` glitch.
// Previously only claude.ts retried (and CMS calls crashed whole batches). This
// module is the single implementation both share.

/**
 * Thrown when the Anthropic account is out of credits (HTTP 402 / billing error).
 * This is TERMINAL, not transient — retrying wastes time and marching on wastes
 * SerpAPI budget. Callers (index.ts generate loop) should catch this and abort
 * the whole batch rather than marking every remaining item as `error`.
 */
export class CreditBalanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CreditBalanceError'
  }
}

/** HTTP statuses that are worth retrying (transient server/rate-limit conditions). */
const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504, 529])

/** Node/undici network error codes that indicate a transient connectivity blip. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
])

function getStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    const s = (err as { status?: unknown }).status
    if (typeof s === 'number') return s
  }
  return undefined
}

function getCode(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const direct = (err as { code?: unknown }).code
    if (typeof direct === 'string') return direct
    const cause = (err as { cause?: { code?: unknown } }).cause
    if (cause && typeof cause.code === 'string') return cause.code
  }
  return undefined
}

/**
 * Classify an error as retryable (transient) or terminal. Handles both
 * status-bearing errors (Anthropic SDK, our PayloadHttpError) and raw
 * network errors from fetch/undici.
 */
export function isRetryableError(err: unknown): boolean {
  // Never retry a known credit-balance failure — it will not self-resolve.
  if (err instanceof CreditBalanceError) return false

  const code = getCode(err)
  if (code && RETRYABLE_CODES.has(code)) return true

  // Our AbortController timeout surfaces as an AbortError — treat a hung
  // connection as transient and retry it.
  if (err instanceof Error && err.name === 'AbortError') return true

  // Node fetch wraps low-level connection failures as TypeError('fetch failed').
  if (err instanceof TypeError && /fetch failed|network|terminated/i.test(err.message)) return true

  const status = getStatus(err)
  if (status && RETRYABLE_HTTP.has(status)) return true

  // The Payload media endpoint intermittently 400s with "No files were uploaded"
  // even though the multipart body is valid — a known transient glitch that always
  // succeeds on retry (see project notes). Match on message or embedded body.
  if (err instanceof Error && /No files were uploaded/i.test(err.message)) return true

  return false
}

export interface RetryOpts {
  /** Total attempts including the first (default 4 → up to 3 retries). */
  tries?: number
  /** Base delay in ms; grows exponentially per attempt (default 2000 → 2s/4s/8s). */
  baseDelayMs?: number
  /** Human label for retry log lines. */
  label?: string
}

/**
 * Run `fn`, retrying transient failures with exponential backoff + jitter.
 * Non-retryable errors (and CreditBalanceError) are rethrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const tries = opts.tries ?? 4
  const base = opts.baseDelayMs ?? 2000
  const label = opts.label ?? 'operation'

  let lastErr: unknown
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isRetryableError(err) || attempt >= tries) throw err
      const delay = base * 2 ** (attempt - 1) + Math.floor(Math.random() * 500)
      const reason = getStatus(err) ?? getCode(err) ?? (err instanceof Error ? err.name : 'error')
      console.warn(`  ⚠ ${label} failed (${reason}), retry ${attempt}/${tries - 1} in ${(delay / 1000).toFixed(1)}s`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
