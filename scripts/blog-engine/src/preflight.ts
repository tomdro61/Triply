/**
 * preflight.ts — cheap credit check before the weekly maintenance loop spends.
 *
 * A dead API key mid-cycle wastes the trigger window on partial work (the engine
 * marches on scraping/marking items). This probes both providers up front so the
 * runner can SKIP the spending steps instead:
 *   - SerpAPI: free /account endpoint (does NOT spend a search) → searches left.
 *   - Anthropic: a 1-token Haiku ping → confirms the key + credit balance.
 *
 * Exit code is a bitmask so the caller can gate each provider independently:
 *   0 = both OK   1 = SerpAPI down   2 = Anthropic down   3 = both down
 *
 * CLI: tsx src/preflight.ts
 */

import Anthropic from '@anthropic-ai/sdk'
import { fileURLToPath } from 'url'
import { env, PERF_MODEL } from './config.js'

const PROBE_MODEL = PERF_MODEL // cheapest; a 400 credit error surfaces regardless of model

async function serpApiCreditsLeft(): Promise<number> {
  const keys = [env.SERPAPI_API_KEY, env.SERPAPI_API_KEY_2].map((k) => (k || '').trim()).filter(Boolean)
  if (keys.length === 0) {
    console.log('  · SerpAPI: no key configured — SERP steps will be skipped')
    return 0
  }
  let total = 0
  for (let i = 0; i < keys.length; i++) {
    try {
      const res = await fetch(`https://serpapi.com/account?api_key=${keys[i]}`)
      if (!res.ok) { console.log(`  · SerpAPI key ${i + 1}: account check ${res.status}`); continue }
      const acct = await res.json()
      const left = Number(acct.total_searches_left ?? acct.plan_searches_left ?? 0)
      console.log(`  · SerpAPI key ${i + 1}: ${left} searches left`)
      total += Number.isFinite(left) ? left : 0
    } catch (e) {
      console.log(`  · SerpAPI key ${i + 1}: check failed (${(e as Error).message})`)
    }
  }
  return total
}

export async function anthropicOk(): Promise<boolean> {
  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
    await client.messages.create({
      model: PROBE_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    })
    console.log('  · Anthropic: OK (credit + key valid)')
    return true
  } catch (e) {
    console.log(`  · Anthropic: NOT available — ${(e as Error).message}`)
    return false
  }
}

async function main() {
  console.log('Preflight — checking provider credit before spending:')
  const [serpLeft, aiOk] = await Promise.all([serpApiCreditsLeft(), anthropicOk()])
  const serpOk = serpLeft > 0

  let code = 0
  if (!serpOk) code |= 1
  if (!aiOk) code |= 2

  if (code === 0) console.log('Preflight OK — proceeding with the full cycle.')
  else console.log(`Preflight WARNING (code ${code}) — spending steps will be gated (serpOk=${serpOk}, anthropicOk=${aiOk}).`)

  process.exit(code)
}

// Only self-execute as a CLI; stays importable (e.g. index.ts generate preflight).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
