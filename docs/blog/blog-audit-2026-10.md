# Blog audit — October 2026

**Scope:** all 4,530 published posts (CMS API, metadata only), Search Console and GA4 landing pages
for Jul 19 – Oct 16, 2026, booking attribution (`attribution.first/last.land`), Google URL
Inspection on 75 sampled posts, the live sitemap, and two reviewers who read 38 posts and the engine
code. Read-only; nothing was changed.

> **Public copy.** This repo is public, so traffic, booking and conversion figures are left out or
> given as rough shares. Tom has the full numbers (wrapper `notes/2026-10-19-blog-audit.md`).

**Limits:**
- Bookings carry attribution only since PR #26 (Sep 17), so booking-side findings rest on a few
  weeks of data.
- The topic groups come from slug keywords and are approximate.
- The "not indexed" share is extrapolated from a 75-post sample.

## 1. Headline

| | |
|---|---|
| Posts | 4,530: 4,192 spokes, 285 sub-pillars, 46 hubs; 47 airports |
| Published | Apr 1,370 · May 701 · Jun 1,542 · Jul–Sep ~110 · **Oct 13–17: 781** (20 new airports) |
| Blog clicks | rose roughly 8× from late May to early July as the spring batches were indexed; drifted down ~30 % since July |
| Bookings | about three quarters of attributed bookings touch a blog post |

## 2. What works

- **The spring batches built the traffic.** Clicks rose about 8× as they got indexed. That isn't
  proof more volume helps: the 781 October posts have almost no clicks yet, and daily clicks have
  drifted down since July. Pages getting impressions plateaued from late July; there's no sign of a
  drop.
- **Bookings come from the long tail.** Attributed bookings landed on almost as many different
  posts as there were bookings, and no post produced more than 2. Only a small share came from the
  200 most-clicked posts. **Mass-deleting low-traffic posts would cut bookings.**
- **Rate posts convert best:** roughly 3× the blog average per click, and about a third of blog
  bookings from about a tenth of clicks. The direction is solid; the size isn't (short attribution
  window, first/last touch split, approximate slug grouping).
- **The October batch reads better than the spring posts.** Facts cite "verified October 2026"
  with official links, and Canadian prices are written "C$" with tax stated. Too new to judge
  traffic: of 20 sampled, 6 are indexed, 9 discovered but not indexed, 5 unknown to Google.
- **Technical basics are fine.**
  - All 4,530 posts are in the sitemap.
  - Canonicals are self-referencing, with no Google/user mismatch in the sample.
  - Robots tag is `index, follow`.
  - Every sampled post has the booking widget, CTAs, and links to the airport page and hub.

## 3. Findings

### A. We compete with ourselves at scale — Critical
- **Queries:** for nearly all our higher-volume queries, 5 or more of our posts appeared at some
  point in 90 days, and thousands of queries show 20+. This counts any impression at any position;
  it shows how widely our posts spread over one query, not 5 of them on a single results page.
  - "bwi parking rates": 110 posts compete; the leading page (`bwi-airport-parking-hourly`) sits
    around position 13 and gets almost no clicks.
  - "charlotte airport parking rates": 106 posts, best around position 46, no clicks.
- **Posts are keyword variants, not separate topics.** BWI alone has 11 shuttle/bus posts:
  `-shuttle`, `-shuttle-schedule`, `-bus-schedule`, `-shuttle-hours`, `-tracker`… Logan has 12
  cost/rate posts. IAD has 8 pick-up posts. FLL has 5 Delta posts (`fll-airport-parking-delta`,
  `…-for-delta`, `…-for-delta-airlines`…).
  - Each variant is reworded, so copied-text checks miss it (8-word overlap ≤ 0.07).
  - The duplication shows in the facts and headings instead. The 4 BWI shuttle posts share fact
    overlap of 0.27–0.47 and repeat the same table and "How Often Does…" heading.
    `airport-parking-for-bwi` vs `-in-bwi` has fact overlap 0.67 and TF-IDF similarity 0.74; the
    baseline for unrelated posts is 0.10.
- **Google is dropping the duplicates.** URL Inspection on samples:

  | Sample | Not indexed |
  |---|---|
  | Posts older than 90 days with no impressions | 23 of 25 ("Crawled – currently not indexed") |
  | Posts with impressions but no clicks | 5 of 15 |
  | Posts with clicks | 0 of 15 |

  - Scaled up, that's **≈ 450–850 of the 3,640 posts older than 90 days** (point estimate ~630,
    ≈ 17 %). The middle stratum (5 of 15) is the wide part.
  - Each sampled reject is a variant of a sibling Google kept, or a hotel-brand post with no
    first-hand facts. Examples: `new-york-kennedy-airport-parking` duplicates the JFK hub (fact
    overlap 0.56); `laguardia-airport-parking-marriott` has a same-day twin (0.64).

### B. The engine has no duplicate guard — High
- **Topics:** keywords come from a CSV queue (`import-queue.ts:126-136`, hard-coded to JFK at
  :170/:191), so the 20-airport October batch came from another path we couldn't find.
- **The only check is a unique slug** (`import-queue.ts:237-239`).
- **Weak context:** the prompt's "DO NOT repeat — link instead" sees only 10 of the airport's posts
  (`payload.ts:159-175`, limit 20 → slice 10). At BWI's 150 posts the real twin is almost never
  in view.
- **Link pool:** internal links see 500 of 4,530 posts (`payload.ts:126-143`, no paging).
- **Unused data:** `gsc.ts:452-497` (`fetchQueryPagePairs`) already finds query/page overlap, but
  report-only; `generate` never calls it.

### C. Wrong or unsupported facts — High
- **Official rates wrong on high-traffic posts:**
  - `seattle-airport-parking-rates` says $5/hr, $32/day, $149/week; the Port says $8/hr, $37/day,
    $222/week. It also has 14 outbound links to competitor lots.
  - `dfw-airport-parking-receipt-phone-number` gives the wrong rates (Remote $10 vs $14/$16;
    Valet $34 vs $55) and wrong hours.
  - The Newark promo-P6 post says P6 goes via AirTrain; it's a direct bus.
- **Accurate posts:** DFW promo/veteran, O'Hare economy, Logan, Phoenix, STL, YYC and LAX matched
  the official sites.
- **Unsourced legal and benefit claims:** DFW veteran post (phone, email, TollTag timing,
  "TSA PreCheck free for veterans"); SFO employee post (lots, gift cards, shuttles).
- **Misattributed:** Port Everglades "shortest airport-to-cruise connection in the US" is credited
  to a page that doesn't say it. "POE" is used as an airport code.
- **Contradictions inside one post:** $8–$23 vs $8–$12; $7 / $7.95 / $5.95; $5.75 vs $5.99.
- **AI and template artifacts in published copy:**
  - "…$105 total — wait, let's be precise: $21 × 5 days…" (`newark-airport-parking-rates-p6`)
  - "No competitor article explains this end-to-end" (DFW receipt)
  - "from about 5/day … to 13/day" (both Newark posts)
- **Titles that promise something missing:** FLL "parking map" has no map; Denver "Live
  Availability" has no live data; SFO employee parking has no rates.

### D. Promo-code posts: most clicks, fewest bookings, weakest claims — High
- **Traffic vs bookings:** promo/coupon posts are 7 % of posts but a larger share of clicks, and
  hold the top 3 posts by clicks (DFW, LAX, CLT). They convert at about half the blog average.
- **Claims:**
  - LGA deals lists "PRIME15 / SUMMER20 / SAVE10 / military 25 %" under a **"Working Coupon and
    Promo Codes"** heading, "as reported in April 2026", tied to a lot we sell. The post says the
    codes don't apply on Triply, but none has a source. SAVE10 is also the name of our own code,
    deactivated Sep 24.
  - LAX H1: "Save 10% + **Verified** Discounts"; nothing in the post is verified.
  - DFW claims to have codes "updated for 2025 and 2026" but lists none, and misses DFW's real live
    code (EARLYBIRD, 10/19–11/12).
  - The Newark rates post sends readers to a promo post "with codes up to 40 %"; that post says
    there are none.
- **Our own offer contradicts them:** posts say "Triply does not layer codes", while every page
  shows a "Get 10 % off your first booking" capture.

### E. Every post states prices for lots we sell — High (P3c's job)
- Examples: "Fox Parking about $9/day", "Clarion Inn about $5/day", "Jiffy $12.95/day" (our
  Seattle page shows $10.95).
- Figures disagree across posts and with our pages, and many leave out fees or tax.
- They also appear in hub titles and meta descriptions ("from $7/day").
- The fee-inclusive prices plan (P3, Tom's notes) already covers the engine change and a bulk
  rewrite of existing posts as step P3c.

### F. "Updated" stamps don't track real edits — High
- `contentUpdatedAt` is on 1,971 posts. **778 were stamped on Sep 23 and 696 on Oct 13**, about
  25 per airport, some 0.5 s apart.
- The code that stamps them isn't in git: 0 references on `main`, PR #96 or `vin/main`.
- **The stamps contradict the content:**
  - `hyatt-place-fll-airport-parking` shows "Updated September 2026"; its body says "verified
    April 2026".
  - "Rates verified April 2026" appears 16 times under "Updated October 2026" badges.
- Google's guidance names this pattern ("changing the date of pages to make them seem fresh").

### G. "2026" in 3,594 titles — Medium
- On Jan 1 these read as last year's.
- 14 posts carry 2022–2025, and one says 2028 (`logan-airport-parking-for-terminal-e`).
- Year-named queries are a fraction of a percent of rate-search impressions; month-named queries
  are effectively zero.

### H. Coverage and intent mix — Medium
- **39 of 85 production airports have no posts**, yet they still bring bookings (TYS, ROC, CHS,
  OKC, ORF lead). The October batch went to 20 other airports.
- **Topics and bookings don't line up** (bookings per click, highest first):

  | Topic group | Share of clicks | Conversion vs blog average |
  |---|---|---|
  | Rates | 11 % | ~3× |
  | Shuttle | 4 % | above |
  | Hotel | 3 % | above |
  | General parking | 15 % | above |
  | Long/short-term type | 11 % | about average |
  | Maps/terminals | 17 % | below |
  | Promo | 12 % | about half |
  | Special access | 8 % | well below |
  | Ops/help | 11 % | well below |
  | Cell-phone lot | 4 % | none |

  Informational posts earn clicks and some brand value, but few bookings.
- **Hubs underperform:** the 46 hubs average about a third of a spoke's clicks.
- **Hotel posts are the weakest group:** 393 posts, 57 % with no clicks.

### I. Template weight — Medium
- About 40 % of each page is the same blocks: date widget, an unsupported "save up to 70 %" CTA,
  Waze/TSA tips, "free cancellation…24 hours" 4–8 times, email capture.
- Tables render twice (desktop table plus mobile cards).
- Stock images don't fit the topic ("receipts… not valid for travel" on a map post).

## 4. What not to do

- **Don't mass-delete.** Bookings are spread across the tail. Merge variants into the page Google
  already prefers and 301 them, so links and bookings follow.
- **Don't stop publishing.** Write new ground (uncovered airports, commercial-intent topics), not
  more variants.
- **Don't re-stamp dates in bulk.** Stamp only real changes.

## 5. Appendix: posts per airport

DFW 152 · ORD 195 · FLL 214 · ATL 164 · AUS 211 · JFK 93 · IAD 224 · IAH 159 · CLT 186 · MCO 180 ·
TPA 191 · LAS 242 · EWR 115 · PHL 116 · MSP 184 · LAX 113 · SEA 186 · BWI 150 · SFO 109 · DEN 84 ·
BOS 95 · LGA 79 · BNA 106 · SAN 62 · DCA 87 · MIA 57 (the 26 airports with traffic; per-airport
clicks and bookings are in Tom's copy). October-batch airports: ~0 clicks so far.

No posts: ABE ABQ ALB AZO BHM BUR CHS DAL DSM ELP FAT GEG GSO HPN IDA IND JAX LIT MDW MEM MLB OKC ORF
PBI PIT PVD RIC RNO ROA ROC RSW SAT SAV SLC SNA SYR TUS TYS YOW.

*Created October 19, 2026. Public copy (figures removed) added October 21, 2026.*
