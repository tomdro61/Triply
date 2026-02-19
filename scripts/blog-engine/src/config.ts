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
export const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929'
export const MAX_TOKENS = 16384
export const SCRAPE_DELAY_MS = 3000
export const SCRAPE_TIMEOUT_MS = 15000
export const DOMAIN = 'triplypro.com'
export const BLOG_BASE_URL = `https://www.${DOMAIN}/blog`
