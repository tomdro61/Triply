import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import { scoreArticle, printSeoScore } from './seo-scorer.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const cmsUrl = process.env.PAYLOAD_CMS_URL
const apiKey = process.env.PAYLOAD_API_KEY

// Fetch the current JFK hub article from CMS
const res = await fetch(`${cmsUrl}/api/posts?where[slug][equals]=jfk-airport-parking&limit=1`, {
  headers: { Authorization: `users API-Key ${apiKey}` },
})
const data = await res.json()
const post = data.docs?.[0]

if (!post) {
  console.log('No post found with slug jfk-airport-parking')
  process.exit(1)
}

// We need the raw HTML, but the post stores Lexical JSON.
// For testing, let's fetch the queue item to get metadata and score with what we have.
// In production, scoring happens before Lexical conversion when we still have raw HTML.

// For now, let's test with a mock article to verify the scorer works
const testHtml = `
<p>JFK airport parking offers multiple options ranging from on-site garages at each terminal to budget-friendly off-site lots with free shuttle service. Here's everything you need to know to find the best rate and avoid common mistakes.</p>

<h3>Key Takeaways</h3>
<ul>
  <li><strong>On-site parking</strong> at JFK costs approximately $18-$39 per day depending on the lot</li>
  <li><strong>Off-site lots</strong> typically charge $8-$15 per day with free shuttle transfers</li>
  <li><strong>Booking in advance</strong> through services like <a href="https://www.triplypro.com">TriplyPro</a> can save you significantly</li>
  <li><strong>Long-term Lot 9</strong> is the most affordable official JFK parking option</li>
  <li><strong>Terminal-specific garages</strong> are available at Terminal 1, Terminal 4, Terminal 5, and Terminal 8</li>
</ul>

<h2>How Much Does JFK Airport Parking Cost?</h2>
<p>JFK airport parking rates vary widely based on whether you choose on-site or off-site options. According to the Port Authority of NY & NJ, official on-site garage rates start at approximately $18 per day for long-term parking.</p>
<ul>
  <li><strong>Terminal garages</strong> — approximately $39/day for short-term, $18/day for long-term</li>
  <li><strong>Long-term Lot 9</strong> — the most affordable on-site option at approximately $18/day</li>
  <li><strong>Off-site lots</strong> — typically $8-$15/day with shuttle service included</li>
</ul>
<p>Travelers frequently report saving significant amounts by booking off-site parking in advance. As of 2026, current rates may vary based on season and demand.</p>

<h2>Where Should You Park at JFK?</h2>
<p>The best parking option depends on your terminal, budget, and trip length. JFK has dedicated garages at Terminal 1, Terminal 4 (Delta's hub), Terminal 5 (JetBlue), and Terminal 8 (American Airlines).</p>
<p>If you're flying Delta from Terminal 4, the attached garage is the most convenient but also the priciest. Off-site lots along the Van Wyck Expressway and near Howard Beach offer budget-friendly alternatives with shuttle service to all terminals via the AirTrain.</p>

<h2>What Is Off-Site Airport Parking?</h2>
<p>Off-site airport parking is a budget-friendly alternative where private lots near the airport offer lower daily rates and provide free shuttle buses to your terminal. Based on current rates, off-site lots near JFK typically charge less than half what the official garages cost.</p>
<ul>
  <li>Free shuttle transfers to all JFK terminals</li>
  <li>24/7 security and surveillance</li>
  <li>Online reservations with guaranteed spots</li>
</ul>

<h2>How Do JFK Shuttle Services Work?</h2>
<p>Most off-site parking lots operate free shuttle buses running every 10-15 minutes between the lot and JFK terminals. The AirTrain also connects Long-term Lot 9 to all terminals, with stops at Jamaica Station and Howard Beach.</p>

<h2>Tips for Saving on JFK Airport Parking</h2>
<p>Based on our comparison of parking providers, here are the most effective ways to reduce your JFK parking costs:</p>
<ol>
  <li>Book at least 3-5 days in advance for the best rates</li>
  <li>Compare options on <a href="https://www.triplypro.com">TriplyPro</a> to find deals across multiple lots</li>
  <li>Consider off-site lots if your budget is tight</li>
  <li>Check for promo codes and seasonal discounts</li>
  <li>Use the AirTrain from Long-term Lot 9 to save on shuttle time</li>
</ol>

<h2>JFK Airport Parking FAQs</h2>
<p>Here are answers to the most common questions about parking at JFK International Airport.</p>

<p>For the most up-to-date rates and availability, compare all JFK parking options on <a href="https://www.triplypro.com">TriplyPro</a> — we help you find the best deal for your trip. Check out our <a href="https://www.triplypro.com/blog/jfk-airport-parking-price">complete guide to JFK parking prices</a> for a detailed breakdown.</p>
`

const score = scoreArticle({
  html: testHtml,
  keyword: 'jfk airport parking',
  slug: 'jfk-airport-parking',
  metaTitle: 'JFK Airport Parking Guide 2026: Rates, Lots & Deals',
  metaDescription: 'Compare JFK airport parking options, rates, and deals. Find the best on-site and off-site parking lots with shuttle service to all terminals.',
  excerpt: 'Everything you need to know about JFK airport parking — rates, lots, shuttle services, and money-saving tips.',
  faqItems: [
    { question: 'How much does JFK parking cost per day?', answer: 'Rates range from $8-$39/day.' },
    { question: 'Is there free parking at JFK?', answer: 'No free parking, but the cell phone lot is free for short waits.' },
    { question: 'Where is the cheapest parking at JFK?', answer: 'Off-site lots are cheapest at $8-$15/day.' },
    { question: 'Does JFK have a shuttle service?', answer: 'Yes, most lots offer free shuttle buses.' },
    { question: 'Can I book JFK parking in advance?', answer: 'Yes, booking ahead typically saves money.' },
    { question: 'How far is Long-term Lot 9 from the terminals?', answer: 'Connected via AirTrain, about 10 minutes.' },
    { question: 'Is JFK parking safe?', answer: 'Yes, all lots have 24/7 security and surveillance.' },
    { question: 'What payment methods does JFK parking accept?', answer: 'Credit cards, debit cards, and some lots accept mobile pay.' },
  ],
  articleType: 'hub',
  targetWords: 2500,
  hasImage: true,
  imageAlt: 'Aerial view of JFK airport parking lots — Photo by Josh Withers on Unsplash',
})

printSeoScore(score)
