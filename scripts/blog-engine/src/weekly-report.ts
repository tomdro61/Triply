/**
 * Weekly SEO Performance Report
 *
 * Pulls GSC + Bing data, compares against previous week,
 * sends everything to Claude for synthesis, posts to Discord.
 *
 * Usage: npm run weekly-report
 * Scheduled via Windows Task Scheduler (weekly, Sunday 9am ET)
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'
import Anthropic from '@anthropic-ai/sdk'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

// ── Config ──────────────────────────────────────────────────────────────────

// Discord webhook for the weekly digest. Set DISCORD_WEBHOOK_URL in .env (never commit it — this repo is public).
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || ''
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports')
const CHANGELOG_PATH = path.resolve(REPORTS_DIR, 'changelog.json')
const TSX_PATH = path.resolve(__dirname, '..', 'node_modules', '.bin', 'tsx')
const BLOG_ENGINE_DIR = path.resolve(__dirname, '..')

// ── Helpers ─────────────────────────────────────────────────────────────────

function getGscReports(): Array<{ filename: string; data: any }> {
  if (!fs.existsSync(REPORTS_DIR)) return []
  return fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('gsc-report-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 2) // latest + previous
    .map(f => ({
      filename: f,
      data: JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf-8')),
    }))
}

function getBingReports(): Array<{ filename: string; data: any }> {
  if (!fs.existsSync(REPORTS_DIR)) return []
  return fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('bing-report-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 2)
    .map(f => ({
      filename: f,
      data: JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf-8')),
    }))
}

function getChangelog(): any | null {
  if (!fs.existsSync(CHANGELOG_PATH)) return null
  return JSON.parse(fs.readFileSync(CHANGELOG_PATH, 'utf-8'))
}

/**
 * Run a sibling script as a subprocess.
 *
 * Returns ok:false rather than throwing so one dead provider never aborts the whole
 * report — but it MUST report the failure. The previous version returned the error
 * text in the same string slot as stdout, so a failed pull was indistinguishable from
 * a successful one and the caller's try/catch could never fire. That is how the
 * 2026-08-09 report came to republish 2026-08-02's numbers under a fresh date.
 */
async function runScript(scriptPath: string, args: string[] = []): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', scriptPath, ...args],
      { cwd: BLOG_ENGINE_DIR, env: { ...process.env, NODE_NO_WARNINGS: '1' }, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 }
    )
    return { ok: true, output: stdout + (stderr || '') }
  } catch (err: any) {
    return { ok: false, output: err.stdout || err.message || 'Script failed' }
  }
}

// ── Pull Fresh Data ─────────────────────────────────────────────────────────

interface PullStatus { gscOk: boolean; bingOk: boolean }

async function pullFreshData(): Promise<PullStatus> {
  const status: PullStatus = { gscOk: false, bingOk: false }

  console.log('  Pulling fresh GSC data...')
  const gsc = await runScript(path.resolve(__dirname, 'gsc.ts'))
  status.gscOk = gsc.ok
  if (gsc.ok) {
    console.log('  GSC data pulled.')
  } else {
    // Most common cause: the OAuth refresh token expired (Google expires them weekly
    // while the consent screen is still in "Testing"). Re-auth with `npm run gsc:auth`.
    console.error(`  ⚠ GSC pull FAILED — the report will fall back to older data:\n${gsc.output}`)
  }

  console.log('  Pulling fresh Bing data...')
  const bing = await runScript(path.resolve(__dirname, 'bing.ts'))
  status.bingOk = bing.ok
  if (bing.ok) {
    console.log('  Bing data pulled.')
  } else {
    console.error(`  ⚠ Bing pull FAILED — the report will fall back to older data:\n${bing.output}`)
  }

  return status
}

// ── Freshness ───────────────────────────────────────────────────────────────

/** A weekly report built on data older than this is stale enough to call out. */
const STALE_AFTER_DAYS = 10

function daysSince(isoDate: string): number {
  const then = new Date(isoDate).getTime()
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY
  return Math.floor((Date.now() - then) / 86_400_000)
}

// ── Build Context for Claude ────────────────────────────────────────────────

function buildAnalysisContext(pull: PullStatus): { context: string; staleWarning: string | null } {
  const gscReports = getGscReports()
  const bingReports = getBingReports()
  const changelog = getChangelog()
  const today = new Date().toISOString().split('T')[0]

  // getGscReports() returns the newest file on disk regardless of age, so a failed
  // pull silently yields last week's numbers. Detect that and say so out loud instead
  // of presenting stale data as this week's performance.
  let staleWarning: string | null = null
  const gscEnd: string | undefined = gscReports[0]?.data?.dateRange?.end
  const gscAgeDays = gscEnd ? daysSince(gscEnd) : Number.POSITIVE_INFINITY
  if (gscReports.length === 0) {
    staleWarning = 'No GSC report found on disk — this report has NO Google data.'
  } else if (!pull.gscOk) {
    staleWarning = `The fresh GSC pull FAILED. Falling back to data ending ${gscEnd} (${gscAgeDays}d old). Re-auth with \`npm run gsc:auth\`.`
  } else if (gscAgeDays > STALE_AFTER_DAYS) {
    staleWarning = `GSC data ends ${gscEnd} — ${gscAgeDays} days old. Google may be lagging, or the pull silently returned nothing new.`
  }
  if (staleWarning) console.error(`  ⚠ STALE DATA: ${staleWarning}`)

  let context = `# Weekly SEO Performance Data for triplypro.com\nDate: ${today}\n\n`

  if (staleWarning) {
    context += `## ⚠️ DATA FRESHNESS WARNING\n${staleWarning}\n\n`
    context += `Do NOT describe these numbers as this week's performance or report week-over-week `
    context += `movement as if it were new. Lead the report by flagging that the data is stale.\n\n`
  }

  // Current GSC report
  if (gscReports.length > 0) {
    const current = gscReports[0].data
    context += `## Current Google Search Console Report\n`
    context += `Date range: ${current.dateRange.start} to ${current.dateRange.end}\n\n`
    context += `### Site-wide totals\n`
    context += `- Clicks: ${current.totals.clicks}\n`
    context += `- Impressions: ${current.totals.impressions}\n`
    context += `- CTR: ${(current.totals.ctr * 100).toFixed(2)}%\n`
    context += `- Avg Position: ${current.totals.position.toFixed(1)}\n\n`
    context += `### Blog totals (/blog/*)\n`
    context += `- Clicks: ${current.blogTotals.clicks}\n`
    context += `- Impressions: ${current.blogTotals.impressions}\n`
    context += `- CTR: ${(current.blogTotals.ctr * 100).toFixed(2)}%\n`
    context += `- Avg Position: ${current.blogTotals.position.toFixed(1)}\n`
    context += `- Indexed Pages: ${current.indexedPages}\n\n`

    // Airport clusters
    if (current.airportClusters?.length > 0) {
      context += `### Airport Cluster Performance\n`
      for (const c of current.airportClusters) {
        context += `- ${c.airportCode}: ${c.pageCount} pages, ${c.totalClicks} clicks, ${c.totalImpressions} impressions, pos ${c.avgPosition.toFixed(1)}, CTR ${(c.avgCtr * 100).toFixed(2)}%\n`
      }
      context += '\n'
    }

    // Top queries
    if (current.topQueries?.length > 0) {
      context += `### Top 15 Queries\n`
      for (const q of current.topQueries.slice(0, 15)) {
        context += `- "${q.query}": ${q.clicks}c, ${q.impressions}i, pos ${q.position.toFixed(1)}, CTR ${(q.ctr * 100).toFixed(1)}%\n`
      }
      context += '\n'
    }

    // Quick wins
    if (current.quickWins?.length > 0) {
      context += `### Quick Wins (position 5-20, 10+ impressions)\n`
      for (const q of current.quickWins) {
        context += `- "${q.query}": pos ${q.position.toFixed(1)}, ${q.impressions} impressions, ${q.clicks} clicks\n`
      }
      context += '\n'
    }

    // Low CTR pages
    if (current.lowCtrHighImpressions?.length > 0) {
      context += `### Low CTR Pages (50+ impressions, <2% CTR)\n`
      for (const p of current.lowCtrHighImpressions) {
        context += `- ${p.slug}: ${(p.ctr * 100).toFixed(1)}% CTR, ${p.impressions} impressions, pos ${p.position.toFixed(1)}\n`
      }
      context += '\n'
    }

    // Previous report comparison
    if (gscReports.length > 1) {
      const prev = gscReports[1].data
      context += `## Previous GSC Report (for comparison)\n`
      context += `Date range: ${prev.dateRange.start} to ${prev.dateRange.end}\n`
      context += `- Blog Clicks: ${prev.blogTotals.clicks}\n`
      context += `- Blog Impressions: ${prev.blogTotals.impressions}\n`
      context += `- Blog CTR: ${(prev.blogTotals.ctr * 100).toFixed(2)}%\n`
      context += `- Blog Avg Position: ${prev.blogTotals.position.toFixed(1)}\n`
      context += `- Indexed Pages: ${prev.indexedPages}\n\n`

      if (prev.airportClusters?.length > 0) {
        context += `### Previous Airport Clusters\n`
        for (const c of prev.airportClusters) {
          context += `- ${c.airportCode}: ${c.totalClicks}c, ${c.totalImpressions}i, pos ${c.avgPosition.toFixed(1)}\n`
        }
        context += '\n'
      }
    }
  } else {
    context += `## Google Search Console\nNo GSC reports available.\n\n`
  }

  // Bing data
  if (bingReports.length > 0 && bingReports[0].data.totals.impressions > 0) {
    const bing = bingReports[0].data
    context += `## Bing Webmaster Tools\n`
    context += `- Clicks: ${bing.totals.clicks}\n`
    context += `- Impressions: ${bing.totals.impressions}\n`
    context += `- CTR: ${(bing.totals.ctr * 100).toFixed(2)}%\n`
    context += `- Avg Position: ${bing.totals.position.toFixed(1)}\n\n`
  } else {
    context += `## Bing Webmaster Tools\nNo Bing data yet (crawling in progress).\n\n`
  }

  // Changelog
  if (changelog && changelog.entries.length > 0) {
    context += `## Change Log\n`
    const pending = changelog.entries.filter((e: any) => e.status === 'pending')
    const measured = changelog.entries.filter((e: any) => e.status === 'measured')
    const readyToMeasure = pending.filter((e: any) => today >= e.measurementWindow.canMeasureAfter)
    const waiting = pending.filter((e: any) => today < e.measurementWindow.canMeasureAfter)

    if (readyToMeasure.length > 0) {
      context += `\n### Ready to Measure (${readyToMeasure.length})\n`
      for (const e of readyToMeasure) {
        context += `- [${e.id}] ${e.date}: ${e.description} (${e.category}, ${e.impact} impact)\n`
        if (e.baseline) {
          context += `  Baseline: ${e.baseline.clicks}c, ${e.baseline.impressions}i, ${(e.baseline.ctr * 100).toFixed(2)}% CTR, pos ${e.baseline.avgPosition.toFixed(1)}\n`
        }
      }
    }

    if (waiting.length > 0) {
      context += `\n### Waiting (${waiting.length})\n`
      for (const e of waiting) {
        const daysLeft = Math.ceil((new Date(e.measurementWindow.canMeasureAfter).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24))
        context += `- ${e.date}: ${e.description} — ${daysLeft} days until measurable\n`
      }
    }

    if (measured.length > 0) {
      context += `\n### Previously Measured (${measured.length})\n`
      for (const e of measured) {
        const r = e.result
        context += `- ${e.date}: ${e.description} — Verdict: ${r.verdict} (${r.impressionsDelta >= 0 ? '+' : ''}${r.impressionsDelta} imp, ${r.positionDelta >= 0 ? '+' : ''}${r.positionDelta.toFixed(1)} pos)\n`
      }
    }
  }

  return { context, staleWarning }
}

// ── Claude Analysis ─────────────────────────────────────────────────────────

async function analyzeWithClaude(context: string): Promise<string> {
  const client = new Anthropic()

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `You are the SEO analyst for triplypro.com, an airport parking comparison marketplace. Analyze this weekly search performance data and write a concise Discord report.

${context}

Write a Discord-formatted report (use **bold**, bullet points, and sections). Keep it under 1800 characters (Discord limit). Include:

1. **Key Metrics** — This week's clicks, impressions, CTR, avg position. If previous week data exists, show the delta (up/down arrows and percentages).

2. **What's Working** — Which airport clusters or specific pages are gaining traction? Any position improvements? Best CTR performers?

3. **What Needs Attention** — Pages with high impressions but no clicks (title/meta issues). Clusters losing position. Any red flags.

4. **Quick Wins** — Specific, actionable items that could move the needle in the next 1-2 weeks. Be specific: name the page/query and what to do.

5. **Changelog Status** — Any changes ready to measure? Any waiting? Brief summary.

Be direct and specific. No fluff. Use actual numbers from the data. This goes to the business owner who makes decisions based on it.`
    }],
  })

  const textBlock = response.content.find(b => b.type === 'text')
  return textBlock ? textBlock.text : 'Analysis failed — no response from Claude.'
}

// ── Discord ─────────────────────────────────────────────────────────────────

async function sendToDiscord(message: string): Promise<void> {
  // Discord has a 2000 char limit per message. Split if needed.
  const chunks: string[] = []
  if (message.length <= 2000) {
    chunks.push(message)
  } else {
    // Split at line breaks near the limit
    let remaining = message
    while (remaining.length > 0) {
      if (remaining.length <= 2000) {
        chunks.push(remaining)
        break
      }
      let splitAt = remaining.lastIndexOf('\n', 2000)
      if (splitAt === -1 || splitAt < 1000) splitAt = 2000
      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt)
    }
  }

  for (const chunk of chunks) {
    const response = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Triply SEO Bot',
        content: chunk,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Discord webhook failed ${response.status}: ${text}`)
    }

    // Rate limit: wait between messages if sending multiple
    if (chunks.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now()
  console.log('\n  === Weekly SEO Report ===\n')

  // Step 1: Pull fresh data
  const pull = await pullFreshData()

  // Step 2: Build context from all reports
  console.log('\n  Building analysis context...')
  const { context, staleWarning } = buildAnalysisContext(pull)

  // Step 3: Send to Claude for synthesis
  console.log('  Analyzing with Claude...')
  let analysis = await analyzeWithClaude(context)

  // Banner the rendered report too — the synthesis prompt is asked to lead with the
  // staleness, but a deterministic header means a stale week can never *look* fresh
  // in Discord even if the model buries the caveat.
  if (staleWarning) {
    analysis = `> ⚠️ **STALE DATA — read before acting:** ${staleWarning}\n\n${analysis}`
  }

  // Step 4: Send to Discord
  console.log('  Sending to Discord...')
  try {
    await sendToDiscord(analysis)
    console.log('  Discord message sent!')
  } catch (err: any) {
    console.error(`  Discord send failed: ${err.message}`)
    // Still print the report even if Discord fails
  }

  // Step 5: Save the analysis locally
  const analysisPath = path.join(REPORTS_DIR, `weekly-analysis-${new Date().toISOString().split('T')[0]}.txt`)
  fs.writeFileSync(analysisPath, analysis)
  console.log(`  Analysis saved to: ${analysisPath}`)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n  Done in ${elapsed}s\n`)

  // Print the analysis to console too
  console.log('  --- Analysis ---\n')
  console.log(analysis)
  console.log()

  // The report still gets written and posted on a failed pull (a stale report beats no
  // report), but exit non-zero so Task Scheduler surfaces it instead of logging success.
  if (!pull.gscOk || !pull.bingOk) {
    const failed = [!pull.gscOk && 'GSC', !pull.bingOk && 'Bing'].filter(Boolean).join(' + ')
    console.error(`  ⚠ Report published, but the ${failed} pull failed — exiting non-zero.\n`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
