# Triply Blog Growth Roadmap v3.4 — protect what the blog built, then grow its traffic and bookings (2026-10-30)

**What this is.** The roadmap for the blog, and only the blog: on-page, off-page, AI-search visibility,
indexing, our own data, links and mentions, new pages, and the process that tracks it. It keeps everything
in Tom's v3.2 (`docs/blog/blog-plan-v3.2.md`, PR #110) that protects what the blog has, and adds the growth
work without which cleanup only slows the decline. Checkout, site trust, supply and customer emails live in
the Triply Marketing Plan, not here.

**How to use it.** It is a living document. Each track has a status table (where we are), a target
(where we are going), and numbered recipes (exactly what to do, in order, with "done when"). The
execution list (§16) is every recipe as one ordered list, no dates. When something ships, tick it there and the next step
is the job. Re-read §2 (status) and §9 (targets) at every monthly readout and correct them.

**Public copy.** This repo is public. Traffic, booking, conversion and revenue figures are left out or
given as directions and ratios. The full numbers live in Tom's and Vin's notes.

> **The rule (Tom, 2026-10-21, unchanged).** SEO means Google **and** AI assistants (ChatGPT, Gemini,
> Copilot, Perplexity, Claude) **and** Bing, and it drives the business. A change is a *step* only if
> the evidence says it helps all of them and hurts none. Anything we can't show is safe for every
> channel is a *test*: small, measured on all three before and after, against controls, with a way back.

---

## 1. The goal, and the blog's part of the equation

Bookings = **visitors × search rate × checkout rate × (1 + repeat rate)**. The blog owns the first factor
and half of the second: bring people in from Google, Bing and AI assistants, and send them into a search
from a page that answers their question and shows the widget. Every recipe here moves or protects that.

| Factor | What moves it | Track |
|---|---|---|
| Visitors | pages that are indexed, rank, and get cited by assistants; links and mentions on other sites; our own data that others quote; new questions we answer first; social and partner footprint | B, C, D, E |
| Search rate (visitor → runs a search) | answer-first pages, the booking widget on every article, honest prices, the hub linking to the booking page | B, E |
| What we protect | index health, no self-competition, no fake freshness, no claims we can't source, no dependence on one supplier | A |

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
| Year "2026" in ~3,600 titles | ⏸ | Stays through the peak; test after the peak readout (step 42) |
| IndexNow | ✅ key live; ping in running engine on new-airport publish; **not in git** | Bing/Copilot path |
| Thanksgiving price index | ✅ live 29 Oct | 25 airports, garage vs off-airport, press pitch drafted, not sent |
| Holiday pages | ❌ | Only two Thanksgiving posts exist (DEN, AUS) |
| Sold-out "rescue" articles | ✅ 26 live | Written during events; §E6 writes them before events |
| Partner/operator articles | ✅ 7 live, CTA → /partners | |

### 2.2 Site facts the blog depends on (owner: Tom; tracked in the Marketing Plan)
| Item | Status | Notes |
|---|---|---|
| Booking widget on every article | ✅ #22 | Measured: blog-landing bookings rose several-fold the week it shipped; first ChatGPT/Copilot-referred bookings seen the same week |
| Booking pages link to the airport's guides | ✅ #97 | |
| Airport booking pages | ❌ thin | ~265 words; rank ~50–77 for "<airport> airport parking". The biggest head-term lever on the site. Tom's area |
| All-in price | ✅ rendered on lot cards; **never said in words** | "The price you see is the price you pay" is true and absent |
| "~70 % cheaper than the terminal garage" | ✅ true at the median of our lots at every measured airport | Never on the site. Against the airport's **economy** lot we are only ~30 % cheaper and **dearer** at AUS, IAH, ORD, PBI, DSM, PVD, HPN, MDW, ALB, FAT, SAV — so the claim is garage-only |
| Homepage "4.9 Rating" badge, "JFK and LGA only" copy | ❌ | Perplexity called Triply "unverified" from these. v3.2 W8 |
| 10 %-off signup block on promo posts | ✅ #99 | Article-wide capture (#23) closed; decide |
| Blog post caching | ❌ | Posts are `private, no-store` (every hit runs a function). v3.2 W8.5 |
| Attribution (first/last touch, channel, airport) | ✅ #26 since 17 Sep | Lead time: median about 2 days, about a third same-day, nearly all within 30 days → campaigns have a window of days |

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
| W7 | Measurement first (Bing AI Performance, GSC generative report, GA4 AI classification in our code, AI-fetcher log drain incl. cached hits, fixed prompt panel, weekly indexed counts, pre-merge export) | **Split:** Vin = prompt panel + Bing export + indexed counts; Tom + Claude = log drain (Q5) + GA4 classification | ❌ step 3; step 4; step 5; step 6; hand-off H1; hand-off H2 (the Stage A clock starts when the baseline does) |
| W8.1–8.3 | Remove/source the "4.9 Rating" badge; generate airport count/list from config (homepage FAQ + meta); www schema URLs; 308 → permanent apex redirect | Tom + Claude | ❌ |
| W8.4 | Trustpilot profile; ask every customer the same neutral way | Tom decides | ❌ |
| W8.5 | Blog post caching (`generateStaticParams() { return [] }`; `getPostBySlug` throws on non-404) | Tom + Claude | ❌ |
| W8.6 | Bot Protection: log mode first; AI Bots ruleset on Allow | Tom | when it goes on |
| W2 | Merge **test**: Stage A zero-signal copies, Stage B ≤ 5 pairs per pilot airport; closest-intent destination, never hub/sub-pillar; one apply; `next.config` `redirects()` from a JSON map; draft after; revert order; unit test; render-time link swap; IndexNow both URLs; pilot BWI/LAX/BOS/EWR; controls | Tom + Vin | ❌ earliest early Dec. **Change:** candidates start from the 101 + 294 lists, filtered by Stage A's rule. **Change:** the destination gets the copy's unique answers as one added section (principle 4) |
| W3a / W3b | Rates pages: official figures updated in place monthly (step); new block / answer-first opening / meta (test, separate airports) | rotation | ❌ first W3a early Dec |
| W4 | P3c lot-price removal on P3's schedule; fact corrections on survivors | Vin + Claude | ⏸ with P3 |
| W5 | New ground | engine with W1 | ✅ every sellable airport has pages (§2.1); continues as §8 E |
| W6 | Year in titles | Tom decides | **Change (v3.4):** the year stays as it is through the peak; a small test at 2 non-pilot airports only after the peak readout (step 42). The new year makes "leave" the default, and that is accepted |
| §6 Not doing | mass deletion, monthly new posts, bulk date bumps, year batch, live price block, llms.txt work, schema/FAQ "for AI", chunking, fan-out chasing, Reddit seeding, GBP, Wikipedia | — | kept, with one proposal in §7 D-h (disclosed, person-written forum answers) |

---

## 5. Answers to v3.2's open questions

**Q1 — what stamps `contentUpdatedAt`?** Vin's engine copy (`vin/main`), five writers:
`src/index.ts:630` (regenerate existing slug), `src/perf-apply.ts:151,159` (perf body/FAQ additions),
`src/monthly-prices.ts:260` (hub price tables), `src/inject-coupon.ts:97` (coupon block),
`reports/lot-rewrite/publish.mts:56` (lot-article rewrites). Oct 13 = the lot-rewrite/API-rewrite runs
that week. **The Sep 23 stamps (778 posts) are the quick-answer rollout** of 22–23 Sep (`perf run --only quick-answer --apply`, via `perf-apply.ts`): every stamped post gained a "Quick answer" block as its first paragraph, and the ledger time equals `contentUpdatedAt` on 778/778. Each stamp coincided with a real body change, not a date bump; what was missing was the rule that only a facts change may stamp (W1.7). Confirmed 30 Oct (`notes/q1-stamp-source-2026-10-30.md`). None runs in bulk now.

**Q2 — which engine runs; what produced Oct 13–17?** `Triplyvin-main/scripts/blog-engine` on `vin/main`
plus one-off scripts under `scripts/blog-engine/reports/` (`lot-rewrite/api-rewrite.mts` on the Anthropic
Batch API wrote Oct 13–17; `new-airports/create.mts` wrote Oct 23–24: fact sheet → writer → separate
fact-check → relink → inbound links). That's why `main` has no record of the publish path, the stamps
or IndexNow. **Fix:** one `feat/*` PR (steps 1–2) bringing the running engine into `main` (publish path,
stamping callers, IndexNow ping, new-airport scripts, duplicate guard, lint, answer-first); then
`vin/main` is frozen. v3.2's fallback done the other way round, because the running copy holds the
publish path and the in-repo one doesn't. Does the running copy ping IndexNow? On new-airport publish
yes; on updates no → W1.11.

**Q3 — a lot list the engine can read.** Until Tom adds a token endpoint, the engine reads live
`/api/search?...&surface=featured` (tagged so it doesn't count as a customer search) — what the Oct
fact sheets did. Decision: keep that, or build the endpoint.

**Q4 — P3c through preview → apply?** Yes, once it exists (§6 B-4); until then P3c stays on P3's schedule.

**Q5 — log drain for AI-fetcher hits incl. cached responses.** Tom's call on vendor/cost; it gates
Stage A eligibility and the AI metrics, so it sits with Tom in the Marketing Plan; the blog's merge test waits for it.

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
- **B-1 Request indexing for the 6 unindexed hubs** (Vin, Search Console, one by one; "URL is on Google" or a stated reason). Note: 5 of the 6 lose the head query to the booking page or `/blog/airport/<code>`; that's correct — the fix for those is the hub rebuild (B-9) and Tom's booking-page work, not another request.
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
- **C-2 December holidays index**: same method, data pulled the week before, live before the December peak, pitched (D-1).
- **C-3 Monthly price index**: one rolling page per method ("Airport parking price index — <month>") updated in place, plus a dated edition per holiday. First edition at step 43.
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

**Measure:** referring domains and linking pages (`npm run backlinks` from GSC + Bing exports), baseline at step 6, then monthly. Brand mentions in AI answers via the prompt panel (named, not only linked).

---

## 8. Track E — New demand with buying intent (pages that bring people who are about to book)

- **E-1 Holiday pages** for the top airports by blog bookings, **only where the guard finds no page with that intent**: Thanksgiving (step 10) and Christmas/New Year (step 21), each live well before its peak. Answer-first: when the airport's lots sell out, what the garage costs, our cheapest all-in, book-by dates, shuttle timing. Official advisories cited. Written to be **updated** each year, not reissued. Linked from the hub and the index.
- **E-2 Park-sleep-fly pages**: one per airport where a package is sold ("park sleep fly <city>", "hotel with parking near <airport>"), live the week Park & Stay goes public. There was already heavy search demand on our hotel/park-sleep-fly content with nothing to sell against it; this closes that gap. Hotels link back (D-4). Prefer direct hotel contracts for packages (far better economics than affiliate).
- **E-3 Lot pages** (`/<city>/airport-parking/<lot>`): these are where people book and where assistants answer "best off-site lot at <airport>". Verified reviews (#119), shuttle details, hours, all-in price, "Limited spots". Tom's area; content from the fact sheets.
- **E-4 Airport booking pages** (Tom's, in the Marketing Plan): the head-term pages. The blog's job is to link every hub to them above the fold and never outrank them.
- **E-5 Cruise-port parking** where we sell lots (Port Everglades live; Miami, Tampa, Galveston where inventory exists).
- **E-6 Pre-written event pages**: for each dated closure/capacity cut in the airport files (C-6) and each known peak (spring break by airport, major events), a page live 4–6 weeks before, updated during, kept after as the record. Same shape as the 26 sold-out rescue articles, written before the event instead of during it.
- **E-7 New airports on first lot**: when an airport gets its first sellable lot, 3–5 intent pages within a week (the October method: fact sheet → writer → separate fact-check → relink → inbound links → IndexNow), and its airport page is re-indexed.
- **E-8 Commercial-intent keyword bias**: for any new keyword plan, prefer "book / compare / cheap / deal / long-term / off-site" over informational "rates" variants that AI Overviews answer without a click. Rates pages exist once per airport (W3); they don't multiply.
- **E-9 Social as footprint, not traffic**: 50 posts scheduled; the goal is that a customer or a lot operator who looks us up sees a real company. Measure referrals, expect little; don't spend on growth there.

---

## 9. Targets (relative to the baseline taken at steps 3–6; absolute figures in the notes)

| Measure | First checkpoint (after step 41) | Quarter readout (step 49) |
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

## 10. Measurement, stop rules and operating rhythm

**Pre-registered (v3.2 §7, kept):** query-set position and impressions per pilot cluster; GA4 sessions to destinations by source; bookings on destinations vs the merged posts' baseline; against matched untouched airports. Success = cluster query-set position +5 places or clicks +50 % vs controls at 8–12 weeks. Stop and revert a cluster if impressions fall 30 %+ vs controls after 6 weeks or the destination's bookings + sessions fall clearly below baseline. **Added:** if the prompt panel shows a merged pair losing its Triply citation in two or more assistants for two weeks running, revert that pair, whatever Google shows.

**Caveats we don't forget:** GSC impressions were unreliable May 2025–Apr 2026; GSC CTR is not a success metric; GA4 undercounts AI sessions (classify in our code; dark-AI segment); attribution exists since Sep 17 and not every booking carries it (unattributed = unknown, not zero); tool sweeps write fake `search_events` (filter on `ga_client_id`); the engine's own treatment-ROI numbers are survivorship-biased and not used here.

**Weekly (Vin, Monday):** prompt panel; Bing AI report; indexed counts; backlink delta; new-page indexing; the widget GA event; outreach sends/replies; one line per track in the team channel.
**Monthly (Tom + Vin, first business days):** W3a rates update; index edition; admin monthly numbers (bookings, net take, repeat, sellable lots, by channel); profit workbook; index-health sample; lot quality list; this document's status tables corrected.
**Quarterly:** readout against §9; re-rank the execution list; version bump.

---

## 11. Risks and confounds
- **Google quality action** from mass-produced variants: cleanup (A, B) is the insurance; growth creates only guard-checked pages.
- **Merging away AI/Bing bookings:** Stage A zero-signal only; Stage B capped; stop rule; EWR in the pilot so a loss shows.
- **Two engines, one outside git:** fixed by the engine PR (steps 1–2); nothing else in W1 helps until then.
- **Holiday noise:** the peak, the trust fixes, caching, the year test and the merges all land Nov–Jan; dates logged; controls used; only large moves count.
- **One supplier:** 45-day exit either side; direct lots are the hedge; never late on payment; APB follow-up.
- **Claims risk:** "cheaper than the garage" is safe; "cheaper than economy" is not at eleven airports; lowest-price promises are a standing bill.
- **Dependence on Vin's Max plan / API credits** for writing: engine runs on the Max credit; keep the ledger.
- **Too many things at once:** the review's main worry. The execution list now puts the engine PR, measurement, the two flags and the booking pages ahead of everything else, and defers the year test and W3b until after the peak readout. Tests never overlap: one test in flight per airport.
- **The "not doing" list is a guard, not a preference:** no monthly new posts, no bulk stamps, no live price block; the duplicate guard stays strict and is never loosened to ship faster.
- **People:** two devs plus John; every recipe names one owner; anything with no owner by its date moves to the next window rather than being half-done.

## 12. Not doing (kept from v3.2, plus)
Mass deletion · monthly new posts · bulk date bumps · year batch · live price block · llms.txt work, schema/FAQ "for AI", chunking, fan-out chasing · Reddit seeding, bought links, link networks, sock puppets · GBP (ineligible), Wikipedia (not yet) · paid ads at scale (two narrow exceptions stay in the marketing plan) · pricing tests until after the peak · a weekly newsletter · building a consumer app.

## 13. Decisions for Tom
1. Accept Q1–Q6 as answered (§5); the engine-into-`main` PR as the fix.
2. Growth, conversion, repeat and supply tracks run **alongside** cleanup as steps (they add, never remove).
3. Stage A candidates start from the 101 + 294 lists; destination gets the copy's answers as a section.
4. W6: leave the year through the peak; small test at 2 non-pilot airports after the peak readout (step 42).
5. W7 split (Vin panel/Bing/indexed counts; Tom log drain/GA4).
6. D-8 disclosed forum answers: allow or keep banned.
7. Hub rebuilds stamp `contentUpdatedAt` (facts change) and run at non-pilot airports first.
8. Q3 lot list: keep tagged live search, or build the endpoint.
9. Q5 log drain vendor and cost.

## 14. Review ledger (v3.3 → v3.4)

One outside review of v3.3 (senior growth lead framing). Every recommendation and what changed:

| # | Recommendation | v3.4 |
|---|---|---|
| 1 | Engine PR is the critical path; land it before anything content-related; freeze `vin/main` the same day | Execution list steps 1–2; nothing content-side ships until it lands |
| 2 | Pull F-1 (booking-page rebuild) forward; the 4 pilot airports early | Moved to the Marketing Plan (site work, Tom); the blog hub links to the booking page above the fold |
| 3 | Turn on the two flags now (#44 recovery, #76 post-trip review) | Moved to the Marketing Plan (site flags, Tom) |
| 4 | Cap concurrent tests: Stage A only after a clean 4-week baseline; defer W6 and W3b past the peak readout | Stage A gate unchanged (step 36); W6 moved to step 42 (after the checkpoint readout); W3b to step 48 (after the Stage A readout); §11 "one test in flight per airport" |
| 5 | Supply focus: the 6 thin high-demand airports for direct lots over broad outreach | Moved to the Marketing Plan (supply) |
| 6 | Measurement in the first week is non-negotiable | Steps 3–8 precede every judged change; the stop rules depend on them |
| 7 | Protect the "not doing" list; keep the duplicate guard strict | §11 risk line added; §12 unchanged |

Not adopted: none. The reviewer's dating ("by mid-November") is not carried into the document, which has no dates by design.

## 15. Glossary
**Hub / intent page / spoke** — the three-level page shape per airport (§6). **Step / test** — safe for every channel vs measured with a way back. **Stage A / B** — the merge test's zero-signal and capped low-signal stages. **Prompt panel** — fixed questions asked weekly in four assistants, recording whether Triply is named/cited. **All-in** — the price with fees and tax, what the customer pays. **Garage gap** — official terminal-garage daily rate minus our cheapest all-in. **Sellable lot** — a lot returned by live `/api/search`; the catalogue is editorial. **Non-circumvention** — the ResLab clause that limits direct recruiting to lots not on ResLab. **IndexNow** — the ping that tells Bing (and so Copilot) a URL changed. **Dark AI** — direct visits landing on deep posts, a proxy for unreferred assistant traffic.

## 16. The execution list — every blog step, in order

The blog roadmap as one ordered checklist. No dates: a step starts when the one before it is done or in flight. Gates are inline (4 weeks of measurement before any merge; 8 weeks of watching before the merge readout). Blocks are reading aids; the numbers are the order. Tick in place; the next unticked step is the job. Work the blog depends on but doesn't own (checkout, site trust, supply, customer emails) is tracked in the Triply Marketing Plan.

### Block 1 — Critical path
- [x] **1.** **§5 Q2** — engine PR branch cut from `main`: publish path, stamping rule, IndexNow, guard, lint, answer-first, new-airport scripts. Vin.
- [ ] **2.** Engine PR reviewed (`/scoped-review`) and merged; `vin/main` frozen the same day. **Critical path: nothing content-side ships until this lands**. Vin, Tom merges.

### Block 2 — Measurement baseline (the stop rules depend on these)
- [ ] **3.** **A-W7** — write the prompt-panel question set (per pilot cluster + per index; 4 assistants; 3 runs each). Vin. Done: sheet exists, week-1 run logged.
- [ ] **4.** **A-W7** — Bing Webmaster AI Performance export; sitemap submitted to Bing. Vin. Done: first export saved.
- [ ] **5.** **A-W7** — Google + Bing indexed-URL counts logged (weekly from now). Vin.
- [ ] **6.** **D** — backlink baseline (`npm run backlinks` from fresh GSC + Bing exports). Vin. Done: referring-domain count dated.

### Block 3 — Fix the worst, index the hubs, IndexNow
- [x] **7.** **A-W0** — back up and hand-fix the ~10 worst live posts (Seattle, DFW ×2, Newark ×2, LGA, LAX, Logan). Tom approves, Claude edits. Done: slugs read clean live.
- [ ] **8.** **B-1** — request indexing for the 6 unindexed hubs in Search Console. Vin. Done: each resolved or explained.
- [x] **9.** **W1.11** — IndexNow ping on every update in the running engine (publish already pings). Vin. Done: Bing shows pings.

### Block 4 — Thanksgiving pages, the index, first pitch, off-page profiles
- [x] **10.** **E-1** — Thanksgiving pages for the top 10 airports by blog bookings, guard-checked, answer-first, cited advisories, linked from hubs. Vin + Claude. Done: live, linked from hubs.
- [x] **11.** **C-1** — index method page live, linked from the Thanksgiving index. Vin + Claude.
- [ ] **12.** **C-1** — the airport's index line + link added to all 25 indexed hubs. Vin + Claude.
- [ ] **13.** **D-1** — Thanksgiving index pitched to local news/travel desks at the 25 airports; log of who/when. Vin.
- [ ] **14.** **D-2** — reporter-request accounts set up; first answers sent. Vin.
- [ ] **15.** **D-9** — LinkedIn/BBB/Crunchbase/social bios: same legal name, description, airport count; street address and personal phone removed. Vin.
- [x] **16.** **§5 Q1** — Sep 23 stamp source confirmed against the perf ledgers. Vin.

### Block 5 — Merge machinery, linking pass, Christmas pages, December index prep
- [ ] **17.** **B-3** — redirect map as JSON + `next.config` `redirects()` + unit test + render-time link swap; map empty. Tom + Claude. Done: merged.
- [ ] **18.** **B-4** — preview → apply command; dry run on one post shows diff + lint. Vin.
- [ ] **19.** **B-5 prep** — 101 + 294 candidate pairs run through Stage A's zero-signal filter; Tom signs off each pair. Vin, Tom.
- [x] **20.** **B-2** — linking pass, airports 1–10 by traffic (dry run → apply → spot-check 5 pages each). Vin.
- [ ] **21.** **E-1** — Christmas/New Year pages for the top 10 airports. Vin + Claude. Done: live, linked from hubs.
- [ ] **22.** **C-2** — December index data collection scripted and scheduled (pull the week before it goes live). Vin.
- [x] **23.** **D-10** — "list your lot" article series brief (3 pieces) written. Vin.

### Block 6 — Readout, hubs, December index, links and mentions, new pages, repairs
- [x] **24.** **Readout** — Oct 13–17 + Oct 23–24 new-airport pages: indexed, impressions, citations, sessions by source, bookings per airport; what to replicate. Vin.
- [x] **25.** **B-2** — linking pass, airports 11–30. Vin.
- [ ] **26.** **B-9** — hub rebuilds 1–10 (non-pilot airports) through preview → apply. Vin + Claude.
- [ ] **27.** **C-2** — December index live + D-1 pitch. Vin + Claude.
- [ ] **28.** **D-3** — "Book on Triply" badge + sentence offered to every lot we sell (email via the tracker). Vin.
- [ ] **29.** **D-5** — unlinked-mention sweep #1; link asks sent. Vin.
- [ ] **30.** **D-6** — broken-link sweep #1 (travel/city guides linking to dead parking pages); replacement offers sent. Vin.
- [ ] **31.** **E-5** — cruise-port pages where we sell lots. Vin + Claude.
- [ ] **32.** **E-6** — event pages for every Q1 closure/capacity cut in the airport files + spring break by airport. Vin + Claude.
- [ ] **33.** **C-4** — official-rate tracker page (who raised garage/economy rates in 2026). Vin + Claude.
- [ ] **34.** **C-5** — park-vs-rideshare page + hub block. Vin + Claude.
- [ ] **35.** **B-6** — `&amp;` corpus repair through preview → apply (no stamp). Vin.

### Block 7 — Merge test, rates refresh, more hubs, park-sleep-fly pages
- [ ] **36.** **B-5** — Stage A merges at BWI/LAX/BOS/EWR — gate: 4 weeks of W7 baseline, steps 17–19 done: one apply per pair, map entry, draft, IndexNow both. Vin + Tom. **Test; watch 8–12 weeks.**
- [ ] **37.** **W3a** — first monthly in-place update of official figures on every rates page. Rotation.
- [ ] **38.** **B-9** — hub rebuilds 11–30. Vin + Claude.
- [ ] **39.** **E-2** — park-sleep-fly pages the week Park & Stay goes public; D-4 hotel link asks. Vin + Tom.
- [ ] **40.** **D-1/D-5/D-6** — index pitch follow-ups; sweep #2. Vin.
- [ ] **41.** **Checkpoint readout** — §9 first-checkpoint targets vs baseline; §2 status tables corrected. Tom + Vin.

### Block 8 — After the peak readout
- [ ] **42.** **W6** — year-in-titles test at 2 non-pilot airports, **after the peak readout (previous step)**; until then the year stays as it is. Vin. **Test.**
- [ ] **43.** **C-3** — monthly price index, first edition; rolling page. Vin.
- [ ] **44.** **B-9** — hubs 31+ ; the 4 pilot hubs **after** the Stage A readout. Vin + Claude.
- [ ] **45.** **E-7** — standing rule live: new airport → 3–5 pages within a week of its first lot. Vin.
- [ ] **46.** **W4** — fact corrections on all merge destinations. Vin.

### Block 9 — Merge readout and the quarter close
- [ ] **47.** **Stage A readout** — gate: 8 weeks after step 36 — go/stop per §10; Stage B pairs signed off. Tom + Vin. **Test.**
- [ ] **48.** **W3b** — answer-first openings on existing rates pages at airports kept apart from the merges, **after the Stage A readout**. Rotation. **Test.**
- [ ] **49.** **Quarter readout** — §9 scored, execution list re-ranked, **v3.4** published. Tom + Vin.


**Then, monthly, for as long as the company exists:** W3a figures · index edition · pitch · sweeps #5/#6 · hub and booking-page refresh on a facts diff · lot-quality list · outreach list refresh with demand data · readout and re-rank.

*Created October 30, 2026 — Vin's reply to v3.2; rewritten the same day as the whole-funnel roadmap; v3.4 the same day after one outside review (§14).*
