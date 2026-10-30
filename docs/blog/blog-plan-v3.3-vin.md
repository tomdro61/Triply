# Blog plan v3.3 (Vin) — v3.2, answered and put on a calendar (2026-10-30)

**What this is:** Vin's reply to Tom's v3.2 (`docs/blog/blog-plan-v3.2.md`, PR #110), written as one
step-by-step plan we can both run. It keeps v3.2's rule and nearly all of its mechanics. It answers
Q1/Q2, adds what Vin's side has already shipped since Oct 23, and moves the safe steps forward so they
land before the holiday booking peak instead of after it.

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

## 6. Stop / go (v3.2 §7, plus one line)

All of v3.2 §7 stands. Add: **if the prompt panel shows a pilot cluster losing its Triply citation in two
or more assistants for two weeks running after a merge, revert that pair** (republish first, then remove
the map entry), whatever Google shows.

## 7. Decisions for Tom

1. Accept Q1/Q2 as answered, and the engine-into-`main` PR as the fix (step 9).
2. Holiday pages now (step 8), not later.
3. Stage A candidates start from the 101 + 294 lists (step 13).
4. W6 small test from Dec 1 (step 18).
5. W7 split: Vin runs the panel and the Bing export; Tom runs the log drain and GA4 (steps 3–4).

*Created October 30, 2026 — Vin's reply to v3.2.*
