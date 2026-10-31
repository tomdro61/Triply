import { Command } from 'commander'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getNextQueuedItems, validatePrerequisites, markGenerating, markDraft, markError, markPublished, markQueued, getBatchItems } from './queue.js'
import { CreditBalanceError } from './retry.js'
import { anthropicOk } from './preflight.js'
import { generateArticlesBatch } from './generate-batch.js'
import type { BatchItemInput, BatchArticleOutcome } from './generate-batch.js'
import type { GenerateArticleResult } from './claude.js'
import type { QueueItem, ArticleStyle } from './queue.js'
import { ARTICLE_STYLES } from './queue.js'
import { scrapeCompetitors } from './scraper.js'
import type { ScrapedArticle } from './scraper.js'
import { generateArticle, resetTokenTracking, getTokenSummary, setCurrentStep, PROMPT_VERSION } from './claude.js'
import { factsDiff, lexicalText } from './stamp.js'
import { getPostById } from './payload.js'
import { sellableFlagSummary, type AirportData } from './airport-data.js'

/**
 * W1.3 / W1.6: the data block is the only source of figures, so it has to exist, carry sellable flags and be
 * fresh. Runs for every item BEFORE any scrape or batch submission (a refused item costs no SerpAPI or Claude
 * credit). loadAirportData already drops `sellable: false` lots. Throws with the reason.
 */
function checkAirportData(code: string, allowStale: boolean): { data: AirportData; note: string } {
  const counts = sellableFlagSummary(code)
  const data = counts ? loadAirportData(code) : null
  if (!counts || !data) throw new Error(`no data file for ${code} (data/airports/${code}.json) — the writer would guess every figure; add the file before generating`)
  // Counted on the raw file: every lot needs an explicit flag (one flagged lot among eight unflagged is not "flagged"),
  // and at least one must be sellable, or the writer has nothing to recommend.
  if (counts.total > 0 && counts.flagged < counts.total) throw new Error(`${code}: ${counts.total - counts.flagged} of ${counts.total} lots carry no sellable flag — the writer would name lots Triply cannot sell (W1.6); mark every lot sellable: true/false`)
  if (counts.sellable === 0) throw new Error(`${code}: no lot is marked sellable: true — nothing to recommend; mark the sellable lots first`)
  const verifiedAt = new Date(data.lastVerified)
  // An unreadable lastVerified is treated as stale, never as fresh.
  const ageDays = Number.isNaN(verifiedAt.getTime()) ? Number.POSITIVE_INFINITY : Math.round((Date.now() - verifiedAt.getTime()) / 86_400_000)
  if (ageDays > 90 && !allowStale) {
    const when = Number.isFinite(ageDays) ? `${ageDays} days ago (${data.lastVerified})` : `at an unreadable date ("${data.lastVerified}")`
    throw new Error(`${code} data was verified ${when} — refresh it, or pass --allow-stale-data`)
  }
  return { data, note: `verified ${data.lastVerified}; ${counts.sellable} sellable of ${counts.total} lots, all flagged` }
}
import { htmlToLexical } from './html-to-lexical.js'
import { generateInfographics } from './infographics.js'
import { getAirportPhoto } from './unsplash.js'
import {
  createPost,
  updatePost,
  findPostBySlug,
  uploadMedia,
  findOrCreateCategory,
  findOrCreateTag,
  getApiUser,
  getQueueItems,
  getAllPublishedSlugs,
  updateQueueItem,
  getClusterUsedPhotoIds,
  getAllSlugsAnyStatus,
} from './payload.js'
import { env, CLAUDE_MODEL } from './config.js'
import { loadAirportData } from './airport-data.js'
import { scoreArticle, printSeoScore } from './seo-scorer.js'
import type { SeoScore } from './seo-scorer.js'
import { lexicalToHtml } from './lexical-to-html.js'
import { bootstrapAirport, verifyUrls, saveBootstrapData, printBootstrapSummary } from './bootstrap-airport.js'
import { submitUrls, postUrlFor } from './indexnow.js'
import { findDuplicate, loadRedirectMap, logRefusal, REFUSAL_LOG_PATH } from './duplicate-guard.js'
import { lintArticle, formatLint, collectFigures } from './lint.js'
import { stampField } from './stamp.js'
import { rankBySimilarity } from './similarity.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const logsDir = path.resolve(__dirname, '..', 'logs')

/**
 * Strip any "Frequently Asked Questions" section from HTML body.
 * FAQs are stored as structured faqItems and rendered by FaqAccordion —
 * having them in the HTML body too causes duplicate rendering.
 */
function stripFaqSection(html: string): string {
  // Match an H2 starting with "frequently asked questions" or "FAQ" (case-insensitive)
  // and everything after it until the next H2 or end of string
  const faqPattern = /<h2[^>]*>\s*(?:frequently\s+asked\s+questions|faqs?)\b[^<]*<\/h2>[\s\S]*?(?=<h2[\s>]|$)/i
  const stripped = html.replace(faqPattern, '')
  if (stripped.length < html.length) {
    console.log('  ✓ Stripped FAQ section from HTML body (rendered separately via FaqAccordion)')
  }
  return stripped
}

interface ArticleReport {
  timestamp: string
  promptVersion: string
  experiment?: {
    arm: string | null
    modelAnalyze: string
    modelWrite: string
    modelEdit: string
  }
  queueItemId: string
  title: string
  slug: string
  keyword: string
  articleType: string
  airportCode: string
  priority: string
  scraping: {
    searchedKeyword: string
    urlsFound: number
    urlsScraped: number
    urlsFailed: number
    articles: {
      url: string
      title: string
      headingsFound: number
      status: 'success' | 'failed'
    }[]
  }
  analysis: {
    commonTopics: string[]
    contentGaps: string[]
    recommendedH2s: string[]
    faqQuestions: string[]
    suggestedTags: string[]
  }
  article: {
    htmlLength: number
    estimatedWordCount: number
    faqCount: number
    excerpt: string
    metaTitle: string
    metaDescription: string
    suggestedCategory: string
  }
  editing: {
    changesCount: number
    qualityScore: number
    changes: string[]
  }
  infographics: {
    count: number
  }
  image: {
    found: boolean
    filename: string | null
    alt: string | null
    mediaId: string | null
  }
  post: {
    postId: string | null
    status: string
    categoryCreated: string
    tagsCreated: string[]
  }
  timing: {
    totalSeconds: number
    scrapeSeconds: number
    analyzeSeconds: number
    writeSeconds: number
    editSeconds: number
    uploadSeconds: number
  }
  seoScore: SeoScore | null
  revision: {
    triggered: boolean
    scoreBefore: number
    scoreAfter: number
    failedChecks: string[]
  } | null
  tokenUsage?: {
    totalInput: number
    totalOutput: number
    totalCacheRead: number
    totalCacheWrite: number
    totalCost: number
    steps: { step: string; input: number; output: number; cost: number }[]
  }
  error: string | null
}

function saveReport(report: ArticleReport) {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }

  const date = new Date().toISOString().slice(0, 10)
  const safeSlug = report.slug.slice(0, 50)
  const filename = `${date}_${safeSlug}.json`
  const filepath = path.join(logsDir, filename)

  fs.writeFileSync(filepath, JSON.stringify(report, null, 2))
  return filepath
}

function printReport(report: ArticleReport) {
  console.log('\n  ┌──────────────────────────────────────────────────┐')
  console.log('  │              GENERATION REPORT                   │')
  console.log('  └──────────────────────────────────────────────────┘')

  console.log(`\n  Article: ${report.title}`)
  console.log(`  Slug: ${report.slug}`)
  console.log(`  Type: ${report.articleType} | Airport: ${report.airportCode} | Priority: ${report.priority}`)

  console.log(`\n  SCRAPING:`)
  console.log(`    Keyword searched: "${report.scraping.searchedKeyword}"`)
  console.log(`    URLs found: ${report.scraping.urlsFound} | Scraped: ${report.scraping.urlsScraped} | Failed: ${report.scraping.urlsFailed}`)
  for (const a of report.scraping.articles) {
    const icon = a.status === 'success' ? '✓' : '✗'
    console.log(`    ${icon} ${a.title || a.url} (${a.headingsFound} headings)`)
  }

  console.log(`\n  ANALYSIS:`)
  console.log(`    Common topics: ${report.analysis.commonTopics.join(', ')}`)
  console.log(`    Content gaps: ${report.analysis.contentGaps.join(', ')}`)
  console.log(`    Recommended H2s: ${report.analysis.recommendedH2s.length}`)
  console.log(`    FAQ questions: ${report.analysis.faqQuestions.length}`)
  console.log(`    Tags: ${report.analysis.suggestedTags.join(', ')}`)

  console.log(`\n  ARTICLE:`)
  console.log(`    HTML length: ${report.article.htmlLength.toLocaleString()} chars`)
  console.log(`    Est. word count: ~${report.article.estimatedWordCount.toLocaleString()}`)
  console.log(`    FAQs: ${report.article.faqCount}`)
  console.log(`    Meta title: ${report.article.metaTitle}`)
  console.log(`    Category: ${report.article.suggestedCategory}`)

  console.log(`\n  EDITING:`)
  console.log(`    Quality score: ${report.editing.qualityScore}/100`)
  console.log(`    Changes made: ${report.editing.changesCount}`)
  for (const c of report.editing.changes.slice(0, 5)) {
    console.log(`    - ${c}`)
  }
  if (report.editing.changes.length > 5) {
    console.log(`    ... and ${report.editing.changes.length - 5} more`)
  }

  if (report.revision) {
    console.log(`\n  REVISION:`)
    console.log(`    Triggered: ${report.revision.triggered ? 'Yes' : 'No'}`)
    if (report.revision.triggered) {
      console.log(`    Score before: ${report.revision.scoreBefore}`)
      console.log(`    Score after: ${report.revision.scoreAfter}`)
      console.log(`    Improvement: ${report.revision.scoreAfter - report.revision.scoreBefore >= 0 ? '+' : ''}${report.revision.scoreAfter - report.revision.scoreBefore} points`)
      console.log(`    Failed checks addressed: ${report.revision.failedChecks.length}`)
    }
  }

  console.log(`\n  INFOGRAPHICS:`)
  console.log(`    Generated: ${report.infographics.count}`)

  console.log(`\n  IMAGE:`)
  if (report.image.found) {
    console.log(`    File: ${report.image.filename}`)
    console.log(`    Alt: ${report.image.alt}`)
    console.log(`    Media ID: ${report.image.mediaId}`)
  } else {
    console.log(`    No image uploaded`)
  }

  console.log(`\n  POST:`)
  console.log(`    Post ID: ${report.post.postId}`)
  console.log(`    Status: ${report.post.status}`)
  console.log(`    Category: ${report.post.categoryCreated}`)
  console.log(`    Tags: ${report.post.tagsCreated.join(', ')}`)

  console.log(`\n  TIMING:`)
  console.log(`    Total: ${report.timing.totalSeconds}s`)
  console.log(`    Scraping: ${report.timing.scrapeSeconds}s | Analyze: ${report.timing.analyzeSeconds}s`)
  console.log(`    Write: ${report.timing.writeSeconds}s | Edit: ${report.timing.editSeconds}s`)
  console.log(`    Upload: ${report.timing.uploadSeconds}s`)
}

const program = new Command()
  .name('triply-blog-engine')
  .description('Automated SEO blog content generator for Triply')
  .version('1.0.0')

// Generate command
program
  .command('generate')
  .description('Generate blog articles from the content queue')
  .option('-t, --type <type>', 'Article type filter: hub, sub-pillar, spoke')
  .option('-a, --airport <code>', 'Airport code filter (e.g., JFK)')
  .option('-n, --limit <number>', 'Max articles to generate', '1')
  .option('-m, --min-sv <number>', 'Only process items with searchVolume >= N (sorted by SV desc)')
  .option('-s, --slug <slug>', 'Target exactly one queued item by slug (used by `maintain` rewrites)')
  .option('--style <style>', `Override articleStyle for this run: ${ARTICLE_STYLES.join(' | ')}`)
  .option('--batch', 'EXPERIMENTAL: generate all items via the async Batches API (~50% cheaper text, minutes–hours latency)')
  .option('--publish', 'Create posts as published (default: draft — review in the Payload admin, then `npm run publish`)')
  .option('--stamp', 'Regenerating an existing slug: also set contentUpdatedAt (W1.7). Default off.')
  .option('--skip-duplicate-guard', 'DANGEROUS: write even when the keyword matches an existing page at the airport')
  .option('--allow-stale-data', 'Write even when the airport data file was verified more than 90 days ago')
  .option('--dry-run', 'Preview what would be generated without creating posts')
  .action(async (options) => {
    // Collect successfully published URLs → one bulk IndexNow ping at the end (in `finally`, so a fatal
    // error after a publish still pings what went live). Instant Bing/Yandex indexing; feeds ChatGPT/Copilot.
    const publishedUrls: string[] = []
    // Refused, failed and written counts drive the exit code (a caller like maintain must not read a run with
    // failures as "done"), so they live outside the try: the `finally` reads them on every exit path.
    let errored = 0
    let succeeded = 0
    try {
      console.log(`\n🚀 Triply Blog Engine — Generate [prompt: ${PROMPT_VERSION}]\n`)
      const publishMode: boolean = Boolean(options.publish)
      console.log(publishMode
        ? '  Status: --publish → posts go live immediately'
        : '  Status: draft (pass --publish to go live; CLAUDE.md: generate as draft → review → publish)')

      // Validate --style before touching the queue, so a typo fails immediately rather than
      // silently passing whenever the filters happen to match nothing.
      let styleOverride: ArticleStyle | undefined
      if (options.style) {
        const style = String(options.style).toLowerCase()
        if (!ARTICLE_STYLES.includes(style as ArticleStyle)) {
          console.error(`Invalid --style "${options.style}". Must be one of: ${ARTICLE_STYLES.join(', ')}`)
          process.exit(1)
        }
        styleOverride = style as ArticleStyle
      }

      const limit = parseInt(options.limit, 10)
      const minSv = options.minSv !== undefined ? parseInt(options.minSv, 10) : undefined
      const items = await getNextQueuedItems(options.type, options.airport, limit, minSv, options.slug)

      if (items.length === 0) {
        console.log('No queued items found matching your filters.')
        return
      }

      // Apply the override here, before any consumer reads the items, so write/edit/score/batch
      // all see the same value without threading a flag through each call site. This is a
      // run-local override — nothing is written back to the CMS.
      if (styleOverride) {
        for (const item of items) item.articleStyle = styleOverride
        console.log(`Style override: all ${items.length} item(s) will be written as "${styleOverride}" (not persisted to the queue)`)
      }

      console.log(`Found ${items.length} queued item(s)\n`)

      // Preflight: confirm Anthropic credit before spending any SerpAPI budget.
      // A dead key / empty balance would otherwise scrape competitors for every
      // item and then fail the write — wasting SERP credits on unusable data.
      if (!options.dryRun) {
        const creditOk = await anthropicOk()
        if (!creditOk) {
          console.error('\n🛑 Anthropic preflight failed (key invalid or credit balance empty).')
          console.error('   Top up credits and re-run — no items were touched, no SerpAPI spent.')
          process.exit(1)
        }
      }

      // Fetch all published slugs for internal link intelligence
      console.log('Fetching published posts for internal linking...')
      const publishedPosts = await getAllPublishedSlugs()
      console.log(`  ✓ ${publishedPosts.length} published post(s) available for linking\n`)

      // W1.1 duplicate guard: one page per question per airport. Compare the normalised keyword
      // with every slug at the airport in ANY status plus the redirect map; refuse matches.
      const redirectMap = loadRedirectMap()
      const slugsByAirport = new Map<string, string[]>()
      const statusBySlug = new Map<string, string>() // reused by the preflight below: a LIVE slug needs --publish
      const inRun = new Set<string>()
      const guarded: QueueItem[] = []
      for (const item of items) {
        const code = item.airportCode.toUpperCase()
        if (!slugsByAirport.has(code)) {
          const known = await getAllSlugsAnyStatus(code)
          slugsByAirport.set(code, known.map((p) => p.slug))
          for (const p of known) statusBySlug.set(p.slug, p.status)
        }
        const dup = findDuplicate(item.keyword, code, slugsByAirport.get(code)!, redirectMap, item.slug)
        if (dup && inRun.has(dup.matchedSlug)) {
          // Same question as an item accepted earlier in THIS run. Not an error on this item — its twin may still
          // fail — so it stays queued and is judged against the real page next run.
          console.log(`  ⏭ "${item.keyword}" asks the same question as "${dup.matchedSlug}" earlier in this run — left queued; re-run once that one is written`)
          continue
        }
        if (dup && !options.skipDuplicateGuard) {
          const rec = { at: new Date().toISOString(), airportCode: code, keyword: item.keyword, queuedSlug: item.slug, queueItemId: item.id, match: dup }
          if (!options.dryRun) logRefusal(rec)
          console.log(`  ⛔ "${item.keyword}" duplicates /blog/${dup.slug} (${dup.via}) — refused; update that page instead.${options.dryRun ? '' : ` Logged to ${path.relative(process.cwd(), REFUSAL_LOG_PATH)}`}`)
          if (!options.dryRun) {
            await markError(item.id, `duplicate guard: update /blog/${dup.slug} instead (matched ${dup.matchedSlug})`)
              .catch((e) => console.warn(`  ⚠ could not mark queue item ${item.id} as error (it will be picked up again next run): ${e instanceof Error ? e.message : e}`))
          }
          errored++
          continue
        }
        if (dup) console.log(`  ⚠ "${item.keyword}" duplicates /blog/${dup.slug} but --skip-duplicate-guard was passed`)
        guarded.push(item)
        // An accepted item now answers its question: a second queued item for the same question in THIS run
        // ("jfk parking cost" + "jfk parking prices") must see it, or both get written.
        slugsByAirport.get(code)!.push(item.slug)
        inRun.add(item.slug)
      }
      items.length = 0
      items.push(...guarded)
      if (items.length === 0) {
        console.log('Every queued item was refused by the duplicate guard. Nothing to generate.')
        return
      }

      // Verified airport data — checked here, before the batch pre-phase or any per-item scrape, so neither mode
      // spends a SerpAPI or Claude credit on an item that will be refused.
      console.log('Checking airport data files...')
      const airportDataById = new Map<string, AirportData>()
      {
        const withData: QueueItem[] = []
        for (const item of items) {
          // A LIVE slug without --publish is refused HERE, before any spend; the same check near the write is the backstop.
          if (statusBySlug.get(item.slug) === 'published' && !publishMode) {
            console.log(`  ⛔ "${item.keyword}": /blog/${item.slug} is LIVE — regenerating it without --publish would replace its body in place. Left queued; re-run with --publish, or change it with apply-edit.`)
            errored++
            continue
          }
          try {
            const { data, note } = checkAirportData(item.airportCode, Boolean(options.allowStaleData))
            airportDataById.set(item.id, data)
            console.log(`  ✓ ${item.airportCode}: ${note}`)
            withData.push(item)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.log(`  ⛔ "${item.keyword}" refused — ${msg}`)
            if (!options.dryRun) {
              await markError(item.id, `airport data: ${msg}`)
                .catch((err) => console.warn(`  ⚠ could not mark queue item ${item.id} as error: ${err instanceof Error ? err.message : err}`))
            }
            errored++
          }
        }
        items.length = 0
        items.push(...withData)
        if (items.length === 0) {
          console.log('No queued item has a usable airport data file. Nothing to generate.')
          return
        }
      }

      // Get the API user for the author field
      const apiUser = await getApiUser()
      if (!apiUser) {
        console.error('Error: No API user found. Create a user in the CMS first.')
        process.exit(1)
      }

      // EXPERIMENTAL batch mode: pre-scrape every item, then generate ALL article
      // text through the async Batches API (~50% cheaper). The normal per-item loop
      // below still handles infographics + CMS upload + report using these results.
      let batchCompetitors: Map<string, ScrapedArticle[]> | null = null
      let batchOutcomes: Map<string, BatchArticleOutcome> | null = null
      if (options.batch && !options.dryRun) {
        console.log('\n📦 BATCH MODE (experimental) — pre-scraping all items, then generating text via the Batches API…')
        console.log('   Latency is async (minutes–hours). Validate on a small run before trusting a full cluster.\n')
        batchCompetitors = new Map()
        const batchInputs: BatchItemInput[] = []
        const marked: string[] = []
        try {
          for (const item of items) {
            await markGenerating(item.id)
            marked.push(item.id)
            const manualUrls = item.competitorUrls?.map((c) => c.url) || []
            const competitors = await scrapeCompetitors(item.keyword, manualUrls)
            batchCompetitors.set(item.id, competitors)
            batchInputs.push({ item, competitors, airportData: airportDataById.get(item.id) })
          }
          const { outcomes, totalCost } = await generateArticlesBatch(batchInputs, publishedPosts)
          console.log(`   Batch text cost: $${totalCost.toFixed(4)} (infographics + CMS still per-item below)`)
          batchOutcomes = new Map(outcomes.map((o) => [o.itemId, o]))
        } catch (err) {
          // A batch-phase failure must not strand every item in 'generating' (invisible to getNextQueuedItems).
          console.error(`  ✗ batch phase failed: ${err instanceof Error ? err.message : err} — resetting ${marked.length} item(s) to queued`)
          for (const id of marked) await markQueued(id).catch((e) => console.warn(`  ⚠ could not reset ${id} to queued: ${e instanceof Error ? e.message : e}`))
          throw err
        }
      }

      for (const item of items) {
        console.log(`\n━━━ Processing: ${item.keyword} ━━━`)
        console.log(`  Type: ${item.articleType} | Airport: ${item.airportCode} | Priority: ${item.priority}`)

        // Validate prerequisites
        const prereqError = await validatePrerequisites(item)
        if (prereqError) {
          console.log(`  ⏭ Skipping — ${prereqError}`)
          continue
        }

        if (options.dryRun) {
          console.log('  [DRY RUN] Would generate this article. Skipping.')
          continue
        }

        // Initialize report
        const report: ArticleReport = {
          timestamp: new Date().toISOString(),
          promptVersion: PROMPT_VERSION,
          experiment: {
            arm: process.env.EXPERIMENT_ARM || null,
            modelAnalyze: process.env.MODEL_ANALYZE || CLAUDE_MODEL,
            modelWrite: process.env.MODEL_WRITE || CLAUDE_MODEL,
            modelEdit: process.env.MODEL_EDIT || CLAUDE_MODEL,
          },
          queueItemId: item.id,
          title: item.keyword,
          slug: item.slug,
          keyword: item.keyword,
          articleType: item.articleType,
          airportCode: item.airportCode,
          priority: item.priority,
          scraping: { searchedKeyword: item.keyword, urlsFound: 0, urlsScraped: 0, urlsFailed: 0, articles: [] },
          analysis: { commonTopics: [], contentGaps: [], recommendedH2s: [], faqQuestions: [], suggestedTags: [] },
          article: { htmlLength: 0, estimatedWordCount: 0, faqCount: 0, excerpt: '', metaTitle: '', metaDescription: '', suggestedCategory: '' },
          editing: { changesCount: 0, qualityScore: 0, changes: [] },
          infographics: { count: 0 },
          image: { found: false, filename: null, alt: null, mediaId: null },
          post: { postId: null, status: 'draft', categoryCreated: '', tagsCreated: [] },
          timing: { totalSeconds: 0, scrapeSeconds: 0, analyzeSeconds: 0, writeSeconds: 0, editSeconds: 0, uploadSeconds: 0 },
          seoScore: null,
          revision: null,
          error: null,
        }

        const totalStart = Date.now()

        try {
          // Mark as generating
          await markGenerating(item.id)
          // Reset per-item token tracking. In sync mode this captures analyze/write/
          // edit + infographics; in batch mode text cost is reported by the batch
          // summary, so this captures just this item's infographic tokens.
          resetTokenTracking()

          // Validated up front (checkAirportData), before any scrape.
          const airportData = airportDataById.get(item.id)
          if (!airportData) throw new Error(`internal: airport data for ${item.airportCode} was not validated for this item`)

          // Scrape competitors (reuse the batch pre-phase's scrape when in batch mode)
          const scrapeStart = Date.now()
          const manualUrls = item.competitorUrls?.map((c) => c.url) || []
          const competitors = batchCompetitors
            ? (batchCompetitors.get(item.id) || [])
            : await scrapeCompetitors(item.keyword, manualUrls)
          report.timing.scrapeSeconds = Math.round((Date.now() - scrapeStart) / 1000)

          // Populate scraping report
          report.scraping.urlsFound = competitors.length + (manualUrls.length > 0 ? 0 : 5 - competitors.length)
          report.scraping.urlsScraped = competitors.length
          report.scraping.urlsFailed = report.scraping.urlsFound - competitors.length
          report.scraping.articles = competitors.map((c: ScrapedArticle) => ({
            url: c.url,
            title: c.title,
            headingsFound: c.headings.length,
            status: 'success' as const,
          }))

          // Filter published posts to same airport (keep context focused)
          // W1.2: ranked by similarity to this keyword (hub first), not CMS order
          const airportPosts = rankBySimilarity(item.keyword, item.airportCode, publishedPosts.filter(p =>
            p.airportCode === item.airportCode || !p.airportCode
          ))

          // Generate with Claude. In batch mode the text was already produced by the
          // pre-phase; reuse that result (a missing/errored item throws → per-item
          // error handling below). Otherwise run the normal sync 3-prompt pipeline.
          let result: GenerateArticleResult
          if (batchOutcomes) {
            const o = batchOutcomes.get(item.id)
            if (!o || !o.result) throw new Error(o?.error || 'batch generation produced no result for this item')
            result = o.result
          } else {
            result = await generateArticle(item, competitors, (step, data) => {
              // Callback to capture intermediate results for the report
              const r = data.result as Record<string, unknown>
              if (step === 'analyze') {
                report.timing.analyzeSeconds = Math.round(data.elapsed / 1000)
                report.analysis = {
                  commonTopics: (r.commonTopics as string[]) || [],
                  contentGaps: (r.gaps as string[]) || [],
                  recommendedH2s: (r.recommendedH2s as string[]) || [],
                  faqQuestions: (r.faqQuestions as string[]) || [],
                  suggestedTags: (r.suggestedTags as string[]) || [],
                }
              } else if (step === 'write') {
                report.timing.writeSeconds = Math.round(data.elapsed / 1000)
              } else if (step === 'edit') {
                report.timing.editSeconds = Math.round(data.elapsed / 1000)
                report.editing = {
                  changesCount: (r.changes as string[])?.length || 0,
                  qualityScore: (r.qualityScore as number) || 0,
                  changes: (r.changes as string[]) || [],
                }
              }
            }, airportData || undefined, airportPosts)
          }

          // Capture revision metadata
          if (result.revision) {
            report.revision = result.revision
          }

          // Resolve title: AI-generated > spreadsheet > keyword
          const resolvedTitle = result.title || item.keyword
          report.title = resolvedTitle

          // Article stats
          report.article = {
            htmlLength: result.html.length,
            estimatedWordCount: Math.round(result.html.replace(/<[^>]+>/g, ' ').split(/\s+/).length),
            faqCount: result.faqItems.length,
            excerpt: result.excerpt,
            metaTitle: result.metaTitle,
            metaDescription: result.metaDescription,
            suggestedCategory: result.suggestedCategory,
          }

          // Use SEO score from generateArticle (already scored during write/edit flow)
          const seoScore = result.seoScore
          report.seoScore = seoScore
          if (result.editSkipped) {
            console.log(`  ✓ Edit skipped (score ${seoScore.total}/${seoScore.maxTotal} above threshold)`)
          }

          // Generate infographics (Claude SVG → resvg PNG → Payload upload)
          let contentHtml = result.html
          if (airportData) {
            try {
              console.log('  Generating infographics...')
              setCurrentStep('infographics')
              const infResult = await generateInfographics(contentHtml, airportData, item.airportCode)
              contentHtml = infResult.html
              report.infographics.count = infResult.count
              if (infResult.count > 0) {
                console.log(`  ✓ ${infResult.count} infographic(s) generated`)
              } else {
                console.log('  No infographics generated')
              }
            } catch (err) {
              console.log(`  ⚠ Infographic generation failed: ${err instanceof Error ? err.message : err} — continuing without`)
            }
          }

          // Strip any FAQ section from HTML body (FAQs are rendered separately via FaqAccordion)
          contentHtml = stripFaqSection(contentHtml)

          // Convert HTML to Lexical
          console.log('  Converting to Lexical format...')
          const lexicalContent = htmlToLexical(contentHtml)

          // Upload featured image (with cluster deduplication)
          const uploadStart = Date.now()
          let featuredImageId: string | null = null
          console.log('  Fetching featured image...')
          let usedPhotoIds: string[] = []
          try {
            usedPhotoIds = await getClusterUsedPhotoIds(item.airportCode)
            if (usedPhotoIds.length > 0) {
              console.log(`    Excluding ${usedPhotoIds.length} photo(s) already used in ${item.airportCode} cluster`)
            }
          } catch (e) {
            // Dedup is optional (worst case: a repeated hero photo), but log the
            // reason so a real auth/network failure isn't invisible.
            console.log(`    ⚠ cluster photo dedup skipped: ${e instanceof Error ? e.message : e}`)
          }
          const photo = await getAirportPhoto(item.airportCode, item.keyword, usedPhotoIds)
          if (photo) {
            const media = await uploadMedia(photo.buffer, photo.filename, photo.alt)
            featuredImageId = media.doc?.id || media.id
            report.image = { found: true, filename: photo.filename, alt: photo.alt, mediaId: featuredImageId }
            console.log(`  ✓ Image uploaded: ${photo.filename}`)
          } else {
            console.log('  ⚠ No image found — post will be created without featured image')
          }
          report.timing.uploadSeconds = Math.round((Date.now() - uploadStart) / 1000)

          // Re-score the image check now that we know if image was uploaded
          if (report.seoScore) {
            const imgScore = scoreArticle({
              html: result.html,
              keyword: item.keyword,
              slug: item.slug,
              metaTitle: result.metaTitle,
              metaDescription: result.metaDescription,
              excerpt: result.excerpt,
              faqItems: result.faqItems,
              articleType: item.articleType as 'hub' | 'sub-pillar' | 'spoke',
              articleStyle: item.articleStyle,
              targetWords: item.targetWords || (item.articleType === 'hub' ? 2500 : item.articleType === 'sub-pillar' ? 1500 : 1000),
              hasImage: report.image.found,
              imageAlt: report.image.alt,
              airportCode: item.airportCode,
              parentSlug: item.parentSlug,
              hubSlug: item.hubSlug,
              // Forward CTA text so CTA-relevance scores on the final logged score
              // (previously omitted → "CTA topic relevance" failed 100% of articles).
              earlyCta: result.earlyCta,
              closingCta: result.closingCta,
            })
            report.seoScore = imgScore
          }

          // Find or create category and tags
          const category = await findOrCreateCategory(result.suggestedCategory)
          report.post.categoryCreated = result.suggestedCategory
          const tagIds: string[] = []
          for (const tagName of result.suggestedTags) {
            const tag = await findOrCreateTag(tagName)
            tagIds.push(tag.doc?.id || tag.id)
            report.post.tagsCreated.push(tagName)
          }

          // Check if a post with this slug already exists (re-generation)
          const existingPost = await findPostBySlug(item.slug)

          // W1.4 lint — fails the write. Year + answer-first checks apply to new posts only.
          const lint = lintArticle({
            title: resolvedTitle, metaTitle: result.metaTitle, metaDescription: result.metaDescription,
            html: contentHtml, excerpt: result.excerpt, faqItems: result.faqItems,
            keyword: item.keyword, slug: item.slug, isNew: !existingPost,
            knownFigures: airportData ? collectFigures(airportData) : undefined,
          })
          if (lint.warnings.length) console.log(formatLint({ ok: true, errors: [], warnings: lint.warnings }))
          if (!lint.ok) {
            console.log(`  ⛔ Lint failed (${lint.errors.length}) — not written to the CMS:\n${formatLint(lint)}`)
            throw new Error(`lint: ${lint.errors.map((e) => `${e.rule}: ${e.message}`).join(' | ')}`)
          }

          const postStatus: 'draft' | 'published' = publishMode ? 'published' : 'draft'
          const postData: Record<string, unknown> = {
            title: resolvedTitle,
            slug: item.slug,
            excerpt: result.excerpt,
            content: lexicalContent,
            category: category.doc?.id || category.id,
            tags: tagIds,
            author: apiUser.id,
            status: postStatus,
            ...(publishMode ? { publishedAt: new Date().toISOString() } : {}),
            airportCode: item.airportCode,
            articleType: item.articleType,
            parentSlug: item.parentSlug || undefined,
            hubSlug: item.hubSlug || undefined,
            faqItems: result.faqItems,
            seo: {
              metaTitle: result.metaTitle,
              metaDescription: result.metaDescription,
            },
          }

          if (featuredImageId) {
            postData.featuredImage = featuredImageId
          }

          // Include SEO score in post data
          if (report.seoScore) {
            postData.seoScore = Math.min(report.seoScore.total, 100)
            postData.seoScoreDetails = report.seoScore
          }

          let postId: string
          // The status the post will have after this write — the queue, the IndexNow ping and the success line all follow it.
          let finalStatus: 'draft' | 'published' = postStatus
          if (existingPost) {
            // A regenerate replaces the body IN PLACE. On a live post that is a live content change, so the
            // draft default cannot silently cover it: it needs the same --publish a new post would.
            if (existingPost.status === 'published' && !publishMode) {
              throw new Error(`/blog/${item.slug} is LIVE — regenerating it without --publish would replace its body in place. Re-run with --publish to overwrite it, or change it with apply-edit.`)
            }
            // Update existing post instead of creating a duplicate.
            // Preserve the original publishedAt (datePublished) on refresh — Payload
            // auto-bumps updatedAt, which drives dateModified in JSON-LD. Resetting
            // publishedAt here is what previously made dateModified === datePublished.
            console.log(`  Updating existing post (ID:${existingPost.id}, ${existingPost.status}) with regenerated content...`)
            const { publishedAt: _omitPublishedAt, ...updateData } = postData
            // Stamp the dedicated freshness field ONLY on a genuine content refresh
            // (this existingPost branch). Drives the "Updated [Month YYYY]" badge,
            // JSON-LD dateModified, OG modified_time, and sitemap lastmod. New posts
            // (the else branch) leave it unset so the badge stays hidden until the
            // first real refresh. The score pass (updatePost with seoScore) and the
            // update-links pass (updatePost with content) deliberately never set this,
            // so neither bumps the visible freshness date — the reason Tom used a
            // dedicated field instead of Payload's auto-bumping updatedAt.
            // A regenerate never flips a post's status: a draft stays a draft (publish it with `npm run publish`),
            // a live post stays live. Everything downstream reads `finalStatus`, not the flag.
            delete updateData.status
            finalStatus = existingPost.status === 'published' ? 'published' : 'draft'
            // W1.7: the date moves only by an explicit --stamp AND when a sentence with a figure actually changed.
            // Both sides flattened the same way (Lexical → text); HTML vs Lexical never compared equal.
            const facts = factsDiff(lexicalText(existingPost.content), lexicalText(lexicalContent))
            Object.assign(updateData, stampField({
              factsChanged: facts.changed,
              requested: Boolean(options.stamp),
              reason: facts.changed ? `${facts.added.length} figure sentence(s) added, ${facts.removed.length} removed` : 'no sentence with a figure changed',
            }))
            await updatePost(existingPost.id, updateData)
            postId = existingPost.id
          } else {
            console.log(`  Creating ${postStatus} post in CMS...`)
            const post = await createPost(postData)
            postId = post.doc?.id || post.id
          }
          report.post.postId = postId
          report.post.status = finalStatus
          // IndexNow on every publish AND every update (W1.11); a draft is not public, nothing to ping.
          if (finalStatus === 'published') publishedUrls.push(postUrlFor(item.slug))

          // The queue item's status follows the post's real status, not the flag.
          if (finalStatus === 'published') await updateQueueItem(item.id, { status: 'published', generatedPost: postId })
          else await markDraft(item.id, postId)

          report.timing.totalSeconds = Math.round((Date.now() - totalStart) / 1000)

          // Token cost summary
          const tokenSummary = getTokenSummary()
          report.tokenUsage = {
            totalInput: tokenSummary.totalInput,
            totalOutput: tokenSummary.totalOutput,
            totalCacheRead: tokenSummary.totalCacheRead,
            totalCacheWrite: tokenSummary.totalCacheWrite,
            totalCost: Math.round(tokenSummary.totalCost * 10000) / 10000,
            steps: tokenSummary.steps.map(s => ({ step: s.step, input: s.inputTokens, output: s.outputTokens, cost: Math.round(s.cost * 10000) / 10000 })),
          }
          console.log(`\n  💰 Total API cost: $${tokenSummary.totalCost.toFixed(4)} (${tokenSummary.totalInput.toLocaleString()} in / ${tokenSummary.totalOutput.toLocaleString()} out)`)
          for (const s of tokenSummary.steps) {
            console.log(`     ${s.step}: $${s.cost.toFixed(4)} (${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out)`)
          }

          console.log(`\n  ✅ ${finalStatus === 'published' ? 'Published' : 'Draft saved'}${existingPost ? ' (existing post updated)' : ''}! SEO Score: ${report.seoScore?.total}/${report.seoScore?.maxTotal} (${report.seoScore?.grade})`)
          console.log(finalStatus === 'published' ? `  🌐 Live at: ${postUrlFor(item.slug)}` : `  📝 Review at: CMS Admin → Posts → "${resolvedTitle}" — then \`npm run publish\``)

          // Print reports
          printReport(report)
          if (report.seoScore) printSeoScore(report.seoScore)
          const reportPath = saveReport(report)
          console.log(`\n  📄 Report saved: ${reportPath}`)
          succeeded++
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)

          // Out of Anthropic credits: not this item's fault, and it will hit every
          // remaining item identically. Abort the batch instead of marching on and
          // wasting SerpAPI scraping on articles that can't be written. Leave this
          // item as 'queued' so a re-run (after top-up) picks it up cleanly.
          if (err instanceof CreditBalanceError) {
            console.error(`\n🛑 ${errorMsg}`)
            console.error('   Aborting batch — top up credits, then re-run. This item left as queued.')
            report.error = errorMsg
            report.timing.totalSeconds = Math.round((Date.now() - totalStart) / 1000)
            await markQueued(item.id).catch((e) => console.warn(`  ⚠ could not reset ${item.id} to queued — it is stuck in 'generating' until fixed by hand: ${e instanceof Error ? e.message : e}`))
            saveReport(report)
            errored++
            break
          }

          errored++
          console.error(`  ❌ Error: ${errorMsg}`)
          report.error = errorMsg
          report.timing.totalSeconds = Math.round((Date.now() - totalStart) / 1000)
          try {
            await markError(item.id, errorMsg)
          } catch (e) {
            // Keep going: the error report below is still saved, the IndexNow ping still runs in `finally`.
            console.warn(`  ⚠ could not mark queue item ${item.id} as error — it stays 'generating' until fixed by hand: ${e instanceof Error ? e.message : e}`)
          }

          // Save report even on error
          const reportPath = saveReport(report)
          console.log(`  📄 Error report saved: ${reportPath}`)
        }
      }

      // A caller (maintain's Tier-1 rewrite, a cron) must not read a run with failures as "done".
      if (errored > 0 || (!options.dryRun && items.length > 0 && succeeded === 0)) {
        console.log(`\n⚠ ${succeeded} written, ${errored} failed, ${items.length - succeeded - errored} skipped — exit code 1`)
        process.exitCode = 1
      }

      console.log('\n✨ Generation complete!\n')
    } catch (err) {
      console.error('Fatal error:', err)
      process.exitCode = 1
    } finally {
      // Bulk-notify IndexNow of everything published this run (no-op without a key; submitUrls never throws).
      if (publishedUrls.length > 0) {
        console.log(`\n📣 Notifying IndexNow of ${publishedUrls.length} published URL(s)...`)
        await submitUrls(publishedUrls)
      }
      // Refusals on the early-return paths (duplicate guard, data check) count too.
      if (errored > 0 && !options.dryRun) process.exitCode = 1
      void succeeded
    }
  })

// Report command
program
  .command('report')
  .description('Show content queue status report')
  .option('-a, --airport <code>', 'Airport code filter')
  .option('-b, --batch <batch>', 'Batch name filter')
  .action(async (options) => {
    try {
      console.log('\n📊 Triply Blog Engine — Queue Report\n')

      const filters: Record<string, string> = {}
      if (options.airport) {
        filters['where[airportCode][equals]'] = options.airport.toUpperCase()
      }
      if (options.batch) {
        filters['where[batch][equals]'] = options.batch
      }

      const result = await getQueueItems(filters)
      const items = result.docs as QueueItem[]

      if (items.length === 0) {
        console.log('Queue is empty.')
        return
      }

      // Group by status
      const byStatus: Record<string, QueueItem[]> = {}
      for (const item of items) {
        if (!byStatus[item.status]) byStatus[item.status] = []
        byStatus[item.status].push(item)
      }

      const statusOrder = ['queued', 'generating', 'draft', 'review', 'published', 'error']
      for (const status of statusOrder) {
        const group = byStatus[status]
        if (!group) continue

        console.log(`\n${status.toUpperCase()} (${group.length}):`)
        for (const item of group) {
          const batchTag = item.batch ? ` [${item.batch}]` : ''
          console.log(`  ${item.priority} | ${item.airportCode} | ${item.articleType.padEnd(11)} | ${item.keyword}${batchTag}`)
        }
      }

      console.log(`\nTotal: ${items.length} items`)

      // Show batch summary if filtering by batch
      if (options.batch) {
        const published = byStatus['published']?.length || 0
        const draft = byStatus['draft']?.length || 0
        const review = byStatus['review']?.length || 0
        const queued = byStatus['queued']?.length || 0
        const error = byStatus['error']?.length || 0
        console.log(`\nBatch "${options.batch}" summary:`)
        console.log(`  Queued: ${queued} | Draft: ${draft} | Review: ${review} | Published: ${published} | Error: ${error}`)
      }

      console.log('')
    } catch (err) {
      console.error('Error:', err)
      process.exit(1)
    }
  })

// Publish command
program
  .command('publish')
  .description('Publish articles by batch — updates post status and queue item status')
  .requiredOption('-b, --batch <batch>', 'Batch name to publish')
  .option('--dry-run', 'Preview what would be published without making changes')
  .action(async (options) => {
    try {
      console.log('\n📤 Triply Blog Engine — Batch Publish\n')
      console.log(`Batch: ${options.batch}${options.dryRun ? ' (DRY RUN)' : ''}\n`)

      // Fetch items in the batch with draft/review status
      const items = await getBatchItems(options.batch, ['draft', 'review'])

      if (items.length === 0) {
        console.log('No draft or review items found in this batch.')
        console.log('Items must have status "draft" or "review" to be published.')
        return
      }

      console.log(`Found ${items.length} article(s) to publish:\n`)

      let published = 0
      let failed = 0

      const publishedUrls: string[] = []
      for (const item of items) {
        // `generatedPost` is a Payload relationship: the REST API returns the id (a number on Postgres) or the
        // populated post — never a string. The old `typeof === 'string'` check skipped every post and still
        // marked the queue item published.
        const gp = item.generatedPost as unknown
        const postId = gp && typeof gp === 'object' ? String((gp as { id?: unknown }).id ?? '') : gp != null ? String(gp) : ''
        console.log(`  ${item.slug}`)
        console.log(`    Title: ${item.keyword}`)
        console.log(`    Status: ${item.status} → published`)
        console.log(`    Post ID: ${postId || 'none'}`)

        if (options.dryRun) {
          console.log('    [DRY RUN] Would publish this article.\n')
          published++
          continue
        }

        try {
          if (!postId) throw new Error('queue item has no linked post — generate it first')
          const post = await getPostById(postId)
          // publishedAt drives the card date, the -publishedAt sort and JSON-LD datePublished; a draft never had one.
          await updatePost(postId, { status: 'published', publishedAt: post.publishedAt ?? new Date().toISOString() })
          const after = await getPostById(postId)
          if (after.status !== 'published') throw new Error(`CMS still reports status "${after.status}" after the update`)

          // The post is live from here on, whatever happens to the queue row.
          publishedUrls.push(postUrlFor(item.slug))
          published++
          try {
            await markPublished(item.id)
          } catch (e) {
            console.log(`    ⚠ post is LIVE but the queue item could not be marked published (fix by hand): ${e instanceof Error ? e.message : e}`)
          }
          console.log(`    ✓ Published → ${postUrlFor(item.slug)}\n`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.log(`    ✗ Failed: ${msg}\n`)
          failed++
        }
      }

      console.log('━━━ Summary ━━━')
      console.log(`  Published: ${published}`)
      if (failed > 0) console.log(`  Failed: ${failed}`)
      console.log(`  Slugs: ${items.map((i) => i.slug).join(', ')}`)

      // W1.11: every publish pings IndexNow (no-op without a key).
      if (!options.dryRun && publishedUrls.length > 0) {
        console.log(`\n📣 Notifying IndexNow of ${publishedUrls.length} published URL(s)...`)
        await submitUrls(publishedUrls)
      }
      if (!options.dryRun && failed > 0) process.exitCode = 1

      if (!options.dryRun && published > 0) {
        console.log('\n  💡 Next steps:')
        console.log('  1. Submit updated sitemap via Google Search Console')
        console.log('  2. Monitor indexing over the next 24-48 hours')
        console.log('  3. Check Search Console for any crawl errors')
      }

      console.log('')
    } catch (err) {
      console.error('Error:', err)
      process.exit(1)
    }
  })

// Score command
program
  .command('score')
  .description('Run SEO scoring on existing posts in the CMS')
  .option('-s, --slug <slug>', 'Score a specific post by slug')
  .option('-a, --airport <code>', 'Score all posts for an airport')
  .option('--all', 'Score all posts')
  .option('--save', 'Update the seoScore field in the CMS')
  .action(async (options) => {
    try {
      console.log('\n📊 Triply Blog Engine — SEO Scorer\n')

      // Build query filters
      const params = new URLSearchParams({ limit: '100' })
      if (options.slug) {
        params.set('where[slug][equals]', options.slug)
      } else if (options.airport) {
        params.set('where[airportCode][equals]', options.airport.toUpperCase())
      } else if (!options.all) {
        console.log('Usage: score --slug <slug> | --airport <code> | --all')
        console.log('  Add --save to update the seoScore field in the CMS')
        return
      }

      // Fetch posts directly
      const postsUrl = `${env.PAYLOAD_CMS_URL}/api/posts?${params.toString()}`
      const postsRes = await fetch(postsUrl, {
        headers: { Authorization: `users API-Key ${env.PAYLOAD_API_KEY}` },
      })
      const postsData = await postsRes.json()
      const posts = postsData.docs || []

      if (posts.length === 0) {
        console.log('No posts found matching your filters.')
        return
      }

      console.log(`Found ${posts.length} post(s) to score\n`)

      // Fetch queue items for keyword lookup
      const queueRes = await getQueueItems({ limit: '200' })
      const queueItems = (queueRes.docs || []) as QueueItem[]
      const queueBySlug = new Map(queueItems.map((q) => [q.slug, q]))

      const results: { slug: string; title: string; score: number; grade: string }[] = []

      for (const post of posts) {
        console.log(`━━━ ${post.title} ━━━`)

        // Convert Lexical content back to HTML
        const html = post.content ? lexicalToHtml(post.content) : ''
        if (!html) {
          console.log('  ⚠ No content to score\n')
          continue
        }

        // Look up keyword from queue item
        const queueItem = queueBySlug.get(post.slug)
        const keyword = queueItem?.keyword || post.slug.replace(/-/g, ' ')

        // Determine target words based on article type
        const articleType = post.articleType || 'spoke'
        const targetWords = queueItem?.targetWords
          || (articleType === 'hub' ? 2500 : articleType === 'sub-pillar' ? 1500 : 1000)

        // Check for featured image
        const hasImage = !!post.featuredImage
        const imageAlt = typeof post.featuredImage === 'object' ? post.featuredImage?.alt : null

        const score = scoreArticle({
          html,
          keyword,
          slug: post.slug,
          metaTitle: post.seo?.metaTitle || post.title || '',
          metaDescription: post.seo?.metaDescription || post.excerpt || '',
          excerpt: post.excerpt || '',
          faqItems: post.faqItems || [],
          articleType: articleType as 'hub' | 'sub-pillar' | 'spoke',
          targetWords,
          hasImage,
          imageAlt,
          airportCode: post.airportCode || undefined,
          parentSlug: post.parentSlug || undefined,
          hubSlug: post.hubSlug || undefined,
        })

        printSeoScore(score)
        results.push({ slug: post.slug, title: post.title, score: score.total, grade: score.grade })

        // Optionally save score to CMS
        if (options.save) {
          try {
            await updatePost(post.id, { seoScore: score.total, seoScoreDetails: score })
            console.log(`\n  ✓ Score saved to CMS: ${score.total}/100`)
          } catch (err) {
            console.log(`\n  ⚠ Failed to save score: ${err instanceof Error ? err.message : err}`)
          }
        }

        console.log('')
      }

      // Summary table for multiple posts
      if (results.length > 1) {
        console.log('\n  ┌──────────────────────────────────────────────────┐')
        console.log('  │              SCORE SUMMARY                       │')
        console.log('  └──────────────────────────────────────────────────┘')
        for (const r of results) {
          console.log(`  ${r.grade.padEnd(3)} ${String(r.score).padStart(3)}/100  ${r.title.slice(0, 60)}`)
        }
        const avg = Math.round(results.reduce((s, r) => s + r.score, 0) / results.length)
        console.log(`\n  Average: ${avg}/100`)
      }

      console.log('')
    } catch (err) {
      console.error('Error:', err)
      process.exit(1)
    }
  })

// Bootstrap command — generate airport data JSON
program
  .command('bootstrap')
  .description('Bootstrap a new airport data file using Claude + URL verification')
  .requiredOption('-a, --airport <code>', 'Airport code (e.g., ORD)')
  .option('--verify', 'Verify all URLs in the generated data with HTTP HEAD checks')
  .action(async (options) => {
    try {
      const code = options.airport.toUpperCase()
      console.log(`\n🏗️  Triply Blog Engine — Airport Data Bootstrap\n`)
      console.log(`Airport: ${code}\n`)

      // Generate base data
      const data = await bootstrapAirport(code)

      // Print summary
      printBootstrapSummary(data)

      // Optionally verify URLs
      if (options.verify) {
        console.log(`\n  URL Verification:`)
        const verification = await verifyUrls(data)
        console.log(`\n  Results: ${verification.valid} valid, ${verification.broken} broken out of ${verification.total} URLs`)

        // Add verification results to the data file
        ;(data as Record<string, unknown>)._urlVerification = {
          date: new Date().toISOString().split('T')[0],
          total: verification.total,
          valid: verification.valid,
          broken: verification.broken,
          brokenUrls: verification.results
            .filter(r => !r.ok)
            .map(r => ({ path: r.path, url: r.url, status: r.status })),
        }
      }

      // Save the data
      const filepath = saveBootstrapData(data)
      console.log(`\n  📄 Airport data saved: ${filepath}`)

      console.log(`\n  💡 Next steps:`)
      console.log(`  1. Review the generated JSON and fix [UNVERIFIED] values`)
      console.log(`  2. Replace VERIFY_URL_NEEDED placeholders with real URLs`)
      if (!options.verify) {
        console.log(`  3. Run with --verify to check all URLs: npm run bootstrap -- -a ${code} --verify`)
      }
      console.log(`  4. Add parkingLots array with off-site lot data`)
      console.log(`  5. Run npm run import-queue to load topics into the CMS queue`)

      console.log('')
    } catch (err) {
      console.error('Error:', err)
      process.exit(1)
    }
  })

program.parse()
