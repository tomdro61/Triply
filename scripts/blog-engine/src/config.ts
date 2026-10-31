import { config } from 'dotenv'
import { z } from 'zod'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  PAYLOAD_CMS_URL: z.string().url().default('http://localhost:3001'),
  PAYLOAD_API_KEY: z.string().min(1, 'PAYLOAD_API_KEY is required'),
  SERPAPI_API_KEY: z.string().optional(),
  SERPAPI_API_KEY_2: z.string().optional(), // fallback, used when primary is out of searches
  // Disk cache TTL for SerpAPI results (hours). A repeat search within this window
  // reuses the cached response instead of spending a credit. Set 0 to disable.
  SERP_CACHE_TTL_HOURS: z.coerce.number().optional(),
  // IndexNow key for instant Bing/Yandex indexing (free). The same key must be
  // hosted as a text file at https://<host>/<key>.txt (frontend/domain root).
  INDEXNOW_KEY: z.string().optional(),
  // Microsoft Clarity Data Export API token (Settings → Data Export → Generate).
  // Enables `clarity insights|suggest` — behavior data → Claude UX suggestions.
  CLARITY_API_TOKEN: z.string().optional(),
  UNSPLASH_ACCESS_KEY: z.string().optional(),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Environment validation failed:')
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`)
  }
  process.exit(1)
}

export const env = parsed.data

// Constants
export const CLAUDE_MODEL = 'claude-sonnet-4-6'
export const MAX_TOKENS = 16384
export const SCRAPE_DELAY_MS = 3000
export const SCRAPE_TIMEOUT_MS = 15000
export const DOMAIN = 'triplypro.com'
export const BLOG_BASE_URL = `https://www.${DOMAIN}/blog`
export const REVISION_THRESHOLD = 85 // Default — overridden by type-aware thresholds below
export const REVISION_THRESHOLDS: Record<string, number> = {
  hub: 90,           // Cornerstone content — highest quality bar
  'sub-pillar': 85,  // Detailed guides — standard quality bar
  spoke: 80,         // Focused pieces — slightly lower bar
}
export const HARD_FLOOR_SCORE = 70 // Below this after all passes → status 'review' (human required)

// ── Per-step model overrides (Workstream C cost/quality experiments) ──────────
// Each step defaults to CLAUDE_MODEL when its env var is unset → ZERO behavior
// change by default. Set e.g. MODEL_ANALYZE=claude-haiku-4-5-20251001 to test a
// cheaper model on the analyze step. Step keys match setCurrentStep() in claude.ts.
export function modelForStep(step: string): string {
  const overrides: Record<string, string | undefined> = {
    analyze: process.env.MODEL_ANALYZE,
    write: process.env.MODEL_WRITE,
    edit: process.env.MODEL_EDIT,
    revision: process.env.MODEL_EDIT, // revision shares the editor model
  }
  return overrides[step] || CLAUDE_MODEL
}

// ── Improvement-loop tunables ────────────────────────────────────────────────
// Previously these were magic numbers scattered across perf-*/maintain-*/ctr-rescue.
// Centralized here and env-overridable so behavior can be tuned without code edits.
function envNum(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** Cheap model shared by the perf/ctr-rescue/preflight probes (title-meta, recommend, ping). */
export const PERF_MODEL = process.env.PERF_MODEL || 'claude-haiku-4-5-20251001'
/** Fraction of auto-applied perf edits flagged for after-the-fact human spot-audit. */
export const AUDIT_SAMPLE_RATE = envNum('AUDIT_SAMPLE_RATE', 0.34)
/** Reuse a maintenance snapshot taken within this many hours instead of pulling a new one. */
export const SNAPSHOT_FRESH_HOURS = envNum('SNAPSHOT_FRESH_HOURS', 6)
/** Minimum baseline impressions before `perf measure` will issue a non-inconclusive verdict. */
export const PERF_MIN_BASELINE_IMPRESSIONS = envNum('PERF_MIN_BASELINE_IMPRESSIONS', 10)
/** `maintain learn` disables a treatment only when win-rate is below this AND it's a net loser. */
export const LEARN_DISABLE_WINRATE = envNum('LEARN_DISABLE_WINRATE', 0.35)
/** …and its net loss is at least this fraction of the decisive sample. */
export const LEARN_DISABLE_NET_FRACTION = envNum('LEARN_DISABLE_NET_FRACTION', 0.2)

// Per-model pricing, USD per million tokens. Cache write = 1.25x input, cache read
// = 0.1x input (Anthropic standard 5-min cache multipliers). Models NOT listed here
// fall back to Sonnet pricing with a runtime warning — add a verified entry before
// trusting cost numbers for that model in an experiment.
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.10 },
}
