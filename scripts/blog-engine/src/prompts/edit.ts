import { DOMAIN, BLOG_BASE_URL } from '../config.js'

type ArticleStyle = 'standard' | 'narrative' | 'listicle' | 'data-heavy' | 'comparison'

function getStyleEditPreamble(style: ArticleStyle): string {
  switch (style) {
    case 'narrative':
      return `This article uses the **narrative** style. Do NOT restructure it to match a standard format.
- Do NOT add a "Key Takeaways" list if one is missing — narrative style intentionally omits it.
- Do NOT convert prose sections into bulleted lists unless listing genuinely distinct items.
- Do NOT convert statement headings into question-format headings.
- Preserve the traveler-scenario opening.`

    case 'listicle':
      return `This article uses the **listicle** style. Do NOT restructure it to match a standard format.
- Do NOT convert numbered headings ("1. Topic", "2. Topic") into question-format headings.
- Preserve the numbered H2 structure throughout.
- Ensure each numbered section has supporting bullet points or details.`

    case 'data-heavy':
      return `This article uses the **data-heavy** style. Do NOT restructure it to match a standard format.
- Preserve the pricing/data-first opening structure.
- Ensure specific numbers and rates are present throughout.
- Keep comparison lists and pricing breakdowns intact.`

    case 'comparison':
      return `This article uses the **comparison** style. Do NOT restructure it to match a standard format.
- Preserve the "choosing between A and B" framing.
- Keep "[Option A] vs [Option B]" heading formats.
- Ensure every section has comparison elements (pros/cons, side-by-side lists).`

    case 'standard':
    default:
      return ''
  }
}

export function buildEditPrompt(html: string, keyword: string, articleType: string, articleStyle?: ArticleStyle): string {
  const stylePreamble = getStyleEditPreamble(articleStyle || 'standard')

  return `You are a senior editor reviewing an airport parking blog article for ${DOMAIN}.

Review and improve this article. The target keyword is "${keyword}" and the article type is "${articleType}".
${stylePreamble ? `\n${stylePreamble}\n` : ''}
<article>
${html}
</article>

**Check and fix:**
1. Factual accuracy — remove any made-up statistics or prices. Use phrases like "typically ranges from" instead of specific numbers unless commonly known
2. Keyword usage — target keyword should appear naturally in the first paragraph, at least 2 H2s, and the conclusion. Don't over-optimize
3. Internal links — verify all links use ${BLOG_BASE_URL}/[slug] format. Remove any broken-looking links
4. HTML validity — only these tags allowed: h2, h3, p, ul, ol, li, a, strong, em, blockquote. Remove anything else
5. Readability (Flesch-Kincaid grade 6-9 target) — break up long paragraphs (max 3-5 sentences). CRITICAL: also check SENTENCE LENGTH — average should be 15-20 words, never exceed 30 words. Split compound sentences into two. Prefer simple words ("use" not "utilize", "help" not "facilitate", "near" not "in proximity to"). Use active voice ("The shuttle picks you up" not "You will be picked up"). If the writing feels dense or academic, simplify aggressively.
6. BOOKING CTAs — this is about CONVERSION, not just brand mention. Check TWO things:
   a) EARLY CTA: Within the first 500 words, there MUST be a contextual call-to-action with a link to https://www.${DOMAIN}/search or similar. The CTA MUST reference something specific from the surrounding content — a terminal name, a price range, a parking type, or the airport name. If a CTA is generic ("Compare rates on Triply" with no context), rewrite it to reference the nearest specific detail (e.g., "Compare Terminal 4 parking rates" or "Find deals starting under $10/day").
   b) CLOSING CTA: In the final section, there MUST be another booking CTA with a link that ties back to the article's main promise. If the article is about saving money, the CTA should reference savings. If it's about convenience, reference ease of booking.
   If either is missing, ADD it naturally. If either is generic, REWRITE it to reference specific content nearby.
7. Remove any AI-sounding phrases like "In conclusion", "It's worth noting", "Whether you're a...", "It's important to note", "invaluable", "game-changer", "Whether you're a seasoned traveler or..."

**AI Search Optimization (enforce all of these — fix any that are missing):**
8. OPENING ANSWER — the very first paragraph must be a concise, direct answer to the main query. If it's a fluffy intro instead, rewrite it so someone reading only that paragraph gets the core answer. This is the #1 thing AI search engines extract.
9. KEY TAKEAWAYS — there MUST be a bulleted <ul> list near the top (after the opening answer) with 4-6 key facts. Each bullet should have the lead phrase in <strong>. If missing, add one.
10. LISTS WHERE NATURAL — most H2 sections should contain a <ul> or <ol> where it fits (options, steps, tips, comparisons). If a section is listing multiple items in paragraph form, convert to a list. But don't force lists into sections that read better as narrative.
11. ANSWER-FIRST SECTIONS — each H2 section must open with a concise 1-2 sentence direct answer (30-50 words) before elaborating. If a section buries the answer, restructure it.
12. QUESTION HEADINGS — where natural, H2s should be phrased as questions. Convert bland headings to question format where it improves clarity, but don't force it on every heading.
13. SOURCE ATTRIBUTION — facts should be attributed to real sources where possible. NEVER fabricate an attribution. If a claim has no clear source, soften the language to "travelers typically find" or "based on current rates" rather than inventing a source.
14. BOLD KEY TERMS — important terms, names, and key phrases should use <strong>. If key terms are plain text, bold them. Don't over-bold — 2-4 bolded terms per section is ideal.
15. PARAGRAPH & SENTENCE LENGTH — paragraphs should be 3-5 sentences (80-120 words). Split any paragraph longer than 5 sentences. ALSO check individual sentences: if any sentence exceeds 25 words, split it. Rewrite compound sentences (those with semicolons, multiple commas, or "which/that" chains) as two shorter sentences. Target an 8th-grade reading level.
16. NO FILLER — remove any sentence that doesn't contain a fact, tip, or specific useful detail. Cut generic transitions like "Let's dive in", "Read on to learn", "In this guide we'll cover".
17. E-E-A-T LANGUAGE — ensure the article uses credibility phrases like "based on current rates", "according to airport data", "travelers report", "as of 2026". Remove any generic claims without grounding.
18. FRESHNESS — for rates, policies, and construction updates, ensure timeframe references ("as of 2026", "current rates"). Don't add year references to evergreen facts. Remove any outdated year references (2024, 2023, etc.).

Respond with ONLY valid JSON in this exact format:
{
  "html": "<h2>Edited first section</h2><p>Edited content...</p>...",
  "changes": ["List of changes made"],
  "qualityScore": 85
}`
}
