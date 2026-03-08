import { DOMAIN, BLOG_BASE_URL } from '../config.js'
import type { QueueItem } from '../queue.js'
import type { AirportData } from '../airport-data.js'
import type { PublishedPost } from '../payload.js'
import { getExternalLinks, formatExternalLinksForPrompt } from '../external-links.js'

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
- Target length: 2000-2500 words`

    case 'sub-pillar':
      return `This is a SUB-PILLAR article — a detailed guide on a specific aspect of ${item.airportCode} airport parking.
- Start the introduction with a link back to the hub: <a href="${BLOG_BASE_URL}/${item.hubSlug}">Complete ${item.airportCode} Airport Parking Guide</a>
- Go deep on this specific topic — more detail than the hub provides
- Cross-link to 2-3 sibling sub-pillar articles where relevant
- Target length: 1500-2000 words`

    case 'spoke':
      return `This is a SPOKE article — a focused, specific piece about ${item.airportCode} airport parking.
- Include a link to the parent sub-pillar: <a href="${BLOG_BASE_URL}/${item.parentSlug}">Back to [parent topic]</a>
- Include a link to the hub: <a href="${BLOG_BASE_URL}/${item.hubSlug}">Complete ${item.airportCode} Airport Parking Guide</a>
- Very focused on one specific question or niche topic
- Target length: 800-1200 words`

    default:
      return `Write a standard blog article about airport parking.
- Target length: 1200-1500 words`
  }
}

type ArticleStyle = 'standard' | 'narrative' | 'listicle' | 'data-heavy' | 'comparison'

function getStyleInstructions(style: ArticleStyle, item: QueueItem): string {
  switch (style) {
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

  const lines: string[] = ['\n**Off-Site Parking Lots (sorted by price — use these EXACT names and rates in tables and text, NEVER generalize into categories):**']
  for (const lot of lots) {
    const l = lot as Record<string, unknown>
    let line = `- **${l.name}**: $${l.dailyRate}/day`
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
  lines.push(`\nPrice range: $${cheapest.dailyRate}/day — $${mostExpensive.dailyRate}/day across ${lots.length} verified lots.`)

  return lines.join('\n')
}

function formatOnAirportParking(data: AirportData): string {
  if (!data.onAirportParking) return ''
  const parking = data.onAirportParking as Record<string, Record<string, unknown>>
  const lines: string[] = ['\n**On-Airport Parking Options:**']
  for (const [key, info] of Object.entries(parking)) {
    if (typeof info === 'string') {
      lines.push(`- ${key}: ${info}`)
      continue
    }
    const parts: string[] = [`- **${key}**`]
    if (info.rate) parts.push(`${info.rate}`)
    if (info.dailyMax) parts.push(`max $${info.dailyMax}/day`)
    if (info.preBookRate) parts.push(`pre-book $${info.preBookRate}/day`)
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
    for (const p of construction.projects) lines.push(`- ${p}`)
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

When citing specific numbers (rates, distances, shuttle frequency), use ONLY the data above. For claims you're unsure about, use hedging language ("typically", "around", "based on current rates").
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
  // Always include construction for freshness signals
  result += formatConstruction(data)

  return result
}

function formatLiveSources(data: AirportData): string {
  if (!data.liveSources) return ''

  const lines: string[] = ['\n**Verified Reference URLs (use these for external links — do NOT invent URLs):**']
  for (const [category, value] of Object.entries(data.liveSources)) {
    if (category.startsWith('_')) continue
    if (typeof value === 'string') continue
    const urls = Object.entries(value as Record<string, string>)
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
  headings: { level: number; text: string }[]
  excerpt: string
}

function formatClusterContext(clusterArticles: ClusterArticle[], item: QueueItem): string {
  if (clusterArticles.length === 0) return ''

  const lines: string[] = ['\n**Cluster Content Context (DO NOT repeat — link instead):**']
  lines.push(`You are writing a ${item.articleType}. These sibling articles already exist for ${item.airportCode}:`)

  for (const article of clusterArticles) {
    const h2s = article.headings.filter(h => h.level === 2).map(h => h.text)
    lines.push(`- "${article.title}" (${article.articleType}) — ${BLOG_BASE_URL}/${article.slug}`)
    if (h2s.length > 0) {
      lines.push(`  Covers: ${h2s.join(', ')}`)
    }
  }

  lines.push('')
  lines.push('IMPORTANT: Do NOT repeat content already covered in depth by the hub or siblings above.')
  lines.push('Instead, reference them with links (e.g., "For a complete overview, see our [guide](url)").')
  lines.push('Go deeper on YOUR specific angle that siblings do not cover.\n')

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

**Target keyword:** ${item.keyword}
**Airport:** ${item.airportCode}

**Generate an article title** (50-65 characters) that:
- Places the target keyword near the front
- Is compelling and specific (not generic)
- Omits the year unless content is genuinely time-sensitive
- Hub = authoritative guide title; Sub-pillar = deep-dive title; Spoke = specific answer title
${item.suggestedTitle ? `**Title guidance (optional angle):** ${item.suggestedTitle}` : ''}

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
**Content gaps to fill (unique angles):** ${analysis.gaps.join(', ')}${analysis.topicGaps?.length ? `\n**Topic gaps (NO competitor covers these — high-value differentiation):** ${analysis.topicGaps.join(', ')}` : ''}${analysis.depthGaps?.length ? `\n**Depth gaps (competitors mention but cover shallowly):** ${analysis.depthGaps.join(', ')}` : ''}${analysis.dataGaps?.length ? `\n**Data gaps (specific missing data points):** ${analysis.dataGaps.join(', ')}` : ''}${analysis.entityFrequency?.length ? `\n**Key entities to mention (by competitor frequency):** ${analysis.entityFrequency.slice(0, 8).map(e => `${e.entity} (${e.mentions}x)`).join(', ')}` : ''}${analysis.structuralPatterns?.length ? `\n**Structural patterns to match:** ${analysis.structuralPatterns.join('; ')}` : ''}

**Writing rules:**
1. Output ONLY clean HTML using these tags: h2, h3, p, ul, ol, li, a, strong, em, blockquote, table, thead, tbody, tr, th, td, img
2. Do NOT use: h1, div, span, inline styles, classes, or IDs
3. Do NOT include the article title as an h1 — it's handled separately
4. All internal links use format: ${BLOG_BASE_URL}/[slug]
5. External links: USE the verified external links database and liveSources URLs provided above. Pick the most relevant links for this topic. Add rel="nofollow" where specified. Use the suggested anchor text (vary it naturally). Do NOT invent external URLs — ONLY use URLs from the databases provided above.
6. Use natural keyword placement — target keyword in first paragraph, 2-3 H2s, and conclusion
7. Write in a friendly, helpful, authoritative voice — not corporate
8. Include specific details: prices, distances, shuttle times, tips
9. Use "Triply" or "TriplyPro" when referencing our service with a link to https://www.${DOMAIN}

**Booking CTAs (CRITICAL for conversions — must be CONTEXTUAL, not generic):**
10. EARLY CTA: Within the first 500 words, include a booking CTA that references something specific from the surrounding content. If the section discusses Terminal 4 options, say "Compare Terminal 4 parking rates." If it discusses budget options, say "Find deals starting under $10/day." The CTA must feel like a natural extension of the paragraph, not a generic insert. Link to https://www.${DOMAIN}/search?airport=${item.airportCode}. Do NOT use generic phrases like "Compare rates on Triply" — always tie the CTA to a specific detail mentioned nearby (a terminal, a price range, a parking type, the airport name).
11. CLOSING CTA: In the final section, include a CTA that ties back to the article's main promise. If the article is about saving money, close with "Start comparing rates to find your best deal." If it's about convenience, close with "Book your spot now and skip the stress on travel day." Reference the specific airport (${item.airportCode}). Link to https://www.${DOMAIN}/search?airport=${item.airportCode}.

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
16. OPENING ANSWER: The very first paragraph must be a concise, direct answer to the main query implied by the title. It should be extractable on its own — if someone only read this one paragraph, they'd get the core answer. AI search engines pull this as the primary citation.
17. KEY TAKEAWAYS: For standard, data-heavy, and comparison styles, immediately after the opening answer include a "Key Takeaways" section using a <ul> with 4-6 bullet points summarizing the most important facts. Bold the lead phrase of each bullet with <strong>. Skip this for narrative style (weave facts into prose instead) and listicle style (the numbered format serves this purpose).
18. USE LISTS NATURALLY: Include <ul> or <ol> lists in most sections where they fit — options, steps, tips, comparisons, pros/cons. Don't force a list into a section that reads better as narrative, but when you're presenting multiple items, always use a list rather than burying them in paragraph form.
19. ANSWER-FIRST SECTIONS: Begin each H2 section with a concise 1-2 sentence direct answer before elaborating. AI systems extract the first clear statement after a heading.
20. QUESTION HEADINGS: For standard and data-heavy styles, frame H2s as questions where natural (e.g., "How Much Does JFK Parking Cost?" not "JFK Parking Costs"). For listicle style, keep numbered headings as statements. For narrative style, prefer statement headings. This rule is OVERRIDDEN by the style instructions above when they conflict.
21. DEFINITION PATTERN: When genuinely introducing a new concept the reader may not know, use the "What is X? X is..." pattern as an H3. Don't overuse this — it's for terms that actually need defining (e.g., "off-site parking", "cell phone lot"), not for obvious concepts.
22. COMPARISONS: Include at least one comparison section using a structured list (e.g., "<h3>On-Site vs Off-Site Parking</h3>" with a <ul> comparing key differences side by side).
23. SOURCE ATTRIBUTION: When citing facts you're confident about, attribute them to real sources (e.g., "the Port Authority of NY & NJ", "JFK's official parking page", "TSA guidelines"). NEVER fabricate a source or attribution — if you're not sure who published a fact, use softer language like "travelers typically find" or "based on current rates" instead.
24. E-E-A-T SIGNALS: Use phrases like "based on current rates", "travelers frequently report", "we compared options across providers" to signal expertise and first-hand experience.
25. BOLD KEY TERMS: Use <strong> to highlight key terms, names, and important phrases throughout the article. This helps AI systems identify the most important concepts for extraction.
26. ENTITY COVERAGE: Mention related entities thoroughly — terminal names (Terminal 1, Terminal 4, Terminal 8), airline hubs (JetBlue T5, Delta T4), nearby roads (Van Wyck Expressway, Belt Parkway), shuttle services, and neighborhood names (Jamaica, Howard Beach). Entity density helps NLP systems gauge content depth.
27. FRESHNESS SIGNALS: For things that genuinely change (rates, policies, construction updates), include timeframe references like "as of 2026" or "current rates". Don't add year references to evergreen facts that don't change — it just dates the content unnecessarily.
28. PARAGRAPH LENGTH: Keep paragraphs to 3-5 sentences (80-120 words). Long enough to develop a point, short enough for AI to parse and extract. Never exceed 5 sentences in a single paragraph.
29. NO FILLER: Every sentence must contain a fact, a tip, or a specific actionable detail. Remove any sentence that exists just to fill space or transition generically.
30. COMPARISON TABLES: For pricing data and side-by-side comparisons, use HTML tables (<table>, <thead>, <tbody>, <tr>, <th>, <td>). Tables are especially valuable in data-heavy and comparison style articles. Include at least one table when comparing parking options, rates, or features across providers. CRITICAL: Every row in a parking comparison table MUST use an ACTUAL named facility from the verified data above (e.g., "PARK AC", "ARB Parking", "Bolt Parking"). NEVER use generic categories like "Budget (Jamaica)" or "Premium (Near terminals)" — readers need real lot names they can search for and book.
31. VERIFICATION DATES: When citing promo codes, specific rates, or time-sensitive facts, add "(verified [Month Year])" inline — e.g., "The early bird rate is $18/day (verified February 2026)." This builds trust and signals freshness.
32. PAA TARGETS: Include 2-3 "People Also Ask" style questions as H2 or H3 headings, targeting common related queries that searchers ask about this topic. For example, if writing about JFK parking deals, include headings like "Is There Free Parking at JFK?" or "How Early Should I Book JFK Parking?"
Respond with ONLY valid JSON in this exact format:
{
  "title": "Display title for the article (50-65 chars, keyword-rich, compelling)",
  "html": "<h2>First Section</h2><p>Content...</p>...",
  "excerpt": "A brief 1-2 sentence summary for SEO (max 300 chars)",
  "metaTitle": "SEO title (max 60 chars, shorter variant of title)",
  "metaDescription": "SEO description (max 160 chars)",
  "earlyCta": "The exact text of your early CTA (e.g., 'Compare Terminal 4 parking rates on Triply')",
  "closingCta": "The exact text of your closing CTA (e.g., 'Reserve your JFK parking spot and save up to 60%')",
  "faqItems": [
    {"question": "Question?", "answer": "Answer text"},
    ...
  ],
  "suggestedCategory": "Airport Parking"
}`
}
