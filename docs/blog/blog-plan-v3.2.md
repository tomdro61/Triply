# Blog plan v3.2 — consolidate, guard, refresh, measured across Google, AI and Bing (2026-10-23)

**Status:** v3.2, after 2 Opus reviews (logic/SEO; plan-vs-code): 0 Critical, 8 High, 11 Medium, 7 Low,
all folded in (ledger §10). Built from v3.1 (`docs/blog/blog-plan-v3.1.md`, PR #110) and the October SEO
findings (`docs/seo/2026-10-seo-findings.md`, PR #112). Both files live on those PR branches, not on `main`.
- **Owners:** Tom + Vin (the blog engine is shared); Claude for the app parts.
- **Review:** Vin's Claude reviews this before anything is executed. Comments on the PR are the review.
- **No code yet.**
- **Facts checked against:** `triply` `main` `4c6d20f` and the live site, Oct 23, 2026.
- **Public copy:** this repo is public, so traffic and booking figures are rough shares only. W0 names live
  content errors by slug (as v3.1 already did); fixing them before this merges is better.

> **The rule this plan is written to (Tom, 2026-10-21).** SEO means Google **and** AI assistants
> (ChatGPT, Gemini, Copilot, Perplexity, Claude) **and** Bing, and it drives the business. A change is a
> *step* only if the evidence says it helps all of them and hurts none. Anything we can't show is safe
> for every channel is a *test*: measured on all three before and after, on a small set, against controls,
> with a way back.

## 0. What changed from v3.1, and why

| v3.1 | v3.2 | Why (findings §) |
|---|---|---|
| W2: merge 40–70 posts into ~8–10 survivors at 4 pilot airports | **W2 is a two-stage merge *test*.** Stage A clears only zero-traffic copies; Stage B, capped, tries low-traffic ones. One-to-one to the closest-intent page, never a hub; IndexNow the same day; pooled per airport against controls | A large share of AI and Bing bookings land on posts a Google-led merge would redirect; no study shows merging raises AI citations; redirecting to a generic page is what lost traffic in the published pruning case (§8, §9) |
| W2 rollout: hotel-brand posts merge into one hotel page per airport | Hotel-brand posts follow the W2 rule (closest match, eligible posts only) | Same: one generic page per airport is the "redirect to a hub" pattern |
| W3: one-time rewrite of each survivor, then monthly refresh | **W3a (step):** update existing figures in place, monthly. **W3b (test):** new "This month" block, answer-first opening, meta rewrites — at airports kept apart from W2 | Body rewrites of pages AI already cites cut retrieval in one benchmark (§9) |
| W3.1: link to the airport page's "live, fee-inclusive table" | The table shows the pre-fee daily price (`rates-table.tsx:64`); its Book links lead to fee-inclusive lot pages. W3 links the airport page (crawlable) and P3a's table fix should land first | Code check; `/search` is `noindex` and renders in the browser, so it gives crawlers nothing |
| W6: remove "2026" from titles in one dated batch | **No batch.** At most a small test at airports kept apart from W2; the year lint applies to new posts only | No guidance either way (§9 "Uncertain") |
| §7 measurement: Google position/clicks, GA4 sessions, bookings | **W7: AI + Bing + Google measurement set up first**, incl. a log drain for AI-fetcher hits; §7 pools per airport with minimum baselines and one noise band | ChatGPT referrers dropped Oct 9–15 and the app strips them, so GA4 alone undercounts AI (§2, §9) |
| — | **W8: site trust + technical fixes** (homepage rating badge, stale JFK/LGA copy, non-www schema URLs, Trustpilot, blog post caching) | Perplexity called Triply "unverified" from the unsourced badge and stale scope copy; blog posts are `no-store` (§6, §7) |
| W1: guard, lint, stamping | + **answer-first** rule for new posts; + **IndexNow ping in git**, on publish **and** update | The one on-page lever with within-site evidence; the ping code is in no git ref today (§3, §6) |
| §6 Not doing | + llms.txt work, schema for AI's sake, FAQ blocks for AI, chunking, chasing fan-out phrasings, Reddit seeding, Wikipedia (for now) | No measurable effect, or banned (§9 "Not worth the effort") |

Everything else in v3.1 stands: W0's hand fixes, the duplicate guard, the stamping rule, the redirect
mechanics (map-first, re-parenting, revert order), one rates page per airport, P3c on P3's own schedule,
new airports.

## 1. What we know

**From the blog audit (Oct 19):**
- The spring batches built the traffic (blog clicks up roughly 8× as ~3,600 posts were indexed). Not proof
  more volume helps: the October posts have almost no clicks yet, and daily clicks drifted down ~30 % since
  July.
- Bookings are spread widely: about as many different posts as bookings, and a real share on posts with 0
  Google clicks. → **No mass deletion; survivor choice can't use Google data alone.**
- Keyword variants are reworded copies (BWI 11 shuttle/bus posts, Logan 12 cost posts, IAD 8 pick-up posts).
  Google leaves an estimated ≈ 450–850 older posts "crawled – currently not indexed".
- Rate posts convert better than average (direction certain, size not).
- Quality problems in high-traffic posts: wrong official rates, AI artifacts, unsourced promo codes and
  claims, lot prices that contradict our pages. **Still live on Oct 23** (e.g. "let's be precise" on
  `newark-airport-parking-rates-p6`).
- "Updated" stamps don't track edits (bulk stamps Sep 23 and Oct 13, by code no git ref contains). The
  engine that runs is outside git; the in-repo engine has no duplicate guard.
- 39 of 85 airports have no posts. "2026" is in ~3,600 titles.

**From the SEO findings (Oct 21):**
- **Each AI assistant searches its own index.** ChatGPT mostly its own plus Google scrapes; Claude uses
  Brave; Perplexity its own; Copilot uses Bing; Google's AI features use Google's index. A post Google barely
  ranks can still be the one an assistant cites, and our data shows it.
- **AI and no-referrer visits bring roughly 40 % of all bookings** and book at a much higher rate per session
  than Google visits. They land on commercial topics (rates, long-term, off-site) across about a thousand
  different posts, a quarter of them with 0 Google clicks.
- **Retrieval for the exact question matters ~10× more than page features.** Within a site, a title and
  opening paragraph that match the question helped; FAQ blocks, schema and author boxes didn't.
- **The biggest risk is Google judging the blog as mass-produced.** Google's May 2026 guide names separate
  pages for every variation of a question as scaled-content abuse, including for AI answers. In a documented
  case a Google scaled-content penalty was followed by the site dropping out of AI Overviews, AI Mode and
  ChatGPT. Bing says AI systems group near-identical pages and pick one copy, possibly an outdated one.
- **Merging is not proven safe:** a large share of AI and Bing bookings land on posts a Google-led merge
  would redirect; in one Perplexity test half its sources for a Newark question were our own copies.
- **New posts get cited fast** (within ~5 days at DTW, CLE, CVG, RDU).
- **Trust gaps:** Perplexity called Triply "unverified", citing the unsourced homepage "4.9 Rating" badge and
  stale "JFK and LGA only" copy. Both are still live (badge `hero.tsx:229`; FAQ `faq.tsx:21-23` on the
  homepage; homepage meta description `(main)/page.tsx:21`). No Trustpilot profile. Schema URLs are non-www.
- **Technical:** blog posts return `Cache-Control: private, no-store` (Vercel MISS every time); no IndexNow
  ping in any git ref (key file only).

## 2. Principles

1. **One page per question per airport.** "Question" means intent:
   - generic rates, long-term/economy, hourly/short-term and each terminal/garage are *different* questions;
   - "rates" vs "cost" vs "price" vs "fees" is the *same* question.
2. **Stop making new copies; be careful removing old ones.** New rewordings stop now (safe for every
   channel). Existing copies merge only where a test shows nobody loses (W2).
3. **Keep the breadth.** Never delete for low traffic alone. A merge is a one-to-one permanent redirect to
   the **closest-intent** page — never a hub or a generic page. The survivor score only breaks ties.
4. **New ground over variants:** uncovered airports, booking-intent topics first.
5. **Answer first.** A *new* page puts the answer and the key numbers in its title and first paragraph.
   Existing pages that AI or Bing already use change only by test (W3b).
6. **Every fact has a source and a month.** No promo-code strings without an official source.
7. **Dates move only when facts change.** `contentUpdatedAt` is stamped only by a person-approved apply whose
   diff changed facts. Never in bulk.
8. **Measure all three channels before taking anything away.** Google, Bing and AI, before and after,
   pooled, against controls.

## 3. Workstreams

| | What | Who | Blocked on | Kind |
|---|---|---|---|---|
| W0 | Fix the worst live errors by hand | Tom (Claude edits, Tom approves) | — | step |
| W0b | Stop bulk stamping + new rewordings | Vin | **Q1, Q2** | step |
| W1 | Engine guardrails (+ answer-first, IndexNow) | Tom + Vin | **Q2** | step |
| W7 | AI + Bing + Google measurement | Tom + Claude | Q5 for AI-fetcher hits | step (first) |
| W8 | Site trust + technical fixes | Tom + Claude (app PRs) | — (Trustpilot: Tom's decision) | step |
| W2 | Merge test, Stage A then B | Tom + Vin; Claude for the app part | **Q2**, W1.1, W1.11, **Q5**, W7 baseline (4+ weeks) | **test** |
| W3a | Rates pages: figures updated in place, monthly | rotation | **Q2** (apply path), W3.5 data files, **Q3** lot list | step |
| W3b | Rates pages: new block, answer-first opening, meta | rotation | W3a, W7 | **test** |
| W4 | P3c on P3's schedule + fact corrections | Vin + Claude | P3; **Q2** (apply path) | step |
| W5 | New ground: uncovered airports | engine with W1 | W1 | step |
| W6 | Year in titles | Tom decides | W7 | **test or leave** |

**Q2 is the critical path:** the preview → apply command is engine code, so W2, W3 and W4 all wait on it.
Answer wanted by **Oct 31**. Fallback if there's no answer: declare the in-repo engine canonical and freeze
the other copy.

### W0 — Fix the worst now (no `contentUpdatedAt` change)

Unchanged from v3.1 except the owner and date. **Not started as of Oct 23. Owner Tom; target Oct 31.**

**Before editing any post, save its JSON** (GET by id → file). Posts have no versions, and the admin's
table editor can mangle engine tables. Or use the engine's Lexical round-trip (`update-links.ts:211-284`,
which checks for lost links and images) with a dry run.

- **Remove AI artifacts:**
  - `newark-airport-parking-rates-p6` ("wait, let's be precise");
  - `dfw-airport-parking-receipt-phone-number` ("No competitor article…");
  - "5/day … 13/day" in both Newark posts.
- **Correct wrong official facts:**
  - Seattle rates ($8/hr, $37/day, $222/week, Port of Seattle, as of Oct 2026) and its 14 competitor links;
  - DFW receipt post: rates and hours;
  - Newark promo-P6: direct bus, not AirTrain;
  - DFW veteran post: cut to what DFW's site says (SB 792 waiver, 90-day limit, (972) 973-3112,
    finparkingrev@); remove "TSA PreCheck free for veterans" and the unsourced phone/email/TollTag claims.
- **Promo-code posts:**
  - LGA deals: remove the code strings and the "Working Coupon and Promo Codes" heading;
  - LAX H1: drop "Verified";
  - DFW: drop "codes updated for 2025 and 2026"; link DFW's official parking offers page instead of the
    dated EARLYBIRD code;
  - Newark rates: remove "codes up to 40 %".
- **Logan Terminal E title:** "2028" → fix.
- **About 10 posts.** Corrections, not refreshes; AI assistants repeat what we publish, so this is the
  cheapest win on every channel. Edits show within ~1–3 h today; up to ~4 h once W8.5 caches posts.

### W0b — Stop the bleeding (needs Vin)

- **Q1:** what stamps `contentUpdatedAt`? The rhythm (Sep 23, Oct 13) suggests another run around early
  November. Pause it until W1.7.
- **Q2:** which engine copy runs, and who runs batches? **Pause new batches for airports that already have
  posts** until the W1.1 guard exists. Batches for the 39 uncovered airports continue only with W1's lint
  (W5).

### W1 — Engine guardrails (in the copy that runs; reconcile first; PR #96 touches the same code)

Line numbers are for the in-repo engine (`scripts/blog-engine/src/`) at `4c6d20f`.
1. **Duplicate guard before writing:**
   - compare the normalised keyword with every slug at that airport, **any status**, plus the redirect map
     (a JSON file in the repo that app and engine both import);
   - normalise: drop airport names/codes and for/in/near/at/the; fold cost ≈ price ≈ rates ≈ fee ≈ per day,
     shuttle ≈ bus, pick-up ≈ visitor ≈ waiting;
   - intent words stay distinct: long-term, hourly, terminal X, garage name;
   - page `getAllPublishedSlugs()` (`payload.ts:126`, `limit: '500'` at :129, called site-wide at
     `index.ts:254`; 4,530 posts are published);
   - on a match the job becomes "update that page"; refusals go to a log a person reads;
   - Search Console query→page pairs are advisory only (interactive OAuth, 2–3 day lag).
2. **Cluster context for the writer:** the airport's posts ranked by similarity, not the first 20.
3. **Facts:** official figures only from the data file or a cited official URL, with "as of"; one variable
   per "from $X"; percentages computed in code.
4. **Lint before publish (fails the write):** artifact phrases ("wait,", "let's be precise", "competitor
   article", "as an AI"); money without "$"/"C$"; "verified"/"working" next to a code; code strings not in an
   approved list; "save up to N %" without a source; "no codes" copy next to our own 10 %-off capture.
   **Year check: new posts, and titles an apply itself changes, only** — so from Jan 1 the ~3,600 "2026"
   titles don't block every fact fix.
5. **Promo posts:** "how to save" framing. Name a code only if the airport or lot publishes it.
6. **Lot/hotel posts:** only for lots we sell that are in the channel snapshot (PR #96's "sellable only").
7. **`contentUpdatedAt` in git:** set only by the apply step when the diff changes facts. The same step
   writes the visible "verified <month>" text.
8. **Lot prices:** P3c (prompt change + deny-by-default pre-publish check). Not repeated.
9. **Fix while there:** the in-repo engine sends `status: 'review'` (decided `claude.ts:639`, sent
   `index.ts:486/496/524`), which the CMS rejects (draft/published only); remove or restrict `delete-post.ts`
   (deletes the first 10 posts of any status, no arguments).
10. **Answer first (new posts).** The writer prompt puts the direct answer and the key numbers (official
    rate, shuttle frequency, distance) in the title and first paragraph, phrased the way the question is
    asked. The lint checks the first paragraph of a rates/cost post carries at least one sourced figure.
11. **IndexNow in git.** Add the ping to the in-repo engine and call it on every publish **and** update (W0,
    W3, W4 applies; W2 redirects: old and new URL). Key file: `public/a36d16ee395347eb33ed68ef73858f5f.txt`.

### W7 — Measurement first (Tom + Claude)

Set up **now**, so W2 and W3b have a baseline of at least 4 weeks:
- **Bing Webmaster Tools AI Performance** (Copilot/Bing grounding citations per page), exported weekly.
- **Search Console generative-AI report** (impressions).
- **AI sessions in GA4:** classify `sessionSource` in our own code with the AI domain list in
  `src/lib/attribution/source.ts:96-103`, so `/admin/analytics` and booking attribution agree (the analytics
  key is read-only, so a GA4 custom channel group would need Tom in the GA4 UI). Plus a "probable dark AI"
  segment (Direct visits landing on deep blog posts).
- **AI-fetcher hits per page** — the only referrer-independent signal for ChatGPT, Perplexity and Claude:
  `ChatGPT-User`, `Perplexity-User`, `Claude-User`, plus OAI-SearchBot, PerplexityBot, Claude-SearchBot,
  Bingbot, Googlebot. The app has no log access today; this needs a **log drain started now** (Q5), and it
  must record **cached** responses, because after W8.5 most post hits never run a function.
- **A fixed prompt panel:** per pilot query set, the same questions asked weekly in ChatGPT, Perplexity,
  Copilot and Gemini (several runs each, answers vary), recording which Triply URL is cited.
- **Weekly indexed-URL counts** in Google and Bing, as an early warning of deindexing.
- **Pre-merge export** per candidate post: Google clicks/impressions, GA4 sessions by source, Bing AI
  citations, AI-fetcher hits, attributed bookings. **Attribution starts Sep 17 and not every booking carries
  it**: an unattributed booking is *unknown*, not zero.

### W8 — Site trust + technical (app PRs, Tom + Claude)

Safe for every channel; independent of the engine:
1. **Homepage "4.9 Rating" badge** (`src/components/shared/hero.tsx:229`): remove it, or source it.
2. **Stale scope copy:** the homepage FAQ "We currently serve JFK … and LGA" (`src/components/shared/faq.tsx:21-23`)
   and the homepage meta description "…airport parking at JFK and LaGuardia" (`src/app/(main)/page.tsx:21`).
   Generate the airport count/list from config (as `llms.txt`, the help page and the AI knowledge base already
   do), so it can't go stale again.
3. **Schema URLs:** Organization `url` and `logo`, the WebSite `url` and the SearchAction `target`
   (`(main)/page.tsx:29, 30, 59, 62`) → `https://www.triplypro.com`. `sameAs` already lists 8 profiles
   (:38-47): keep only real, active ones. The apex domain redirects to www with a **307**; make it permanent
   (Vercel domain setting).
4. **Trustpilot (Tom decides):** open a profile; ask every customer the same neutral way, never conditioned
   on a good experience. Separate from our own verified-review emails (PRs #76/#119/#125, not live yet).
5. **Blog post caching:** posts are `private, no-store` because `blog/[slug]/page.tsx` has no
   `generateStaticParams`, so Next renders them dynamically. Add `generateStaticParams() { return [] }`
   (render on first request, then cache — the airport page's pattern, `[slug]/airport-parking/page.tsx:45`);
   **not** all 4,530 slugs at build (CMS egress). Before shipping:
   - make `getPostBySlug` (`src/lib/cms.ts:151-161`) throw on a non-404 CMS error, so a CMS hiccup isn't
     cached as a 404 for an hour;
   - edits then take up to ~1 h longer to show;
   - posts only — `/blog`, `/blog/airport/[code]` and `/blog/category/[slug]` read `searchParams` and stay
     dynamic on purpose.
   Nothing personalised breaks: sign-in state, attribution capture, the booking widget, email capture and
   chat all run in the browser.
6. **Bot Protection** (when it goes on): Log mode first; the AI Bots ruleset stays on **Allow** (Deny blocks
   AI search and user-fetch bots too). `robots.txt` already names OAI-SearchBot, ClaudeBot and PerplexityBot;
   adding ChatGPT-User, Claude-User and Perplexity-User is cosmetic.

### W2 — Merge test (two stages)

**Stage A — zero-traffic copies.** A post is eligible only if, over the lookback (90 days, or since Sep 17
for bookings), it has **no** AI sessions (GA4 AI group, dark-AI segment), **no** AI-fetcher hits, **no**
Bing sessions, **no** Bing AI citations, **no** attributed bookings, and no unattributed booking that could
be its. This clears copies Google already ignores. **It can't show a ranking gain**; its job is to prove the
mechanics and show nothing breaks (index health, destination traffic within the noise band).

**Stage B — low-traffic copies, capped.** Only after a clean Stage A readout: at most **5 pairs per pilot
airport**, posts with a little AI/Bing traffic (below a threshold set from the W7 baseline), never one with
an attributed booking or a distinct top query. This is the stage that can say whether merging helps or
hurts the copies that matter (e.g. EWR off-site, where Perplexity cited several of our copies at once).

**Both stages:**
- same intent as the destination (principle 1), both slugs normalising to the same key;
- not a hub and not a sub-pillar (no one's `parentSlug`/`hubSlug`);
- **destination = the closest-intent page** at that airport; the survivor score (Google clicks +
  impressions, GA4 sessions by source, AI citations, bookings) only breaks ties;
- **a person signs off every pair**.

**Mechanics** (from v3.1, plus the code review):
1. **One apply** through preview → apply (§W3.4): the destination gets any fact it lacks. No body rewrite.
2. **Redirect:** prefer `next.config` `redirects()` reading the same JSON map — a 308 before any render, so
   page caching (W8.5) can't interfere. (The v3.1 alternative, a map check before `getPostBySlug` at
   `blog/[slug]/page.tsx:127` calling `permanentRedirect()`, must be verified with `curl -sI` on a cached
   page.) Then set the merged post to `draft`: every exposure filters on `published` (`cms.ts:198`,
   listings, related/sibling posts, `sitemap.ts:256`, `airport-guides.tsx:28`, chat; no RSS; `llms.txt`
   lists no posts). Revert order: republish first, then remove the map entry. Unit test: no chains, no
   loops, no key is a destination, every destination is published (+ a daily check against the CMS).
3. **Internal links:** post bodies use **absolute** links (`https://www.triplypro.com/blog/...`). The
   render-time swap (`RichText.tsx:222-237`, a client component — the map ships to the browser, which is
   fine) must match absolute and relative forms, a trailing slash and `#fragments`.
4. **Same day:** IndexNow both URLs (W1.11).

**Pilot airports:** BWI, LAX, BOS (worst duplication) and EWR. **Controls:** matched clusters at comparable
hub/business airports, not touched by W3b or W6.

**Timing:** Stage A after Q2, W1.1, W1.11, Q5 and ≥ 4 weeks of W7 baseline (earliest early December). Watch
8–12 weeks (AI citations can stay on an old URL for 6–10 weeks). Stage B after Stage A's readout.

**Rollout** beyond the pilot only on a clean Stage B. Hotel-brand posts follow the same rule.

### W3 — Rates pages (one per airport, kept current)

**One rates page per airport, updated every month — not a new post each month** (Tom, 2026-10-19:
month-named rate queries are effectively zero; Google names fake freshness and near-duplicate pages).
**Which page:** the airport's current leading generic-rates page (survivor score). It doesn't wait for W2.

**W3a — figures in place (step).** Monthly, at every airport with a verified data file — pilot and control
airports alike, so W2's comparison isn't skewed:
- update the official-rates figures and "as of" where they already appear, the lot list where one exists,
  and FAQ answers that carry a figure;
- link "see today's prices" to the **airport page** (crawlable; its Book links open fee-inclusive lot
  pages). Its rates table still shows the pre-fee daily price (`rates-table.tsx:64`; also `lot-grid.tsx:14`
  and the meta-title "from $X"): **P3a's airport-page fix should land before the first refresh.** Not
  `/search`, which is `noindex` and renders in the browser;
- no prices for lots we sell (P3c);
- `contentUpdatedAt` only when a figure changed.

**W3b — new layout (test).** A "This month" block (what changed, what's coming, booking advice — facts only),
the official rates moved into the first paragraph, rewritten `metaDescription`/`excerpt`. Tested on rates
pages at airports **kept apart** from W2's pilot and controls, against untouched rates pages. Title changes
only on pages with **no AI citations, no AI-feature impressions and no visits** from AI or Bing.

**W3.3 Not included:** live price block (≈ 3,000+ ResLab calls/day for 8 airports; own plan), price history,
new CMS fields, month in the title.

**W3.4 Preview → apply** (shared write path for W2 merges, W3 updates, W4 fixes):
1. `--preview`: reads the post (`findPostBySlug`, `payload.ts:38`, any status), the official rates (data
   file) and our lot list (a new read-only app endpoint with an engine token, Q3 — or, at zero cost, the
   sitemap's lot URLs, which come from the saved lot list); writes a local preview + diff (metaTitle ≤ 60,
   metaDescription ≤ 160, excerpt ≤ 300, FAQ). Every number must appear in the supplied facts; P3's
   pre-publish check and W1 lint run.
2. A person reads it. `--apply`: re-reads, PATCHes by id (never sends `slug`), reuses `update-links.ts`'s
   round-trip and image guard, sets `contentUpdatedAt` only on a non-empty facts diff, pings IndexNow.

**Cadence:** first W3a pass in **early December** (after W3.5); then the first business days of each month,
one person, one engine writer at a time; ~15 min per airport. A page whose facts didn't change keeps its
old date.

**W3.5 Pre-pilot:** re-verify the data files (last verified Feb–Apr 2026; EWR's must exist or be added).

### W4 — Content

- **P3c's lot-price removal runs on P3's schedule** (California first, highest traffic first). Status Oct 23:
  P3a is partly shipped — search cards and map (`customerTotalFromPricing`/`customerPerDayFromPricing`) and
  the lot page (`priceViewFromPricing`) are fee-inclusive (PRs #113, #115); the airport page table, its
  meta-title "from $X" and the lot page JSON-LD `priceRange` are not. P3c not started.
- **Fact corrections on high-traffic posts** (highest traffic by all sources first): official facts
  re-checked with "as of"; artifacts and unsupported claims removed; title promises met (a "map" post gets a
  map, or a new title — a title change follows W3b's rule); "no codes" copy reconciled with the 10 %-off
  capture; `contentUpdatedAt` only on a facts diff. **Corrections, not rewrites.**

### W5 — New ground

- **The 39 airports with no posts,** ordered by bookings and inventory: TYS, ROC, CHS, OKC, ORF, DSM, GSO,
  SYR first.
- **About 5–7 pages each, separate intents:** hub, generic rates, long-term/economy, off-site + shuttle,
  pick-up/cell lot. **A page per lot only with first-hand facts** (the lot's own details from the channel
  snapshot: address, shuttle frequency, hours, cancellation) — brand-name lot and hotel posts without them
  are what Google already leaves unindexed.
- **Answer first** (W1.10), booking-intent topics first, IndexNow on publish.
- **Starts after W1**, so the guard and lint apply.
- **Leave new pages alone for 60–90 days** after publishing (no merges, no rewrites).

### W6 — Year in titles (decide by Dec 1)

- **Scope:** "2026" in ~3,600 titles and `seo.metaTitle`s, ~1,500 meta descriptions, ~2,100 excerpts.
- **Recommended:** **no batch.** Keep the year on rates pages updated monthly (W3a), where it's true.
  Elsewhere leave it, or test removal on a small set at airports **kept apart** from W2 and W3b, reading all
  three channels. A test can't read out before January.
- **Decide by Dec 1 what Jan 1 looks like:** "2026" goes stale on every untouched post. Options: leave it
  (honest about when it was written), remove it on the test set only, or remove it wherever a W3/W4 apply
  touches the title anyway. **Never a blanket bump to 2027.**
- Leave the 27 slugs with "2026" alone.

## 4. Order

1. **Now (by Oct 31):**
   - W0 fixes (Tom, with JSON backups).
   - Q1 + Q2 to Vin, answer by Oct 31; W0b pauses.
   - W7 set-up: Bing AI Performance export, GSC AI report, AI-source classification on `/admin/analytics`,
     **log drain** (Q5), prompt panel.
   - W8 1–3 and 5 (app PRs → `/scoped-review`).
2. **Next 2–3 weeks:**
   - W1.1 guard, W1.4 lint, W1.7 stamping rule, W1.10 answer-first, W1.11 IndexNow.
   - Redirect map in `next.config` + link swap (app PR).
   - Lot list for the engine (Q3); the preview → apply command.
   - W3.5 data files; P3a's airport-page table fix.
3. **Early December:** first W3a pass (pilot and control airports alike). W2 Stage A, if its blockers are
   clear and the baseline has 4+ weeks.
4. **By Dec 1:** W6 and the Jan 1 decision.
5. **January:** W3b test starts (separate airports).
6. **~February–March:** Stage A readout → Stage B. W5 starts once W1 is in.

## 5. Risks and confounds

- **Merging away AI or Bing traffic.** Stage A takes only zero-traffic copies; Stage B is capped; one-to-one
  closest-intent redirects; IndexNow same day; pooled controls; stop rule in §7.
- **A Google scaled-content action**, which would also take AI visibility down. W0b and W1.1 stop new copies
  now; that's the main defence, and it removes nothing.
- **Map/CMS drift:** redirects in `next.config` from the map; unit test; daily check.
- **Hierarchy breakage:** hubs and sub-pillars aren't merged in the test.
- **Two engines, one outside git:** nothing in W1–W4 helps until the running copy is the guarded one (Q2).
- **Open SEO PRs change the same pages** and must be in the readout log with their merge dates: #114 (BOS/PHX
  airport-page copy, draft), #118 (BOS/DEN hub copy — BOS is a pilot airport), #120 (lot JSON-LD
  `aggregateRating`), #121 (titles on lot and static pages), #122 (noindex airport pages with nothing
  bookable). **#122 is subtractive**: run it under the rule (measured, controls) or Tom exempts it
  explicitly.
- **Measurement noise:** holiday season, ChatGPT referrer gaps (Oct 9–15), P3 deploys, W0/W8 changes. Dates
  logged; controls used; minimum baselines (§7).

## 6. Not doing

- Mass deletion. Monthly new posts. Bulk date bumps. A year-removal batch.
- A live price block (for now). New CMS fields for the pilot.
- **For AI's sake:** llms.txt work, schema added for AI, FAQ blocks for AI, chunking content, chasing exact
  fan-out phrasings (only ~27 % repeat run to run).
- Google Business Profile (ineligible), Wikipedia/Wikidata (not yet), Reddit seeding (banned).

## 7. Measurement (pre-registered)

**Unit:** pooled per pilot airport (all its merged pairs and their destinations together), and per query
set — never one pair alone. **Controls:** matched clusters at comparable hub/business airports.

**Metrics:**
- **Google:** query-set position, impressions, clicks.
- **Bing:** clicks; AI Performance citations.
- **AI:** GA4 AI-source sessions + dark-AI segment; AI-fetcher hits; the weekly prompt panel.
- **Bookings:** a guardrail, not a trigger (too few per page to test).

**A metric counts only with a baseline of at least ~50 events per pooled group** over the 4-week baseline
(sessions, hits or citations; impressions need far more). Below that it's reported, not judged.

**One noise band (±20 % vs controls) for every metric:**
- **Success (8–12 weeks):** Google position or clicks better than the band (5+ places, or +50 % clicks),
  and no counted Bing or AI metric below the band.
- **Stop and revert:** any counted metric 30 %+ below controls after 6 weeks, or pooled bookings at the
  airport clearly down with the other channels down too.
- **Inside the band:** inconclusive. For Stage A that's the expected result (it says "safe to proceed to
  Stage B"); for Stage B, inconclusive means "don't roll out yet; extend or redesign".

**Index health:** monthly URL Inspection on the same 75-post sample; weekly indexed counts in Google and
Bing.

**W3b:** the same metrics on the tested rates pages vs untouched ones. **W5:** new pages indexed and earning
impressions or AI citations within 8 weeks; bookings at those airports vs the prior 90 days.

**Readout logs the dates of:** W0, W8 items, P3 deploys, each merge, W3a passes, any W3b/W6 test, the open
SEO PRs (§5), known AI referrer outages.

## 8. Decisions for Tom (and Vin)

1. **Pause new rewordings** for covered airports until the W1 guard exists (recommended; safe for every
   channel).
2. **Merging becomes a two-stage test**, Stage A zero-traffic only, Stage B capped (recommended; replaces
   v3.1's pilot).
3. **W3 split:** figures updated in place (step); new layout tested (recommended).
4. **W6: no batch;** decide the Jan 1 default by Dec 1 (recommended; reverses v3.1).
5. **W8 trust and caching fixes now** (recommended).
6. **Trustpilot:** open a profile and ask every customer neutrally? (Tom.)
7. **#122 noindex PR:** test it under the rule, or exempt it? (Tom.)
8. **Q2 fallback:** if there's no answer by Oct 31, the in-repo engine becomes canonical (recommended).
9. **P3c stays on P3's schedule** (unchanged).

## 9. Open questions

1. What stamped `contentUpdatedAt` on ~2,000 posts (Sep 23, Oct 13), and on what rule? (Vin) **Blocks W0b.**
2. Which engine copy runs, and what produced the Oct 13–17 batch? How do the copies get reconciled? Does the
   running copy ping IndexNow? (Vin, by Oct 31) **Blocks W1–W4.**
3. A lot list the engine can read: a new read-only endpoint with an engine token (`/api/admin/availability`
   is admin-session only and returns the sold-out rollup, not a lot list), or the sitemap's lot URLs.
   **Blocks W3a's lot list.**
4. Does P3c's bulk pass use the preview → apply path for published posts? (P3 owners)
5. A log drain that records AI-fetcher hits **including cached responses** — which one, at what cost?
   (Tom) **Blocks W2 eligibility and §7's AI metrics.**
6. Is a wider rewrite of an AI-cited page ever worth testing? Not in this plan; revisit after the readouts.

## 10. Review ledger (v3.2 draft → v3.2)

L = logic/SEO reviewer, C = plan-vs-code reviewer. Both Opus.

| Finding | Sev | v3.2 |
|---|---|---|
| L-1: W2 eligibility leaves only zero-traffic copies; can't show a gain or clear the copies that matter | High | Two stages: A (zero-traffic, proves mechanics/no harm), B (capped low-traffic); inconclusive pre-registered |
| L-2: §7 thresholds are noise at per-pair volumes; "neither falls" has no tolerance | High | Pooled per airport/query set; ≥ ~50-event baselines; one ±20 % band; bookings a guardrail |
| L-3: AI citations are Bing-only; Q5 blocks W2 and §7, not just bot counts | High | Q5 blocks W2 + §7; log drain now; weekly prompt panel |
| L-4: W3's refresh confounds W2 at the same airports | High | W3a runs at pilot and control airports alike; W3b at separate airports |
| L-5: W3 labelled a step but adds blocks/rewrites to cited pages; title gate used visits only | High | W3a (figures, step) / W3b (layout, test); title gate adds citations + AI impressions |
| L-6: open SEO PRs (#114, #118, #120–#122) not counted as confounds; #122 subtractive | High | §5 lists them; readout log; Decision 7 |
| L-7 / C-4: "JFK and LGA" copy *is* in `src/` (`faq.tsx:21-23`, `page.tsx:21`) | High | W8.2 corrected; generate from config |
| C-2: caching fix had no cause; CMS 4xx would be cached as 404; cached hits skip logs | High | W8.5: `generateStaticParams` → `[]`; `getPostBySlug` throws on non-404; W7 drain must log cached hits |
| L-8: year lint blocks every fix from Jan 1 | Medium | W1.4: new posts / changed titles only; W6 Jan 1 decision |
| L-9: W6 test at W2 controls | Medium | W6 at airports kept apart |
| L-10: Q2 is the critical path; W0 had no owner | Medium | Q2 blocks W1–W4, answer by Oct 31 + fallback; W0 owner Tom, Oct 31 |
| L-11: W2 needs W1.11 too | Medium | Added |
| L-12: booking lookback partly blind (attribution from Sep 17) | Medium | W7 + W2: unattributed = unknown |
| L-13: W5 per-lot pages repeat the unindexed pattern | Medium | Per-lot pages only with first-hand facts |
| C-1: `/search` is `noindex`, browser-rendered | Medium | W3a links the airport page; P3a table fix first |
| C-5: schema URL list incomplete; `sameAs` exists; apex 307 | Medium | W8.3 |
| C-6a: post links are absolute; swap must match all forms | Medium | W2 mechanics 3 |
| C-6b: `permanentRedirect` inside a cached render unverified | Medium | `next.config` `redirects()` preferred |
| C-8: GA4 group needs the UI; app has no log path | Medium | Classify in our code via `source.ts`; drain (Q5) |
| L-14: "40 % of blog bookings" should be all bookings | Low | §1 fixed |
| L-15: reviews PRs not live | Low | W8.4 wording |
| L-16: hard-coded "85 airports" | Low | Generated from config |
| L-17: principle 3 vs "prefer sub-pillar" | Low | Closest intent rules; score breaks ties |
| C-3: IndexNow key path | Low | W1.11 |
| C-7: W1 line numbers moved | Low | Updated |
| C-10: Q3 alternative (sitemap lot URLs) | Low | Q3 / W3.4 |

*Created October 23, 2026 — v3.2: v3.1 + the October SEO findings (Google + AI + Bing); 2 Opus reviews
folded in the same day.*
