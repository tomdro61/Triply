# Blog plan v3.3 (Vin) — clean up, protect, and grow traffic (2026-10-30)

**What this is:** Vin's reply to Tom's v3.2 (`docs/blog/blog-plan-v3.2.md`, PR #110), written as one
step-by-step plan we can both run. It has two tracks:

- **Cleanup + protect** (sections 1–5): v3.2's rule and nearly all of its mechanics, Q1/Q2 answered,
  the safe steps moved forward so they land before the holiday booking peak.
- **Growth** (section 6): v3.2 is a plan for not losing ground; it adds almost no new traffic. **The
  main goal is a lot more traffic while protecting what we built.** The growth track adds pages,
  data, links and mentions; it removes nothing, so under v3.2's rule it's a step, not a test, and it
  doesn't wait for the merge tests.

> **Public copy.** This repo is public: no traffic, booking or revenue figures, only rough shares.

> **The rule (unchanged from v3.2, Tom 2026-10-21).** SEO means Google **and** AI assistants **and**
> Bing. A change is a *step* only if the evidence says it helps all of them and hurts none. Anything we
> can't show is safe for every channel is a *test*: small, measured on all three, against controls, with a
> way back.

## 0. The short version

1. **Stop making copies now; merge old copies only by test.** Agreed with v3.2.
2. **The target shape is one hub per airport → one page per intent → a spoke only for a truly separate
   question.** That taxonomy drives the duplicate guard (W1.1), the merge destination (W2) and new
   writing (W5). Section 3.
3. **Every page answers first** and is the most complete answer to *its* question on the web. A merged copy's
   unique facts move into its destination as a section, so no answer is lost when a URL is.
4. **Get pages indexed by being worth indexing:** fewer near-copies, fuller destination pages, links from
   strong hubs, IndexNow on every publish/update. Indexing is how a page becomes visible to Google, to
   Bing/Copilot, and to the assistants that read those indexes.
5. **Measure all three channels before anything is taken away** (W7), and start the measurement **this
   week**, because Stage A can't start until there are 4 weeks of baseline.
6. **Holiday pages are new ground, not variants:** ship them by Nov 10.
7. **Grow on four fronts at once** (section 6): publish our own data that nobody else has, earn links
   and mentions on other sites, make each hub the best page on the web for its airport, and open new
   questions (park-sleep-fly, lot pages). AI assistants cite original data and trust what other sites
   say about you. Cleanup alone gets us neither.

## 1. Accepted from v3.2 as written

W0 hand fixes · W0b pause on rewording batches for covered airports · W1.1–W1.11 guardrails (guard,
cluster context, facts, lint, promo framing, sellable-only, stamping in git, answer-first, IndexNow in
git) · W7 measurement first · W8 trust + technical fixes (rating badge, stale JFK/LGA copy, www schema
URLs, 308 apex, post caching, AI bots allowed) · W2 as a two-stage **test** (Stage A zero-signal, Stage B
capped) with v3.2's mechanics (closest-intent destination, never a hub or sub-pillar, one apply,
`next.config` `redirects()` from a JSON map, draft after the map, revert order, unit test, render-time
link swap, IndexNow both URLs) · W3a step / W3b test · P3c on P3's schedule · §7 pre-registered
criteria · §6 "not doing".

## 2. Answers to the blocking questions

### Q1 — what stamps `contentUpdatedAt`?

Vin's engine copy (branch `vin/main`, not on `main`). Every writer of the field there:

| Code | When it stamps |
|---|---|
| `src/index.ts:630` (`generate` on an existing slug) | regenerates the whole post |
| `src/perf-apply.ts:151,159` | perf-loop body or FAQ additions |
| `src/monthly-prices.ts:260` | monthly hub price-table refresh |
| `src/inject-coupon.ts:97` | coupon block rollout |
| `reports/lot-rewrite/publish.mts:56` | lot-article rewrites |

The Oct 13 stamp matches the lot-rewrite and API-rewrite runs that week. The Sep 23 run is still being
matched against the perf ledgers; Vin confirms by **Nov 6**. **Until W1.7 lands, none of these run in
bulk** (W0b). After W1.7, only the preview → apply path stamps, and only on a facts diff.

### Q2 — which engine runs, and what produced Oct 13–17?

- **The engine that runs is `Triplyvin-main/scripts/blog-engine` on `vin/main`** plus one-off scripts
  under `scripts/blog-engine/reports/` (e.g. `new-airports/create.mts`, `lot-rewrite/publish.mts`,
  `lot-rewrite/api-rewrite.mts`). That's why `main` has no record of the publish path, the stamps or IndexNow.
- **Oct 13–17 (20 airports):** written by `reports/lot-rewrite/api-rewrite.mts` on the Anthropic Batch API, plus subagent
  runs for the uncovered airports. Published straight to `published` (auto-publish was on).
- **Oct 23–24 (new, after v3.2 was written):** 140 pages at 28 airports, 3–5 intent pages each, via
  `reports/new-airports/create.mts`. Each airport had a fact sheet (official rates + our live lot
  list), a writer, and a **separate** fact-check pass; then a hub↔spoke relink and inbound links from
  nearby hubs. Answer-first, prices quoted fee-inclusive. Rules: `reports/new-airports/WRITER-RULES.md`.
- **Fix (Vin, by Nov 13):** one `feat/*` PR that brings the running engine into `main`: the publish
  path, the stamping callers above, the IndexNow ping and the new-airport scripts. The `vin/main` copy is
  then frozen. This is v3.2's fallback ("declare one canonical") done the other way round, because the
  running copy holds the publish path and the in-repo one doesn't.

### Airports with no posts

Every airport with a **sellable** lot now has posts (the last six, BDL MSY OAK SDF SJC YYC, have 33–40
each). The 11 still at zero (ABE ABQ AZO DAL GEG IDA MEM ROA RSW SLC SNA) have **no lots to sell**, and
#122 already noindexes their airport pages. That's deliberate: a page there sends readers to a "coming
soon" page. **Rule:** when an airport gets its first sellable lot, it gets 3–5 intent pages within a
week (the Oct 23 method), and its airport page is indexed again.

## 3. The target shape: hub → intent page → spoke

One structure per airport, used by the guard, the merge test and new writing:

| Level | Pages | Examples |
|---|---|---|
| Hub (1) | the airport's parking guide | `jfk-airport-parking` |
| Intent pages (6–10) | one per distinct question | rates/cost · long-term/economy · short-term/hourly · off-site + shuttle · pick-up/cell lot · terminal or garage X · hotel park-and-fly · holidays |
| Spokes | only a question none of the above answers | a specific lot we sell; a terminal move; a construction closure |

- **Words that fold into one question:** rates ≈ cost ≈ price ≈ fees ≈ per day; shuttle ≈ bus;
  pick-up ≈ visitor ≈ waiting. **Words that stay separate:** long-term, hourly, terminal X, garage name.
  (Same as W1.1.)
- **Links:** hub → every intent page; intent page → hub, its siblings and its spokes; spoke → its intent
  page and the hub. Descriptive anchors, under ~45 links a page.
- **Each intent page opens with the answer** (official rate, shuttle frequency, distance, "as of"), then
  one short section per sub-question it absorbed. AI assistants quote a passage, not a page, so one page
  with clear sections can be cited for each sub-question.

## 4. What v3.3 changes

| v3.2 | v3.3 | Why |
|---|---|---|
| W7 owner Tom + Claude, start "now" | Split: Tom sets up the log drain (Q5) and the GA4 classification; **Vin runs the weekly prompt panel and the Bing AI Performance export from Nov 2** | The Stage A clock only starts when the baseline does |
| W2 destination gets "any fact it lacks; no body rewrite" | Same, made explicit: the copy's unique answers go in as **one added section** under the matching heading. The existing opening isn't touched (that stays the W3b test) | Nothing a reader or an assistant found on the copy disappears |
| W2 Stage A candidates come from fresh clustering | **Start from the two lists we already have:** the 101 pairs on `feat/blog-consolidation-redirects` and the 294-row unindexed merge map (Sep 28). Each pair goes through Stage A's zero-signal filter; only passes ship in Stage A, the rest wait for Stage B or stay | Saves the clustering pass; most "crawled – not indexed" copies have no Google traffic by definition, so they're the natural Stage A pool |
| Redirect map: a JSON file app + engine import | Agreed. Our branch's `src/config/blog-redirects.mjs` becomes that JSON (flattened, no chains, all destinations verified published on Oct 21); v3.2's unit test added before it opens as a PR | Reuses work that's already checked |
| W5 starts after W1 | W5 is done for every sellable airport (section 2). Next: **readout Nov 6–13** on the Oct 13–17 and Oct 23–24 pages (indexing in Google and Bing, impressions, AI citations in the panel, sessions by source) | Use what shipped as the W5 evidence |
| Recurring themes (holidays) "later" | **Thanksgiving + December pages now** for the top airports by blog bookings, **only where the guard finds no page with that intent**. Answer-first, official advisories cited, written to be updated (not reissued) each year | New ground with booking intent; the peak starts mid-November |
| W6 "test or leave", decision after W7 | **Run the small test from Dec 1** at 2 airports kept apart from W2, so the decision lands before Jan 1, when every "2026" title starts to read as last year's | Waiting past Jan 1 makes "leave" the decision by default |

## 5. The plan, step by step

Kind: **S** = step (safe for every channel), **T** = test.

### This week and next (Nov 2 – Nov 13)

| # | Step | Owner | Kind | Done when |
|---|---|---|---|---|
| 1 | W0 hand fixes (~10 posts), JSON backup first | Tom approves, Claude edits | S | the slugs in v3.2 W0 read clean live |
| 2 | Freeze bulk stamping and rewording batches for covered airports (W0b) | Vin | S | nothing stamps `contentUpdatedAt` in bulk |
| 3 | Start W7: weekly prompt panel (ChatGPT, Perplexity, Copilot, Gemini; fixed questions per pilot cluster), Bing AI Performance export, Google + Bing indexed-URL counts | Vin | S | first week logged by Nov 6 |
| 4 | W7: log drain for AI-fetcher hits (Q5), GA4 AI classification in our code | Tom + Claude | S | hits per page recorded, cached responses included |
| 5 | W8.1–8.3: rating badge, stale JFK/LGA copy, www schema URLs, 308 apex | Tom + Claude | S | live |
| 6 | Search Console: request indexing for the unindexed hubs, one by one | Vin | S | each hub shows "URL is on Google" or a stated reason |
| 7 | IndexNow on every publish and update (W1.11), in the running engine now and in git with step 9 | Vin | S | Bing shows the pings received |
| 8 | Holiday pages for the top airports, only where no page has that intent | Vin + Claude | S | live by Nov 10, linked from each hub |
| 9 | Engine PR: running copy into `main` (Q2), with W1.1 guard, W1.4 lint, W1.7 stamping, W1.10 answer-first | Vin | S | merged; `vin/main` frozen |
| 10 | Q1 confirmed against the perf ledgers | Vin | S | Sep 23 source named in the PR |

### November (Nov 16 – Nov 30)

| # | Step | Owner | Kind | Done when |
|---|---|---|---|---|
| 11 | New-airport readout (Oct 13–17 + Oct 23–24 pages) | Vin | S | one table: indexed, impressions, AI citations, sessions by source, per airport |
| 12 | Redirect map as JSON + `redirects()` + unit test + render-time link swap (W2 mechanics) | Tom + Claude (app PR) | S | merged, map empty |
| 13 | Run the 101 + 294 candidate pairs through Stage A's zero-signal filter; a person signs off every pair | Vin, Tom signs off | S | a signed list of Stage A pairs |
| 14 | Preview → apply command (W3.4) in the engine | Vin | S | dry run on one pair shows the added section + diff |
| 15 | W8.5 post caching | Tom + Claude | S | posts return a cacheable header, CMS errors aren't cached as 404 |

### December

| # | Step | Owner | Kind | Done when |
|---|---|---|---|---|
| 16 | W2 Stage A at the 4 pilot airports (BWI, LAX, BOS, EWR) once W7 has 4 weeks: one apply per pair (section added), map entry, draft, IndexNow both URLs | Vin + Tom | T | applied; watch 8–12 weeks |
| 17 | W3a: first monthly in-place update of official figures on the rates pages | rotation | S | stamped only where facts changed |
| 18 | W6 year test at 2 control-free airports | Vin | T | decision by Dec 31 |

### January – March

| # | Step | Owner | Kind | Done when |
|---|---|---|---|---|
| 19 | Stage A readout (v3.2 §7, plus the prompt panel) | Tom + Vin | — | go / stop per §7 |
| 20 | Stage B (≤ 5 pairs per pilot airport), then roll out airport by airport on a clean readout | Tom + Vin | T | per §7 |
| 21 | W3b answer-first openings on existing rates pages, at airports kept apart from W2 | rotation | T | per §7 |

## 6. Growth track — more traffic, nothing removed

v3.2's own findings say where AI answers come from: retrieval for the exact question, trust in the
site, and (from the wider research) original data and mentions on other sites. v3.2 covers the first
two. This track covers the rest, plus new questions to rank for.

### G1 — Publish our own data (the thing only we have)

We see live, fee-inclusive prices for every lot we sell, next to each airport's official rates. Nobody
else publishes that comparison. AI assistants and reporters cite original numbers; a reworded fact
from the airport's site is interchangeable, ours isn't.

- **Started:** the Thanksgiving Airport Parking Price Index (25 airports, terminal garage vs off-airport,
  checked Oct 28) is live as `thanksgiving-airport-parking-price-index-2026`; a press pitch is drafted.
- **Make it a series:** a December holidays index (by Dec 1), then a **monthly price index** (same
  method, same URL pattern per period, one page updated rather than a new copy each month for the
  rolling version, plus a dated edition for each holiday).
- **Each hub gets its airport's line from the index** ("garage vs off-airport, fees included, as of
  <month>") with a link to the index page. That turns the index into the most-linked page we own.
- **Method page:** how the numbers are collected (dates, nights, fees and tax included, which lots),
  so a reporter or an assistant can trust and cite it.
- **Other data we can publish without booking figures:** official rate changes we track across
  airports (who raised garage prices this year), shuttle frequency by airport, and the
  park-vs-rideshare distance where parking starts to win.

### G2 — Links and mentions on other sites

Backlinks have never been measured here. Every item below is earned, disclosed, and something a real
editor or partner chooses to do. No paid links, no link networks, no fake reviews.

| # | Tactic | How | Owner |
|---|---|---|---|
| a | **Data PR** | Pitch each index to travel desks and local news at the indexed airports 2–3 weeks before each holiday ("Thanksgiving parking at <airport>: garage $X more than off-site"). Local TV and papers run this every year and need a number. | Vin |
| b | **Reporter requests** | Answer journalist queries (Qwoted, Featured, Help a B2B Writer / HARO-style) on airport parking and holiday travel, with a figure from the index. | Vin |
| c | **Lots we sell** | Offer every operator a "Book on Triply" badge and a line for their site; the partners page already lists them. Local, on-topic links. | Vin |
| d | **Hotels and park-and-fly partners** | Hotels in park-sleep-fly packages link to the package page from their parking/airport page (G5). | Vin + Tom |
| e | **Unlinked mentions** | Monthly search for "Triply" / "triplypro" without a link; ask for the link. | Vin |
| f | **Broken links** | Find travel and city-guide pages linking to dead airport-parking pages; offer our page as the replacement. | Vin |
| g | **Review profiles** | Trustpilot (v3.2 W8.4) and our verified-review emails (#76/#119) once live. Assistants read reviews to judge trust. | Tom |
| h | **Forums (decision)** | Reddit/forum answers only by a named person, disclosed as Triply, where the question is real and the answer helps without a link. No seeding, no sock accounts. v3.2 lists Reddit under "not doing"; this asks to allow the disclosed form. | Tom decides |

**Measure:** referring domains and linking pages (Bing Webmaster + Search Console Links report),
baseline in the week of Nov 2, then monthly. Brand mentions in AI answers are logged by the W7 prompt
panel (does the answer name Triply, not only link it).

### G3 — Make each hub the best page for its airport

v3.2's audit: hubs get about a third of a spoke's clicks. The hub should be the page an assistant cites
for "parking at <airport>". For each hub, highest-traffic airports first:

- **Answer first:** cheapest official option, cheapest option we sell (fee-inclusive, "as of"), and the
  garage-vs-off-site gap from G1.
- **One comparison table:** every official lot + every lot we sell: price per day all-in, distance or
  shuttle time, open hours.
- **A real map** where the post's title promises one (v3.2 W4 already requires this).
- **"Park or rideshare?"** a short table by distance (parking usually wins only beyond ~20 miles).
- **Links to every intent page** (section 3 shape) and the latest index.
- **Through preview → apply**, `contentUpdatedAt` stamped because facts change. Hubs are never merged,
  so this doesn't touch W2.
- **Order:** the 4 pilot airports' hubs are kept apart from W3b's opening test; start with non-pilot
  airports, then pilot hubs after Stage A's readout.

### G4 — Linking pass across existing posts

v3.2 only swaps links that point at merged pages. G4 builds the section 3 mesh at every airport:
hub ↔ intent pages ↔ spokes, descriptive anchors, under ~45 links a page, with `update-links.ts`'s
Lexical round-trip and link-loss guard (the Oct `relink.mts` did this for the 28 new airports). Links
from strong pages are how Google finds and indexes weak ones, so this is also the main push for the
~450–850 "crawled – not indexed" posts that aren't merge candidates. No `contentUpdatedAt` stamp
(links aren't facts).

### G5 — New questions with buying intent

- **Park-sleep-fly:** one page per airport where we sell a package ("park sleep fly <city>", "hotel with
  parking near <airport>"), live the week packages go live. Hotels link back (G2d).
- **Lot pages** (`/<city>/airport-parking/<lot>`): these are where people book, and where assistants
  answer "best off-site lot at <airport>". Show verified reviews (#119) once live, shuttle details and
  the all-in price; Tom's area.
- **Holiday pages** (step 8) and **cruise-port parking** where we sell lots (Port Everglades and others).
- **New airports:** when an airport gets its first sellable lot, 3–5 intent pages within a week.
- **Every new page passes the W1.1 guard first**, so growth never creates the copies cleanup removes.

### G6 — Visibility in AI assistants specifically

- **Bing:** IndexNow on every publish and update (W1.11); Bing Webmaster sitemap submitted; Bing AI
  Performance report weekly. Copilot answers from Bing.
- **Crawlers allowed:** OAI-SearchBot, PerplexityBot, Claude-SearchBot, Bingbot, Googlebot (already in
  robots.txt; keep it so when Bot Protection goes on, v3.2 W8.6).
- **Entity consistency:** the same name, description, airport count and contact on the site, schema,
  Trustpilot, and every partner listing, so assistants describe Triply the same way everywhere.
- **Prompt panel (W7):** weekly, the same questions per airport and per index, recording whether
  Triply is named and which URL is cited. This is the scoreboard for G1–G5.

### G7 — Targets (relative to the Nov 2 baseline; figures kept in Tom's and Vin's notes)

| Measure | By end of March |
|---|---|
| Blog clicks (Google + Bing) | **2×** the Oct baseline |
| Sessions from AI assistants | **2×** |
| Indexed blog posts (Google) | the "crawled – not indexed" share **halved** |
| Referring domains | **+25** earned |
| Prompt panel: questions where Triply is named or cited | **+50 %** |

### Growth steps on the calendar

| # | Step | Owner | When |
|---|---|---|---|
| G-1 | Backlink + referring-domain baseline; prompt panel adds brand-mention column | Vin | week of Nov 2 |
| G-2 | Thanksgiving index pitched to local news at all 25 airports + reporter-request answers | Vin | Nov 2–10 |
| G-3 | Method page for the index; index line + link on each of those 25 hubs | Vin + Claude | by Nov 13 |
| G-4 | Partner badge offer to every lot we sell | Vin | by Nov 13 |
| G-5 | Linking pass (G4), highest-traffic airports first, dry run then apply | Vin | Nov 16 – Dec 15 |
| G-6 | December holidays index + pitch | Vin + Claude | data by Nov 24, live Dec 1 |
| G-7 | Hub rebuilds (G3), 5 airports a week, non-pilot first | Vin + Claude | from Nov 30 |
| G-8 | Park-sleep-fly pages + hotel link asks | Vin + Tom | the week packages launch |
| G-9 | Monthly price index, rolling page | Vin | first edition Jan 5 |
| G-10 | Unlinked-mention and broken-link sweeps | Vin | monthly from Dec |

## 7. Stop / go (v3.2 §7, plus one line)

All of v3.2 §7 stands. Add: **if the prompt panel shows a pilot cluster losing its Triply citation in two
or more assistants for two weeks running after a merge, revert that pair** (republish first, then remove
the map entry), whatever Google shows.

## 8. Decisions for Tom

1. Accept Q1/Q2 as answered, and the engine-into-`main` PR as the fix (step 9).
2. Holiday pages now (step 8), not later.
3. Stage A candidates start from the 101 + 294 lists (step 13).
4. W6 small test from Dec 1 (step 18).
5. W7 split: Vin runs the panel and the Bing export; Tom runs the log drain and GA4 (steps 3–4).
6. **Growth track as steps, running alongside cleanup** (section 6), with the G7 targets.
7. Hub rebuilds (G3) stamp `contentUpdatedAt`, since they change facts.
8. Disclosed, person-written forum answers (G2h): allow, or keep under "not doing".
9. Lot pages (G5): Tom's area; reviews + shuttle details + all-in price on the page.

*Created October 30, 2026 — Vin's reply to v3.2; growth track (section 6) added the same day.*
