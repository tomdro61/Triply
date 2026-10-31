/**
 * Blog Engine Changelog & Performance Tracker
 *
 * Tracks changes made to the blog engine, content, or SEO strategy,
 * then correlates them with GSC performance data to measure impact.
 *
 * Usage:
 *   npm run changelog log "description of change" -- --category prompt --impact high
 *   npm run changelog list
 *   npm run changelog measure
 *   npm run changelog report
 *
 * Measurement Windows (based on SEO research):
 *   - Technical fixes (title/meta/schema): 2-4 weeks to measure
 *   - Content updates (rewrites, new sections): 4-8 weeks to measure
 *   - New content (new articles): 6-12 weeks to measure
 *   - Structural changes (internal linking, site architecture): 8-16 weeks to measure
 *   - Strategy changes (new airport clusters, content types): 12-24 weeks to measure
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHANGELOG_PATH = path.resolve(__dirname, '..', 'reports', 'changelog.json')
const REPORTS_DIR = path.resolve(__dirname, '..', 'reports')

// ── Types ───────────────────────────────────────────────────────────────────

type ChangeCategory =
  | 'prompt'       // Changes to AI prompts (write, edit, analyze)
  | 'scoring'      // Changes to SEO scorer
  | 'technical'    // Title tags, meta descriptions, schema, sitemap
  | 'content'      // Content updates, rewrites, regenerations
  | 'new-content'  // New articles or airport clusters
  | 'linking'      // Internal linking changes
  | 'structure'    // Site architecture, URL structure
  | 'infographic'  // Infographic generation changes
  | 'pipeline'     // Blog engine pipeline changes
  | 'other'

type ImpactLevel = 'low' | 'medium' | 'high' | 'critical'

interface ChangeEntry {
  id: string
  date: string
  description: string
  category: ChangeCategory
  impact: ImpactLevel
  details?: string
  affectedAirports?: string[]   // e.g., ['JFK', 'LGA'] or ['ALL']
  affectedPages?: string[]      // specific slugs
  measurementWindow: {
    minDays: number
    maxDays: number
    canMeasureAfter: string     // ISO date
    shouldMeasureBy: string     // ISO date
  }
  status: 'pending' | 'measuring' | 'measured' | 'inconclusive'
  baseline?: {
    capturedAt: string
    clicks: number
    impressions: number
    ctr: number
    avgPosition: number
    topQueries?: Array<{ query: string; position: number; impressions: number }>
  }
  result?: {
    measuredAt: string
    clicks: number
    impressions: number
    ctr: number
    avgPosition: number
    clicksDelta: number
    impressionsDelta: number
    ctrDelta: number
    positionDelta: number
    verdict: 'positive' | 'negative' | 'neutral' | 'inconclusive'
    notes?: string
  }
}

interface Changelog {
  entries: ChangeEntry[]
  lastUpdated: string
}

// ── Measurement Windows ─────────────────────────────────────────────────────

const MEASUREMENT_WINDOWS: Record<ChangeCategory, { minDays: number; maxDays: number }> = {
  'prompt':       { minDays: 42, maxDays: 84 },   // 6-12 weeks (affects new content quality)
  'scoring':      { minDays: 42, maxDays: 84 },   // 6-12 weeks (affects which content passes)
  'technical':    { minDays: 14, maxDays: 28 },    // 2-4 weeks (title/meta/schema)
  'content':      { minDays: 28, maxDays: 56 },    // 4-8 weeks (content updates)
  'new-content':  { minDays: 42, maxDays: 84 },    // 6-12 weeks (new articles)
  'linking':      { minDays: 56, maxDays: 112 },   // 8-16 weeks (internal link changes)
  'structure':    { minDays: 56, maxDays: 112 },   // 8-16 weeks (site architecture)
  'infographic':  { minDays: 42, maxDays: 84 },    // 6-12 weeks (visual content)
  'pipeline':     { minDays: 42, maxDays: 84 },    // 6-12 weeks (pipeline = new content quality)
  'other':        { minDays: 28, maxDays: 56 },    // 4-8 weeks default
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function loadChangelog(): Changelog {
  if (!fs.existsSync(CHANGELOG_PATH)) {
    return { entries: [], lastUpdated: new Date().toISOString() }
  }
  return JSON.parse(fs.readFileSync(CHANGELOG_PATH, 'utf-8'))
}

function saveChangelog(changelog: Changelog): void {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true })
  changelog.lastUpdated = new Date().toISOString()
  fs.writeFileSync(CHANGELOG_PATH, JSON.stringify(changelog, null, 2))
}

function generateId(): string {
  return `chg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1)
  const d2 = new Date(date2)
  return Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24))
}

function loadLatestGscReport(): any | null {
  if (!fs.existsSync(REPORTS_DIR)) return null
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('gsc-report-') && f.endsWith('.json'))
    .sort()
    .reverse()
  if (files.length === 0) return null
  return JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, files[0]), 'utf-8'))
}

// ── Commands ────────────────────────────────────────────────────────────────

function logChange(
  description: string,
  category: ChangeCategory = 'other',
  impact: ImpactLevel = 'medium',
  details?: string,
  airports?: string[]
): ChangeEntry {
  const changelog = loadChangelog()
  const today = new Date().toISOString().split('T')[0]
  const window = MEASUREMENT_WINDOWS[category]

  const entry: ChangeEntry = {
    id: generateId(),
    date: today,
    description,
    category,
    impact,
    details,
    affectedAirports: airports,
    measurementWindow: {
      minDays: window.minDays,
      maxDays: window.maxDays,
      canMeasureAfter: addDays(today, window.minDays),
      shouldMeasureBy: addDays(today, window.maxDays),
    },
    status: 'pending',
  }

  // Capture baseline from latest GSC report
  const gscReport = loadLatestGscReport()
  if (gscReport) {
    const baselineData: ChangeEntry['baseline'] = {
      capturedAt: gscReport.dateRange.end,
      clicks: gscReport.blogTotals.clicks,
      impressions: gscReport.blogTotals.impressions,
      ctr: gscReport.blogTotals.ctr,
      avgPosition: gscReport.blogTotals.position,
    }

    // If airport-specific, capture cluster baseline
    if (airports && airports.length > 0 && airports[0] !== 'ALL') {
      const clusterData = gscReport.airportClusters?.filter(
        (c: any) => airports.includes(c.airportCode)
      )
      if (clusterData?.length > 0) {
        baselineData.clicks = clusterData.reduce((s: number, c: any) => s + c.totalClicks, 0)
        baselineData.impressions = clusterData.reduce((s: number, c: any) => s + c.totalImpressions, 0)
        baselineData.ctr = baselineData.impressions > 0 ? baselineData.clicks / baselineData.impressions : 0
        baselineData.avgPosition = clusterData.reduce((s: number, c: any) => s + c.avgPosition, 0) / clusterData.length
      }
    }

    entry.baseline = baselineData
  }

  changelog.entries.push(entry)
  saveChangelog(changelog)

  console.log(`\n  Change logged: ${entry.id}`)
  console.log(`  Category: ${category} | Impact: ${impact}`)
  console.log(`  Measure after: ${entry.measurementWindow.canMeasureAfter}`)
  console.log(`  Measure by:    ${entry.measurementWindow.shouldMeasureBy}`)
  if (entry.baseline) {
    console.log(`  Baseline captured: ${entry.baseline.clicks}c / ${entry.baseline.impressions}i / ${(entry.baseline.ctr * 100).toFixed(2)}% CTR / pos ${entry.baseline.avgPosition.toFixed(1)}`)
  }
  console.log()

  return entry
}

function listChanges(): void {
  const changelog = loadChangelog()
  const today = new Date().toISOString().split('T')[0]

  if (changelog.entries.length === 0) {
    console.log('\n  No changes logged yet. Use: npm run changelog log "description"\n')
    return
  }

  console.log('\n' + '='.repeat(70))
  console.log('  CHANGE LOG — Blog Engine & Content Changes')
  console.log('='.repeat(70))

  // Group by status
  const pending = changelog.entries.filter(e => e.status === 'pending')
  const measuring = changelog.entries.filter(e => e.status === 'measuring')
  const measured = changelog.entries.filter(e => e.status === 'measured')

  // Check which pending entries are now ready to measure
  const readyToMeasure = pending.filter(e => today >= e.measurementWindow.canMeasureAfter)
  const notYetReady = pending.filter(e => today < e.measurementWindow.canMeasureAfter)
  const overdue = pending.filter(e => today > e.measurementWindow.shouldMeasureBy)

  if (readyToMeasure.length > 0) {
    console.log(`\n  READY TO MEASURE (${readyToMeasure.length})`)
    console.log('  -----------------------------------------')
    for (const e of readyToMeasure) {
      const daysReady = daysBetween(e.measurementWindow.canMeasureAfter, today)
      console.log(`  [${e.id}] ${e.date} | ${e.category.padEnd(12)} | ${e.description}`)
      console.log(`    Ready ${daysReady} days ago. Run: npm run changelog measure`)
    }
  }

  if (overdue.length > 0) {
    console.log(`\n  OVERDUE (${overdue.length})`)
    console.log('  -----------------------------------------')
    for (const e of overdue) {
      const daysOverdue = daysBetween(e.measurementWindow.shouldMeasureBy, today)
      console.log(`  [${e.id}] ${e.date} | ${e.category.padEnd(12)} | ${e.description}`)
      console.log(`    ${daysOverdue} days overdue! Measure NOW or mark inconclusive.`)
    }
  }

  if (notYetReady.length > 0) {
    console.log(`\n  WAITING (${notYetReady.length})`)
    console.log('  -----------------------------------------')
    for (const e of notYetReady) {
      const daysLeft = daysBetween(today, e.measurementWindow.canMeasureAfter)
      console.log(`  [${e.id}] ${e.date} | ${e.category.padEnd(12)} | ${e.description}`)
      console.log(`    ${daysLeft} days until measurable (${e.measurementWindow.canMeasureAfter})`)
    }
  }

  if (measured.length > 0) {
    console.log(`\n  MEASURED (${measured.length})`)
    console.log('  -----------------------------------------')
    for (const e of measured) {
      const r = e.result!
      const verdict = r.verdict === 'positive' ? '[+]' : r.verdict === 'negative' ? '[-]' : '[~]'
      console.log(`  ${verdict} ${e.date} | ${e.category.padEnd(12)} | ${e.description}`)
      console.log(`    Clicks: ${r.clicksDelta >= 0 ? '+' : ''}${r.clicksDelta} | ` +
        `Impressions: ${r.impressionsDelta >= 0 ? '+' : ''}${r.impressionsDelta} | ` +
        `CTR: ${r.ctrDelta >= 0 ? '+' : ''}${(r.ctrDelta * 100).toFixed(2)}% | ` +
        `Position: ${r.positionDelta >= 0 ? '+' : ''}${r.positionDelta.toFixed(1)}`)
    }
  }

  console.log('\n' + '='.repeat(70))
  console.log(`  Total: ${changelog.entries.length} changes | ` +
    `${readyToMeasure.length} ready | ${notYetReady.length} waiting | ${measured.length} measured`)
  console.log('='.repeat(70) + '\n')
}

function measureChanges(): void {
  const changelog = loadChangelog()
  const today = new Date().toISOString().split('T')[0]
  const gscReport = loadLatestGscReport()

  if (!gscReport) {
    console.error('\n  No GSC report found. Run: npm run gsc\n')
    return
  }

  const readyEntries = changelog.entries.filter(
    e => e.status === 'pending' && today >= e.measurementWindow.canMeasureAfter && e.baseline
  )

  if (readyEntries.length === 0) {
    console.log('\n  No changes ready to measure yet.')
    const nextReady = changelog.entries
      .filter(e => e.status === 'pending' && today < e.measurementWindow.canMeasureAfter)
      .sort((a, b) => a.measurementWindow.canMeasureAfter.localeCompare(b.measurementWindow.canMeasureAfter))
    if (nextReady.length > 0) {
      const daysLeft = daysBetween(today, nextReady[0].measurementWindow.canMeasureAfter)
      console.log(`  Next measurement ready in ${daysLeft} days (${nextReady[0].measurementWindow.canMeasureAfter})`)
      console.log(`  Change: ${nextReady[0].description}`)
    }
    console.log()
    return
  }

  console.log(`\n  Measuring ${readyEntries.length} changes against latest GSC data...`)
  console.log(`  GSC report date: ${gscReport.dateRange.start} to ${gscReport.dateRange.end}\n`)

  for (const entry of readyEntries) {
    let currentClicks = gscReport.blogTotals.clicks
    let currentImpressions = gscReport.blogTotals.impressions
    let currentCtr = gscReport.blogTotals.ctr
    let currentPosition = gscReport.blogTotals.position

    // Airport-specific measurement
    if (entry.affectedAirports && entry.affectedAirports[0] !== 'ALL') {
      const clusters = gscReport.airportClusters?.filter(
        (c: any) => entry.affectedAirports!.includes(c.airportCode)
      )
      if (clusters?.length > 0) {
        currentClicks = clusters.reduce((s: number, c: any) => s + c.totalClicks, 0)
        currentImpressions = clusters.reduce((s: number, c: any) => s + c.totalImpressions, 0)
        currentCtr = currentImpressions > 0 ? currentClicks / currentImpressions : 0
        currentPosition = clusters.reduce((s: number, c: any) => s + c.avgPosition, 0) / clusters.length
      }
    }

    const baseline = entry.baseline!
    const clicksDelta = currentClicks - baseline.clicks
    const impressionsDelta = currentImpressions - baseline.impressions
    const ctrDelta = currentCtr - baseline.ctr
    const positionDelta = currentPosition - baseline.avgPosition

    // Determine verdict
    let verdict: 'positive' | 'negative' | 'neutral' | 'inconclusive' = 'inconclusive'
    const significantImpressionChange = Math.abs(impressionsDelta) > baseline.impressions * 0.1
    const significantPositionChange = Math.abs(positionDelta) > 3

    if (significantImpressionChange || significantPositionChange) {
      if (impressionsDelta > 0 && positionDelta < 0) verdict = 'positive'  // more impressions, better position
      else if (impressionsDelta < 0 && positionDelta > 0) verdict = 'negative'
      else if (impressionsDelta > 0) verdict = 'positive'
      else if (impressionsDelta < 0) verdict = 'negative'
    } else {
      verdict = 'neutral'
    }

    entry.result = {
      measuredAt: today,
      clicks: currentClicks,
      impressions: currentImpressions,
      ctr: currentCtr,
      avgPosition: currentPosition,
      clicksDelta,
      impressionsDelta,
      ctrDelta,
      positionDelta,
      verdict,
    }
    entry.status = 'measured'

    const icon = verdict === 'positive' ? '[+]' : verdict === 'negative' ? '[-]' : '[~]'
    console.log(`  ${icon} ${entry.description}`)
    console.log(`    Baseline: ${baseline.clicks}c / ${baseline.impressions}i / ${(baseline.ctr * 100).toFixed(2)}% / pos ${baseline.avgPosition.toFixed(1)}`)
    console.log(`    Current:  ${currentClicks}c / ${currentImpressions}i / ${(currentCtr * 100).toFixed(2)}% / pos ${currentPosition.toFixed(1)}`)
    console.log(`    Delta:    ${clicksDelta >= 0 ? '+' : ''}${clicksDelta}c / ${impressionsDelta >= 0 ? '+' : ''}${impressionsDelta}i / ${ctrDelta >= 0 ? '+' : ''}${(ctrDelta * 100).toFixed(2)}% / ${positionDelta >= 0 ? '+' : ''}${positionDelta.toFixed(1)} pos`)
    console.log(`    Verdict:  ${verdict.toUpperCase()}`)
    console.log()
  }

  saveChangelog(changelog)
  console.log(`  Updated ${readyEntries.length} entries.\n`)
}

function generateSummaryReport(): void {
  const changelog = loadChangelog()

  if (changelog.entries.length === 0) {
    console.log('\n  No changes logged yet.\n')
    return
  }

  const measured = changelog.entries.filter(e => e.status === 'measured')
  const positive = measured.filter(e => e.result?.verdict === 'positive')
  const negative = measured.filter(e => e.result?.verdict === 'negative')
  const neutral = measured.filter(e => e.result?.verdict === 'neutral')

  console.log('\n' + '='.repeat(70))
  console.log('  CHANGE IMPACT SUMMARY')
  console.log('='.repeat(70))

  console.log(`\n  Total changes tracked: ${changelog.entries.length}`)
  console.log(`  Measured: ${measured.length} | Pending: ${changelog.entries.length - measured.length}`)
  console.log(`  Positive: ${positive.length} | Negative: ${negative.length} | Neutral: ${neutral.length}`)

  // Category breakdown
  const categories = new Map<string, { total: number; positive: number; negative: number }>()
  for (const entry of measured) {
    const cat = categories.get(entry.category) || { total: 0, positive: 0, negative: 0 }
    cat.total++
    if (entry.result?.verdict === 'positive') cat.positive++
    if (entry.result?.verdict === 'negative') cat.negative++
    categories.set(entry.category, cat)
  }

  if (categories.size > 0) {
    console.log('\n  BY CATEGORY')
    console.log('  -----------------------------------------')
    for (const [cat, stats] of categories.entries()) {
      const winRate = stats.total > 0 ? (stats.positive / stats.total * 100).toFixed(0) : '0'
      console.log(`  ${cat.padEnd(14)} ${stats.total} measured | ${stats.positive} positive | ${winRate}% win rate`)
    }
  }

  // Best performing changes
  if (positive.length > 0) {
    console.log('\n  TOP POSITIVE CHANGES')
    console.log('  -----------------------------------------')
    const sorted = positive.sort((a, b) => (b.result!.impressionsDelta) - (a.result!.impressionsDelta))
    for (const e of sorted.slice(0, 5)) {
      console.log(`  ${e.date} | ${e.category.padEnd(12)} | ${e.description}`)
      console.log(`    +${e.result!.impressionsDelta} impressions, ${e.result!.positionDelta.toFixed(1)} position change`)
    }
  }

  // Worst performing changes
  if (negative.length > 0) {
    console.log('\n  NEGATIVE CHANGES (learn from these)')
    console.log('  -----------------------------------------')
    for (const e of negative) {
      console.log(`  ${e.date} | ${e.category.padEnd(12)} | ${e.description}`)
      console.log(`    ${e.result!.impressionsDelta} impressions, ${e.result!.positionDelta.toFixed(1)} position change`)
    }
  }

  // Measurement timeline reference
  console.log('\n  MEASUREMENT TIMELINE REFERENCE')
  console.log('  -----------------------------------------')
  console.log('  Technical (title/meta/schema):     2-4 weeks')
  console.log('  Content updates (rewrites):        4-8 weeks')
  console.log('  New content (new articles):         6-12 weeks')
  console.log('  Internal linking changes:           8-16 weeks')
  console.log('  Structural/architecture changes:    8-16 weeks')
  console.log('  Strategy changes (new clusters):   12-24 weeks')
  console.log('  GSC data lag:                       2-3 days')

  console.log('\n' + '='.repeat(70) + '\n')
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === 'help') {
    console.log(`
  Blog Engine Change Tracker

  Commands:
    log <description>   Log a change (flags: --category, --impact, --airports, --details)
    list                List all changes and their status
    measure             Measure ready changes against latest GSC data
    report              Generate impact summary report

  Examples:
    npm run changelog log "Tightened write prompt rule 36: AI phrase blacklist" -- --category prompt --impact high
    npm run changelog log "Published 12 new LGA spoke articles" -- --category new-content --airports LGA
    npm run changelog log "Fixed meta descriptions exceeding 160 chars" -- --category technical --impact medium
    npm run changelog list
    npm run changelog measure
    npm run changelog report

  Categories: prompt, scoring, technical, content, new-content, linking, structure, infographic, pipeline, other
  Impact levels: low, medium, high, critical
`)
    return
  }

  switch (command) {
    case 'log': {
      const description = args[1]
      if (!description) {
        console.error('  Usage: npm run changelog log "description"')
        process.exit(1)
      }
      const categoryIdx = args.indexOf('--category')
      const impactIdx = args.indexOf('--impact')
      const airportsIdx = args.indexOf('--airports')
      const detailsIdx = args.indexOf('--details')

      const category = (categoryIdx >= 0 ? args[categoryIdx + 1] : 'other') as ChangeCategory
      const impact = (impactIdx >= 0 ? args[impactIdx + 1] : 'medium') as ImpactLevel
      const airports = airportsIdx >= 0 ? args[airportsIdx + 1].split(',') : undefined
      const details = detailsIdx >= 0 ? args[detailsIdx + 1] : undefined

      logChange(description, category, impact, details, airports)
      break
    }
    case 'list':
      listChanges()
      break
    case 'measure':
      measureChanges()
      break
    case 'report':
      generateSummaryReport()
      break
    default:
      console.error(`  Unknown command: ${command}. Run: npm run changelog help`)
  }
}

main()
