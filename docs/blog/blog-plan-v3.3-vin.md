# Triply growth roadmap v3.3 — protect what we built, then grow traffic and bookings (2026-10-30)

**What this is.** One roadmap for the whole funnel: more people to the site → more of them book → more
of them come back. It replaces the blog-only framing of v3.1/v3.2 (`docs/blog/blog-plan-v3.2.md`, PR
#110) with the business goal those plans serve, keeps everything in v3.2 that protects what we have,
and adds the growth, conversion, repeat and supply work without which cleanup only slows the decline.

**How to use it.** It is a living document. Each track has a status table (where we are), a target
(where we are going), and numbered recipes (exactly what to do, in order, with "done when"). The
calendar (§12) puts the recipes on dates. When something ships, tick it here and move the next recipe
up. Re-read §2 (status) and §13 (targets) at every monthly readout and correct them.

**Public copy.** This repo is public. Traffic, booking, conversion and revenue figures are left out or
given as directions and ratios. The full numbers live in Tom's and Vin's notes.

> **The rule (Tom, 2026-10-21, unchanged).** SEO means Google **and** AI assistants (ChatGPT, Gemini,
> Copilot, Perplexity, Claude) **and** Bing, and it drives the business. A change is a *step* only if
> the evidence says it helps all of them and hurts none. Anything we can't show is safe for every
> channel is a *test*: small, measured on all three before and after, against controls, with a way back.

---

## 1. The goal, and the only equation that matters

Bookings = **visitors × search rate × checkout rate × (1 + repeat rate)**, times the value of each
booking. Every recipe in this document moves one of those four factors or protects one of them.

| Factor | What moves it | Track |
|---|---|---|
| Visitors | pages that are indexed, rank, and get cited by assistants; links and mentions on other sites; our own data that others quote; new questions we answer first; social and partner footprint | B, C, D, E |
| Search rate (visitor → runs a search) | answer-first pages, a booking widget on every article, honest prices, trust signals, a booking page worth landing on | F |
| Checkout rate (search → paid) | all-in price shown and said, "Limited spots", reviews on lot pages, recovery email for abandoned checkouts, lot data that doesn't get rejected | F |
| Repeat rate | post-trip review email, email list, a reason to come back (price index, holiday reminders, waitlist), the first booking being good | G |
| Value per booking | longer stays, holidays, park-sleep-fly packages, direct lots (no channel commission), ParkGuard attach | E, H |
| What we protect | index health, no self-competition, no fake freshness, no claims we can't source, no dependence on one supplier | A, H |

**Order of operations.** Protect first (A), because a Google quality action would take every channel
down at once. Then structure and indexing (B), because an unindexed page helps nobody. Then the growth
tracks in parallel, because they add and never remove, so they don't wait on the merge tests.

---

## 2. Where we are (status snapshot, 30 Oct 2026)

Legend: ✅ live · 🌑 merged but off behind a flag · 🔁 open PR · 🛠 built, not in `main` · ⏸ parked · ❌ not started.

### 2.1 Content and index
| Item | Status | Notes |
|---|---|---|
| Blog corpus | ✅ 4,670 published posts (CMS, 30 Oct), 74 airports | Spring batches (Apr–Jun) built the traffic; clicks drifted down ~30 % Jul→Oct |
| Every airport with a sellable lot has posts | ✅ done 12–24 Oct | 42 airports added in October (3–40 pages each, intent-grouped, fact-checked). The 11 airports at zero (ABE ABQ AZO DAL GEG IDA MEM ROA RSW SLC SNA) have **no lots to sell**; #122 noindexes their airport pages |
| Self-competition | ❌ open | Keyword variants are reworded copies (BWI 11 shuttle posts, Logan 12 cost posts); an estimated 450–850 older posts are "crawled – currently not indexed"; 6 hubs unindexed (JFK, EWR, SFO, SEA, MCO, SAN) |
| Redirects | 🛠 | 101 pairs on `feat/blog-consolidation-redirects` (verified, not pushed); 294-row unindexed merge map (28 Sep); `next.config` has 3 redirects live |
| Stale prices in titles/meta | ✅ fixed 9 Oct | ~3,800 fields. Bodies still carry old prices and unsellable lot names at the older airports |
| Unsellable lots named in articles | 🔁 partly | Rule since 16 Oct: naming unsellable lots is fine **if ours are named too**. ~1,400 posts name none of our lots. Engine filter in PR #96 |
| Lexical `&amp;` bug | ✅ engine fixed (#66) | Corpus repair (≈2,700 posts) not done |
| "Updated" stamps | ❌ | Bulk stamps Sep 23 / Oct 13 (§5 answers Q1). Must stop until the stamping rule is in git |
| Year "2026" in ~3,600 titles | ❌ | Decision needed before Jan 1 |
| IndexNow | ✅ key live; ping in running engine on new-airport publish; **not in git** | Bing/Copilot path |
| Thanksgiving price index | ✅ live 29 Oct | 25 airports, garage vs off-airport, press pitch drafted, not sent |
| Holiday pages | ❌ | Only two Thanksgiving posts exist (DEN, AUS) |
| Sold-out "rescue" articles | ✅ 26 live | Written during events; §E6 writes them before events |
| Partner/operator articles | ✅ 7 live, CTA → /partners | |

### 2.2 Site, conversion, trust
| Item | Status | Notes |
|---|---|---|
| Booking widget on every article | ✅ #22 | Measured: blog-landing bookings rose several-fold the week it shipped; first ChatGPT/Copilot-referred bookings seen the same week |
| Booking pages link to the airport's guides | ✅ #97 | |
| Airport booking pages | ❌ thin | ~265 words; rank ~50–77 for "<airport> airport parking". The biggest head-term lever on the site. Tom's area |
| All-in price | ✅ rendered on lot cards; **never said in words** | "The price you see is the price you pay" is true and absent |
| "~70 % cheaper than the terminal garage" | ✅ true at the median of our lots at every measured airport | Never on the site. Against the airport's **economy** lot we are only ~30 % cheaper and **dearer** at AUS, IAH, ORD, PBI, DSM, PVD, HPN, MDW, ALB, FAT, SAV — so the claim is garage-only |
| Homepage "4.9 Rating" badge, "JFK and LGA only" copy | ❌ | Perplexity called Triply "unverified" from these. v3.2 W8 |
| Canonical + Offer + real-review aggregateRating JSON-LD on lot pages | ✅ #120, #121 | |
| Verified reviews on lot pages and search cards | 🔁 #119 | Stacked on #76 |
| Review ask to past customers (backfill) | 🔁 #125 | |
| Post-trip review email | 🌑 #76 | Flag `POST_TRIP_REVIEW_EMAILS_ENABLED` |
| Abandoned-checkout recovery email | 🌑 #44 | Flag `CHECKOUT_RECOVERY_EMAILS_ENABLED`; a measurable share of people who reach payment don't finish |
| "Limited spots" on lot page | ✅ #46 | |
| Lot-declared extra fields enforced before payment | ✅ #49 | ResLab rejections stopped |
| Booking window | ✅ 100 days (#43) | Thanksgiving and Christmas bookable since late Sep |
| Waitlist beyond the window | ✅ #25 | |
| Sold-out signal logged on every search | ✅ #24 | Demand data ResLab can't see |
| Search-event log | ✅ | Tool sweeps pollute it; filter `ga_client_id IS NOT NULL` |
| 10 %-off signup block on promo posts | ✅ #99 | Article-wide capture (#23) closed; decide |
| Promo: source per code + one use per customer | 🔁 #48 | |
| Mobile speed | ✅ #50 | |
| Blog post caching | ❌ | Posts are `private, no-store` (every hit runs a function). v3.2 W8.5 |
| Attribution (first/last touch, channel, airport) | ✅ #26 since 17 Sep | Lead time: median about 2 days, about a third same-day, nearly all within 30 days → campaigns have a window of days |
| Admin monthly numbers page | ✅ #45 | Bookings, net take, repeat rate, sellable lots |
| Cancellation reasons | ✅ #47 | |

### 2.3 Supply and product
| Item | Status | Notes |
|---|---|---|
| Inventory | ResLab only (one source, ~285 sellable lots across 85 airports; 5 airports carry 10+, the median airport ~4) | Contract: 45-day no-cause exit either side; 12-month non-circumvention → **direct recruiting only for lots NOT on ResLab** |
| Direct lots | ✅ Phase 1 modules merged (#60); first direct lots live (JFK, 13 Oct) | New lots sign with Triply directly |
| /partners page | ✅ #56 | Inquiry form; "partners are paid monthly"; never lead with commission |
| Lot outreach tracker | ✅ | ~387 non-ResLab lots (hotels + operators), contacts sourced for 33 airports, 9-step sequence (8 emails + 1 call), monthly list after. The Parking Spot and WallyPark are **not** on ResLab |
| Dead lots on ResLab | ❌ | 13 lots / 11 airports at 0 bookable for months; ask ResLab |
| ResLab APB1/APB2 listings | ⏳ | Promised 28 Sep; email Sean for a firm date if not live by 3 Nov |
| Park & Stay (hotel + parking) | ✅ admin-only (#104, #106) on LiteAPI | Public launch = Tom. Economics favour **direct** hotel contracts over affiliate for packages |
| ParkGuard | ✅ preselected | Margin above wholesale is ours |

### 2.4 Distribution and measurement
| Item | Status | Notes |
|---|---|---|
| Social (IG, FB, Pinterest, LinkedIn) | ✅ 50 posts scheduled from 31 Oct via Metricool | Purpose: look legitimate to customers and to lots we approach. Profile clean-up (bios, FB name/address) due before launch |
| Backlinks | ✅ baseline tool (#63) | A handful of real linking domains. Plan (21 Oct): 20 real linking domains by 31 Dec |
| GA4, GSC, Bing Webmaster, Clarity | ✅ | GSC impressions unreliable May 2025–Apr 2026 (Google bug); AI sessions partly land in "(not set)"; ChatGPT referrers dropped Oct 9–15 |
| AI citation tracking | 🛠 `geo-tracker` (SerpAPI, Google AIO only) | No cross-assistant panel yet |
| Admin: bookings by channel, top airports, capture health | ✅ | |
| Monthly profit workbook | ✅ by trip-checkout month | Break-even is a few hundred dollars of fixed cost a month plus Stripe per booking |

### 2.5 Measured directions we build on
- The booking widget on articles produced the first measured booking lift from blog work; the lift was all blog landings.
- Rate/cost posts convert about 3× the blog average per click; promo-code posts get the most clicks and convert at about half.
- Bookings are spread across the long tail: about as many landing posts as bookings; a real share on posts with 0 Google clicks (Bing, AI, direct). **So no mass deletion, and survivor choice can't use Google data alone.**
- AI and no-referrer visits bring a large share of bookings and book at a much higher rate per session than Google visits; they land on commercial topics across ~1,000 posts.
- New posts get cited by assistants fast (within ~5 days at DTW, CLE, CVG, RDU).
- Within-site: a title and first paragraph that match the question helped retrieval; FAQ blocks, schema and author boxes didn't.
- Perplexity cited several of our own copies at once for a Newark question: duplicates don't just split Google; they dilute what an assistant reads.

---

## 3. Principles (every recipe obeys these)

1. **Step vs test** (the rule above). A step adds, corrects or protects. Removing, redirecting or rewriting a page that earns anything is a test.
2. **One page per question per airport.** Rates ≈ cost ≈ price ≈ fees is one question; long-term, hourly, each terminal/garage are different questions. Hubs are never merged.
3. **Answer first.** The direct answer and the key numbers (official rate, our cheapest all-in, shuttle frequency, distance, "as of <month>") in the title and first paragraph, phrased the way the question is asked.
4. **Keep the breadth; move the answers.** A merged copy's unique facts go into the destination as a section before its URL redirects. Nothing a reader or an assistant found disappears.
5. **Name our lots.** Every page that names a lot names at least one we sell, with the all-in price ("as of"). Naming lots we don't sell is fine; implying we sell them is not. `/api/search` is the only source of truth for what we sell; the catalogue JSONs are editorial.
6. **Honest comparisons.** "Cheaper than the terminal garage" (true at the median everywhere measured). Never "cheaper than the economy lot" without the airport's actual number, because at eleven airports we aren't.
7. **Every fact has a source and a month.** No promo-code strings without an official source. No "verified"/"working" next to a code. No occupancy snapshots (they go stale).
8. **Dates move only when facts change.** `contentUpdatedAt` is set by a person-approved apply whose diff changed facts. Never in bulk. Links aren't facts.
9. **New pages pass the duplicate guard first.** Growth never creates the copies cleanup removes.
10. **Measure all three channels before taking anything away**, pooled per airport, against controls, with a stop rule.
11. **Nothing fake.** No bought links, link networks, sock-puppet forum accounts, invented reviews or testimonials of unknown origin, fake freshness, or "verified" claims we didn't verify. These are the things that get a site removed from every channel at once.
12. **Protect the booking page from the blog.** A blog page may not outrank the airport booking page for "<airport> airport parking"; the hub links to it above the fold.

---

## 4. Track A — Protect and clean (v3.2 W0–W8, accepted; status added)

Everything in v3.2 stands. This section only records status and the few changes.

| v3.2 item | What | Owner | Status / change |
|---|---|---|---|
| W0 | Hand-fix ~10 worst live errors (Seattle rates, DFW receipt/veteran, Newark P6 artifacts, LGA/LAX/DFW promo copy, Logan "2028"). JSON backup first | Tom approves, Claude edits | ❌ not started; **do first** (assistants repeat what we publish) |
| W0b | Stop bulk stamping + rewording batches for covered airports | Vin | ✅ nothing bulk-stamps now; batches paused |
| W1.1–1.11 | Duplicate guard (normalised keyword vs every slug any status + redirect map), cluster context by similarity, facts from data file/cited URL, lint (artifact phrases, bare money, "verified" near codes, non-approved codes, unsourced "save N %"), promo framing, sellable-only, stamping in git, `status: 'review'` fix, `delete-post.ts` restricted, **answer-first**, **IndexNow in git on publish and update** | Vin | 🛠 partly in the running engine; lands in `main` with the engine PR (§5) |
| W7 | Measurement first (Bing AI Performance, GSC generative report, GA4 AI classification in our code, AI-fetcher log drain incl. cached hits, fixed prompt panel, weekly indexed counts, pre-merge export) | **Split:** Vin = prompt panel + Bing export + indexed counts; Tom + Claude = log drain (Q5) + GA4 classification | ❌ start week of Nov 2 (the Stage A clock starts when the baseline does) |
| W8.1–8.3 | Remove/source the "4.9 Rating" badge; generate airport count/list from config (homepage FAQ + meta); www schema URLs; 308 → permanent apex redirect | Tom + Claude | ❌ |
| W8.4 | Trustpilot profile; ask every customer the same neutral way | Tom decides | ❌ |
| W8.5 | Blog post caching (`generateStaticParams() { return [] }`; `getPostBySlug` throws on non-404) | Tom + Claude | ❌ |
| W8.6 | Bot Protection: log mode first; AI Bots ruleset on Allow | Tom | when it goes on |
| W2 | Merge **test**: Stage A zero-signal copies, Stage B ≤ 5 pairs per pilot airport; closest-intent destination, never hub/sub-pillar; one apply; `next.config` `redirects()` from a JSON map; draft after; revert order; unit test; render-time link swap; IndexNow both URLs; pilot BWI/LAX/BOS/EWR; controls | Tom + Vin | ❌ earliest early Dec. **Change:** candidates start from the 101 + 294 lists, filtered by Stage A's rule. **Change:** the destination gets the copy's unique answers as one added section (principle 4) |
| W3a / W3b | Rates pages: official figures updated in place monthly (step); new block / answer-first opening / meta (test, separate airports) | rotation | ❌ first W3a early Dec |
| W4 | P3c lot-price removal on P3's schedule; fact corrections on survivors | Vin + Claude | ⏸ with P3 |
| W5 | New ground | engine with W1 | ✅ every sellable airport has pages (§2.1); continues as §8 E |
| W6 | Year in titles | Tom decides | **Change:** small test at 2 non-pilot airports from Dec 1, decision by Dec 31 (Jan 1 makes "leave" the default) |
| §6 Not doing | mass deletion, monthly new posts, bulk date bumps, year batch, live price block, llms.txt work, schema/FAQ "for AI", chunking, fan-out chasing, Reddit seeding, GBP, Wikipedia | — | kept, with one proposal in §7 D-h (disclosed, person-written forum answers) |

---

## 5. Answers to v3.2's open questions

**Q1 — what stamps `contentUpdatedAt`?** Vin's engine copy (`vin/main`), five writers:
`src/index.ts:630` (regenerate existing slug), `src/perf-apply.ts:151,159` (perf body/FAQ additions),
`src/monthly-prices.ts:260` (hub price tables), `src/inject-coupon.ts:97` (coupon block),
`reports/lot-rewrite/publish.mts:56` (lot-article rewrites). Oct 13 = the lot-rewrite/API-rewrite runs
that week. Sep 23 is being matched against the perf ledgers; confirmed by Nov 6. None runs in bulk now.

**Q2 — which engine runs; what produced Oct 13–17?** `Triplyvin-main/scripts/blog-engine` on `vin/main`
plus one-off scripts under `scripts/blog-engine/reports/` (`lot-rewrite/api-rewrite.mts` on the Anthropic
Batch API wrote Oct 13–17; `new-airports/create.mts` wrote Oct 23–24: fact sheet → writer → separate
fact-check → relink → inbound links). That's why `main` has no record of the publish path, the stamps
or IndexNow. **Fix:** one `feat/*` PR by Nov 13 bringing the running engine into `main` (publish path,
stamping callers, IndexNow ping, new-airport scripts, duplicate guard, lint, answer-first); then
`vin/main` is frozen. v3.2's fallback done the other way round, because the running copy holds the
publish path and the in-repo one doesn't. Does the running copy ping IndexNow? On new-airport publish
yes; on updates no → W1.11.

**Q3 — a lot list the engine can read.** Until Tom adds a token endpoint, the engine reads live
`/api/search?...&surface=featured` (tagged so it doesn't count as a customer search) — what the Oct
fact sheets did. Decision: keep that, or build the endpoint.

**Q4 — P3c through preview → apply?** Yes, once it exists (§6 B-4); until then P3c stays on P3's schedule.

**Q5 — log drain for AI-fetcher hits incl. cached responses.** Tom's call on vendor/cost; it gates
Stage A eligibility and the AI metrics, so it is in the first week of the calendar.

**Q6 — wider rewrite of an AI-cited page?** Not in this plan. The hub rebuild (B-9) is the exception,
run at non-pilot airports first and read like a test.

---

## 6. Track B — Structure and indexing (make every page worth indexing, then make sure it is)

**Target shape per airport** (drives the guard, the merge destination and new writing):

| Level | Count | What | Examples |
|---|---|---|---|
| Hub | 1 | the airport's complete parking guide; the page an assistant should cite for "parking at <airport>" | `jfk-airport-parking` |
| Intent pages | 6–10 | one per distinct question | rates/cost · long-term/economy · short-term/hourly · off-site + shuttle · pick-up / cell-phone lot · terminal or garage X · hotel park-and-fly · holidays · (cruise port where relevant) |
| Spokes | as needed | a question none of the above answers | a specific lot we sell · a terminal move · a construction closure · an event |

Links: hub → every intent page and the **booking page above the fold**; intent page → hub, siblings,
its spokes; spoke → its intent page and the hub. Descriptive anchors; under ~45 links a page.

### Recipes
- **B-1 Request indexing for the 6 unindexed hubs** (Vin, Search Console, one by one; "URL is on Google" or a stated reason). Note: 5 of the 6 lose the head query to the booking page or `/blog/airport/<code>`; that's correct — the fix for those is the hub rebuild (B-9) and the booking page (F-1), not another request.
- **B-2 Linking pass** across existing posts, highest-traffic airports first: build the mesh above with `update-links.ts`'s Lexical round-trip and link-loss guard (the October `relink.mts` did this for 28 new airports). Dry run per airport → apply → spot-check 5 pages. No stamp. **This is the main push for the "crawled – not indexed" posts that aren't merge candidates:** links from strong pages are how Google reaches weak ones.
- **B-3 Redirect map as JSON** (`src/config/blog-redirects.mjs` → JSON both app and engine import), flattened, unit test (no chains, no loops, no key is a destination, every destination published), daily CMS check. Opens as an app PR with the map **empty**; entries land per signed-off pair.
- **B-4 Preview → apply command** in the engine (v3.2 W3.4): `--preview` writes the diff and runs lint + P3 check; a person reads it; `--apply` PATCHes by id, Lexical round-trip, stamps only on a facts diff, IndexNow. Every content edit from then on goes through it.
- **B-5 Merge test** (v3.2 W2) once B-3, B-4, the engine PR, Q5 and 4 weeks of baseline exist: run the 101 + 294 candidate pairs through Stage A's zero-signal filter → a person signs off each pair → one apply per pair (section added to the destination, map entry, source to draft, IndexNow both URLs) → watch 8–12 weeks → Stage B.
- **B-6 Corpus `&amp;` repair** through B-4 (≈2,700 posts; no stamp: not a fact change). Readers see "Park &amp; Ride" today.
- **B-7 Sitemap + Bing**: submit the sitemap in Bing Webmaster (GSC token is read-only); weekly indexed-URL counts in both as the early warning.
- **B-8 Weekly index-health file**: URL Inspection on the fixed 75-post sample monthly, plus every destination page's status (v3.2 §7).
- **B-9 Hub rebuild** (hubs get about a third of a spoke's clicks; the hub should be the page an assistant cites for "parking at <airport>"). For each hub, highest-traffic airports first, through preview → apply, `contentUpdatedAt` stamped because facts change:
  1. Answer first: cheapest official option, cheapest option we sell (all-in, "as of"), the garage gap from the index.
  2. One comparison table: every official lot + every lot we sell — all-in price per day, distance or shuttle time, hours.
  3. A real map where the title promises one.
  4. "Park or rideshare?" — a short table by distance (C-5).
  5. The booking page above the fold; links to every intent page, the spokes, and the latest index.
  6. The airport's construction/closure line (C-6) and holiday page (E-1) where they exist.
  Hubs are never merged, so this doesn't touch the merge test. Order: non-pilot airports first; the 4 pilot hubs after Stage A's readout, so the merge test isn't confounded. Read the before/after like a test (clicks, citations, bookings on the hub).

**Done when:** every airport's hub links to every intent page and the booking page; indexed-post count rises month on month; no hub is unindexed; the merge test has a clean Stage A readout.

---

## 7. Track C, D — Earn visibility: our own data, and links and mentions on other sites

### C — Publish the data only we have
We see live, fee-inclusive prices for every lot we sell, next to each airport's official rates.
Nobody else publishes that comparison. Assistants and reporters cite original numbers; a reworded fact
from the airport's site is interchangeable, ours isn't.

- **C-1 Thanksgiving index** (live): add a **method page** (dates, nights, fees and tax included, which lots, when checked) linked from the index, so a reporter or an assistant can trust and cite it. Add each indexed airport's line to its hub ("garage vs off-airport, fees included, as of <month>") with a link. Done when all 25 hubs carry it.
- **C-2 December holidays index**: same method, data by Nov 24, live Dec 1, pitched (D-1).
- **C-3 Monthly price index**: one rolling page per method ("Airport parking price index — <month>") updated in place, plus a dated edition per holiday. First edition Jan 5.
- **C-4 Official-rate tracker**: which airports raised garage/economy rates this year (we already hold the official rates for 30+ airports and re-verified 11 in October). One page, updated as rates change.
- **C-5 Park vs rideshare**: a table by distance and trip length (parking usually wins only beyond ~20 miles; the edge shrinks with trip length). One page + a short block on each hub.
- **C-6 Construction and closures calendar**: 21 of 30 airport files carry parking/shuttle construction and 17 an actual closure or capacity cut. One page per airport event, written **before** the date, linked from the hub (E-6 writes them).
- **C-7 Demand data ResLab can't see**: sold-out signals (#24), waitlist (#25) and search events show which airports and dates sell out. Publish as "busiest parking dates at <airport>" where the sample is sound; use the rest for outreach (H) and holiday pages (E).

### D — Links and mentions (earned, disclosed, no shortcuts)
| # | Tactic | How | Owner |
|---|---|---|---|
| D-1 | **Data PR** | 2–3 weeks before each holiday, pitch the index to travel desks and local news at every indexed airport ("Thanksgiving parking at <airport>: the garage is $X more than off-site"). Local TV and papers run this every year and need a number. Follow up once. | Vin |
| D-2 | **Reporter requests** | Answer journalist queries (Qwoted, Featured, HARO-style) on airport parking and holiday travel with a figure from the index and a named person. | Vin |
| D-3 | **Lots we sell** | Offer every operator a "Book on Triply" badge and a sentence for their site; /partners already lists them. Local, on-topic links. | Vin |
| D-4 | **Hotels / park-and-fly partners** | Every hotel in a Park & Stay package links to the package page from its parking/airport page. | Vin + Tom |
| D-5 | **Unlinked mentions** | Monthly search for "Triply" / "triplypro" without a link; ask for the link. | Vin |
| D-6 | **Broken links** | Find travel and city-guide pages linking to dead airport-parking pages; offer our page as the replacement. | Vin |
| D-7 | **Review profiles** | Trustpilot (W8.4) and our own verified reviews (#76/#119/#125) — assistants read reviews to judge trust. | Tom |
| D-8 | **Disclosed forum answers (decision)** | Only by a named person, disclosed as Triply, where the question is real and the answer helps without a link. v3.2 bans *seeding*; this asks to allow the disclosed form. | Tom decides |
| D-9 | **Directory and profile consistency** | LinkedIn company page, BBB, Crunchbase, social bios: same legal name, description, airport count, contact. Remove the street address and personal phone from public profiles. | Vin |
| D-10 | **Operator and hotel articles** | The 7 live operator articles + a "list your lot" series answer what operators search; they are also the pages partners link to. | Vin |

**Measure:** referring domains and linking pages (`npm run backlinks` from GSC + Bing exports), baseline week of Nov 2, then monthly. Brand mentions in AI answers via the prompt panel (named, not only linked).

---

## 8. Track E — New demand with buying intent (pages that bring people who are about to book)

- **E-1 Holiday pages** for the top airports by blog bookings, **only where the guard finds no page with that intent**: Thanksgiving (by Nov 10) and Christmas/New Year (by Nov 24). Answer-first: when the airport's lots sell out, what the garage costs, our cheapest all-in, book-by dates, shuttle timing. Official advisories cited. Written to be **updated** each year, not reissued. Linked from the hub and the index.
- **E-2 Park-sleep-fly pages**: one per airport where a package is sold ("park sleep fly <city>", "hotel with parking near <airport>"), live the week Park & Stay goes public. There was already heavy search demand on our hotel/park-sleep-fly content with nothing to sell against it; this closes that gap. Hotels link back (D-4). Prefer direct hotel contracts for packages (far better economics than affiliate).
- **E-3 Lot pages** (`/<city>/airport-parking/<lot>`): these are where people book and where assistants answer "best off-site lot at <airport>". Verified reviews (#119), shuttle details, hours, all-in price, "Limited spots". Tom's area; content from the fact sheets.
- **E-4 Airport booking pages**: see F-1. They are also demand pages: "<airport> airport parking" is the head term.
- **E-5 Cruise-port parking** where we sell lots (Port Everglades live; Miami, Tampa, Galveston where inventory exists).
- **E-6 Pre-written event pages**: for each dated closure/capacity cut in the airport files (C-6) and each known peak (spring break by airport, major events), a page live 4–6 weeks before, updated during, kept after as the record. Same shape as the 26 sold-out rescue articles, written before the event instead of during it.
- **E-7 New airports on first lot**: when an airport gets its first sellable lot, 3–5 intent pages within a week (the October method: fact sheet → writer → separate fact-check → relink → inbound links → IndexNow), and its airport page is re-indexed.
- **E-8 Commercial-intent keyword bias**: for any new keyword plan, prefer "book / compare / cheap / deal / long-term / off-site" over informational "rates" variants that AI Overviews answer without a click. Rates pages exist once per airport (W3); they don't multiply.
- **E-9 Social as footprint, not traffic**: 50 posts scheduled; the goal is that a customer or a lot operator who looks us up sees a real company. Measure referrals, expect little; don't spend on growth there.

---

## 9. Track F — Conversion (turn visitors into searches, searches into paid bookings)

| # | Recipe | Why | Owner | Done when |
|---|---|---|---|---|
| F-1 | **Rebuild the airport booking pages** (~265 words today): answer-first intro (cheapest official option, our cheapest all-in, garage gap), the live lot table with the all-in price and "Limited spots", shuttle/hours, a map, the hub's intent links, FAQ from the fact sheet. Keep it a booking page, not an article | Head-term pages rank ~50–77; this is the biggest single ranking lever on the site | Tom + Claude | pages ≥ 600 words of real content; head-term position improves at the pilot airports |
| F-2 | **Say the all-in sentence** on lot cards, search and checkout: "the price you see is the price you pay — fees and tax included" | Hidden cost is the #1 abandonment cause; we already compute it and never say it | Tom | live |
| F-3 | **Garage comparison on every lot card and hub**: "$X/day vs $Y at the terminal garage (official, as of <month>)" | Our strongest true sentence; garage-only, never economy | Tom (card) + Vin (data) | live at airports with a verified garage rate |
| F-4 | **Turn on the abandoned-checkout recovery email** (#44, flag) with one week of watching send counts and replies | Recovers a share of people who reached payment | Tom | flag on; sends + bookings from it visible in admin |
| F-5 | **Reviews on lot pages and search cards** (#119) + backfill ask (#125) + post-trip email on (#76 flag) | Showing a few reviews materially raises purchase likelihood; assistants read them | Tom | merged + flags on; first reviews visible |
| F-6 | **Trust fixes** (W8.1–8.3): no unsourced badge, no testimonials of unknown origin, correct scope copy, www schema, Trustpilot | Perplexity called us unverified | Tom + Claude | live |
| F-7 | **Promo rules**: one source per code, one use per customer (#48); "how to save" framing on promo posts; our own 10 %-off signup block where it helps (#99); never a code we can't source | Promo posts get the most clicks and convert worst | Tom + Vin | #48 merged; promo posts linted |
| F-8 | **Checkout rejections**: lot-declared fields enforced (#49, done); show the real reason when ResLab voids a payment; fix the 3 lots with attempts and no paid bookings ever | Each is a lost paid booking | Tom | no silent "payment not completed" |
| F-9 | **Blog widget + CTA**: keep the widget; add the airport's garage gap line above it; track widget clicks via the existing GA event (no internal UTMs — they overwrite attribution) | The widget is what turned article traffic into bookings | Vin | GA event reported weekly |
| F-10 | **Waitlist and sold-out capture everywhere a search returns nothing** (#24/#25 exist; make sure every empty result offers the waitlist and shows the nearest alternative) | Demand we currently lose silently | Tom | empty results always capture |
| F-11 | **Mobile**: keep the speed work (#50); check Core Web Vitals monthly in Clarity/GSC | Most holiday searches are on phones | Tom | no "poor" URLs |
| F-12 | **ParkGuard**: keep preselected; show the premium's value in one line | Margin above wholesale | Tom | — |
| F-13 | **Pricing tests** | parked (Vin, 27 Oct): the fee floor change showed no visible checkout drop; revisit after the holiday peak | — | ⏸ |

---

## 10. Track G — Repeat and retention (the second booking is the cheapest booking)

- **G-1 Post-trip review email on** (#76): ask shuttle wait, extra charges, comment, consent to show first name. Replies to support@ (monitored). This is also the source for reviews (F-5) and for the lot quality list (H-5).
- **G-2 Fix the case-sensitive email match** so repeat rate is measured right (it's a floor today).
- **G-3 Email list with a reason to exist**: the signup block (#99) + waitlist (#25) + review consent feed one list. Send only: (a) a holiday booking reminder 6–8 weeks before each peak at the airports the person searched, (b) the index edition for their airport, (c) "your airport opened for <holiday>" from the waitlist. No weekly newsletter.
- **G-4 Rebook prompt** on the confirmation page and in the post-trip email: "book your return / next trip at <airport>", with the all-in price and the garage gap.
- **G-5 Customer account value**: past bookings, saved airport, one-click rebook (Tom's area; after F).
- **G-6 Support loop**: every refund/cancellation reason (#47) reviewed monthly; the top reason becomes a page or a product fix.

---

## 11. Track H — Supply (protect against the one-supplier risk; more and better lots)

- **H-1 Outreach runs weekly** from the tracker: John sends the 9-step sequence to the ~66 lots with confirmed email first (SEA, AUS, DEN, LAX deepest), then by airport demand. No commission talk cold; "partners are paid monthly"; CTA /partners. Replies handled by John; terms on a call.
- **H-2 The big calls**: The Parking Spot (most-named operator in our articles; 11 airports; **not on ResLab**), WallyPark, FastPark, PreFlight — one person, one call plan each, after checking the operator isn't on ResLab at that airport (§10 non-circumvention; ask before approaching an operator that is on ResLab elsewhere).
- **H-3 Direct lots first where ResLab is thin**: AUS, CLT, DCA, IAD, IAH, MSP have ≤ 2 sellable lots each and real demand; a direct lot there adds supply and margin. Phase 1 modules exist (#60); wire and onboard with least friction (research first, pre-filled listing to OK, agreement then payment + W-9).
- **H-4 Dead lots**: 13 ResLab lots at 0 bookable for months → ask ResLab; meanwhile they stay out of articles (sellable-only rule).
- **H-5 Lot quality**: from reviews and cancellation reasons, a monthly list of lots with shuttle or extra-charge complaints → tell ResLab/the lot; hide repeat offenders (as done with one JFK lot).
- **H-6 Supply data for sales**: each outreach email carries the airport's Google demand and our sold-out signals; refresh monthly.
- **H-7 Second inventory source**: the agreement has no exclusivity; direct lots are the second source today. Keep the ResLab relationship (APB1/APB2 follow-up by Nov 3; pay by the 3rd; never 10 days late).
- **H-8 Tax check**: a CPA to confirm whether we owe parking tax (Illinois/Chicago first) and who pays it on ResLab bookings. Keep-the-business item.

---

## 12. Calendar (recipes on dates; S = step, T = test)

### Week of Nov 2 (and by Nov 13)
| # | Recipe | Owner | Kind | Done when |
|---|---|---|---|---|
| 1 | A-W0 hand fixes (~10 posts), JSON backup first | Tom approves, Claude edits | S | slugs read clean live |
| 2 | A-W7 baseline: prompt panel (fixed questions per pilot cluster + per index, 4 assistants, several runs), Bing AI Performance export, Google + Bing indexed counts, backlink baseline (`npm run backlinks`) | Vin | S | first week logged by Nov 6 |
| 3 | A-W7: log drain for AI-fetcher hits incl. cached (Q5) + GA4 AI classification in our code | Tom + Claude | S | hits per page recorded |
| 4 | A-W8.1–8.3 trust fixes; F-2 all-in sentence; F-3 garage line on lot cards (airports with verified garage rates) | Tom + Claude | S | live |
| 5 | B-1 request indexing for the 6 hubs | Vin | S | each hub resolved or explained |
| 6 | W1.11 IndexNow on every publish and update in the running engine | Vin | S | Bing shows pings |
| 7 | E-1 Thanksgiving pages for the top airports (guard-checked) + C-1 method page + index line on 25 hubs | Vin + Claude | S | live by Nov 10, linked from hubs |
| 8 | D-1 pitch the Thanksgiving index to local news at the 25 airports; D-2 reporter-request answers; D-9 profile consistency (remove address/phone, same description everywhere) | Vin | S | pitches sent, log kept |
| 9 | Engine PR into `main` (Q2): publish path, stamping rule, IndexNow, guard, lint, answer-first, new-airport scripts; `vin/main` frozen | Vin | S | merged |
| 10 | Q1 confirmed against the perf ledgers | Vin | S | named in the PR |
| 11 | H-1 outreach sequence starts (66 confirmed emails); H-7 APB1/APB2 follow-up | John / Vin | S | first sends logged |
| 12 | F-4 recovery email flag on (watch a week); G-1 post-trip review email flag on | Tom | S | sends visible in admin |
| 13 | Social foundation live (profiles cleaned before the 31 Oct first post) | Vin | S | bios/name fixed |

### Nov 16 – Nov 30
| # | Recipe | Owner | Kind | Done when |
|---|---|---|---|---|
| 14 | New-airport readout (Oct 13–17 + Oct 23–24 pages): indexed, impressions, AI citations, sessions by source, bookings per airport | Vin | S | one table |
| 15 | B-3 redirect map + `redirects()` + unit test + render-time link swap (app PR), map empty | Tom + Claude | S | merged |
| 16 | B-4 preview → apply command | Vin | S | dry run on one pair shows the added section + diff |
| 17 | B-5 prep: 101 + 294 pairs through Stage A's filter; Tom signs off | Vin, Tom | S | signed list |
| 18 | B-2 linking pass, highest-traffic airports first (dry run → apply → spot-check) | Vin | S | 10 airports/week |
| 19 | C-2 December index data (by Nov 24) + E-1 Christmas/New Year pages | Vin + Claude | S | live Dec 1 |
| 20 | F-1 booking-page rebuild: spec + the 4 pilot airports | Tom + Claude | S | pilot pages live |
| 21 | F-5 merge #119 + #125; W8.5 post caching; #48 promo | Tom | S | merged |
| 22 | H-2 The Parking Spot call plan; H-3 first direct-lot targets at thin airports | Vin / John | S | calls scheduled |
| 23 | G-3 holiday reminder email (one send, airports searched, 6–8 weeks before Christmas peak) | Vin + Tom | S | sent, measured |

### December
| # | Recipe | Owner | Kind | Done when |
|---|---|---|---|---|
| 24 | B-5 Stage A merges at BWI/LAX/BOS/EWR once W7 has 4 weeks | Vin + Tom | **T** | applied; watch 8–12 weeks |
| 25 | W3a first monthly in-place update of official figures on the rates pages | rotation | S | stamped only where facts changed |
| 26 | W6 year test at 2 non-pilot airports; decision by Dec 31 | Vin | **T** | decided |
| 27 | B-9 hub rebuilds, 5 airports/week, non-pilot first, through preview → apply | Vin + Claude | S (read like a test) | 20 hubs by Dec 31 |
| 28 | D-1 December index pitch; D-5/D-6 first unlinked-mention and broken-link sweeps | Vin | S | log |
| 29 | F-1 booking-page rebuild rolls to the next 10 airports | Tom + Claude | S | live |
| 30 | E-2 park-sleep-fly pages the week Park & Stay goes public; D-4 hotel link asks | Vin + Tom | S | live with launch |

### January – March
| # | Recipe | Owner | Kind | Done when |
|---|---|---|---|---|
| 31 | Stage A readout (v3.2 §7 + prompt panel); Stage B (≤ 5 pairs per pilot airport); roll out airport by airport on a clean readout | Tom + Vin | **T** | per §14 |
| 32 | C-3 monthly index first edition (Jan 5), then monthly; C-4 rate tracker; C-5 park-vs-rideshare page; B-9 remaining hubs incl. the 4 pilot hubs after the Stage A readout | Vin | S | live |
| 33 | W3b answer-first openings on existing rates pages, airports kept apart from the merges | rotation | **T** | per §14 |
| 34 | E-6 event pages for Q1–Q2 closures and spring break; E-5 cruise ports | Vin + Claude | S | live 4–6 weeks before |
| 35 | B-6 `&amp;` corpus repair; W4 fact corrections on survivors | Vin | S | done |
| 36 | G-2 repeat-rate fix; G-4 rebook prompt; G-5 account value | Tom | S | live |
| 37 | H-3 direct lots live at ≥ 3 thin airports; H-5 lot quality list monthly | Vin / John / Tom | S | live |
| 38 | Quarterly readout against §13; re-rank this document | Tom + Vin | — | v3.4 |

---

## 13. Targets (relative to the Nov 2 baseline; absolute figures in the notes)

| Measure | By Dec 31 | By Mar 31 |
|---|---|---|
| Blog + booking-page clicks (Google + Bing) | hold through the merge test, +25 % | **2×** Oct |
| Sessions from AI assistants (GA4 AI group + dark-AI segment) | +50 % | **2×** |
| Prompt panel: questions where Triply is named or cited | +25 % | **+50 %** |
| Indexed blog posts (Google) | no decline | "crawled – not indexed" share **halved** |
| Referring domains (real, earned) | **20** | **40** |
| Head-term position for "<airport> airport parking" at the 4 pilot airports | measurable improvement | top 20 |
| Search rate (visitor → search) and checkout rate | baseline logged | each **+20 %** |
| Repeat rate (measured correctly after G-2) | baseline | **+50 %** of baseline |
| Bookings | holiday peak captured | **2×** the Oct run-rate |
| Sellable airports with ≥ 3 lots | baseline | +6 airports (direct or ResLab) |

---

## 14. Measurement, stop rules and operating rhythm

**Pre-registered (v3.2 §7, kept):** query-set position and impressions per pilot cluster; GA4 sessions to destinations by source; bookings on destinations vs the merged posts' baseline; against matched untouched airports. Success = cluster query-set position +5 places or clicks +50 % vs controls at 8–12 weeks. Stop and revert a cluster if impressions fall 30 %+ vs controls after 6 weeks or the destination's bookings + sessions fall clearly below baseline. **Added:** if the prompt panel shows a merged pair losing its Triply citation in two or more assistants for two weeks running, revert that pair, whatever Google shows.

**Caveats we don't forget:** GSC impressions were unreliable May 2025–Apr 2026; GSC CTR is not a success metric; GA4 undercounts AI sessions (classify in our code; dark-AI segment); attribution exists since Sep 17 and not every booking carries it (unattributed = unknown, not zero); tool sweeps write fake `search_events` (filter on `ga_client_id`); the engine's own treatment-ROI numbers are survivorship-biased and not used here.

**Weekly (Vin, Monday):** prompt panel; Bing AI report; indexed counts; backlink delta; new-page indexing; the widget GA event; outreach sends/replies; one line per track in the team channel.
**Monthly (Tom + Vin, first business days):** W3a rates update; index edition; admin monthly numbers (bookings, net take, repeat, sellable lots, by channel); profit workbook; index-health sample; lot quality list; this document's status tables corrected.
**Quarterly:** readout against §13; re-rank the calendar; version bump.

---

## 15. Risks and confounds
- **Google quality action** from mass-produced variants: cleanup (A, B) is the insurance; growth creates only guard-checked pages.
- **Merging away AI/Bing bookings:** Stage A zero-signal only; Stage B capped; stop rule; EWR in the pilot so a loss shows.
- **Two engines, one outside git:** fixed by the engine PR (calendar #9); nothing else in W1 helps until then.
- **Holiday noise:** the peak, the trust fixes, caching, the year test and the merges all land Nov–Jan; dates logged; controls used; only large moves count.
- **One supplier:** 45-day exit either side; direct lots are the hedge; never late on payment; APB follow-up.
- **Claims risk:** "cheaper than the garage" is safe; "cheaper than economy" is not at eleven airports; lowest-price promises are a standing bill.
- **Dependence on Vin's Max plan / API credits** for writing: engine runs on the Max credit; keep the ledger.
- **People:** two devs plus John; every recipe names one owner; anything with no owner by its date moves to the next window rather than being half-done.

## 16. Not doing (kept from v3.2, plus)
Mass deletion · monthly new posts · bulk date bumps · year batch · live price block · llms.txt work, schema/FAQ "for AI", chunking, fan-out chasing · Reddit seeding, bought links, link networks, sock puppets · GBP (ineligible), Wikipedia (not yet) · paid ads at scale (two narrow exceptions stay in the marketing plan) · pricing tests until after the peak · a weekly newsletter · building a consumer app.

## 17. Decisions for Tom
1. Accept Q1–Q6 as answered (§5); the engine-into-`main` PR as the fix.
2. Growth, conversion, repeat and supply tracks run **alongside** cleanup as steps (they add, never remove).
3. Stage A candidates start from the 101 + 294 lists; destination gets the copy's answers as a section.
4. W6 small test from Dec 1, decide by Dec 31.
5. W7 split (Vin panel/Bing/indexed counts; Tom log drain/GA4).
6. F-1 booking-page rebuild is the head-term lever; spec together, Tom builds.
7. Flags on: recovery email (#44), post-trip review email (#76); merge #119, #125, #48.
8. D-8 disclosed forum answers: allow or keep banned.
9. Hub rebuilds stamp `contentUpdatedAt` (facts change) and run at non-pilot airports first.
10. Q3 lot list: keep tagged live search, or build the endpoint.
11. Q5 log drain vendor and cost.

## 18. Glossary
**Hub / intent page / spoke** — the three-level page shape per airport (§6). **Step / test** — safe for every channel vs measured with a way back. **Stage A / B** — the merge test's zero-signal and capped low-signal stages. **Prompt panel** — fixed questions asked weekly in four assistants, recording whether Triply is named/cited. **All-in** — the price with fees and tax, what the customer pays. **Garage gap** — official terminal-garage daily rate minus our cheapest all-in. **Sellable lot** — a lot returned by live `/api/search`; the catalogue is editorial. **Non-circumvention** — the ResLab clause that limits direct recruiting to lots not on ResLab. **IndexNow** — the ping that tells Bing (and so Copilot) a URL changed. **Dark AI** — direct visits landing on deep posts, a proxy for unreferred assistant traffic.

## 19. The execution list — every step, in order

This is the whole roadmap as one ordered list. No dates: each step starts when the one before it is done or in flight, and the only gates are stated inline (a measurement baseline of 4 weeks before any merge; an 8–12-week watch after). Each step names its recipe, owner, and done-when. Tick in place; when a step is done, the next one is the job.

1. A-W0 — back up and hand-fix the ~10 worst live posts (Seattle, DFW ×2, Newark ×2, LGA, LAX, Logan). Tom approves, Claude edits. Done: slugs read clean live.
2. A-W7 — write the prompt-panel question set (per pilot cluster + per index; 4 assistants; 3 runs each). Vin. Done: sheet exists, week-1 run logged.
3. A-W7 — Bing Webmaster AI Performance export; sitemap submitted to Bing. Vin. Done: first export saved.
4. A-W7 — Google + Bing indexed-URL counts logged (weekly from now). Vin.
5. D — backlink baseline (`npm run backlinks` from fresh GSC + Bing exports). Vin. Done: referring-domain count dated.
6. A-W7 — GA4 AI-source classification in our code + "dark AI" segment. Tom + Claude. Done: `/admin/analytics` and attribution agree.
7. A-W7 — Q5 decided: log drain vendor, cost, turned on, cached hits included. Tom. Done: hits per page visible.
8. A-W8.1 — "4.9 Rating" badge removed or sourced; testimonials of unknown origin removed. Tom + Claude.
9. A-W8.2 — homepage FAQ + meta generated from config (airport count/list). Tom + Claude.
10. A-W8.3 — www in all schema URLs; apex → www made permanent. Tom.
11. F-2 — the all-in sentence on lot cards, search and checkout. Tom.
12. F-3 — garage-gap line on lot cards at airports with a verified official garage rate; data file from Vin. Tom + Vin.
13. B-1 — request indexing for the 6 unindexed hubs in Search Console. Vin. Done: each resolved or explained.
14. W1.11 — IndexNow ping on every update in the running engine (publish already pings). Vin. Done: Bing shows pings.
15. E-1 — Thanksgiving pages for the top 10 airports by blog bookings, guard-checked, answer-first, cited advisories, linked from hubs. Vin + Claude. Done: live, linked from hubs.
16. C-1 — index method page live, linked from the Thanksgiving index. Vin + Claude.
17. C-1 — the airport's index line + link added to all 25 indexed hubs. Vin + Claude.
18. D-1 — Thanksgiving index pitched to local news/travel desks at the 25 airports; log of who/when. Vin.
19. D-2 — reporter-request accounts set up; first answers sent. Vin.
20. D-9 — LinkedIn/BBB/Crunchbase/social bios: same legal name, description, airport count; street address and personal phone removed. Vin.
21. E-9 — social profiles cleaned before the first scheduled post. Vin.
22. H-1 — outreach sequence starts for the 66 confirmed-email lots. John. Done: first sends logged in the tracker.
23. H-7 — APB1/APB2 follow-up email to ResLab if not yet live. Vin.
24. F-4 — abandoned-checkout recovery email flag ON; watch sends/replies daily for a week. Tom.
25. G-1 — post-trip review email flag ON; support@ monitored. Tom.
26. §5 Q1 — Sep 23 stamp source confirmed against the perf ledgers. Vin.
27. §5 Q2 — engine PR branch cut from `main`: publish path, stamping rule, IndexNow, guard, lint, answer-first, new-airport scripts. Vin.

28. Engine PR reviewed (`/scoped-review`) and merged; `vin/main` frozen. Vin, Tom merges.
29. B-3 — redirect map as JSON + `next.config` `redirects()` + unit test + render-time link swap; map empty. Tom + Claude. Done: merged.
30. B-4 — preview → apply command; dry run on one post shows diff + lint. Vin.
31. B-5 prep — 101 + 294 candidate pairs run through Stage A's zero-signal filter; Tom signs off each pair. Vin, Tom.
32. B-2 — linking pass, airports 1–10 by traffic (dry run → apply → spot-check 5 pages each). Vin.
33. F-1 — booking-page rebuild spec agreed (sections, data sources, fact-sheet feed). Tom + Vin.
34. F-5 — #119 (reviews on lot pages/cards) and #125 (review backfill ask) merged; #48 (promo source/one-use) merged. Tom.
35. A-W8.5 — blog post caching shipped (`generateStaticParams`, `getPostBySlug` throws on non-404). Tom + Claude.
36. E-1 — Christmas/New Year pages for the top 10 airports. Vin + Claude. Done: live, linked from hubs.
37. C-2 — December index data collection scripted and scheduled (pull the week before it goes live). Vin.
38. H-2 — The Parking Spot call plan (which airports, who, the ask); WallyPark/FastPark/PreFlight queued. Vin.
39. H-3 — direct-lot target list at AUS/CLT/DCA/IAD/IAH/MSP (non-ResLab only), first 6 approached. Vin + John.
40. G-3 — holiday booking-reminder email to the list (airports searched, Christmas peak). Vin + Tom. Done: sent, bookings from it visible.
41. A-W8.4 — Trustpilot decision; profile opened if yes. Tom.
42. D-10 — "list your lot" article series brief (3 pieces) written. Vin.

43. Readout — Oct 13–17 + Oct 23–24 new-airport pages: indexed, impressions, citations, sessions by source, bookings per airport; what to replicate. Vin.
44. B-2 — linking pass, airports 11–30. Vin.
45. F-1 — booking pages rebuilt at the 4 pilot airports. Tom + Claude. Done: live, ≥ 600 words of real content.
46. B-9 — hub rebuilds 1–10 (non-pilot airports) through preview → apply. Vin + Claude.
47. C-2 — December index live + D-1 pitch. Vin + Claude.
48. D-3 — "Book on Triply" badge + sentence offered to every lot we sell (email via the tracker). Vin.
49. D-5 — unlinked-mention sweep #1; link asks sent. Vin.
50. D-6 — broken-link sweep #1 (travel/city guides linking to dead parking pages); replacement offers sent. Vin.
51. E-5 — cruise-port pages where we sell lots. Vin + Claude.
52. E-6 — event pages for every Q1 closure/capacity cut in the airport files + spring break by airport. Vin + Claude.
53. C-4 — official-rate tracker page (who raised garage/economy rates in 2026). Vin + Claude.
54. C-5 — park-vs-rideshare page + hub block. Vin + Claude.
55. B-6 — `&amp;` corpus repair through preview → apply (no stamp). Vin.
56. H-4 — dead-lot list sent to ResLab. Vin.
57. H-8 — CPA engaged on parking tax (Illinois/Chicago first). Vin.
58. F-8 — real reason shown when ResLab voids a payment; the 3 never-paid lots fixed or hidden. Tom.
59. F-10 — every empty search result offers the waitlist + nearest alternative. Tom.
60. G-6 — first monthly review of cancellation reasons; top reason → page or fix. Tom + Vin.

61. B-5 — Stage A merges at BWI/LAX/BOS/EWR — gate: 4 weeks of W7 baseline, steps 29–31 done: one apply per pair, map entry, draft, IndexNow both. Vin + Tom. **Test; watch 8–12 weeks.**
62. W3a — first monthly in-place update of official figures on every rates page. Rotation.
63. W6 — year test at 2 non-pilot airports; decide before the year turns. Vin.
64. B-9 — hub rebuilds 11–30. Vin + Claude.
65. F-1 — booking pages rebuilt at the next 10 airports. Tom + Claude.
66. E-2 — park-sleep-fly pages the week Park & Stay goes public; D-4 hotel link asks. Vin + Tom.
67. G-2 — case-sensitive email match fixed; repeat rate re-measured. Tom.
68. G-4 — rebook prompt on confirmation page + post-trip email. Tom.
69. H-5 — first lot-quality list from reviews + cancellations → ResLab/lots. Vin.
70. H-3 — ≥ 3 direct lots live at thin airports. Vin + John + Tom.
71. D-1/D-5/D-6 — index pitch follow-ups; sweep #2. Vin.
72. Checkpoint readout — §13 first-checkpoint targets vs baseline; §2 status tables corrected. Tom + Vin.

73. C-3 — monthly price index, first edition; rolling page. Vin.
74. B-9 — hubs 31+ ; the 4 pilot hubs **after** the Stage A readout. Vin + Claude.
75. F-1 — booking pages rebuilt at all airports with ≥ 3 lots. Tom + Claude.
76. E-7 — standing rule live: new airport → 3–5 pages within a week of its first lot. Vin.
77. G-5 — customer account: past bookings, saved airport, one-click rebook. Tom.
78. W4 — fact corrections on all merge destinations. Vin.
79. Stage A readout — gate: 8 weeks after step 61 — go/stop per §14; Stage B pairs signed off. Tom + Vin. **Test.**
80. W3b — answer-first openings on existing rates pages at airports kept apart from the merges. Rotation. **Test.**
81. Quarter readout — §13 scored, calendar re-ranked, **v3.4** published. Tom + Vin.

**Then, monthly for as long as the company exists:** W3a figures · index edition · pitch · sweeps #5/#6 · hub and booking-page refresh on a facts diff · lot-quality list · outreach list refresh with demand data · readout and re-rank.

*Created October 30, 2026 — Vin's reply to v3.2; rewritten the same day as the whole-funnel roadmap.*
