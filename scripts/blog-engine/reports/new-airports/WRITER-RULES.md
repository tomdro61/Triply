# New-airport pages: writer rules (pilot MDW / PIT / RIC, 23 Oct 2026)

One page per search intent, not one per keyword. Each page has a focus keyword (slug + title) and absorbs the
other keywords of its group as H2s / FAQ questions. Source of truth: `<a>/factsheet.md` and nothing else.

## Grouping (writer decides from the keyword sheet)
- Drop off-topic rows (other airports/cities/countries, e.g. Birmingham UK, generic "airport parking near airport",
  "X airport to <place>", car-park permits/fines, "what is valet parking").
- A group is a distinct question: hub (general "<code> airport parking"), cost/rates, long-term/economy, off-site
  (our lots), pick-up/cell lot, how-to-save (coupon/promo), plus any other distinct intent with ≥ ~100/mo combined
  volume (e.g. valet, map, a named garage, hotel park-and-fly). Wording variants of the same question are ONE group.
- 3–7 pages per airport. Skip a group that has no facts to say (e.g. cell lot with nothing official) or <20/mo
  combined and fold it into the hub instead. Focus keyword = highest-volume keyword in the group.
- Write `<a>/PLAN.md` first: the groups, focus keyword, volume, and which keywords each absorbs + what was dropped.

## Never
- Never request `https://www.triplypro.com/blog/<slug>` for a page not yet published (a 404 gets cached for an hour).
- Our lot prices = what the customer pays on triplypro.com: `pricing.grandTotal` + Triply service fee, where
  fee = max($5.95, 6% × (subtotal + feesTotal)) rounded to cents (`customerTotalFromPricing`, app
  `src/lib/utils/service-fee.ts`). Per day = that ÷ billed days. Every "cheaper than" comparison uses it.
  (23 Oct: pages quoting bare grandTotal understated by ~$6–8/booking; PIT Globe flipped from cheaper to dearer.)
  Say "includes taxes and fees" if grandTotal has tax; else "includes fees".

## Output: `<a>/<slug>.page.json`
```json
{ "slug": "pit-airport-parking", "keyword": "pit airport parking", "title": "...",
  "articleType": "hub", "parentSlug": null, "hubSlug": null,
  "tags": ["PIT airport parking", "Pittsburgh airport parking", "off-airport parking"],
  "seo": { "metaTitle": "<= 60 chars", "metaDescription": "<= 160 chars" },
  "excerpt": "<= 300 chars, the direct answer",
  "html": "<p>...</p><h2>...</h2>...",
  "faqItems": [ { "question": "...", "answer": "..." } ] }
```
- Spokes: `articleType: "spoke"`, `parentSlug` and `hubSlug` = the hub's slug.
- Slug = focus keyword lowercased, spaces to hyphens.
- Allowed html tags: h2 h3 p ul ol li table thead tbody tr th td strong em a br. No h1 (the title is the h1).
  No FAQ section in the html (FAQs go in `faqItems`, 4–6 per page).

## Answer first
1. Title: the focus keyword plus the answer or key number, phrased like the question (e.g. "PIT Airport
   Parking: Rates From $X/Day, Lots and How to Book (2026)"). No "Ultimate", "Complete Guide", hype.
2. First paragraph (2–3 sentences): the direct answer with the key numbers (official rate, cheapest option,
   shuttle frequency) and "as of October 2026". A reader who stops there has the answer.
3. Every H2 that answers a question opens with a one-sentence direct answer, then detail.
4. Length: hub 1,200–1,800 words; spokes 800–1,300. Tight, no filler, no restating.

## Facts
5. Every number comes from the factsheet with its "as of" month. If the factsheet says "unconfirmed", don't
   state it (or say plainly that the airport doesn't publish it).
6. On-airport rates: the airport's own figures. Our lots: name, address, distance/shuttle, amenities and
   price only as the factsheet gives them. Prices: "about $X/day" rounded, and once per page say Triply prices
   are for the sample dates shown, include taxes and fees, and change by date.
7. Don't claim our lots beat the airport's cheapest option unless the factsheet numbers show it. If a lot
   costs more than economy, say so and say what you get for it (shuttle, reservation, covered, etc. if stated).
8. Cancellation: only what the factsheet says. Never say a booking can be modified.
9. Promo/coupon intent: "how to save" framing. Name a code only if the airport or lot publishes it (cite).
   Never "verified"/"working" codes. Never "save up to N%" without a source.
10. Never name competing booking sites or apps (SpotHero, Way.com, ParkWhiz, etc.) or Park 'N Fly. Never
    mention commission or how Triply is paid. Unsellable private lots: don't name them.

## Links
11. Book links go to the airport page given in the factsheet (e.g. `https://www.triplypro.com/<city-code>/airport-parking`)
    or the lot's own page URL from the factsheet. Not `/search`.
12. Hub links to every spoke; each spoke links to the hub and 1–2 sibling spokes. Absolute URLs
    `https://www.triplypro.com/blog/<slug>`.
13. Link the airport's official parking page once as the source of official rates.
13a. Internal linking model = hub (pillar) + spokes. Hub links EVERY spoke in context (not just a list at the end)
    and once in a short "More <CODE> parking guides" list. Each spoke links the hub in the first 2 paragraphs and
    EVERY sibling spoke at least once where the topic comes up. Descriptive, varied anchor text (e.g. "PIT long-term
    parking rates"), never "click here", never the same exact-match anchor twice on a page.
13b. Same-metro hubs: the hub (and the off-site spoke) link the existing hub of a nearby airport travelers
    compare, when one exists: MDW↔`ord-airport-parking`, BUR→`lax-airport-parking`, HPN→`jfk-airport-parking`,
    `laguardia-airport-parking`, `newark-airport-parking`, YOW→`yul-airport-parking`, `yyz-airport-parking` (only where
    the text genuinely compares them).
13c. External links: 2–4 per page, primary sources only, each where the fact it supports appears: the airport's
    official parking/rates page, its ground-transportation or cell-lot page, the local transit agency's route page,
    TSA (tsa.gov) for security/arrival timing, the airport's parking map. Never competitors, coupon or review
    sites, never press when an official page says the same. Every external URL must return 200/301 (check it).

## Voice
14. Plain, confident, helpful. Second person. No em dashes. No "In conclusion". No AI phrases ("let's dive in",
    "it's worth noting", "navigating"). Write `&` as `&amp;` in html.
15. Use a table for rates (facility | hourly | daily | weekly | shuttle) on the hub and the rates page.
