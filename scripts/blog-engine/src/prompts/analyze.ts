import type { ScrapedArticle } from '../scraper.js'

export function buildAnalyzePrompt(
  keyword: string,
  competitors: ScrapedArticle[]
): string {
  const competitorSummaries = competitors
    .map(
      (c, i) => {
        const headingList = c.headings.map(h => `${'  '.repeat(h.level - 2)}${h.level === 2 ? 'H2' : h.level === 3 ? 'H3' : 'H4'}: ${h.text}`).join('\n')
        const schemaLine = c.schemaTypes.length > 0 ? `\nSchema types: ${c.schemaTypes.join(', ')}` : ''
        const outboundLine = c.outboundLinks.length > 0 ? `\nOutbound links: ${c.outboundLinks.slice(0, 10).map(l => `"${l.anchor}" → ${l.href}`).join(', ')}` : ''
        const ctaLine = c.ctaPatterns.length > 0 ? `\nCTA patterns: ${c.ctaPatterns.join(', ')}` : ''
        return `### Competitor ${i + 1}: ${c.title}\nURL: ${c.url}\nStats: ${c.wordCount} words, ${c.h2Count} H2s, ${c.listCount} lists, ${c.tableCount} tables, ${c.linkCount} links, ${c.faqCount} FAQ-like headings${schemaLine}${ctaLine}\nHeading hierarchy:\n${headingList}${outboundLine}\nContent excerpt: ${c.content.slice(0, 4000)}`
      }
    )
    .join('\n\n')

  return `You are an SEO content analyst for an airport parking comparison website (triplypro.com).

Analyze these competitor articles for the keyword "${keyword}" and provide a structured analysis.

${competitorSummaries || 'No competitor articles available. Provide analysis based on your knowledge of the keyword.'}

Respond with ONLY valid JSON in this exact format:
{
  "commonTopics": ["topic1", "topic2", ...],
  "gaps": ["gap1", "gap2", ...],
  "topicGaps": ["entire topic X not covered by any competitor"],
  "depthGaps": ["topic Y covered shallowly — competitors list options but none give pricing"],
  "dataGaps": ["missing specific data point: shuttle frequency, daily rates, distance to terminal"],
  "entityGaps": ["missing named entities: Terminal 4, JetBlue, Van Wyck Expressway"],
  "entityFrequency": [{"entity": "Terminal 4", "mentions": 12}, {"entity": "AirTrain", "mentions": 8}],
  "structuralPatterns": ["3/5 use pricing tables", "4/5 have FAQ sections"],
  "contentFormats": ["pricing-table", "step-by-step", "pros-cons", "comparison-chart"],
  "recommendedH2s": ["heading1", "heading2", ...],
  "faqQuestions": ["question1?", "question2?", ...],
  "estimatedWordCount": 1500,
  "suggestedTags": ["tag1", "tag2", ...],
  "competitorBenchmarks": {
    "avgWordCount": 1800,
    "avgH2Count": 8,
    "avgListCount": 12,
    "avgTableCount": 1,
    "avgLinkCount": 15
  }
}

Requirements:
- commonTopics: Topics covered by most competitors
- gaps: High-level summary of content gaps (kept for backward compatibility)
- topicGaps: Entire topics/sections that NO competitor covers — these are our biggest differentiation opportunities
- depthGaps: Topics that competitors mention but cover shallowly — we should go deeper with specific data
- dataGaps: Specific data points missing across competitors (rates, times, distances, schedules)
- entityGaps: Named entities (terminals, airlines, roads, lots) that competitors miss — entity density helps NLP
- entityFrequency: Top 10 entities mentioned most across all competitors with mention counts — helps writer prioritize coverage
- structuralPatterns: What content formats competitors use — "3/5 use pricing tables", "4/5 have FAQ sections", "2/5 include step-by-step guides"
- contentFormats: Detected content format types across competitors (pricing-table, comparison-chart, step-by-step, FAQ, pros-cons, checklist)
- recommendedH2s: 5-8 recommended H2 headings that cover the topic comprehensively. IMPORTANT: phrase headings as questions where natural (e.g., "How Much Does JFK Parking Cost?" instead of "JFK Parking Costs") — question-format headings perform better in AI search (Google AI Overviews, Perplexity, ChatGPT)
- faqQuestions: 6-8 frequently asked questions with high search intent. Focus on questions that AI search engines commonly pull answers for — "how much", "where is", "how to", "what is the best", "is it safe" patterns
- suggestedTags: 3-5 relevant tags for categorization
- estimatedWordCount: Recommended word count based on competitor length
- competitorBenchmarks: Average structural metrics across competitors (avgWordCount, avgH2Count, avgListCount, avgTableCount, avgLinkCount). Calculate from the competitor stats provided above. These will be used to set concrete targets for the writer.
- Focus on identifying entities (terminal names, airline names, road names, neighborhoods, shuttle services) that competitors mention — entity coverage helps NLP systems understand content depth`
}
