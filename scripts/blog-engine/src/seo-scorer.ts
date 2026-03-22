/**
 * SEO Content Scorer
 *
 * Programmatic scoring rubric modeled after Rank Math, Yoast SEO, and Surfer SEO,
 * with additional checks for AI search optimization (Google AI Overviews, Perplexity, ChatGPT).
 *
 * Five categories, 100 total points:
 *   1. Keyword Optimization (21) — Rank Math "Basic SEO" + Yoast keyphrase checks
 *   2. Content Structure (32)    — Rank Math "Content Readability" + Surfer structure + CTA + anchor quality
 *   3. AI Search Optimization (21) — GEO best practices for AI citation
 *   4. Content Quality (26)      — E-E-A-T, readability, unique value, engagement signals
 *
 *   Total: 100 points (maxPoints computed dynamically from checks)
 *
 * Updated with 8 additions from team SEO audit:
 *   - CTA Placement, Readability Score, Anchor Text Quality, Unique Value Indicator,
 *   - Topical Authority Links, Reweighted Meta Description, Adjusted List Target,
 *   - Freshness Depth increase
 */

import { parse, HTMLElement, TextNode } from 'node-html-parser'
import { loadAirportData, getEntityPatterns } from './airport-data.js'
import { getApprovedDomains } from './external-links.js'

// ── Types ────────────────────────────────────────────────────────────────────

interface ScorerInput {
  html: string
  keyword: string
  slug: string
  metaTitle: string
  metaDescription: string
  excerpt: string
  faqItems: { question: string; answer: string }[]
  articleType: 'hub' | 'sub-pillar' | 'spoke'
  articleStyle?: 'standard' | 'narrative' | 'listicle' | 'data-heavy' | 'comparison'
  targetWords: number
  hasImage: boolean
  imageAlt: string | null
  airportCode?: string       // For topical authority link validation
  parentSlug?: string | null // For topical authority link validation
  hubSlug?: string | null    // For topical authority link validation
  earlyCta?: string          // For CTA relevance check
  closingCta?: string        // For CTA relevance check
}

interface Check {
  name: string
  passed: boolean
  points: number
  maxPoints: number
  detail: string
}

interface CategoryScore {
  name: string
  points: number
  maxPoints: number
  checks: Check[]
}

export interface SeoScore {
  total: number
  maxTotal: number
  grade: string // A+ (95+), A (90+), B+ (85+), B (80+), C (70+), D (60+), F (<60)
  categories: CategoryScore[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTextContent(root: HTMLElement): string {
  return root.textContent || ''
}

function countKeywordOccurrences(text: string, keyword: string): number {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(escaped, 'gi')
  return (text.match(regex) || []).length
}

function getWordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length
}

function getAllElements(root: HTMLElement, tag: string): HTMLElement[] {
  return root.querySelectorAll(tag) as unknown as HTMLElement[]
}

function getFirstParagraph(root: HTMLElement): string {
  const firstP = root.querySelector('p')
  return firstP ? getTextContent(firstP) : ''
}

function getSections(root: HTMLElement): { heading: string; content: HTMLElement[] }[] {
  const sections: { heading: string; content: HTMLElement[] }[] = []
  let currentHeading = ''
  let currentContent: HTMLElement[] = []

  for (const child of root.childNodes) {
    if (child instanceof HTMLElement && /^h[23]$/i.test(child.tagName)) {
      if (currentHeading || currentContent.length > 0) {
        sections.push({ heading: currentHeading, content: currentContent })
      }
      currentHeading = getTextContent(child)
      currentContent = []
    } else if (child instanceof HTMLElement) {
      currentContent.push(child)
    }
  }

  if (currentHeading || currentContent.length > 0) {
    sections.push({ heading: currentHeading, content: currentContent })
  }

  return sections
}

function gradeFromScore(score: number): string {
  if (score >= 95) return 'A+'
  if (score >= 90) return 'A'
  if (score >= 85) return 'B+'
  if (score >= 80) return 'B'
  if (score >= 70) return 'C'
  if (score >= 60) return 'D'
  return 'F'
}

// ── Sentence counting for readability ───────────────────────────────────────

function countSentences(text: string): number {
  // Split on sentence-ending punctuation followed by space or end of string
  const sentences = text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0)
  return Math.max(sentences.length, 1)
}

function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, '')
  if (word.length <= 3) return 1
  // Remove silent e
  word = word.replace(/(?:[^leas]es|ed|[^aeiou]e)$/, '')
  word = word.replace(/^y/, '')
  const matches = word.match(/[aeiouy]{1,2}/g)
  return matches ? Math.max(matches.length, 1) : 1
}

function fleschKincaidGrade(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  const wordCount = words.length
  if (wordCount === 0) return 0
  const sentenceCount = countSentences(text)
  const syllableCount = words.reduce((sum, w) => sum + countSyllables(w), 0)
  // FK Grade Level = 0.39 * (words/sentences) + 11.8 * (syllables/words) - 15.59
  return 0.39 * (wordCount / sentenceCount) + 11.8 * (syllableCount / wordCount) - 15.59
}

// ── AI phrase detection ─────────────────────────────────────────────────────

const AI_PHRASES = [
  'in conclusion',
  "it's worth noting",
  "it's important to note",
  'whether you\'re a',
  'whether you are a',
  'let\'s dive in',
  'without further ado',
  'in today\'s world',
  'in this comprehensive',
  'read on to learn',
  'read on to discover',
  'invaluable',
  'game-changer',
  'game changer',
  'look no further',
  'navigating the world of',
  'ever-evolving',
  'it goes without saying',
  'needless to say',
  'at the end of the day',
  'when it comes to',
]

const EEAT_PHRASES = [
  'according to',
  'based on current',
  'based on published',
  'travelers report',
  'travelers typically',
  'travelers frequently',
  'we compared',
  'we analyzed',
  'based on our',
  'the port authority',
  'the tsa',
  'airport authority',
  'official',
  'published rates',
  'as of 20',
]

// ── Generic anchor text blocklist ───────────────────────────────────────────

const GENERIC_ANCHORS = [
  'click here',
  'read more',
  'learn more',
  'this article',
  'this page',
  'here',
  'link',
  'more info',
  'more information',
  'check it out',
]

// ── CTA patterns ────────────────────────────────────────────────────────────

const CTA_PATTERNS = [
  /book\s*(now|your|a\s+spot|parking|today)/i,
  /reserve\s*(now|your|a\s+spot|parking|today)/i,
  /compare\s*prices/i,
  /check\s*availability/i,
  /find\s*parking/i,
  /get\s*(a\s+)?quote/i,
  /save\s*(on|up\s+to|\$)/i,
  /search\s*(for\s+)?parking/i,
  /view\s*(all\s+)?lots/i,
  /see\s*(current\s+)?rates/i,
]

// ── Scoring Functions ───────────────────────────────────────────────────────

function scoreKeywordOptimization(input: ScorerInput, root: HTMLElement, fullText: string): CategoryScore {
  const checks: Check[] = []
  const kw = input.keyword.toLowerCase()

  // 1. Keyword in first paragraph (4 pts) — Rank Math + Yoast
  const firstPara = getFirstParagraph(root).toLowerCase()
  const kwInFirst = firstPara.includes(kw)
  checks.push({
    name: 'Keyword in first paragraph',
    passed: kwInFirst,
    points: kwInFirst ? 4 : 0,
    maxPoints: 4,
    detail: kwInFirst ? 'Focus keyword found in opening paragraph' : `Keyword "${input.keyword}" not found in first paragraph`,
  })

  // 2. Keyword in H2 headings (3 pts) — Rank Math "Focus Keyword in Subheading"
  const h2s = getAllElements(root, 'h2')
  const h2Texts = h2s.map((h) => getTextContent(h).toLowerCase())
  const kwWords = kw.split(/\s+/).filter((w) => w.length > 3)
  const h2sWithKw = h2Texts.filter((h) => kwWords.some((w) => h.includes(w)))
  const h2KwCount = h2sWithKw.length
  const h2Pass = h2KwCount >= 2
  checks.push({
    name: 'Keyword in H2 headings',
    passed: h2Pass,
    points: h2KwCount === 0 ? 0 : h2KwCount === 1 ? 2 : 3,
    maxPoints: 3,
    detail: `${h2KwCount} of ${h2s.length} H2s contain keyword terms (need 2+)`,
  })

  // 3. Keyword density 0.5-2.5% (4 pts) — Rank Math 1-1.5%, Yoast 0.5-3%
  const wordCount = getWordCount(fullText)
  const kwCount = countKeywordOccurrences(fullText.toLowerCase(), kw)
  const kwWordCount = kw.split(/\s+/).length
  const density = wordCount > 0 ? (kwCount * kwWordCount * 100) / wordCount : 0
  const densityPass = density >= 0.5 && density <= 2.5
  checks.push({
    name: 'Keyword density',
    passed: densityPass,
    points: densityPass ? 4 : density > 0 ? 2 : 0,
    maxPoints: 4,
    detail: `${density.toFixed(1)}% (target: 0.5-2.5%) — keyword appears ${kwCount} times in ${wordCount} words`,
  })

  // 4. Keyword in meta title (5 pts) — Rank Math + Yoast (highest keyword check — title matters most)
  const kwInTitle = input.metaTitle.toLowerCase().includes(kw) ||
    kwWords.filter((w) => w.length > 3).every((w) => input.metaTitle.toLowerCase().includes(w))
  checks.push({
    name: 'Keyword in meta title',
    passed: kwInTitle,
    points: kwInTitle ? 5 : 0,
    maxPoints: 5,
    detail: kwInTitle ? 'Focus keyword found in meta title' : 'Focus keyword missing from meta title',
  })

  // 5. Keyword in meta description (2 pts) — Reweighted: Google confirmed meta desc doesn't directly affect rankings
  const kwInDesc = input.metaDescription.toLowerCase().includes(kw) ||
    kwWords.filter((w) => w.length > 3).every((w) => input.metaDescription.toLowerCase().includes(w))
  checks.push({
    name: 'Keyword in meta description',
    passed: kwInDesc,
    points: kwInDesc ? 2 : 0,
    maxPoints: 2,
    detail: kwInDesc ? 'Focus keyword found in meta description (CTR signal)' : 'Focus keyword missing from meta description',
  })

  // 6. Keyword in slug (3 pts) — Rank Math + Yoast
  const slugWords = input.slug.toLowerCase().split('-')
  const kwInSlug = kwWords.every((w) => slugWords.some((s) => s.includes(w)))
  checks.push({
    name: 'Keyword in URL slug',
    passed: kwInSlug,
    points: kwInSlug ? 3 : 0,
    maxPoints: 3,
    detail: kwInSlug ? 'Focus keyword found in slug' : 'Focus keyword missing from slug',
  })

  const points = checks.reduce((sum, c) => sum + c.points, 0)
  const maxPoints = checks.reduce((sum, c) => sum + c.maxPoints, 0)
  return { name: 'Keyword Optimization', points, maxPoints, checks }
}

function scoreContentStructure(input: ScorerInput, root: HTMLElement, fullText: string): CategoryScore {
  const checks: Check[] = []
  const wordCount = getWordCount(fullText)

  // 1. Content meets target word count (4 pts) — Rank Math + Surfer
  const targetMin = Math.round(input.targetWords * 0.8)
  const targetMax = Math.round(input.targetWords * 1.5)
  const lengthPass = wordCount >= targetMin
  checks.push({
    name: 'Content length',
    passed: lengthPass,
    points: wordCount >= targetMin ? 4 : wordCount >= targetMin * 0.7 ? 2 : 0,
    maxPoints: 4,
    detail: `${wordCount} words (target: ${targetMin}-${targetMax})`,
  })

  // 2. Heading hierarchy — H2 then H3, no skips (3 pts) — Yoast
  const headings = root.querySelectorAll('h2, h3, h4') as unknown as HTMLElement[]
  let hierarchyOk = true
  let hasH1 = root.querySelectorAll('h1').length > 0
  if (hasH1) hierarchyOk = false
  for (let i = 1; i < headings.length; i++) {
    const prev = parseInt(headings[i - 1].tagName.slice(1))
    const curr = parseInt(headings[i].tagName.slice(1))
    if (curr > prev + 1) {
      hierarchyOk = false
      break
    }
  }
  checks.push({
    name: 'Heading hierarchy',
    passed: hierarchyOk,
    points: hierarchyOk ? 3 : 0,
    maxPoints: 3,
    detail: hierarchyOk ? 'Proper H2→H3 hierarchy, no H1 in body' : 'Heading levels skipped or H1 found in body',
  })

  // 3. Paragraphs under 120 words (2 pts) — Rank Math
  const paragraphs = getAllElements(root, 'p')
  const longParas = paragraphs.filter((p) => getWordCount(getTextContent(p)) > 120)
  const paraPass = longParas.length === 0
  checks.push({
    name: 'Paragraph length',
    passed: paraPass,
    points: paraPass ? 2 : longParas.length <= 2 ? 1 : 0,
    maxPoints: 2,
    detail: paraPass ? 'All paragraphs under 120 words' : `${longParas.length} paragraph(s) exceed 120 words`,
  })

  // 4. Internal links present (3 pts) — Rank Math + Yoast
  const links = getAllElements(root, 'a')
  const internalLinks = links.filter((a) => {
    const href = a.getAttribute('href') || ''
    return href.includes('triplypro.com') || href.startsWith('/blog/')
  })
  const intLinkPass = internalLinks.length >= 2
  checks.push({
    name: 'Internal links',
    passed: intLinkPass,
    points: internalLinks.length === 0 ? 0 : internalLinks.length === 1 ? 2 : 3,
    maxPoints: 3,
    detail: `${internalLinks.length} internal link(s) found (need 2+)`,
  })

  // 5. External links present (3 pts) — Rank Math + Yoast
  const externalLinks = links.filter((a) => {
    const href = a.getAttribute('href') || ''
    return href.startsWith('http') && !href.includes('triplypro.com')
  })
  const extLinkPass = externalLinks.length >= 1
  checks.push({
    name: 'External links',
    passed: extLinkPass,
    points: extLinkPass ? 3 : 0,
    maxPoints: 3,
    detail: `${externalLinks.length} external link(s) found (need 1+)`,
  })

  // 6. Featured image with alt text (2 pts) — Rank Math + Yoast
  const imgPass = input.hasImage && !!input.imageAlt
  checks.push({
    name: 'Featured image with alt text',
    passed: imgPass,
    points: input.hasImage ? (input.imageAlt ? 2 : 1) : 0,
    maxPoints: 2,
    detail: imgPass ? `Image uploaded with alt: "${input.imageAlt?.slice(0, 50)}..."` : input.hasImage ? 'Image uploaded but missing alt text' : 'No featured image',
  })

  // 7. Meta title length (2 pts) — Yoast (under 60 chars)
  const titleLen = input.metaTitle.length
  const titlePass = titleLen > 0 && titleLen <= 60
  checks.push({
    name: 'Meta title length',
    passed: titlePass,
    points: titlePass ? 2 : titleLen <= 70 ? 1 : 0,
    maxPoints: 2,
    detail: `${titleLen} characters (target: under 60)`,
  })

  // 8. Meta description length (2 pts) — Yoast (120-160 chars)
  const descLen = input.metaDescription.length
  const descPass = descLen >= 120 && descLen <= 160
  checks.push({
    name: 'Meta description length',
    passed: descPass,
    points: descPass ? 2 : descLen >= 80 && descLen <= 170 ? 1 : 0,
    maxPoints: 2,
    detail: `${descLen} characters (target: 120-160)`,
  })

  // 9. NEW: CTA Placement (4 pts) — Booking calls-to-action for conversion
  const allText = fullText
  const words = allText.split(/\s+/)
  const first500Words = words.slice(0, 500).join(' ')
  const last30Pct = words.slice(Math.floor(words.length * 0.7)).join(' ')
  const ctaInFirst500 = CTA_PATTERNS.some((p) => p.test(first500Words))
  const ctaInClosing = CTA_PATTERNS.some((p) => p.test(last30Pct))
  // Also check links with CTA text
  const ctaLinks = links.filter((a) => {
    const text = getTextContent(a).toLowerCase()
    const href = a.getAttribute('href') || ''
    return CTA_PATTERNS.some((p) => p.test(text)) ||
      href.includes('/search') || href.includes('/checkout') || href.includes('book')
  })
  const ctaPoints = (ctaInFirst500 ? 2 : 0) + (ctaInClosing || ctaLinks.length > 0 ? 2 : 0)
  checks.push({
    name: 'CTA placement',
    passed: ctaPoints >= 4,
    points: ctaPoints,
    maxPoints: 4,
    detail: `${ctaInFirst500 ? 'CTA in first 500 words' : 'No CTA in first 500 words'}; ${ctaInClosing ? 'CTA in closing section' : ctaLinks.length > 0 ? `${ctaLinks.length} CTA link(s) found` : 'No CTA in closing section'}`,
  })

  // 10. NEW: Anchor Text Quality (3 pts) — Descriptive vs generic anchors
  const anchorTexts = links.map((a) => getTextContent(a).toLowerCase().trim()).filter((t) => t.length > 0)
  const genericAnchors = anchorTexts.filter((t) =>
    GENERIC_ANCHORS.some((g) => t === g || t === g + '.')
  )
  const descriptiveRatio = anchorTexts.length > 0
    ? (anchorTexts.length - genericAnchors.length) / anchorTexts.length
    : 1
  const anchorPass = descriptiveRatio >= 0.8
  checks.push({
    name: 'Anchor text quality',
    passed: anchorPass,
    points: anchorTexts.length === 0 ? 1 : descriptiveRatio >= 0.8 ? 3 : descriptiveRatio >= 0.6 ? 2 : 0,
    maxPoints: 3,
    detail: anchorTexts.length === 0
      ? 'No links to evaluate'
      : `${Math.round(descriptiveRatio * 100)}% descriptive anchors (${genericAnchors.length} generic of ${anchorTexts.length} total, target: 80%+)`,
  })

  // 11. NEW: Topical Authority Links (4 pts) — Hub/spoke cluster linking
  let pillarLinkPts = 0
  let pillarDetail = ''

  // Check for link to parent/hub page
  const parentOrHubSlug = input.parentSlug || input.hubSlug
  if (input.articleType === 'hub') {
    // Hubs don't need to link to a parent, but should link to sub-pillars
    const subPillarLinks = internalLinks.filter((a) => {
      const href = a.getAttribute('href') || ''
      return href.includes('/blog/')
    })
    pillarLinkPts = subPillarLinks.length >= 3 ? 4 : subPillarLinks.length >= 2 ? 3 : subPillarLinks.length >= 1 ? 2 : 0
    pillarDetail = `Hub article with ${subPillarLinks.length} blog links to sub-content (target: 3+)`
  } else if (parentOrHubSlug) {
    // Sub-pillars and spokes should link to their parent/hub
    const hasParentLink = internalLinks.some((a) => {
      const href = a.getAttribute('href') || ''
      return href.includes(parentOrHubSlug)
    })
    const hasSiblingLinks = internalLinks.filter((a) => {
      const href = a.getAttribute('href') || ''
      return href.includes('/blog/') && !href.includes(parentOrHubSlug)
    }).length
    pillarLinkPts = (hasParentLink ? 2 : 0) + (hasSiblingLinks >= 2 ? 2 : hasSiblingLinks >= 1 ? 1 : 0)
    pillarDetail = `${hasParentLink ? 'Links to parent/hub' : 'Missing link to parent/hub'}; ${hasSiblingLinks} sibling link(s) (target: 2+)`
  } else {
    // No cluster info available — give partial credit for internal links
    pillarLinkPts = internalLinks.length >= 3 ? 3 : internalLinks.length >= 2 ? 2 : 0
    pillarDetail = `${internalLinks.length} internal links (no cluster info available for validation)`
  }
  checks.push({
    name: 'Topical authority links',
    passed: pillarLinkPts >= 4,
    points: pillarLinkPts,
    maxPoints: 4,
    detail: pillarDetail,
  })

  const points = checks.reduce((sum, c) => sum + c.points, 0)
  const maxPoints = checks.reduce((sum, c) => sum + c.maxPoints, 0)
  return { name: 'Content Structure', points, maxPoints, checks }
}

function scoreAiSearchOptimization(input: ScorerInput, root: HTMLElement, fullText: string): CategoryScore {
  const checks: Check[] = []
  const sections = getSections(root)

  // 1. Opening direct answer — concise first paragraph (3 pts)
  const firstPara = root.querySelector('p')
  const firstParaWords = firstPara ? getWordCount(getTextContent(firstPara)) : 0
  const openingPass = firstParaWords > 0 && firstParaWords <= 80
  checks.push({
    name: 'Opening direct answer',
    passed: openingPass,
    points: openingPass ? 3 : firstParaWords > 0 && firstParaWords <= 120 ? 2 : 0,
    maxPoints: 3,
    detail: `First paragraph: ${firstParaWords} words (target: concise, under 80 words)`,
  })

  // 2. Key Takeaways list near top (3 pts)
  // Structural detection: any <ul>/<ol> appearing in the first 8 top-level elements
  // (after the opening paragraph). Also matches if preceded by a heading/paragraph
  // containing takeaway-like text.
  const children = root.childNodes.filter((n) => n instanceof HTMLElement) as HTMLElement[]
  let hasEarlyList = false
  let foundFirstParagraph = false
  for (let i = 0; i < Math.min(children.length, 8); i++) {
    const tag = children[i].tagName
    if (tag === 'P') foundFirstParagraph = true
    // Any list appearing after the first paragraph counts as a takeaway/summary list
    if (foundFirstParagraph && (tag === 'UL' || tag === 'OL')) {
      hasEarlyList = true
      break
    }
    // Also check for labeled takeaway patterns (heading + list)
    if (/key takeaway|takeaway|at a glance|quick summary|key points|key facts|highlights/i.test(getTextContent(children[i]))) {
      if (i + 1 < children.length && (children[i + 1].tagName === 'UL' || children[i + 1].tagName === 'OL')) {
        hasEarlyList = true
        break
      }
    }
  }
  checks.push({
    name: 'Key Takeaways list',
    passed: hasEarlyList,
    points: hasEarlyList ? 3 : 0,
    maxPoints: 3,
    detail: hasEarlyList ? 'Bulleted summary found near top of article' : 'No summary list found in first 8 elements after opening paragraph',
  })

  // 3. Lists or tables used in sections (4 pts) — tables count as structured data equivalent
  const sectionsWithStructure = sections.filter((s) =>
    s.content.some((el) => el.tagName === 'UL' || el.tagName === 'OL' || el.tagName === 'TABLE' ||
      el.querySelector?.('ul, ol, table'))
  )
  const structureRatio = sections.length > 0 ? sectionsWithStructure.length / sections.length : 0
  const structurePass = structureRatio >= 0.3
  checks.push({
    name: 'Structured data in sections',
    passed: structurePass,
    points: structureRatio >= 0.45 ? 4 : structureRatio >= 0.3 ? 3 : sectionsWithStructure.length > 0 ? 1 : 0,
    maxPoints: 4,
    detail: `${sectionsWithStructure.length} of ${sections.length} sections contain lists or tables (${Math.round(structureRatio * 100)}%, target: 30%+)`,
  })

  // 4. Question-format H2 headings (3 pts)
  const h2s = getAllElements(root, 'h2')
  const questionH2s = h2s.filter((h) => getTextContent(h).trim().endsWith('?') ||
    /^(how|what|where|when|why|which|is|are|do|does|can|should)/i.test(getTextContent(h).trim()))
  const questionPass = questionH2s.length >= 2
  checks.push({
    name: 'Question-format headings',
    passed: questionPass,
    points: questionH2s.length >= 3 ? 3 : questionH2s.length >= 2 ? 3 : questionH2s.length >= 1 ? 1 : 0,
    maxPoints: 3,
    detail: `${questionH2s.length} of ${h2s.length} H2s use question format (need 2+)`,
  })

  // 5. FAQ items present (3 pts)
  const faqCount = input.faqItems.length
  const faqPass = faqCount >= 6
  checks.push({
    name: 'FAQ section',
    passed: faqPass,
    points: faqCount >= 6 ? 3 : faqCount >= 4 ? 2 : faqCount >= 2 ? 1 : 0,
    maxPoints: 3,
    detail: `${faqCount} FAQ items (target: 6+)`,
  })

  // 6. Bold key terms (2 pts)
  const strongTags = getAllElements(root, 'strong')
  const boldCount = strongTags.length
  const boldPass = boldCount >= 8
  checks.push({
    name: 'Bold key terms',
    passed: boldPass,
    points: boldCount >= 8 ? 2 : boldCount >= 4 ? 1 : 0,
    maxPoints: 2,
    detail: `${boldCount} bold terms found (target: 8+ across article)`,
  })

  // 7. Source attribution phrases (3 pts)
  const textLower = fullText.toLowerCase()
  const attrCount = EEAT_PHRASES.filter((p) => textLower.includes(p)).length
  const attrPass = attrCount >= 3
  checks.push({
    name: 'Source attribution',
    passed: attrPass,
    points: attrCount >= 3 ? 3 : attrCount >= 1 ? 1 : 0,
    maxPoints: 3,
    detail: `${attrCount} attribution/credibility phrases found (target: 3+)`,
  })

  const points = checks.reduce((sum, c) => sum + c.points, 0)
  const maxPoints = checks.reduce((sum, c) => sum + c.maxPoints, 0)
  return { name: 'AI Search Optimization', points, maxPoints, checks }
}

function scoreContentQuality(input: ScorerInput, root: HTMLElement, fullText: string): CategoryScore {
  const checks: Check[] = []
  const textLower = fullText.toLowerCase()

  // 1. No AI-sounding phrases (5 pts)
  const aiPhrases = AI_PHRASES.filter((p) => textLower.includes(p))
  const aiPass = aiPhrases.length === 0
  checks.push({
    name: 'No AI-sounding phrases',
    passed: aiPass,
    points: aiPass ? 5 : aiPhrases.length <= 2 ? 3 : 0,
    maxPoints: 5,
    detail: aiPass ? 'No AI cliches detected' : `Found: ${aiPhrases.map((p) => `"${p}"`).join(', ')}`,
  })

  // 2. E-E-A-T credibility signals (3 pts)
  const eeatPhrases = EEAT_PHRASES.filter((p) => textLower.includes(p))
  const eeatPass = eeatPhrases.length >= 4
  checks.push({
    name: 'E-E-A-T signals',
    passed: eeatPass,
    points: eeatPhrases.length >= 4 ? 3 : eeatPhrases.length >= 2 ? 2 : eeatPhrases.length >= 1 ? 1 : 0,
    maxPoints: 3,
    detail: `${eeatPhrases.length} E-E-A-T phrases found (target: 4+)`,
  })

  // 3. Entity coverage — named entities (4 pts) — Surfer NLP terms
  // Use airport-specific data if available, otherwise fall back to hardcoded NYC patterns
  let entityPatterns: RegExp[]
  if (input.airportCode) {
    const airportData = loadAirportData(input.airportCode)
    if (airportData) {
      entityPatterns = getEntityPatterns(airportData)
    } else {
      // Fallback: generic patterns for unknown airports
      entityPatterns = [
        /terminal\s*\d/i,
        /terminal\s*[a-f]/i,
        /(jetblue|delta|american airlines|united|southwest|spirit|frontier)/i,
        /(van wyck|belt parkway|grand central|lefferts|howard beach|jamaica|queens)/i,
        /(airtrain|shuttle|jitney)/i,
        /(port authority|tsa|faa)/i,
      ]
    }
  } else {
    entityPatterns = [
      /terminal\s*\d/i,
      /terminal\s*[a-f]/i,
      /(jetblue|delta|american airlines|united|southwest|spirit|frontier)/i,
      /(van wyck|belt parkway|grand central|lefferts|howard beach|jamaica|queens)/i,
      /(airtrain|shuttle|jitney)/i,
      /(port authority|tsa|faa)/i,
    ]
  }
  const entityCount = entityPatterns.filter((p) => p.test(fullText)).length
  const entityPass = entityCount >= 4
  checks.push({
    name: 'Entity coverage',
    passed: entityPass,
    points: entityCount >= 4 ? 4 : entityCount >= 2 ? 2 : entityCount >= 1 ? 1 : 0,
    maxPoints: 4,
    detail: `${entityCount} of ${entityPatterns.length} entity categories found (target: 4+)`,
  })

  // 4. Freshness signals for rates/policies (2 pts) — Increased: need 3+ references (was 1)
  const freshnessPatterns = [
    /as of 202[4-9]/i, /current rates/i, /current pricing/i, /this year/i,
    /202[5-9] rates/i, /updated/i, /recently/i, /latest/i, /this month/i,
    /winter|spring|summer|fall|holiday season/i,
  ]
  const freshnessCount = freshnessPatterns.filter((p) => p.test(fullText)).length
  const freshnessPass = freshnessCount >= 3
  checks.push({
    name: 'Freshness signals',
    passed: freshnessPass,
    points: freshnessCount >= 3 ? 2 : freshnessCount >= 1 ? 1 : 0,
    maxPoints: 2,
    detail: `${freshnessCount} freshness references found (target: 3+)`,
  })

  // 5. Engaging title — power words (1 pt) — Rank Math
  const title = input.metaTitle.toLowerCase()
  const powerWords = ['complete', 'ultimate', 'best', 'guide', 'top', 'essential', 'proven', 'save', 'free', 'exclusive', 'deals', 'tips', 'secrets', 'easy', 'fast', 'cheap', 'affordable']
  const hasPowerWord = powerWords.some((w) => title.includes(w))
  checks.push({
    name: 'Power words in title',
    passed: hasPowerWord,
    points: hasPowerWord ? 2 : 0,
    maxPoints: 2,
    detail: hasPowerWord ? 'Title contains engaging power word(s)' : 'No power words found in title',
  })

  // 6. Number in title (2 pts) — Rank Math
  const hasNumber = /\d/.test(input.metaTitle)
  checks.push({
    name: 'Number in title',
    passed: hasNumber,
    points: hasNumber ? 2 : 0,
    maxPoints: 2,
    detail: hasNumber ? 'Title contains a number' : 'No number in title (years, counts, etc. improve CTR)',
  })

  // 7. NEW: Readability Score (4 pts) — Flesch-Kincaid grade level
  const fkGrade = fleschKincaidGrade(fullText)
  const readabilityPass = fkGrade >= 6 && fkGrade <= 9
  checks.push({
    name: 'Readability score',
    passed: readabilityPass,
    points: fkGrade >= 6 && fkGrade <= 9 ? 4 : fkGrade >= 5 && fkGrade <= 12 ? 2 : fkGrade > 0 ? 1 : 0,
    maxPoints: 4,
    detail: `Flesch-Kincaid grade ${fkGrade.toFixed(1)} (target: 6-9, current top results average 7-8)`,
  })

  // 8. NEW: Unique Value Indicator (4 pts) — Original data, pricing, local knowledge
  let uniqueValuePts = 0
  const uniqueDetails: string[] = []

  // Pricing data
  if (/\$\d+|per day|starting at|costs? (around|about|approximately)|per night/i.test(fullText)) {
    uniqueValuePts++
    uniqueDetails.push('pricing data')
  }

  // Local knowledge
  if (/minute (walk|drive|ride|shuttle)|located (at|on|near)|blocks? (from|away)/i.test(fullText)) {
    uniqueValuePts++
    uniqueDetails.push('local knowledge')
  }

  // Comparison elements
  if (/<table/i.test(input.html) || /\bvs\.?\b|compared to|comparison/i.test(fullText)) {
    uniqueValuePts++
    uniqueDetails.push('comparison/table')
  }

  // Original data signals
  if (/we (found|tested|compared|analyzed|reviewed)|our research|based on \d+ (bookings?|reviews?|customers?)/i.test(fullText)) {
    uniqueValuePts++
    uniqueDetails.push('original data')
  }

  const uniquePass = uniqueValuePts >= 2
  checks.push({
    name: 'Unique value indicator',
    passed: uniquePass,
    points: uniqueValuePts >= 3 ? 4 : uniqueValuePts >= 2 ? 3 : uniqueValuePts >= 1 ? 1 : 0,
    maxPoints: 4,
    detail: uniqueValuePts === 0
      ? 'No unique value markers found (pricing, local knowledge, comparisons, original data)'
      : `${uniqueValuePts} marker(s): ${uniqueDetails.join(', ')} (target: 2+)`,
  })

  const points = checks.reduce((sum, c) => sum + c.points, 0)
  const maxPoints = checks.reduce((sum, c) => sum + c.maxPoints, 0)
  return { name: 'Content Quality', points, maxPoints, checks }
}

// ── Style Adherence ─────────────────────────────────────────────────────────

function scoreStyleAdherence(input: ScorerInput, root: HTMLElement, fullText: string): CategoryScore {
  const checks: Check[] = []
  const style = input.articleStyle || 'standard'
  const h2s = getAllElements(root, 'h2')
  const h2Texts = h2s.map(h => getTextContent(h).trim())

  switch (style) {
    case 'listicle': {
      const numberedH2s = h2Texts.filter(t => /^\d+[\.\)]\s/.test(t))
      const ratio = h2s.length > 0 ? numberedH2s.length / h2s.length : 0
      const pass = ratio >= 0.7
      checks.push({
        name: 'Listicle numbered H2s',
        passed: pass,
        points: pass ? 3 : ratio >= 0.4 ? 1 : 0,
        maxPoints: 3,
        detail: `${numberedH2s.length}/${h2s.length} H2s start with a number (${Math.round(ratio * 100)}%, target: 70%+)`,
      })
      break
    }
    case 'narrative': {
      const hasKeyTakeaways = /key takeaway/i.test(fullText)
      const noTakeaways = !hasKeyTakeaways
      checks.push({
        name: 'Narrative: no Key Takeaways',
        passed: noTakeaways,
        points: noTakeaways ? 2 : 0,
        maxPoints: 2,
        detail: noTakeaways ? 'Correctly omits Key Takeaways section' : 'Narrative style should not have Key Takeaways',
      })
      const firstP = root.querySelector('p')
      const firstPText = firstP ? getTextContent(firstP).toLowerCase() : ''
      const hasScenario = /imagine|picture this|you're|you just|after a long|stepping off/i.test(firstPText)
      checks.push({
        name: 'Narrative: traveler scenario opening',
        passed: hasScenario,
        points: hasScenario ? 2 : 0,
        maxPoints: 2,
        detail: hasScenario ? 'Opens with traveler scenario' : 'Missing traveler scenario opening',
      })
      break
    }
    case 'data-heavy': {
      const hasPricingTable = /<table/i.test(input.html)
      checks.push({
        name: 'Data-heavy: pricing table',
        passed: hasPricingTable,
        points: hasPricingTable ? 3 : 0,
        maxPoints: 3,
        detail: hasPricingTable ? 'Contains pricing/comparison table' : 'Missing required pricing table',
      })
      const priceCount = (fullText.match(/\$\d+/g) || []).length
      const pricePass = priceCount >= 5
      checks.push({
        name: 'Data-heavy: price mentions',
        passed: pricePass,
        points: pricePass ? 2 : priceCount >= 2 ? 1 : 0,
        maxPoints: 2,
        detail: `${priceCount} price mentions (target: 5+)`,
      })
      break
    }
    case 'comparison': {
      const hasVsHeading = h2Texts.some(t => /\bvs\.?\b/i.test(t))
      checks.push({
        name: 'Comparison: vs. heading',
        passed: hasVsHeading,
        points: hasVsHeading ? 3 : 0,
        maxPoints: 3,
        detail: hasVsHeading ? 'Contains "vs." comparison heading' : 'Missing "vs." comparison heading',
      })
      const hasProsCons = /pros|cons|advantages|disadvantages/i.test(fullText)
      checks.push({
        name: 'Comparison: pros/cons elements',
        passed: hasProsCons,
        points: hasProsCons ? 2 : 0,
        maxPoints: 2,
        detail: hasProsCons ? 'Contains pros/cons comparison elements' : 'Missing pros/cons elements',
      })
      break
    }
    case 'standard':
    default: {
      const hasTakeaways = /key takeaway/i.test(fullText)
      checks.push({
        name: 'Standard: Key Takeaways present',
        passed: hasTakeaways,
        points: hasTakeaways ? 2 : 0,
        maxPoints: 2,
        detail: hasTakeaways ? 'Key Takeaways section found' : 'Missing Key Takeaways section',
      })
      break
    }
  }

  const points = checks.reduce((sum, c) => sum + c.points, 0)
  const maxPoints = checks.reduce((sum, c) => sum + c.maxPoints, 0)
  return { name: 'Style Adherence', points, maxPoints, checks }
}

// ── External Link Validation ────────────────────────────────────────────────

function scoreExternalLinkValidation(input: ScorerInput, root: HTMLElement): CategoryScore {
  const checks: Check[] = []
  const links = getAllElements(root, 'a')
  const externalLinks = links.filter(a => {
    const href = a.getAttribute('href') || ''
    return href.startsWith('http') && !href.includes('triplypro.com')
  })

  if (input.airportCode && externalLinks.length > 0) {
    const approved = getApprovedDomains(input.airportCode)
    let approvedCount = 0
    const unapprovedDomains: string[] = []

    for (const link of externalLinks) {
      const href = link.getAttribute('href') || ''
      try {
        const domain = new URL(href).hostname.replace(/^www\./, '')
        if (approved.has(domain)) {
          approvedCount++
        } else {
          if (!unapprovedDomains.includes(domain)) unapprovedDomains.push(domain)
        }
      } catch { /* malformed URL */ }
    }

    const ratio = externalLinks.length > 0 ? approvedCount / externalLinks.length : 0
    const pass = ratio >= 0.8
    checks.push({
      name: 'External links from approved DB',
      passed: pass,
      points: pass ? 3 : ratio >= 0.5 ? 2 : approvedCount > 0 ? 1 : 0,
      maxPoints: 3,
      detail: `${approvedCount}/${externalLinks.length} external links use approved domains (${Math.round(ratio * 100)}%)${unapprovedDomains.length > 0 ? ` — unapproved: ${unapprovedDomains.slice(0, 3).join(', ')}` : ''}`,
    })
  } else {
    checks.push({
      name: 'External links from approved DB',
      passed: true,
      points: externalLinks.length === 0 ? 1 : 3,
      maxPoints: 3,
      detail: input.airportCode ? 'No external links to validate' : 'No airport code — skipping domain validation',
    })
  }

  const points = checks.reduce((sum, c) => sum + c.points, 0)
  const maxPoints = checks.reduce((sum, c) => sum + c.maxPoints, 0)
  return { name: 'Link Validation', points, maxPoints, checks }
}

// ── CTA Relevance ───────────────────────────────────────────────────────────

function scoreCtaRelevance(input: ScorerInput): CategoryScore {
  const checks: Check[] = []
  // Include keyword words AND airport code for matching
  const kwWords = input.keyword.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  const airportCode = input.airportCode?.toLowerCase() || ''

  // Check if CTAs reference the article topic — match on keyword words OR airport code
  const earlyCta = input.earlyCta?.toLowerCase() || ''
  const closingCta = input.closingCta?.toLowerCase() || ''
  const earlyHasKeyword = kwWords.some(w => earlyCta.includes(w)) || !!(airportCode && earlyCta.includes(airportCode))
  const closingHasKeyword = kwWords.some(w => closingCta.includes(w)) || !!(airportCode && closingCta.includes(airportCode))
  const ctaRelevant = earlyHasKeyword || closingHasKeyword

  checks.push({
    name: 'CTA topic relevance',
    passed: ctaRelevant,
    points: (earlyHasKeyword ? 1 : 0) + (closingHasKeyword ? 1 : 0),
    maxPoints: 2,
    detail: ctaRelevant
      ? `CTA references article topic${earlyHasKeyword && closingHasKeyword ? ' (both)' : earlyHasKeyword ? ' (early)' : ' (closing)'}`
      : `CTAs don't reference keyword terms or airport code: ${[...kwWords, airportCode].filter(Boolean).join(', ')}`,
  })

  // Check CTAs are different
  if (earlyCta && closingCta) {
    const areDifferent = earlyCta !== closingCta
    checks.push({
      name: 'CTAs are distinct',
      passed: areDifferent,
      points: areDifferent ? 1 : 0,
      maxPoints: 1,
      detail: areDifferent ? 'Early and closing CTAs use different text' : 'Early and closing CTAs are identical (copy-pasted)',
    })
  }

  const points = checks.reduce((sum, c) => sum + c.points, 0)
  const maxPoints = checks.reduce((sum, c) => sum + c.maxPoints, 0)
  return { name: 'CTA Quality', points, maxPoints, checks }
}

// ── Main Scorer ─────────────────────────────────────────────────────────────

export function scoreArticle(input: ScorerInput): SeoScore {
  const root = parse(input.html)
  const fullText = getTextContent(root)

  const categories = [
    scoreKeywordOptimization(input, root, fullText),
    scoreContentStructure(input, root, fullText),
    scoreAiSearchOptimization(input, root, fullText),
    scoreContentQuality(input, root, fullText),
    scoreStyleAdherence(input, root, fullText),
    scoreExternalLinkValidation(input, root),
    scoreCtaRelevance(input),
  ]

  const total = categories.reduce((sum, c) => sum + c.points, 0)
  const maxTotal = categories.reduce((sum, c) => sum + c.maxPoints, 0)
  const grade = gradeFromScore(total)

  return { total, maxTotal, grade, categories }
}

// ── Pretty Print ────────────────────────────────────────────────────────────

export function printSeoScore(score: SeoScore) {
  console.log('\n  ┌──────────────────────────────────────────────────┐')
  console.log('  │              SEO SCORE REPORT                    │')
  console.log('  └──────────────────────────────────────────────────┘')
  console.log(`\n  Overall: ${score.total}/${score.maxTotal} (${score.grade})`)

  for (const cat of score.categories) {
    const bar = '█'.repeat(Math.round((cat.points / cat.maxPoints) * 20)).padEnd(20, '░')
    console.log(`\n  ${cat.name}: ${cat.points}/${cat.maxPoints} ${bar}`)

    for (const check of cat.checks) {
      const icon = check.passed ? '✓' : check.points > 0 ? '◐' : '✗'
      console.log(`    ${icon} ${check.name} (${check.points}/${check.maxPoints}) — ${check.detail}`)
    }
  }
}
