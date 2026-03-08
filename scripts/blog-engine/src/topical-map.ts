import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { env, CLAUDE_MODEL, DOMAIN } from './config.js'
import { buildPlanTopicsPrompt } from './prompts/plan-topics.js'
import { loadAirportData } from './airport-data.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

// --- Zod schemas for Claude's topical map response ---

const SpokeSchema = z.object({
  keyword: z.string(),
  suggestedTitle: z.string(),
  slug: z.string(),
  articleStyle: z.enum(['standard', 'narrative', 'listicle', 'data-heavy', 'comparison']),
  targetWords: z.number().default(1000),
})

const SubPillarSchema = z.object({
  keyword: z.string(),
  suggestedTitle: z.string(),
  slug: z.string(),
  articleStyle: z.enum(['standard', 'narrative', 'listicle', 'data-heavy', 'comparison']),
  targetWords: z.number().default(1500),
  spokes: z.array(SpokeSchema),
})

const HubSchema = z.object({
  keyword: z.string(),
  suggestedTitle: z.string(),
  slug: z.string(),
  articleStyle: z.enum(['standard', 'narrative', 'listicle', 'data-heavy', 'comparison']),
  targetWords: z.number().default(2500),
})

const TopicalMapSchema = z.object({
  airportCode: z.string(),
  hub: HubSchema,
  subPillars: z.array(SubPillarSchema),
})

export type TopicalMap = z.infer<typeof TopicalMapSchema>

// --- Queue item format matching QueueItem interface ---

export interface QueueEntry {
  keyword: string
  suggestedTitle: string
  airportCode: string
  slug: string
  articleType: 'hub' | 'sub-pillar' | 'spoke'
  articleStyle: string
  targetWords: number
  priority: 'S1' | 'S2' | 'S3'
  hubSlug?: string
  parentSlug?: string
  batch: string
  status: 'queued'
}

// --- Core functions ---

function extractJson(text: string): string {
  let s = text.trim()
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*)```\s*$/)
  if (fenceMatch) s = fenceMatch[1].trim()
  if (!s.startsWith('{')) {
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start !== -1 && end > start) s = s.slice(start, end + 1)
  }
  return s
}

export async function generateTopicalMap(airportCode: string): Promise<TopicalMap> {
  const code = airportCode.toUpperCase()
  const airportData = loadAirportData(code)

  if (airportData) {
    console.log(`  Loaded airport data for ${code} (verified ${airportData.lastVerified})`)
  } else {
    console.log(`  No airport data file for ${code} — Claude will use general knowledge`)
  }

  console.log('  Generating topical map with Claude...')
  const prompt = buildPlanTopicsPrompt(code, airportData || undefined)

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8192,
    system: `You are an SEO content strategist for ${DOMAIN}. Respond with ONLY valid JSON.`,
    messages: [{ role: 'user', content: prompt }],
  })

  const textBlock = response.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude')
  }

  const jsonStr = extractJson(textBlock.text)
  const raw = JSON.parse(jsonStr)
  return TopicalMapSchema.parse(raw)
}

export function topicalMapToQueueEntries(map: TopicalMap, batch: string): QueueEntry[] {
  const entries: QueueEntry[] = []
  const code = map.airportCode.toUpperCase()

  // Hub (S1)
  entries.push({
    keyword: map.hub.keyword,
    suggestedTitle: map.hub.suggestedTitle,
    airportCode: code,
    slug: map.hub.slug,
    articleType: 'hub',
    articleStyle: map.hub.articleStyle,
    targetWords: map.hub.targetWords,
    priority: 'S1',
    batch,
    status: 'queued',
  })

  // Sub-pillars (S2) and their spokes (S3)
  for (const sp of map.subPillars) {
    entries.push({
      keyword: sp.keyword,
      suggestedTitle: sp.suggestedTitle,
      airportCode: code,
      slug: sp.slug,
      articleType: 'sub-pillar',
      articleStyle: sp.articleStyle,
      targetWords: sp.targetWords,
      priority: 'S2',
      hubSlug: map.hub.slug,
      batch,
      status: 'queued',
    })

    for (const spoke of sp.spokes) {
      entries.push({
        keyword: spoke.keyword,
        suggestedTitle: spoke.suggestedTitle,
        airportCode: code,
        slug: spoke.slug,
        articleType: 'spoke',
        articleStyle: spoke.articleStyle,
        targetWords: spoke.targetWords,
        priority: 'S3',
        hubSlug: map.hub.slug,
        parentSlug: sp.slug,
        batch,
        status: 'queued',
      })
    }
  }

  return entries
}

export function printTopicalMap(map: TopicalMap): void {
  const code = map.airportCode
  let totalArticles = 1 // hub

  console.log(`\n  Topical Map for ${code}`)
  console.log('  ═══════════════════════════════════════════')
  console.log(`\n  HUB (S1): ${map.hub.suggestedTitle}`)
  console.log(`    Keyword: "${map.hub.keyword}" | Style: ${map.hub.articleStyle} | ${map.hub.targetWords}w`)
  console.log(`    Slug: ${map.hub.slug}`)

  for (let i = 0; i < map.subPillars.length; i++) {
    const sp = map.subPillars[i]
    totalArticles++
    console.log(`\n  SUB-PILLAR ${i + 1} (S2): ${sp.suggestedTitle}`)
    console.log(`    Keyword: "${sp.keyword}" | Style: ${sp.articleStyle} | ${sp.targetWords}w`)
    console.log(`    Slug: ${sp.slug}`)

    for (const spoke of sp.spokes) {
      totalArticles++
      console.log(`    └─ SPOKE (S3): ${spoke.suggestedTitle}`)
      console.log(`       Keyword: "${spoke.keyword}" | Style: ${spoke.articleStyle} | ${spoke.targetWords}w`)
      console.log(`       Slug: ${spoke.slug}`)
    }
  }

  console.log(`\n  ─────────────────────────────────────────`)
  console.log(`  Total articles: ${totalArticles}`)
  console.log(`  Sub-pillars: ${map.subPillars.length}`)
  console.log(`  Spokes: ${map.subPillars.reduce((sum, sp) => sum + sp.spokes.length, 0)}`)
}

export function saveTopicalMap(map: TopicalMap): string {
  const outDir = path.resolve(__dirname, '..', 'data', 'topical-maps')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

  const filename = `${map.airportCode.toLowerCase()}-topical-map.json`
  const filepath = path.join(outDir, filename)
  fs.writeFileSync(filepath, JSON.stringify(map, null, 2))
  return filepath
}
