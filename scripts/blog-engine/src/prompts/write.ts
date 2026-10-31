import { DOMAIN, BLOG_BASE_URL } from '../config.js'
import type { QueueItem } from '../queue.js'
import { currencySymbol, isCanadianAirport, type AirportData } from '../airport-data.js'
import type { PublishedPost } from '../payload.js'
import { getExternalLinks, formatExternalLinksForPrompt, COMPETITOR_LIVE_SOURCE_CATEGORIES, isOwnSiteUrl, isUsOnlyUrl, COMPETITOR_NAME_RE } from '../external-links.js'
import { loadApprovedCodes, loadApprovedOffers } from '../lint.js'

/**
 * Rule 39 (feature our own promo code) is emitted only for a code the lint will accept: COUPON_CODE must be listed in
 * src/config/approved-promo-codes.json with a percentOff, and the percent comes from that file, never from the env.
 * Otherwise the writer would be told to feature a code the lint then refuses — after the whole Claude spend.
 */
function ownCodeRule(airportCode: string): string {
  const code = (process.env.COUPON_CODE || '').trim().toUpperCase()
  if (!code) return ''
  const pct = loadApprovedOffers()[code]
  if (!loadApprovedCodes().map((c) => c.toUpperCase()).includes(code) || typeof pct !== 'number') {
    console.warn(`  ⚠ COUPON_CODE=${code} is not in src/config/approved-promo-codes.json with a percentOff — the promo-code rule is left out of the prompt`)
    return ''
  }
  return `39. TRIPLY PROMO CODE (coupon-intent articles only): If the focus keyword involves coupons, promo codes, discounts, or deals, feature Triply's own code as the FIRST direct answer near the top: an H2 "Promo code ${code}: ${pct}% off" followed by a short paragraph stating that ${code} takes ${pct}% off the parking rate on bookings made on triplypro.com, entered in the promo code field at checkout, with a link to https://www.${DOMAIN}/search?airport=${airportCode} in that same paragraph, plus the terms line "Applies to bookings made on triplypro.com." Never call it verified or working, never promise one use per customer, NEVER write that no codes exist. Third-party code discussion comes after ours and names only codes the airport or the lot itself publishes.`
}

interface AnalysisResult {
  commonTopics: string[]
  gaps: string[]
  topicGaps?: string[]
  depthGaps?: string[]
  dataGaps?: string[]
  entityGaps?: string[]
  entityFrequency?: { entity: string; mentions: number }[]
  structuralPatterns?: string[]
  contentFormats?: string[]
  recommendedH2s: string[]
  faqQuestions: string[]
  estimatedWordCount: number
  suggestedTags: string[]
  competitorBenchmarks?: {
    avgWordCount: number
    avgH2Count: number
    avgListCount: number
    avgTableCount: number
    avgLinkCount: number
  }
}

function getArticleTypeInstructions(item: QueueItem): string {
  switch (item.articleType) {
    case 'hub':
      return `This is a HUB article — the main pillar page for ${item.airportCode} airport parking.
- Write a comprehensive overview covering ALL aspects of parking at this airport
- Each H2 section should briefly introduce a subtopic and include a CTA link to the sub-pillar article
- Use links in this format: <a href="${BLOG_BASE_URL}/[sub-pillar-slug]">Read our complete guide to [topic]</a>
- The tone should be authoritative and comprehensive — this is THE definitive guide
- Target length: ${item.targetWords ? `${item.targetWords}-${item.targetWords + 500} words` : '3000-3500 words'}`

    case 'sub-pillar':
      return `This is a SUB-PILLAR article — a detailed guide on a specific aspect of ${item.airportCode} airport parking.
- Start the introduction with a link back to the hub: <a href="${BLOG_BASE_URL}/${item.hubSlug}">Complete ${item.airportCode} Airport Parking Guide</a>
- Go deep on this specific topic — more detail than the hub provides
- You MUST include at least 2 contextual links to sibling articles (not just the hub). Use natural anchor text containing the sibling's primary keyword. Place cross-links within relevant H2 sections, not bunched in one paragraph.
- Target length: ${item.targetWords ? `${item.targetWords}-${item.targetWords + 500} words` : '2000-2500 words'}`

    case 'spoke':
      return `This is a SPOKE article — a focused, specific piece about ${item.airportCode} airport parking.
- Include a link to the parent sub-pillar: <a href="${BLOG_BASE_URL}/${item.parentSlug}">Back to [parent topic]</a>
- Include a link to the hub: <a href="${BLOG_BASE_URL}/${item.hubSlug}">Complete ${item.airportCode} Airport Parking Guide</a>
- You MUST include at least 1 contextual link to a sibling article. Use natural anchor text containing the sibling's primary keyword.
- Very focused on one specific question or niche topic
- Target length: ${item.targetWords ? `${item.targetWords}-${item.targetWords + 500} words` : '1000-1500 words'}`

    default:
      return `Write a standard blog article about airport parking.
- Target length: 1200-1500 words`
  }
}

type ArticleStyle = 'standard' | 'narrative' | 'listicle' | 'data-heavy' | 'comparison' | 'rescue'

function getStyleInstructions(style: ArticleStyle, item: QueueItem): string {
  switch (style) {
    case 'rescue':
      return `**Article Style: RESCUE**
This reader has a problem right now: they are flying soon and just found out ${item.airportCode} parking is unavailable. Write for that moment.
- Open on the problem in the FIRST sentence, then immediately reassure — this is common and solvable. Never bury the answer behind background.
- Lead with the live-status check: how to verify current ${item.airportCode} availability (official airport page/app from the verified sources) BEFORE any advice about alternatives.
- Then give alternatives in descending order of how fast they solve the problem: (1) off-site lots bookable right now, (2) park-and-ride and public transit, (3) same-day emergency options — rideshare, fixed-rate taxi, park-sleep-fly hotels.
- Name REAL lots with REAL rates and drive times from the verified data. Never write "several off-site options are available" — list them by name.
- Include ONE comparison table: on-airport vs off-site vs park-and-ride vs valet, with daily rate, shuttle, and who each option suits best.
- Frame off-site parking as the better-value choice, not a consolation prize. The reader should finish feeling they got an upgrade, not a downgrade.
- Close with a prevention section (the peak periods when ${item.airportCode} parking actually fills up) and a short backup-plan recap.
- Use statement headings that name the problem or the fix ("Best Off-Site Alternatives When ${item.airportCode} Parking Is Sold Out"), not abstract topic labels.
- Keep the tone calm and practical. The urgency comes from the structure and the ordering, never from hype or exclamation marks.
- FAQs (in the faqItems JSON field) must be rescue-framed — what to do on arrival, whether walk-ins are possible, refunds/cancellation, shuttle reliability, how early to book for the next trip.`

    case 'narrative':
      return `**Article Style: NARRATIVE**
- Open with a traveler scenario (2-3 sentences painting a relatable situation), then deliver the direct answer.
- Do NOT include a "Key Takeaways" section at the top — instead, weave key facts naturally into the narrative.
- Use lists sparingly — only when listing genuinely distinct items (e.g., terminal names, lot options). Prefer flowing prose.
- Use statement headings ("The Shuttle Experience at ${item.airportCode}") rather than questions. Questions are okay occasionally but should not dominate.
- The tone should feel like a knowledgeable friend sharing travel advice, not an encyclopedia entry.`

    case 'listicle':
      return `**Article Style: LISTICLE**
- Open with a numbered hook (e.g., "7 things every traveler should know about ${item.airportCode} parking"). Key Takeaways section is optional.
- Use numbered H2 headings: "1. [Topic]", "2. [Topic]", etc. — do NOT phrase them as questions.
- Include bulleted details under each numbered heading.
- Heavy use of lists throughout — this format should feel scannable and snackable.
- Keep each numbered section focused: one main point with supporting details.`

    case 'data-heavy':
      return `**Article Style: DATA-HEAVY**
- Open with a quick price comparison list (3-4 parking options with $/day rates), then a 1-sentence summary.
- Heavy use of comparison lists and pricing breakdowns throughout.
- Include specific numbers wherever possible: rates, distances, shuttle frequency, capacity.
- Mix question and statement headings — use whichever best fits the data being presented.
- The tone should feel like a well-researched consumer report.`

    case 'comparison':
      return `**Article Style: COMPARISON**
- Open with "Choosing between [option A] and [option B]?" framing — present the comparison from the very first sentence.
- Every section should include side-by-side comparison elements (pros/cons, feature-by-feature lists).
- Use "[Option A] vs [Option B]" heading format where applicable.
- Include comparison lists in every major section — readers are here to decide between options.
- Conclude with a clear recommendation based on different traveler needs (budget, convenience, families, etc.).`

    case 'standard':
    default:
      return `**Article Style: STANDARD**
- Open with a direct answer to the main query, followed by a "Key Takeaways" bulleted list.
- Use question-format H2 headings where natural.
- Natural mix of lists and prose throughout.
- This is the default structure — balanced and comprehensive.`
  }
}

function formatParkingLots(data: AirportData, keyword: string): string {
  if (!data.parkingLots || data.parkingLots.length === 0) return ''

  // Sort by daily rate ascending, take top 20
  const lots = [...data.parkingLots]
    .filter((lot: Record<string, unknown>) => typeof lot.dailyRate === 'number')
    .sort((a: Record<string, unknown>, b: Record<string, unknown>) => (a.dailyRate as number) - (b.dailyRate as number))
    .slice(0, 20)

  if (lots.length === 0) return ''
  const cur = currencySymbol(data)

  const lines: string[] = ['\n**Off-Site Parking Lots (sorted by price — use these EXACT names and rates in tables and text, NEVER generalize into categories):**']
  for (const lot of lots) {
    const l = lot as Record<string, unknown>
    let line = `- **${l.name}**: ${cur}${l.dailyRate}/day`
    if (l.driveTime) line += ` | ${l.driveTime} from airport`
    if (l.parkingType) line += ` | ${l.parkingType}`
    if (l.shuttleInfo) line += ` | Shuttle: ${(l.shuttleInfo as string).slice(0, 100)}`
    if (l.amenities && Array.isArray(l.amenities) && l.amenities.length > 0) {
      line += ` | Amenities: ${(l.amenities as string[]).join(', ')}`
    }
    if (l.knownCoupons && Array.isArray(l.knownCoupons) && l.knownCoupons.length > 0) {
      line += ` | Coupons: ${(l.knownCoupons as string[]).join('; ')}`
    }
    if (l.freeCancellation) line += ' | Free cancellation'
    lines.push(line)
  }

  const cheapest = lots[0] as Record<string, unknown>
  const mostExpensive = lots[lots.length - 1] as Record<string, unknown>
  lines.push(`\nPrice range: ${cur}${cheapest.dailyRate}/day — ${cur}${mostExpensive.dailyRate}/day across ${lots.length} verified lots.`)

  return lines.join('\n')
}

/**
 * Render a camelCase key as a readable label ("busiestHours" → "Busiest hours").
 */
function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * Flatten an arbitrarily-shaped value (string | string[] | object) into a single line.
 *
 * The 30 airport JSONs were bootstrapped in generations and their sub-object shapes are NOT
 * uniform — e.g. peakTravelTimes has `quietestDays` at most airports but `quietestDay` +
 * `quietDays` at JFK, and popularHotels is an object array at 26 airports but a string array
 * at JFK/LAX/LGA/SFO. Walking whatever keys exist is the only safe approach; hardcoding a
 * known key list silently drops data at the airports that differ.
 */
function flattenValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    return value.map(flattenValue).filter(Boolean).join('; ')
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => {
        const flat = flattenValue(v)
        return flat ? `${humanizeKey(k)}: ${flat}` : ''
      })
      .filter(Boolean)
      .join(' | ')
  }
  return ''
}

/**
 * Format a top-level object field as a bullet list, one line per key.
 * Returns '' when the field is absent or empty so callers can concatenate unconditionally.
 */
function formatObjectSection(value: unknown, header: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const entries = Object.entries(value as Record<string, unknown>).filter(([k]) => !k.startsWith('_'))
  if (entries.length === 0) return ''

  const lines: string[] = [header]
  for (const [key, val] of entries) {
    const flat = flattenValue(val)
    if (flat) lines.push(`- ${humanizeKey(key)}: ${flat}`)
  }
  return lines.length > 1 ? '\n' + lines.join('\n') : ''
}

function formatPeakTravelTimes(data: AirportData): string {
  return formatObjectSection(
    data.peakTravelTimes,
    '**Peak Travel Periods (use for the "when does parking fill up" section — do NOT invent dates or holidays):**',
  )
}

function formatSavingsComparison(data: AirportData): string {
  return formatObjectSection(
    data.savingsComparison,
    '**Worked Savings Scenario (use for the cost-comparison section — these are verified figures):**',
  )
}

function formatParkSleepFly(data: AirportData): string {
  const psf = data.parkSleepFly
  if (!psf || typeof psf !== 'object' || Array.isArray(psf)) return ''
  const p = psf as Record<string, unknown>

  const lines: string[] = [
    '\n**Park-Sleep-Fly Hotel Packages (same-day fallback when lots are full):**',
  ]
  if (typeof p.description === 'string') lines.push(`- ${p.description}`)
  if (typeof p.priceRange === 'string') lines.push(`- Price range: ${p.priceRange}`)

  // popularHotels is an object array at most airports but a plain string array at JFK/LAX/LGA/SFO.
  if (Array.isArray(p.popularHotels)) {
    for (const hotel of p.popularHotels.slice(0, 5)) {
      const flat = flattenValue(hotel)
      if (flat) lines.push(`- ${flat}`)
    }
  }
  if (typeof p.extendedParking === 'string') lines.push(`- Extended parking: ${p.extendedParking}`)

  return lines.length > 1 ? lines.join('\n') : ''
}

function formatOnAirportParking(data: AirportData): string {
  if (!data.onAirportParking) return ''
  const parking = data.onAirportParking as Record<string, Record<string, unknown>>
  const cur = currencySymbol(data)
  const lines: string[] = ['\n**On-Airport Parking Options:**']
  for (const [key, info] of Object.entries(parking)) {
    if (typeof info === 'string') {
      lines.push(`- ${key}: ${info}`)
      continue
    }
    const parts: string[] = [`- **${key}**`]
    if (info.rate) parts.push(`${info.rate}`)
    if (info.dailyMax) parts.push(`max ${cur}${info.dailyMax}/day`)
    if (info.preBookRate) parts.push(`pre-book ${cur}${info.preBookRate}/day`)
    if (info.terminals) parts.push(`near ${info.terminals}`)
    if (info.location) parts.push(`at ${info.location}`)
    if (info.connection) parts.push(`(${info.connection})`)
    if (info.cost) parts.push(String(info.cost))
    if (info.description) parts.push(String(info.description))
    lines.push(parts.join(' | '))
  }
  return lines.join('\n')
}

function formatEvCharging(data: AirportData): string {
  if (!data.evCharging) return ''
  const ev = data.evCharging as Record<string, unknown>
  const lines: string[] = ['\n**EV Charging Info:**']
  if (ev.available !== undefined) lines.push(`- Available: ${ev.available ? 'Yes' : 'No'}`)
  if (ev.locations) lines.push(`- Locations: ${ev.locations}`)
  if (ev.provider) lines.push(`- Provider: ${ev.provider}`)
  if (ev.notes) lines.push(`- Notes: ${ev.notes}`)
  return lines.join('\n')
}

function formatConstruction(data: AirportData): string {
  const construction = (data as Record<string, unknown>).construction2026 as Record<string, unknown> | undefined
  if (!construction) return ''
  const lines: string[] = ['\n**Active Construction (mention for freshness):**']
  if (construction.status) lines.push(`- Status: ${construction.status}`)
  if (Array.isArray(construction.projects)) {
    // projects is a string array at most airports but an object array at LAX/SFO; a bare
    // template literal renders those as "[object Object]" straight into the prompt.
    for (const p of construction.projects) {
      const flat = flattenValue(p)
      if (flat) lines.push(`- ${flat}`)
    }
  }
  if (construction.travelImpact) lines.push(`- Travel impact: ${construction.travelImpact}`)
  return lines.join('\n')
}

function formatLounges(data: AirportData): string {
  if (!data.lounges) return ''
  const lounges = data.lounges as Record<string, unknown>[]
  if (!Array.isArray(lounges) || lounges.length === 0) return ''
  const lines: string[] = ['\n**Airport Lounges:**']
  for (const l of lounges.slice(0, 5)) {
    const parts: string[] = []
    if (l.name) parts.push(`**${l.name}**`)
    if (l.terminal) parts.push(`${l.terminal}`)
    if (l.access) parts.push(`${l.access}`)
    if (l.cost) parts.push(`${l.cost}`)
    lines.push(`- ${parts.join(' | ')}`)
  }
  return lines.join('\n')
}

function formatAirportData(data: AirportData, keyword?: string): string {
  const terminalList = data.terminals
    .map((t) => `${t.name} (${t.airlines.join(', ')})`)
    .join('; ')

  const kw = keyword?.toLowerCase() || ''

  // Always include core facts
  let result = `**Verified Airport Facts (USE THESE — do not invent facts not listed here):**
- Full name: ${data.fullName}
- Terminals: ${terminalList}
- Nearby roads: ${data.roads.join(', ')}
- Transit: ${data.transit.join(', ')}
- Neighborhoods: ${data.neighborhoods.join(', ')}
- Authority: ${data.authority}
- Official parking rates: ${data.parkingRates}
- Shuttle info: ${data.shuttleInfo}
- Distance: ${data.distanceFromCity}
- Data checked: ${data.lastVerified} (the month for every "as of <Month YYYY>" in the article)

When citing specific numbers (rates, distances, shuttle frequency), use ONLY the data above. If a number is not in this data or on a cited official page, leave it out — never estimate, round or hedge a figure ("typically", "around", "roughly").
${formatLiveSources(data)}`

  // Always include parking lot details — this is the core value
  result += formatParkingLots(data, kw)
  result += formatOnAirportParking(data)

  // Include contextual sections based on keyword relevance
  if (kw.includes('ev') || kw.includes('electric') || kw.includes('charg')) {
    result += formatEvCharging(data)
  }
  if (kw.includes('lounge') || kw.includes('premium') || kw.includes('ameniti')) {
    result += formatLounges(data)
  }
  // Capacity/availability intent — the "rescue" family (sold out / full / status / availability)
  // plus any cost-comparison keyword, which is what the savings scenario is for.
  if (
    kw.includes('sold out') ||
    kw.includes('full') ||
    kw.includes('status') ||
    kw.includes('availab') ||
    kw.includes('busy') ||
    kw.includes('peak')
  ) {
    result += formatPeakTravelTimes(data)
    result += formatParkSleepFly(data)
  }
  if (
    kw.includes('sold out') ||
    kw.includes('cost') ||
    kw.includes('price') ||
    kw.includes('rate') ||
    kw.includes('cheap') ||
    kw.includes('save') ||
    kw.includes('compar')
  ) {
    result += formatSavingsComparison(data)
  }
  // Always include construction for freshness signals
  result += formatConstruction(data)

  return result
}

function formatLiveSources(data: AirportData): string {
  if (!data.liveSources) return ''

  const lines: string[] = ['\n**Verified Reference URLs (use these for external links — do NOT invent URLs):**']
  const canadian = isCanadianAirport(data.code ?? '', data)
  for (const [category, value] of Object.entries(data.liveSources)) {
    if (category.startsWith('_')) continue
    if (typeof value === 'string') continue
    // Competing booking sites are never offered as reference URLs (only our own search link survives from those
    // categories), and US-only sources (TSA, CLEAR) are dropped for Canadian airports — same rules as the links DB.
    const urls = Object.entries(value as Record<string, string>).filter(
      ([, url]) => (!COMPETITOR_LIVE_SOURCE_CATEGORIES.has(category) || isOwnSiteUrl(url)) && !(canadian && isUsOnlyUrl(url))
    )
    if (urls.length === 0) continue
    lines.push(`- ${category}: ${urls.map(([label, url]) => `${label} <${url}>`).join(', ')}`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

function formatPublishedPosts(posts: PublishedPost[]): string {
  if (posts.length === 0) return ''

  const lines = [
    '\n**Published articles you can link to (use EXACT slugs):**',
    ...posts.map(p => `- ${BLOG_BASE_URL}/${p.slug} — "${p.title}" (${p.articleType})`),
    'ONLY link to slugs from this list. Do NOT invent blog URLs.\n',
  ]
  return lines.join('\n')
}

interface ClusterArticle {
  slug: string
  title: string
  articleType: string
  keyword?: string
  headings: { level: number; text: string }[]
  excerpt: string
}

function formatClusterContext(clusterArticles: ClusterArticle[], item: QueueItem): string {
  if (clusterArticles.length === 0) return ''

  const lines: string[] = ['\n**Cluster Content Context (DO NOT repeat — link instead):**']
  lines.push(`You are writing a ${item.articleType}. These sibling articles already exist for ${item.airportCode}:`)

  for (const article of clusterArticles) {
    const h2s = article.headings.filter(h => h.level === 2).map(h => h.text)
    const keywordNote = article.keyword ? ` | keyword: "${article.keyword}"` : ''
    lines.push(`- "${article.title}" (${article.articleType}) — ${BLOG_BASE_URL}/${article.slug}${keywordNote}`)
    if (h2s.length > 0) {
      lines.push(`  Covers: ${h2s.join(', ')}`)
    }
  }

  lines.push('')
  lines.push('IMPORTANT: Do NOT repeat content already covered in depth by the hub or siblings above.')
  lines.push('Instead, reference them with contextual links using natural anchor text that includes the sibling\'s keyword.')
  lines.push('Go deeper on YOUR specific angle that siblings do not cover.')
  lines.push('CROSS-LINKING IS MANDATORY: You MUST link to at least 2 sibling articles (not just the hub/pillar). Place these links within relevant H2 sections where the sibling topic naturally comes up — do NOT bunch them in one paragraph or the conclusion.\n')

  return lines.join('\n')
}

export function buildWritePrompt(
  item: QueueItem,
  analysis: AnalysisResult,
  airportData?: AirportData,
  publishedPosts?: PublishedPost[],
  clusterArticles?: ClusterArticle[]
): string {
  const outlineSection = item.outline?.length
    ? `\n\nFollow this outline:\n${item.outline.map((o) => `${o.order}. ${o.heading}${o.summary ? ` — ${o.summary}` : ''}${o.linksTo ? ` [Link to: ${BLOG_BASE_URL}/${o.linksTo}]` : ''}`).join('\n')}`
    : `\n\nUse these recommended headings:\n${analysis.recommendedH2s.map((h, i) => `${i + 1}. ${h}`).join('\n')}`

  return `You are a professional travel and airport parking content writer for ${DOMAIN}.

Write an SEO-optimized blog article with the following parameters:

**Focus keyword:** ${item.keyword} — this is the exact search query we want to rank for
**URL slug:** ${item.slug}
**Airport:** ${item.airportCode}

**Generate an article title** (50-65 characters) that:
- Contains the EXACT focus keyword, placed as close to the front as possible
- Is compelling and specific — generated based on competitive analysis of what ranks
- Include the year (${new Date().getFullYear()}) in the title when the content covers rates, deals, construction, policies, or any data that changes annually. Omit the year only for truly evergreen concepts.
- Hub = authoritative guide title; Sub-pillar = deep-dive title; Spoke = specific answer title
- Do NOT include any brand suffix like "| Triply" — the website template appends it automatically

${getArticleTypeInstructions(item)}
${publishedPosts && publishedPosts.length > 0 ? formatPublishedPosts(publishedPosts) : ''}${clusterArticles && clusterArticles.length > 0 ? formatClusterContext(clusterArticles, item) : ''}
${getStyleInstructions(item.articleStyle || 'standard', item)}
${outlineSection}

${airportData ? formatAirportData(airportData, item.keyword) + '\n\n' : ''}${(() => {
    const links = getExternalLinks(item.airportCode, item.articleType)
    return links.length > 0 ? formatExternalLinksForPrompt(links, item.articleType) + '\n' : ''
  })()}${analysis.competitorBenchmarks ? `**Competitor Benchmarks (match or exceed):**
- Average word count: ${analysis.competitorBenchmarks.avgWordCount}
- Average H2 headings: ${analysis.competitorBenchmarks.avgH2Count}
- Average lists: ${analysis.competitorBenchmarks.avgListCount}
- Average tables: ${analysis.competitorBenchmarks.avgTableCount}
- Average links: ${analysis.competitorBenchmarks.avgLinkCount}
` : ''}**Topics to cover (from competitor analysis):** ${analysis.commonTopics.join(', ')}
**Content gaps to fill (unique angles):** ${analysis.gaps.join(', ')}${analysis.topicGaps?.length ? `\n**Topic gaps (NO competitor covers these — high-value differentiation):** ${analysis.topicGaps.join(', ')}` : ''}${analysis.depthGaps?.length ? `\n**Depth gaps (competitors mention but cover shallowly):** ${analysis.depthGaps.join(', ')}` : ''}${analysis.dataGaps?.length ? `\n**Data gaps (specific missing data points):** ${analysis.dataGaps.join(', ')}` : ''}${(() => { const ents = (analysis.entityFrequency || []).filter((e) => !COMPETITOR_NAME_RE.test(e.entity)).slice(0, 8); return ents.length ? `\n**Key entities to mention (by competitor frequency — skip any parking lot or company not in the verified data above):** ${ents.map(e => `${e.entity} (${e.mentions}x)`).join(', ')}` : '' })()}${analysis.structuralPatterns?.length ? `\n**Structural patterns to match:** ${analysis.structuralPatterns.join('; ')}` : ''}

**Writing rules:**
1. Output ONLY clean HTML using these tags: h2, h3, p, ul, ol, li, a, strong, em, blockquote, table, thead, tbody, tr, th, td, img
2. Do NOT use: h1, div, span, inline styles, classes, or IDs
3. Do NOT include the article title as an h1 — it's handled separately
4. All internal links use format: ${BLOG_BASE_URL}/[slug]
5. External links: USE the verified external links database and liveSources URLs provided above. Pick the most relevant links for this topic. Add rel="nofollow" where specified. Use the suggested anchor text (vary it naturally). Do NOT invent external URLs — ONLY use URLs from the databases provided above.
6. EXACT KEYWORD (ranking-critical — do NOT paraphrase): The focus keyword "${item.keyword}" must appear VERBATIM (identical words, identical order) at least once in the opening paragraph — it can be the 2nd or 3rd sentence, so it coexists with the definition-first opening in rule 34 — plus in at least 2 H2 headings and once near the conclusion. Repeat the exact phrase naturally 3-6 times across the article so keyword density lands between 0.5% and 2.5%. Search engines match the exact string, so reordered or paraphrased variants do not count.
7. Write in a friendly, helpful, authoritative voice — not corporate
8. Include specific details: prices, distances, shuttle times, tips
9. Use "Triply" or "TriplyPro" when referencing our service with a link to https://www.${DOMAIN}

**Booking CTAs (CRITICAL for conversions — must be CONTEXTUAL, not generic):**
10. EARLY CTA: Within the first 500 words, include a booking CTA that references something specific from the surrounding content. The CTA MUST include the airport name or code ("LaGuardia", "LGA", "JFK", etc.) AND a specific detail from the article (a terminal, price range, or parking type). Example: "Compare LaGuardia Terminal B parking from [the lowest sellable lot rate in the data block, with its currency sign]/day on Triply." Do NOT use generic phrases like "Compare rates on Triply" — always include the airport name. Link to https://www.${DOMAIN}/search?airport=${item.airportCode}.
11. CLOSING CTA: In the final section, include a CTA that ties back to the article's main promise AND mentions the airport by name or code. Example: "Find your best LGA parking deal — compare rates from [the lowest sellable lot rate in the data block]/day on Triply." The airport name/code (${item.airportCode}) MUST appear in every CTA. Link to https://www.${DOMAIN}/search?airport=${item.airportCode}.

**Readability (CRITICAL — target Flesch-Kincaid grade 6-9):**
12. SENTENCE LENGTH: Keep sentences SHORT. Average sentence length should be 15-20 words. Mix it up: some sentences 8-12 words, some 20-25, but never exceed 30 words in a single sentence. Break complex ideas into multiple simple sentences.
13. SIMPLE WORDS: Prefer common words over fancy ones. "use" not "utilize", "help" not "facilitate", "start" not "commence", "near" not "in proximity to". Write at an 8th-grade reading level.
14. ACTIVE VOICE: Use active voice ("The shuttle picks you up") not passive ("You will be picked up by the shuttle"). Active voice is shorter and easier to parse.
15. NO COMPOUND SENTENCES: Avoid stringing clauses together with semicolons or multiple commas. Instead of "The lot offers valet parking, which means you drive to the entrance, hand over your keys, and they park your car for you" — write two sentences.

**Readability Examples (follow this quality bar):**
BAD: "While the shuttle service at JFK provides complimentary transportation between parking and terminals, it's worth noting that during peak periods wait times can be significantly longer than the usual 5-10 minute intervals."
GOOD: "JFK's free shuttle runs every 5-10 minutes. During holidays, expect longer waits. Plan an extra 15 minutes around Thanksgiving and Christmas."

BAD: "For travelers seeking to minimize their overall parking expenditure while still maintaining convenient access to terminal facilities, the economy lot represents the most cost-effective option available."
GOOD: "The economy lot is the cheapest option at $18/day. It's a 10-minute shuttle ride to the terminals. For most travelers, the savings outweigh the extra time."

**AI Search & Featured Snippet Optimization (CRITICAL — follow these closely):**
16. OPENING ANSWER (GEO-critical — AI Overviews quote this paragraph): The first paragraph must COMPLETELY answer the main query within its first ~50 words AND, when the data block has one, state the single most important figure — the actual price/rate with its currency sign, taken from the data block (never invented for a topic that has no figure, such as shuttles or cell-phone lots). Lead with the answer; never build up to it. It must be self-contained and quotable: if an AI engine lifted only this paragraph, it would be a complete, accurate answer including the key figure. In the zero-click/AI-Overview era, being the most directly quotable answer-with-data is how you get cited.
16b. PROMO / COUPON / DEAL POSTS (W1.5): frame the article as "how to save on <airport> parking" — booking ahead, off-site lots, long-term vs garage, the airport's own published offers. Name a third-party code ONLY if the airport or the lot publishes it, and link that official page next to it. Never invent, list or "round up" codes; never "verified", "working" or "updated" codes; never "save up to N%" without a linked source.
16a. ANSWER FIRST — RATES/COST/PRICE POSTS (hard rule, checked by a lint that blocks the write): the first paragraph carries the direct answer with AT LEAST ONE sourced figure written with its currency sign ("$18/day", "C$12/day") AND the phrase "as of <Month YYYY>" (the "Data checked" month in the airport data block, never an older or a guessed month). Phrase the sentence the way the question is asked ("Parking at EWR costs $18/day in the economy lot as of October 2026"). The title also names the key number where one exists. Every figure comes from the airport data block or a cited official URL — never from a competitor page.
17. KEY TAKEAWAYS: For standard, data-heavy, and comparison styles, immediately after the opening answer include a "Key Takeaways" section using a <ul> with 4-6 bullet points summarizing the most important facts. Bold the lead phrase of each bullet with <strong>. Skip this for narrative style (weave facts into prose instead) and listicle style (the numbered format serves this purpose).
18. USE LISTS NATURALLY: Include <ul> or <ol> lists in most sections where they fit — options, steps, tips, comparisons, pros/cons. Don't force a list into a section that reads better as narrative, but when you're presenting multiple items, always use a list rather than burying them in paragraph form.
19. ANSWER-FIRST SECTIONS: Begin each H2 section with a concise 1-2 sentence direct answer before elaborating. AI systems extract the first clear statement after a heading.
20. QUESTION HEADINGS: For standard and data-heavy styles, frame H2s as questions where natural (e.g., "How Much Does JFK Parking Cost?" not "JFK Parking Costs"). For listicle style, keep numbered headings as statements. For narrative style, prefer statement headings. This rule is OVERRIDDEN by the style instructions above when they conflict.
21. DEFINITION PATTERN: When genuinely introducing a new concept the reader may not know, use the "What is X? X is..." pattern as an H3. Don't overuse this — it's for terms that actually need defining (e.g., "off-site parking", "cell phone lot"), not for obvious concepts.
22. COMPARISONS: Include at least one comparison section using a structured list (e.g., "<h3>On-Site vs Off-Site Parking</h3>" with a <ul> comparing key differences side by side).
23. SOURCE ATTRIBUTION: When citing facts you're confident about, attribute them to real sources (e.g., "the Port Authority of NY & NJ", "JFK's official parking page", "TSA guidelines"). NEVER fabricate a source or attribution — if you're not sure who published a fact, leave the claim out.
24. E-E-A-T SIGNALS (include at least 4 different ones, spread naturally): Signal expertise with credibility phrases that name a checkable source: "according to <named source>", "per the Port Authority"/the relevant airport authority, "official airport data", "published rates", "as of <Month YYYY>". Use at least four distinct phrases across the article. Never claim research Triply did not do ("based on our analysis", "travelers frequently report", "we compared options across providers") and never fabricate a source or attribution.
25. BOLD KEY TERMS: Use <strong> to highlight key terms, names, and important phrases throughout the article. This helps AI systems identify the most important concepts for extraction.
26. ENTITY COVERAGE: Mention related entities thoroughly — terminal names (Terminal 1, Terminal 4, Terminal 8), airline hubs (JetBlue T5, Delta T4), nearby roads (Van Wyck Expressway, Belt Parkway), shuttle services, and neighborhood names (Jamaica, Howard Beach). Entity density helps NLP systems gauge content depth.
27. FRESHNESS SIGNALS: For things that genuinely change (rates, policies, construction updates), include timeframe references like "as of <Month YYYY>" (the Data checked month) or "current rates". Don't add year references to evergreen facts that don't change — it just dates the content unnecessarily.
28. PARAGRAPH LENGTH: Keep paragraphs to 3-5 sentences (80-120 words). Long enough to develop a point, short enough for AI to parse and extract. Never exceed 5 sentences in a single paragraph.
29. NO FILLER: Every sentence must contain a fact, a tip, or a specific actionable detail. Remove any sentence that exists just to fill space or transition generically.
30. COMPARISON TABLES: For pricing data and side-by-side comparisons, use HTML tables (<table>, <thead>, <tbody>, <tr>, <th>, <td>). Tables are especially valuable in data-heavy and comparison style articles. Include at least one table when comparing parking options, rates, or features across providers. CRITICAL: Every row in a parking comparison table MUST use an ACTUAL named facility from the verified data above (e.g., "PARK AC", "ARB Parking", "Bolt Parking"). NEVER use generic categories like "Budget (Jamaica)" or "Premium (Near terminals)" — readers need real lot names they can search for and book.
31. AS-OF DATES: When citing specific rates or time-sensitive facts, add "(as of [Month Year])" inline — e.g., "The early bird rate is $18/day (as of <Month YYYY>)" — the Data checked month. Never write "verified" or "working" next to a promo code.
32. PAA TARGETS: Include 2-3 "People Also Ask" style questions as H2 or H3 headings, targeting common related queries that searchers ask about this topic. For example, if writing about JFK parking deals, include headings like "Is There Free Parking at JFK?" or "How Early Should I Book JFK Parking?"
33. NO FAQ SECTION IN HTML: Do NOT include a "Frequently Asked Questions" section in the HTML body. FAQs are returned separately in the faqItems JSON field and rendered as a dedicated accordion component on the page. Including them in the HTML causes duplicate rendering.
34. DEFINITION-FIRST OPENING: The very first sentence of the article MUST be a clear, standalone definition using the "X is..." pattern. It must pass the "island test" — if this sentence appeared alone on a search results page with no surrounding context, the reader would understand what the article is about. Example: "Off-site JFK parking is a budget-friendly alternative where private lots near the airport offer shuttle service to terminals for less than the on-airport garages." This is DIFFERENT from rule 16 (opening answer paragraph) — rule 16 is about answering the query; this rule is about the sentence structure of the FIRST sentence being a definition.
35. VERIFIABLE STATISTICS: Include at least 3-5 specific, data-backed statistics per article drawn from the verified parking lot data and airport facts provided above. Present savings as the two rates side by side ("$12/day at <lot> vs $46/day at the terminal garage") — never as a percentage unless the same sentence links its source (a lint blocks unsourced "save up to N%") — distances in exact miles, shuttle frequencies in minutes, and price ranges with specific dollar amounts. Bold statistics with <strong> so AI engines can extract them. Attribute data to its source (e.g., "based on current Triply rates" or "per [airport authority name]"). NEVER fabricate statistics — only use numbers derivable from the data provided.
36. NO AI SLOP: Never use these phrases — they are an instant quality fail: "In conclusion", "It's worth noting", "Whether you're a seasoned traveler or", "It's important to note", "invaluable", "game-changer", "Let's dive in", "Read on to learn", "In this guide we'll cover", "Without further ado", "In today's world", "Look no further", "Navigating the world of", "Ever-evolving", "It goes without saying", "Needless to say", "At the end of the day", "When it comes to". Write like a knowledgeable human, not a chatbot.
37. META DESCRIPTION: 120-160 characters (hard requirement). Include a specific price point when the data block has one (the lowest sellable lot rate, with its currency sign) — prices in meta descriptions measurably increase CTR. Start with a direct answer to the search query, add a key differentiator, end with a CTA.
38. CITABLE STAT SENTENCES (GEO — the strongest AI-citation lever): Throughout the article, phrase key facts as self-contained, quotable sentences that pair a specific number with attribution — e.g., "MSP Terminal 1 General Parking costs $36/day as of <Month YYYY>, per the Metropolitan Airports Commission." AI engines preferentially cite sentences that combine a concrete statistic with a credible source. Include several such standalone citable sentences across the article (a clear stat-bearing sentence to open key sections), not buried mid-paragraph. Combine with rule 24 attribution phrasing.
${ownCodeRule(item.airportCode)}
Respond with ONLY valid JSON in this exact format:
{
  "title": "Display title for the article (50-65 chars, keyword-rich, compelling)",
  "html": "<h2>First Section</h2><p>Content...</p>...",
  "excerpt": "A brief 1-2 sentence summary for SEO (max 300 chars)",
  "metaTitle": "SEO title (max 60 chars, shorter variant of title)",
  "metaDescription": "SEO description (max 160 chars)",
  "earlyCta": "The exact text of your early CTA (e.g., 'Compare Terminal 4 parking rates on Triply')",
  "closingCta": "The exact text of your closing CTA (e.g., 'Reserve your JFK parking spot on Triply')",
  "faqItems": [
    {"question": "Question?", "answer": "Answer text"},
    ...
  ],
  "suggestedCategory": "Airport Parking"
}`
}


/**
 * Static writing rules block — for use as cacheable system prompt.
 * Identical across all articles for same airport, enabling prompt caching.
 */
export function getWritingRulesBlock(airportCode: string): string {
  return `**Condensed writing rules for ${DOMAIN} (airport: ${airportCode}):**
1. Output ONLY clean HTML: h2, h3, p, ul, ol, li, a, strong, em, blockquote, table, thead, tbody, tr, th, td, img. No h1/div/span/styles/classes/IDs.
2. Internal links: ${BLOG_BASE_URL}/[slug]. External links: ONLY from verified database. Add rel="nofollow" where specified. Include year (${new Date().getFullYear()}) in title for rates/deals/construction/policies content.
3. Natural keyword placement in first paragraph, 2-3 H2s, conclusion. Friendly authoritative voice.
4. EARLY CTA within 500 words (contextual, specific). CLOSING CTA in final section. Both link to https://www.${DOMAIN}/search?airport=${airportCode}.
5. Readability: grade 6-9. Sentences 15-20 words avg, never >30. Simple words. Active voice.
6. Opening answer paragraph (extractable standalone); rates/cost posts: first paragraph has a $ figure + "as of <Month YYYY>" (lint-enforced). Key Takeaways <ul> after (standard/data-heavy/comparison/rescue only).
7. Question H2s where natural. Answer-first sections. Lists where they fit.
8. Real source attribution. E-E-A-T language. Bold key terms. Entity coverage.
9. Freshness signals for time-sensitive data. 3-5 sentence paragraphs. Zero filler.
10. Comparison tables use REAL lot names from verified data (never generic categories).
11. As-of dates: "(as of [Month ${new Date().getFullYear()}])", never "verified" next to a code. 2-3 PAA question headings.
12. NO FAQ section in HTML (goes in faqItems JSON). No brand suffix in title.
13. Definition-first opening: First sentence MUST be "X is..." standalone definition (island test). Different from opening answer paragraph — this is about sentence structure.
14. Include 3-5+ verifiable statistics per article from provided data. Bold stats with <strong>. Attribute sources. Never fabricate numbers.
15. NO AI SLOP: Never use: "In conclusion", "It's worth noting", "Whether you're a", "game-changer", "invaluable", "Let's dive in", "Read on to learn", "When it comes to", "At the end of the day", "Without further ado". Write like a human.
16. Meta description MUST be 120-160 characters. Include a price point when available (e.g., "from $8.95/day") — prices boost CTR. Start with direct answer, add differentiator, end with CTA.`
}

/**
 * Get formatted airport data block for prompt caching.
 */
export function getAirportDataBlock(airportData: AirportData, keyword: string): string {
  // Vin 14 Oct 2026: never name off-site lots we can't sell, even if competitor articles do
  const onlySellable = "\n\nOFF-SITE LOTS: name ONLY the off-site lots listed above (all bookable on Triply). Never name any other off-site lot, hotel parking or parking company, even if competitor articles mention them. The airport's own on-airport parking may be named for comparison. Never name competing booking sites or apps (SpotHero, Way.com, ParkWhiz, ParkSleepFly and the like) or send readers to them for codes; if the focus keyword names one (e.g. Groupon), cover it without recommending it."
  const currencyRule = currencySymbol(airportData) === 'C$'
    ? "\n\nCURRENCY: this is a Canadian airport. Every price in the article is Canadian dollars, written C$ (e.g. C$12/day), including on-airport rates, examples and comparisons. Never a bare $."
    : ''
  return formatAirportData(airportData, keyword) + onlySellable + currencyRule
}

/**
 * Get formatted external links block for prompt caching.
 */
export function getExternalLinksBlock(airportCode: string, articleType: string): string {
  const links = getExternalLinks(airportCode, articleType)
  return links.length > 0 ? formatExternalLinksForPrompt(links, articleType) : ''
}
