/**
 * batch.ts — Anthropic Message Batches API runner (50% cheaper than sync calls).
 *
 * The single reusable primitive for async, cost-halved Claude work. Submit N
 * independent requests, poll until the batch ends, get results back keyed by
 * custom_id. Every token is billed at 0.5x the standard rate — this module tracks
 * cost at that discounted rate so logs reflect the real spend.
 *
 * Batches suit work where nobody waits real-time: bulk generation of independent
 * articles (one request per queued item, per pipeline step) and weekly maintenance
 * treatments. NOT for a single article's dependent chain (analyze → write → edit),
 * where each step needs the previous step's output.
 *
 * Turnaround is async (usually minutes, up to 24h SLA). Poll interval backs off.
 */

import Anthropic from '@anthropic-ai/sdk'
import { env, MODEL_PRICING, CLAUDE_MODEL } from './config.js'

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

const BATCH_DISCOUNT = 0.5 // Batches API bills input+output at half the standard rate.

export interface BatchRequest {
  customId: string // your key to match a result back to its input (unique per batch)
  prompt: string
  system?: string | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[]
  model?: string // defaults to CLAUDE_MODEL
  maxTokens?: number
}

export interface BatchResult {
  customId: string
  text: string | null // null when the request errored / was cancelled / expired
  status: 'succeeded' | 'errored' | 'canceled' | 'expired'
  error?: string
}

export interface BatchRunSummary {
  results: Map<string, BatchResult>
  succeeded: number
  failed: number
  cost: number // total USD at the discounted batch rate
  batchId: string
}

function costFor(model: string, inputTokens: number, outputTokens: number, cacheRead = 0, cacheWrite = 0): number {
  const p = MODEL_PRICING[model] || MODEL_PRICING[CLAUDE_MODEL]
  const full =
    (inputTokens * p.input / 1_000_000) +
    (outputTokens * p.output / 1_000_000) +
    (cacheRead * p.cacheRead / 1_000_000) +
    (cacheWrite * p.cacheWrite / 1_000_000)
  return full * BATCH_DISCOUNT
}

/**
 * Submit a batch and poll until it ends, returning results keyed by customId.
 * @param requests independent Claude requests (order irrelevant; matched by customId)
 * @param opts.maxTokens default max_tokens when a request omits it
 * @param opts.pollMs starting poll interval (backs off toward 30s); default 5s
 * @param opts.onProgress called each poll with the batch's request_counts
 */
export async function runBatch(
  requests: BatchRequest[],
  opts: { maxTokens?: number; pollMs?: number; onProgress?: (counts: any, status: string) => void } = {},
): Promise<BatchRunSummary> {
  if (requests.length === 0) {
    return { results: new Map(), succeeded: 0, failed: 0, cost: 0, batchId: '' }
  }
  const defaultMax = opts.maxTokens ?? 8192

  // The API requires custom_id to be a string, but callers pass Payload queue ids
  // that are integers at runtime (Postgres PKs) despite the string typing. Coerce
  // here and translate back on the way out so results stay keyed by the caller's
  // ORIGINAL customId value (results.get(item.id) keeps working for any id type).
  const originalByString = new Map<string, string>()

  // Guard against duplicate custom_ids — the API rejects them and it silently drops results.
  const seen = new Set<string>()
  for (const r of requests) {
    const key = String(r.customId)
    if (seen.has(key)) throw new Error(`batch: duplicate customId "${r.customId}"`)
    seen.add(key)
    originalByString.set(key, r.customId)
  }

  const batch = await client.messages.batches.create({
    requests: requests.map((r) => ({
      custom_id: String(r.customId),
      params: {
        model: r.model || CLAUDE_MODEL,
        max_tokens: r.maxTokens ?? defaultMax,
        ...(r.system ? { system: r.system as any } : {}),
        messages: [{ role: 'user' as const, content: r.prompt }],
      },
    })),
  })

  console.log(`  📦 Batch ${batch.id} submitted — ${requests.length} request(s), billed at ${BATCH_DISCOUNT * 100}% rate`)

  // Poll with backoff until processing ends.
  let status = batch.processing_status
  let wait = opts.pollMs ?? 5000
  let current = batch
  while (status !== 'ended') {
    await new Promise((res) => setTimeout(res, wait))
    current = await client.messages.batches.retrieve(batch.id)
    status = current.processing_status
    opts.onProgress?.(current.request_counts, status)
    wait = Math.min(wait * 1.4, 30_000)
  }

  // Stream results (JSONL); map each back to its customId and tally discounted cost.
  const results = new Map<string, BatchResult>()
  let cost = 0
  let succeeded = 0
  let failed = 0

  for await (const entry of await client.messages.batches.results(batch.id)) {
    // Translate the API's string custom_id back to the caller's original value so
    // callers can look up results with the exact key they submitted.
    const customId = originalByString.get(entry.custom_id) ?? entry.custom_id
    const r = entry.result
    if (r.type === 'succeeded') {
      const msg = r.message
      const textBlock = msg.content.find((b: any) => b.type === 'text')
      const text = textBlock && textBlock.type === 'text' ? textBlock.text : null
      const u = msg.usage as any
      cost += costFor(
        msg.model,
        u.input_tokens || 0,
        u.output_tokens || 0,
        u.cache_read_input_tokens || 0,
        u.cache_creation_input_tokens || 0,
      )
      results.set(customId, { customId, text, status: 'succeeded' })
      succeeded++
    } else {
      const status2 = r.type as BatchResult['status']
      const error = r.type === 'errored' ? JSON.stringify((r as any).error).slice(0, 200) : r.type
      results.set(customId, { customId, text: null, status: status2, error })
      failed++
    }
  }

  console.log(`  ✅ Batch ${batch.id} ended — ${succeeded} ok, ${failed} failed | cost $${cost.toFixed(4)} (50% batch rate)`)
  return { results, succeeded, failed, cost, batchId: batch.id }
}
