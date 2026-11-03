import Anthropic from '@anthropic-ai/sdk'
import { Resvg } from '@resvg/resvg-js'
import { env, CLAUDE_MODEL, DOMAIN } from './config.js'
import { trackUsage } from './claude.js'
import { uploadMedia } from './payload.js'
import { isCanadianAirport, type AirportData } from './airport-data.js'
import {
  chartAlt, chartFileName, chartInputFor, chartSvg, loadPriceSnapshot, MAX_SNAPSHOT_AGE_DAYS, pricesOffSiteLots, rateChartInsertAt, snapshotAgeDays,
} from './rate-chart.js'

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

const MAX_INFOGRAPHICS = 2

interface InfographicSpec {
  svg: string
  alt: string
  placement: string
}

interface InfographicResult {
  html: string
  count: number
}

/**
 * Extract data fields from the airport JSON that are most useful for
 * visualizations: parking rates, transit costs, terminal info, etc.
 * We trim to keep the prompt within reasonable token limits.
 */
function extractVisualizableData(airportData: AirportData): Record<string, unknown> {
  const data: Record<string, unknown> = {
    code: airportData.code,
    fullName: airportData.fullName,
  }

  // Include overview if present
  if (airportData['overview']) {
    data.overview = airportData['overview']
  }

  // Include on-airport parking rates
  if (airportData.onAirportParking) {
    data.onAirportParking = airportData.onAirportParking
  }

  // Off-airport lots WITHOUT their prices (chart redraw, Nov 2026): a free-form chart of lot prices goes stale and
  // undated the day it is drawn, and the October ones labelled lots we don't sell "bookable on Triply". Lot prices
  // reach a post only through the dated standard chart (rate-chart.ts, added below).
  if (airportData.parkingLots && airportData.parkingLots.length > 0) {
    data.parkingLots = airportData.parkingLots.map((l) => ({
      name: l.name, distanceFromAirport: l.distanceFromAirport, driveTime: l.driveTime, shuttleInfo: l.shuttleInfo, parkingType: l.parkingType, amenities: l.amenities,
    }))
  }

  // Include AirTrain / transit fare data
  if (airportData['airTrain']) {
    data.airTrain = airportData['airTrain']
  }

  // Include transit info
  if (airportData.transit) {
    data.transit = airportData.transit
  }

  // Include terminal info (names and airline counts)
  if (airportData.terminals) {
    data.terminals = airportData.terminals.map(t => ({
      name: t.name,
      airlineCount: t.airlines.length,
    }))
  }

  // Include EV charging data
  if (airportData.evCharging) {
    data.evCharging = airportData.evCharging
  }

  // Include lounges
  if (airportData.lounges) {
    data.lounges = airportData.lounges
  }

  // Include shuttle/transport info
  if (airportData['shuttleServices']) {
    data.shuttleServices = airportData['shuttleServices']
  }

  // savingsComparisons and the parkingRates prose are left out: both quote off-site lot prices (see parkingLots above).

  return data
}

/**
 * Build the cached system prompt for infographic generation.
 * Contains brand guide, SVG rules, and airport data — identical across all articles
 * for the same airport, so it benefits from Anthropic's prompt caching.
 */
function buildInfographicSystem(vizData: Record<string, unknown>, airportCode: string): Anthropic.MessageCreateParams['system'] {
  return [
    {
      type: 'text' as const,
      text: `You are a data visualization designer for ${DOMAIN}, an airport parking comparison platform.
Create 1–2 SVG infographics that add the most value for readers.

## Brand Style Guide
- Canvas size: 800×500 pixels
- Background: White (#ffffff)
- Primary color (headings, borders): Navy #1A1A2E
- Accent color (CTAs, highlights): Coral #f87356
- Positive/savings color: Emerald #22c55e
- Neutral text: Gray #64748b
- Font family: Arial, Helvetica, sans-serif (system-safe fonts only)
- Style: clean, modern, minimal — no 3D effects, no gradients, no drop shadows
- All text must be legible at the rendered size (minimum 12px for body text, 18px+ for headings)
- Include "Source: ${DOMAIN}" in small gray text at the bottom-right

## SVG Rules
- SVG must be fully self-contained: no <image>, no external fonts, no CSS @import, no xlink:href to external resources
- SVG must start with \`<svg\` and include explicit width="800" and height="500" attributes
- Use only <svg>, <rect>, <circle>, <ellipse>, <line>, <polyline>, <polygon>, <path>, <text>, <tspan>, <g>, <defs>, <clipPath>, <pattern> elements
- All colors must be inline (fill="..." or style="..."), not via external CSS classes
- Use data from the airport JSON — do NOT invent numbers
- NEVER chart, list or print the price of an off-site lot, a hotel lot or anything "on Triply" / "bookable on Triply" — no lot prices are given to you on purpose. A dated price chart of the lots Triply sells is added to the article separately. Off-site lots may appear by name, distance and shuttle only.
- On-airport parking rates may be charted only with the line "Posted airport rates; check the airport's site for today's price" on the image. Never print a "checked"/"verified"/"as of" date — the data has none you can rely on
- Round dollar amounts to nearest dollar for readability
${vizData.currency === 'CAD' ? '- Prices are Canadian dollars: write every price as C$ (e.g. C$12), in the SVG and in the alt text. Never a bare $.\n' : ''}- Pick the chart type that best fits the data: bar chart, comparison table, icon grid, timeline, cost breakdown, process flow, etc.

## Output Format
Return ONLY a JSON object (no markdown fences, no explanation):
{
  "infographics": [
    {
      "svg": "<svg width=\\"800\\" height=\\"500\\" xmlns=\\"http://www.w3.org/2000/svg\\">...</svg>",
      "alt": "Descriptive alt text for SEO — describe the data shown",
      "placement": "exact text snippet from the article (first 60 chars of a paragraph or heading) after which to insert this infographic"
    }
  ]
}`,
      cache_control: { type: 'ephemeral' as const },
    },
    {
      type: 'text' as const,
      text: `## Airport Data (${airportCode})\n\`\`\`json\n${JSON.stringify(vizData, null, 2)}\n\`\`\``,
      cache_control: { type: 'ephemeral' as const },
    },
  ]
}

/**
 * Extract a compact article summary for infographic context.
 * Instead of sending 12,000 chars of raw HTML, extract just the headings
 * and any data tables — that's all the infographic generator needs to
 * pick relevant visualizations and placement points.
 */
function extractArticleContext(html: string): string {
  const lines: string[] = []

  // Extract H2/H3 headings
  const headingMatches = html.matchAll(/<h[23][^>]*>(.*?)<\/h[23]>/gi)
  for (const m of headingMatches) {
    lines.push(`- ${m[1].replace(/<[^>]+>/g, '')}`)
  }

  // Extract tables (important for knowing what data is already visualized)
  const tableMatches = html.matchAll(/<table[\s\S]*?<\/table>/gi)
  for (const m of tableMatches) {
    lines.push(m[0].slice(0, 500))
  }

  // First paragraph for topic context
  const firstPMatch = html.match(/<p[^>]*>(.*?)<\/p>/i)
  if (firstPMatch) {
    lines.push(`Opening: ${firstPMatch[1].replace(/<[^>]+>/g, '').slice(0, 200)}`)
  }

  return lines.join('\n')
}

/**
 * Build the user message for infographic generation (article-specific content only).
 */
function buildInfographicUserPrompt(articleHtml: string): string {
  const context = extractArticleContext(articleHtml)
  return `Analyze this article and create 1–2 infographics. Pick the most impactful visualizations for this specific topic. If the article is short or data doesn't lend itself to visualization, return just 1.

## Article Structure
${context}`
}

/**
 * Parse Claude's response text into InfographicSpec objects.
 */
function parseInfographicResponse(text: string): InfographicSpec[] {
  let cleaned = text.trim()

  // Strip markdown code fences if present
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim()
  }

  const parsed = JSON.parse(cleaned)

  if (!parsed.infographics || !Array.isArray(parsed.infographics)) {
    throw new Error('Response missing "infographics" array')
  }

  return parsed.infographics.slice(0, MAX_INFOGRAPHICS).map((item: Record<string, unknown>) => ({
    svg: String(item.svg || ''),
    alt: String(item.alt || 'Airport infographic'),
    placement: String(item.placement || ''),
  }))
}

/**
 * Validate that an SVG string has the basic structure needed for PNG conversion.
 */
function validateSvg(svg: string): { valid: boolean; error?: string } {
  if (!svg.trim().startsWith('<svg')) {
    return { valid: false, error: 'SVG does not start with <svg' }
  }

  if (!svg.includes('width=') || !svg.includes('height=')) {
    return { valid: false, error: 'SVG missing width or height attribute' }
  }

  if (!svg.includes('</svg>')) {
    return { valid: false, error: 'SVG missing closing </svg> tag' }
  }

  // Check for disallowed external resources
  if (svg.includes('xlink:href="http') || svg.includes('<image')) {
    return { valid: false, error: 'SVG contains external resources (not allowed)' }
  }

  return { valid: true }
}

/**
 * Convert SVG string to PNG buffer using resvg-js.
 *
 * resvg-js uses a Rust-based SVG renderer that handles <text> elements,
 * system fonts, and complex SVG features far better than sharp's librsvg.
 * This fixes blank/garbled text in Claude-generated infographic SVGs.
 */
function svgToPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 800 },
    font: {
      loadSystemFonts: true,
    },
  })
  const rendered = resvg.render()
  return Buffer.from(rendered.asPng())
}

/**
 * Find the best insertion point in the HTML for a given placement hint.
 * Returns the index in the HTML string after which to insert the <img> tag.
 *
 * Strategy: search for the placement text snippet within the HTML, then find
 * the end of the enclosing block element (</p>, </h2>, </h3>, </ul>, </ol>, </table>).
 */
function findInsertionPoint(html: string, placement: string): number {
  if (!placement) return -1

  // Normalize placement text for matching
  const normalizedPlacement = placement.replace(/\s+/g, ' ').trim().slice(0, 80)

  // Search for the placement text in the HTML (strip tags for matching)
  const plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const matchIndex = plainText.toLowerCase().indexOf(normalizedPlacement.toLowerCase().slice(0, 40))

  if (matchIndex === -1) return -1

  // Map the plain-text index back to an approximate HTML position
  // Walk through the HTML, tracking plain-text offset
  let plainOffset = 0
  let inTag = false
  let htmlPos = 0

  for (htmlPos = 0; htmlPos < html.length && plainOffset < matchIndex; htmlPos++) {
    if (html[htmlPos] === '<') {
      inTag = true
    } else if (html[htmlPos] === '>') {
      inTag = false
    } else if (!inTag) {
      plainOffset++
    }
  }

  // From this position, find the next closing block tag
  const closingTagPattern = /<\/(p|h[1-6]|ul|ol|table|div|blockquote|figure|section)>/gi
  closingTagPattern.lastIndex = htmlPos
  const closeMatch = closingTagPattern.exec(html)

  if (closeMatch) {
    return closeMatch.index + closeMatch[0].length
  }

  return -1
}

/** The figure markup both paths insert (matches the format resolveInlineImages uses). */
function figureTag(mediaId: string, mediaUrl: string, alt: string): string {
  const escapedAlt = alt.replace(/"/g, '&quot;')
  const captionText = alt.replace(/</g, '&lt;')
  return `<figure><img data-media-id="${mediaId}" src="${mediaUrl}" alt="${escapedAlt}" data-width="800" data-height="500" /><figcaption>${captionText}</figcaption></figure>`
}

/** Today in New York, the date the price snapshot's "as of" is written in. */
const nyToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())

/**
 * The one way a new post gets lot prices in a picture: the standard daily chart from the dated price snapshot
 * (data/chart-prices.json, refreshed monthly by reports/chart-redraw/prices.mts), placed after the first paragraph
 * under the post's first cost/price heading. No snapshot, a snapshot older than MAX_SNAPSHOT_AGE_DAYS, no lot we
 * sell at the airport, or no price section → no chart (logged), never an undated one.
 */
export async function addRateChart(html: string, airportCode: string): Promise<InfographicResult> {
  const at = rateChartInsertAt(html)
  if (at === -1) return { html, count: 0 }
  const snap = loadPriceSnapshot()
  if (!snap) { console.log('  Rate chart skipped: no data/chart-prices.json (run reports/chart-redraw/prices.mts)'); return { html, count: 0 } }
  const age = snapshotAgeDays(snap, nyToday())
  if (age > MAX_SNAPSHOT_AGE_DAYS || age < 0) { console.log(`  Rate chart skipped: the prices are dated ${snap.asOf} (${age} days from today) — re-run reports/chart-redraw/prices.mts`); return { html, count: 0 } }
  const d = chartInputFor(airportCode, snap)
  if (!d || d.lots.length === 0) {
    const row = snap.airports[airportCode.toUpperCase()]
    const why = !row ? 'not in the price snapshot' : row.status === 'error' ? row.reason ?? 'search unusable' : 'no lot Triply sells here'
    console.log(`  Rate chart skipped for ${airportCode} (${snap.asOf} prices): ${why}`)
    return { html, count: 0 }
  }
  const alt = chartAlt(d, 'daily')
  const media = await uploadMedia(svgToPng(chartSvg(d, 'daily')), chartFileName(d, 'daily'), alt)
  const fig = figureTag(String(media.doc?.id || media.id), String(media.doc?.url || media.url), alt)
  console.log(`  ✓ Rate chart (prices as of ${snap.asOf}) added`)
  return { html: `${html.slice(0, at)}\n${fig}\n${html.slice(at)}`, count: 1 }
}

/**
 * Main entry point: free-form infographics (Claude SVG → PNG → Payload), then the dated rate chart. A free-form
 * failure doesn't cost the post its rate chart.
 */
export async function generateInfographics(html: string, airportData: AirportData, airportCode: string): Promise<InfographicResult> {
  let out: InfographicResult = { html, count: 0 }
  try {
    out = await generateFreeformInfographics(html, airportData, airportCode)
  } catch (err) {
    console.log(`  ⚠ Free-form infographics failed: ${err instanceof Error ? err.message : err} — continuing with the rate chart`)
  }
  // A failed rate chart (bad snapshot file, CMS upload error) must not throw away the free-form infographics
  // already uploaded above — the caller would fall back to the article without any of them.
  try {
    const chart = await addRateChart(out.html, airportCode)
    return { html: chart.html, count: out.count + chart.count }
  } catch (err) {
    console.log(`  ⚠ Rate chart failed: ${err instanceof Error ? err.message : err} — keeping the other infographics`)
    return out
  }
}

/**
 * Calls Claude to analyze the article + airport data and produce SVG infographics,
 * converts them to PNG, uploads to Payload, and injects <img> tags into the HTML.
 * An infographic that prices an off-site lot is dropped (see pricesOffSiteLots).
 */
async function generateFreeformInfographics(
  html: string,
  airportData: AirportData,
  airportCode: string,
): Promise<InfographicResult> {
  const lotNames = (airportData.parkingLots ?? []).map((l) => l.name).filter((n): n is string => typeof n === 'string')
  const airportWords = `${airportData.fullName ?? ''} ${airportCode}`.split(/[^A-Za-z]+/).filter(Boolean)
  // Extract the subset of airport data most useful for visualization
  const vizData = extractVisualizableData(airportData)
  // Same Canadian rule as the writer and editor prompts (currency field OR the code list), so the SVG never prints $ where the article prints C$.
  if (isCanadianAirport(airportCode, airportData)) vizData.currency = 'CAD'

  // Call Claude with cached system prompt (brand guide + airport data)
  // and compact user message (article headings + tables only)
  const system = buildInfographicSystem(vizData, airportCode)
  const userPrompt = buildInfographicUserPrompt(html)

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16384,
    system,
    messages: [{ role: 'user', content: userPrompt }],
  })

  // Track infographic token usage (was previously untracked)
  trackUsage('infographics', response.usage)

  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')

  // Parse the JSON response
  let specs: InfographicSpec[]
  try {
    specs = parseInfographicResponse(responseText)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`  ⚠ Could not parse infographic response: ${msg}`)
    return { html, count: 0 }
  }

  if (specs.length === 0) {
    console.log('  No infographics returned by Claude')
    return { html, count: 0 }
  }

  // Process each infographic: validate → convert → upload → inject
  let modifiedHtml = html
  let successCount = 0

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    const label = `infographic ${i + 1}/${specs.length}`

    // Validate SVG
    const validation = validateSvg(spec.svg)
    if (!validation.valid) {
      console.log(`  ⚠ Skipping ${label}: ${validation.error}`)
      continue
    }
    if (pricesOffSiteLots(spec.svg, lotNames, airportWords) || pricesOffSiteLots(spec.alt, lotNames, airportWords)) {
      console.log(`  ⚠ Skipping ${label}: it prices off-site lots (only the dated rate chart may)`)
      continue
    }

    // Convert SVG to PNG
    let pngBuffer: Buffer
    try {
      pngBuffer = svgToPng(spec.svg)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  ⚠ SVG-to-PNG conversion failed for ${label}: ${msg}`)
      continue
    }

    // Upload PNG to Payload media library
    let mediaId: string
    let mediaUrl: string
    try {
      const filename = `${airportCode.toLowerCase()}-infographic-${i + 1}-${Date.now()}.png`
      const media = await uploadMedia(pngBuffer, filename, spec.alt)
      mediaId = media.doc?.id || media.id
      mediaUrl = media.doc?.url || media.url
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  ⚠ Upload failed for ${label}: ${msg}`)
      continue
    }

    const wrappedImg = figureTag(mediaId, mediaUrl, spec.alt)

    // Find insertion point and inject
    const insertPos = findInsertionPoint(modifiedHtml, spec.placement)
    if (insertPos !== -1) {
      modifiedHtml = modifiedHtml.slice(0, insertPos) + '\n' + wrappedImg + '\n' + modifiedHtml.slice(insertPos)
    } else {
      // Fallback: insert around the 60% mark of the article
      const fallbackPos = Math.floor(modifiedHtml.length * 0.6)
      const fallbackInsert = modifiedHtml.indexOf('</p>', fallbackPos)
      if (fallbackInsert !== -1) {
        const pos = fallbackInsert + '</p>'.length
        modifiedHtml = modifiedHtml.slice(0, pos) + '\n' + wrappedImg + '\n' + modifiedHtml.slice(pos)
      } else {
        // Last resort: append at the end
        modifiedHtml += '\n' + wrappedImg + '\n'
      }
      console.log(`  ⚠ Could not find placement for ${label} — used fallback position`)
    }

    successCount++
    console.log(`  ✓ Infographic ${successCount}: "${spec.alt.slice(0, 60)}"`)
  }

  return { html: modifiedHtml, count: successCount }
}
