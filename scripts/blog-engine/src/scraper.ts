import * as cheerio from 'cheerio'
import { env, SCRAPE_DELAY_MS, SCRAPE_TIMEOUT_MS } from './config.js'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface ScrapedArticle {
  url: string
  title: string
  content: string
  headings: string[]
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
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS)

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TriplyBot/1.0; +https://triplypro.com)',
      },
    })
    clearTimeout(timeout)

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

    const headings: string[] = []
    article.find('h2, h3').each((_, el) => {
      const text = $(el).text().trim()
      if (text) headings.push(text)
    })

    // Get text content from paragraphs and lists
    const contentParts: string[] = []
    article.find('p, li').each((_, el) => {
      const text = $(el).text().trim()
      if (text && text.length > 20) contentParts.push(text)
    })

    const content = contentParts.join('\n\n').slice(0, 10000) // Limit to ~10k chars

    return { url, title, content, headings }
  } catch (err) {
    console.log(`  ⚠ Error scraping ${url}: ${err instanceof Error ? err.message : err}`)
    return null
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
