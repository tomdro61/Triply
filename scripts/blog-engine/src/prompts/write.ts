import { DOMAIN, BLOG_BASE_URL } from '../config.js'
import type { QueueItem } from '../queue.js'
import type { AirportData } from '../airport-data.js'

interface AnalysisResult {
  commonTopics: string[]
  gaps: string[]
  recommendedH2s: string[]
  faqQuestions: string[]
  estimatedWordCount: number
  suggestedTags: string[]
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

function formatAirportData(data: AirportData): string {
  const terminalList = data.terminals
    .map((t) => `${t.name} (${t.airlines.join(', ')})`)
    .join('; ')

  return `**Verified Airport Facts (USE THESE — do not invent facts not listed here):**
- Full name: ${data.fullName}
- Terminals: ${terminalList}
- Nearby roads: ${data.roads.join(', ')}
- Transit: ${data.transit.join(', ')}
- Neighborhoods: ${data.neighborhoods.join(', ')}
- Authority: ${data.authority}
- Official parking rates: ${data.parkingRates}
- Shuttle info: ${data.shuttleInfo}
- Distance: ${data.distanceFromCity}

When citing specific numbers (rates, distances, shuttle frequency), use ONLY the data above. For claims you're unsure about, use hedging language ("typically", "around", "based on current rates").`
}

export function buildWritePrompt(
  item: QueueItem,
  analysis: AnalysisResult,
  airportData?: AirportData
): string {
  const outlineSection = item.outline?.length
    ? `\n\nFollow this outline:\n${item.outline.map((o) => `${o.order}. ${o.heading}${o.summary ? ` — ${o.summary}` : ''}${o.linksTo ? ` [Link to: ${BLOG_BASE_URL}/${o.linksTo}]` : ''}`).join('\n')}`
    : `\n\nUse these recommended headings:\n${analysis.recommendedH2s.map((h, i) => `${i + 1}. ${h}`).join('\n')}`

  return `You are a professional travel and airport parking content writer for ${DOMAIN}.

Write an SEO-optimized blog article with the following parameters:

**Title:** ${item.suggestedTitle}
**Target keyword:** ${item.keyword}
**Airport:** ${item.airportCode}

${getArticleTypeInstructions(item)}

${getStyleInstructions(item.articleStyle || 'standard', item)}
${outlineSection}

${airportData ? formatAirportData(airportData) + '\n\n' : ''}**Topics to cover (from competitor analysis):** ${analysis.commonTopics.join(', ')}
**Content gaps to fill (unique angles):** ${analysis.gaps.join(', ')}

**Writing rules:**
1. Output ONLY clean HTML using these tags: h2, h3, p, ul, ol, li, a, strong, em, blockquote
2. Do NOT use: h1, div, span, table, img, inline styles, classes, or IDs
3. Do NOT include the article title as an h1 — it's handled separately
4. All internal links use format: ${BLOG_BASE_URL}/[slug]
5. External links to authoritative sources are encouraged (airport websites, TSA, etc.)
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

**AI Search & Featured Snippet Optimization (CRITICAL — follow these closely):**
16. OPENING ANSWER: The very first paragraph must be a concise, direct answer to the main query implied by the title. It should be extractable on its own — if someone only read this one paragraph, they'd get the core answer. AI search engines pull this as the primary citation.
17. KEY TAKEAWAYS: Immediately after the opening answer, include a "Key Takeaways" section using a <ul> with 4-6 bullet points summarizing the most important facts. Bold the lead phrase of each bullet with <strong>. AI search engines cite these heavily.
18. USE LISTS NATURALLY: Include <ul> or <ol> lists in most sections where they fit — options, steps, tips, comparisons, pros/cons. Don't force a list into a section that reads better as narrative, but when you're presenting multiple items, always use a list rather than burying them in paragraph form.
19. ANSWER-FIRST SECTIONS: Begin each H2 section with a concise 1-2 sentence direct answer before elaborating. AI systems extract the first clear statement after a heading.
20. QUESTION HEADINGS: Frame H2s as questions where natural (e.g., "How Much Does JFK Parking Cost?" not "JFK Parking Costs"). This matches search queries and AI extraction patterns.
21. DEFINITION PATTERN: When genuinely introducing a new concept the reader may not know, use the "What is X? X is..." pattern as an H3. Don't overuse this — it's for terms that actually need defining (e.g., "off-site parking", "cell phone lot"), not for obvious concepts.
22. COMPARISONS: Include at least one comparison section using a structured list (e.g., "<h3>On-Site vs Off-Site Parking</h3>" with a <ul> comparing key differences side by side).
23. SOURCE ATTRIBUTION: When citing facts you're confident about, attribute them to real sources (e.g., "the Port Authority of NY & NJ", "JFK's official parking page", "TSA guidelines"). NEVER fabricate a source or attribution — if you're not sure who published a fact, use softer language like "travelers typically find" or "based on current rates" instead.
24. E-E-A-T SIGNALS: Use phrases like "based on current rates", "travelers frequently report", "we compared options across providers" to signal expertise and first-hand experience.
25. BOLD KEY TERMS: Use <strong> to highlight key terms, names, and important phrases throughout the article. This helps AI systems identify the most important concepts for extraction.
26. ENTITY COVERAGE: Mention related entities thoroughly — terminal names (Terminal 1, Terminal 4, Terminal 8), airline hubs (JetBlue T5, Delta T4), nearby roads (Van Wyck Expressway, Belt Parkway), shuttle services, and neighborhood names (Jamaica, Howard Beach). Entity density helps NLP systems gauge content depth.
27. FRESHNESS SIGNALS: For things that genuinely change (rates, policies, construction updates), include timeframe references like "as of 2026" or "current rates". Don't add year references to evergreen facts that don't change — it just dates the content unnecessarily.
28. PARAGRAPH LENGTH: Keep paragraphs to 3-5 sentences (80-120 words). Long enough to develop a point, short enough for AI to parse and extract. Never exceed 5 sentences in a single paragraph.
29. NO FILLER: Every sentence must contain a fact, a tip, or a specific actionable detail. Remove any sentence that exists just to fill space or transition generically.

Respond with ONLY valid JSON in this exact format:
{
  "html": "<h2>First Section</h2><p>Content...</p>...",
  "excerpt": "A brief 1-2 sentence summary for SEO (max 300 chars)",
  "metaTitle": "SEO title (max 60 chars)",
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
