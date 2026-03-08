import * as cheerio from 'cheerio'
import { env, SCRAPE_DELAY_MS, SCRAPE_TIMEOUT_MS } from './config.js'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface ScrapedHeading {
  level: number
  text: string
}

export interface ScrapedArticle {
  url: string
  title: string
  content: string
  headings: ScrapedHeading[]
  wordCount: number
  linkCount: number
  faqCount: number
  tableCount: number
  listCount: number
  h2Count: number
  schemaTypes: string[]
  outboundLinks: { href: string; anchor: string }[]
  imageAlts: string[]
  ctaPatterns: string[]
}

export async function searchGoogle(keyword: string, numResults = 5): Promise<string[]> {
  if (!env.SERPAPI_API_KEY) {
    console.log('  ⚠ No SERPAPI_API_KEY — skipping Google search. Use manual competitor URLs.')
    return []
  }

  const params = new URLSearchParams({
    api_key: env.SERPAPI_API_KEY,
    q: keyword,
    num: String(numResults),
    engine: 'google',
  })

  const res = await fetch(`https://serpapi.com/search?${params.toString()}`)
  if (!res.ok) {
    console.error(`  SerpAPI error ${res.status}: ${await res.text()}`)
    return []
  }

  const data = await res.json()
  return (data.organic_results || [])
    .map((r: { link?: string }) => r.link)
    .filter(Boolean) as string[]
}

export async function scrapeArticle(url: string): Promise<ScrapedArticle | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TriplyBot/1.0; +https://triplypro.com)',
      },
    })

    if (!res.ok) {
      console.log(`  ⚠ Failed to fetch ${url}: ${res.status}`)
      return null
    }

    const html = await res.text()
    const $ = cheerio.load(html)

    // Remove nav, footer, sidebar, scripts, styles
    $('nav, footer, aside, script, style, noscript, iframe, .sidebar, .nav, .footer, .header, .menu, .ad, .advertisement').remove()

    // Extract article content
    const article = $('article').length ? $('article') : $('main').length ? $('main') : $('body')

    const title = $('h1').first().text().trim() || $('title').text().trim()

    // Extract headings with hierarchy
    const headings: ScrapedHeading[] = []
    article.find('h2, h3, h4').each((_, el) => {
      const text = $(el).text().trim()
      const level = parseInt(el.tagName.replace(/h/i, ''), 10)
      if (text) headings.push({ level, text })
    })

    // Get text content from paragraphs, lists, tables, blockquotes, and definition lists
    const contentParts: string[] = []
    article.find('p, li, td, th, blockquote, dt, dd').each((_, el) => {
      const text = $(el).text().trim()
      if (text && text.length > 20) contentParts.push(text)
    })

    const content = contentParts.join('\n\n').slice(0, 20000) // Increased to ~20k chars

    // Extract structural metadata for competitor benchmarking
    const fullText = article.text()
    const wordCount = fullText.split(/\s+/).filter(w => w.length > 0).length
    const linkCount = article.find('a[href]').length
    const h2Count = article.find('h2').length
    const tableCount = article.find('table').length
    const listCount = article.find('ul, ol').length

    // Count FAQ-like patterns (Q&A sections, schema FAQ, etc.)
    let faqCount = 0
    article.find('h2, h3').each((_, el) => {
      const text = $(el).text().trim()
      if (/^(how|what|where|when|why|which|is|are|do|does|can|should)/i.test(text) || text.endsWith('?')) {
        faqCount++
      }
    })

    // Extract JSON-LD schema types
    const schemaTypes: string[] = []
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html() || '')
        const types = Array.isArray(json) ? json.map((j: { '@type'?: string }) => j['@type']) : [json['@type']]
        for (const t of types) {
          if (t && !schemaTypes.includes(t)) schemaTypes.push(t)
        }
      } catch { /* ignore malformed JSON-LD */ }
    })

    // Extract first 20 outbound links with anchor text
    const outboundLinks: { href: string; anchor: string }[] = []
    article.find('a[href^="http"]').each((_, el) => {
      if (outboundLinks.length >= 20) return
      const href = $(el).attr('href') || ''
      const anchor = $(el).text().trim()
      if (href && anchor && !href.includes(new URL(url).hostname)) {
        outboundLinks.push({ href, anchor: anchor.slice(0, 100) })
      }
    })

    // Extract image alt texts
    const imageAlts: string[] = []
    article.find('img[alt]').each((_, el) => {
      const alt = $(el).attr('alt')?.trim()
      if (alt && alt.length > 3) imageAlts.push(alt.slice(0, 100))
    })

    // Detect CTA patterns
    const ctaPatterns: string[] = []
    article.find('a, button').each((_, el) => {
      const text = $(el).text().trim().toLowerCase()
      if (/book\s*(now|your|today|parking)/i.test(text)) ctaPatterns.push(text.slice(0, 60))
      else if (/reserve|compare|check.*availab|find.*parking|get.*quote/i.test(text)) ctaPatterns.push(text.slice(0, 60))
    })

    return { url, title, content, headings, wordCount, linkCount, faqCount, tableCount, listCount, h2Count, schemaTypes, outboundLinks, imageAlts, ctaPatterns: ctaPatterns.slice(0, 5) }
  } catch (err) {
    console.log(`  ⚠ Error scraping ${url}: ${err instanceof Error ? err.message : err}`)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export async function scrapeCompetitors(
  keyword: string,
  manualUrls: string[] = []
): Promise<ScrapedArticle[]> {
  const urls = manualUrls.length > 0 ? manualUrls : await searchGoogle(keyword)

  if (urls.length === 0) {
    console.log('  No competitor URLs to scrape.')
    return []
  }

  console.log(`  Scraping ${urls.length} competitor articles...`)
  const articles: ScrapedArticle[] = []

  for (const url of urls) {
    const article = await scrapeArticle(url)
    if (article) {
      articles.push(article)
      console.log(`  ✓ ${article.title} (${article.headings.length} headings)`)
    }
    await sleep(SCRAPE_DELAY_MS)
  }

  return articles
}
