# Lot-rewrite rules (Triply blog, ATL batch 1)

Goal: these articles recommend parking lots that Triply CANNOT sell. Repoint the recommendations to lots Triply CAN sell, without inventing anything.

Inputs per article: `<slug>.blocks.json` = top-level blocks `{i, type, html}`. `factsheet.json` = the only source of truth about lots.

## Output
Write `<slug>.edits.json`:
```json
{ "slug": "...", "edits": [ { "i": 12, "html": "<p>...</p>", "why": "short reason" } ],
  "deletes": [ 14 ], "seo": { "metaTitle": null, "metaDescription": null }, "excerpt": null, "title": null,
  "faqItems": null, "notes": "anything Vin should know" }
```
- `seo.*` / `excerpt` / `title`: set a new string only if the current one names a not-sellable lot or carries its price (rule 10); else null. (Post title is in the preedit file as `title`.)
- `faqItems`: null if no FAQ names a not-sellable lot; else the FULL new array, same shape as the input `faqItems` (only change the items that need it).
- `html` replaces block `i` entirely. It may contain several blocks (e.g. `<h3>..</h3><p>..</p>`). Allowed tags: h2 h3 h4 p ul ol li table thead tbody tr th td strong em a br.
- Only include blocks you change. Never edit or delete a block whose html is `[IMAGE — do not edit]`.

## Rules
1. A not-sellable lot (factsheet `notSellableOnTriply`) must never appear as bookable on Triply, never with "book on Triply"/"reserve through Triply", never as a Triply recommendation with a price. Lists, tables and "best off-site lots" sections built around them → rebuild around the sellable lots.
2. Never name a not-sellable lot at all — not as context, not in comparisons, not in FAQs (Vin, 14 Oct 2026). Remove every mention; the only other parking named is the airport's own on-airport parking.
3. Facts about sellable lots: ONLY what is in the factsheet (name, address, distance, shuttle, amenities, overview, daily rate). Never invent ratings, shuttle times, EV chargers, covered parking, reviews, space counts. PreFlight: name, address and price only.
4. Prices: write "about $X/day" with the factsheet rate rounded to the nearest dollar, and say once per article that rates are for a 7-day stay booked ahead and change by date. Drop the "(ATL)" suffix in prose.
5. On-airport rates: only from factsheet `onAirportRates`. Do NOT claim off-site beats the airport economy lot unless the factsheet numbers show it; if a sellable lot costs more than economy, say so plainly.
6. Cancellation: "free cancellation with a full refund up to 24 hours before check-in". Never mention commission or how Triply is paid.
7. Keep everything unrelated to lots untouched (terminals, roads, airport policies, FAQs not about lots). Keep length roughly the same. Keep headings unless they name a not-sellable lot. Keep existing links to triplypro.com pages; links to a not-sellable lot's page → remove the link, keep the text if still true. Booking links: reuse the triplypro.com airport-parking/search link already in the article (ATL: `https://www.triplypro.com/atlanta-atl/airport-parking`).
8. Plain, confident, helpful voice; no hype. No em dashes in new text.
9. If a fact in surrounding text becomes false because of your change (e.g. "all five lots above"), fix it too.
10. Prices or stats that came from a not-sellable lot (e.g. ATL "$7.95/day" = Quality Inn, "$8.99"/"$10.95" = Peachy) are false for Triply even when the lot isn't named — replace with factsheet figures everywhere: body, title-adjacent text, seo, excerpt, FAQ. Never say "$X on Triply" unless X is a factsheet rate (cheapest ATL ≈ $10/day).
11. Do not use a sentence from a factsheet `overview` that is cut off mid-sentence.
12. Only call a shuttle "free"/"complimentary" if the factsheet says so for that lot. A lot with no shuttle/distance data (e.g. only name/address/price) must be excluded from any group claim ("each with a shuttle", "2 to 3.6 miles").
13. The site-wide footer sentence "about 89% less per day than the airport's own terminal garage" is false for sellable lots — replace that sentence with a factsheet-based figure (e.g. vs the Daily/Terminal garage rate in onAirportRates) in every article you edit.
14. Write `&` as `&amp;` exactly once (never `&amp;amp;`). No em dashes anywhere inside a block you replace.
15. Policy: no modifications — never say a booking can be changed; it can be cancelled free up to 24h before check-in.
16. Never name competing booking sites or apps (SpotHero, Way.com, ParkWhiz, ParkingAccess, ParkSleepFly, Airport Parking Reservations and similar), never suggest checking their codes or credits. If the article focus keyword names one (e.g. Groupon), you may name that one where needed for the topic, without recommending it. Compare Triply against booking direct with the airport instead (extends Vin's sellable-only rule, 15 Oct 2026).
