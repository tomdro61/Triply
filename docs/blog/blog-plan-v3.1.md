# Blog plan v3.1 — consolidate, guard, refresh (2026-10-19)

**Status:** v3.1. Widened from the monthly-rates-pages plan after the blog audit
(`docs/blog/blog-audit-2026-10.md`).

> **Public copy for review.** This repo is public, so traffic, booking and conversion figures are
> left out or given as rough shares. Tom has the full numbers (wrapper
> `notes/2026-10-18-monthly-rates-pages-plan.md`). **Vin: comments on the PR are the review.** The
> two questions that block most of this are §9 Q1 and Q2.
- v2 (rates pages only) had 2 Opus reviews; ledger in §10.
- v3 had 2 Opus reviews (logic/SEO; plan-vs-code): 1 Critical, 7 High, 12 Medium, 11 Low. All
  folded in here; ledger in §11.
- No code. Owners: Tom + Vin (the blog engine is shared).
- Facts checked against `triply` `main` `d621d80`, `triply-cms` `main` `a72dc0e`, the live CMS API,
  Search Console and GA4 (Jul 19 – Oct 16, 2026).

Related: the P3 fee-inclusive prices plan (in Tom's notes, not in this repo).
Its P3c removes lot prices from posts **on P3's own schedule**; this plan doesn't delay it (§3 W4).

## 1. What the audit says

Tom (2026-10-18): new topics are hard to keep thinking up, posts go stale, and there's no rhythm
for what to publish. The audit says the problem isn't volume. It's that much of the volume
repeats itself.

- **The spring batches built the traffic.** Blog clicks rose roughly 8× as ~3,600 posts were
  indexed (Apr–Jun).
  - Not proof that more volume helps: the 781 October posts have almost no clicks yet, and daily
    clicks have drifted down ~30 % since July.
- **Bookings are spread widely.** Post-attributed bookings landed on almost as many different posts
  as there were bookings; only a small share came from the 200 most-clicked posts, and a real share
  landed on posts with 0 Google clicks (Bing, AI, direct). → **No mass deletion, and survivor choice can't use Google data alone.**
- **Keyword variants are reworded copies:** BWI has 11 shuttle/bus posts, Logan 12 cost posts, IAD
  8 pick-up posts.
  - "98 % of impressions sit on queries where 5+ of our posts appear" counts any impression in 90
    days, at any position. It shows the spread, not 5 posts on one results page.
  - Google drops the copies: an estimated **≈ 450–850 older posts are "crawled – currently not
    indexed"** (point estimate ~630, from a 75-post sample).
- **Rate posts convert better than the average** (roughly 3× what their clicks would predict). The size of the effect is uncertain: bookings only from Sep 17, slug grouping
  approximate.
- **Quality problems in high-traffic posts:**
  - wrong official rates (Seattle, DFW receipt)
  - AI artifacts ("wait, let's be precise")
  - unsourced promo codes under a "Working codes" heading; "Verified Discounts" with nothing
    verified
  - unsourced veteran and legal claims (DFW)
  - lot prices that contradict our own pages
- **"Updated" stamps don't track edits.** 778 posts stamped Sep 23 and 696 on Oct 13. Nothing in
  any git ref writes the field.
- **The engine that runs isn't in git.** Live posts are created already `published` (no draft
  step; live draft count 0) with `publishedAt` set by code no ref contains.
- **The in-repo engine has no duplicate guard** (unique slug only). Its "don't repeat" context
  shows 10 of an airport's posts.
- **Gaps:**
  - 39 of 85 airports have no posts (they still bring some bookings).
  - "2026" in 3,598 titles, 3,620 metaTitles and 1,501 meta descriptions.
  - 393 hotel-brand posts, 57 % with no clicks.

## 2. Principles

1. **One page per question per airport.** "Question" means intent:
   - generic rates, long-term/economy, hourly/short-term and each terminal/garage are *different*
     questions
   - "rates" vs "cost" vs "price" vs "fees" is the *same* question
2. **Keep the breadth.** Merge copies into one page with a permanent redirect, so links and
   bookings follow. Never delete for low traffic alone.
3. **New ground over variants:** uncovered airports, booking-intent topics first.
4. **Every fact has a source and a month.** No promo-code strings without an official source.
5. **Dates move only when facts change.** `contentUpdatedAt` is stamped only by a person-approved
   apply whose diff changed facts. Never in bulk.

## 3. Workstreams

| | What | Who | Blocked on |
|---|---|---|---|
| W0 | Fix the worst live errors by hand | Tom/Vin | — |
| W0b | Stop bulk stamping + variant batches | Vin | **Q1, Q2** |
| W1 | Engine guardrails | Tom + Vin | **Q2** (which engine) |
| W2 | Consolidation pilot: 4 airports, then roll out | Tom + Vin; Claude for the app part | W1.1 (guard sees merged slugs); **Q3** for W3 lot list |
| W3 | Monthly rates pages on the pilot survivors | rotation | W2 pilot merges |
| W4 | Content: P3c lot-price pass (P3's schedule) + audit fixes on survivors | Vin + Claude | P3 |
| W5 | New ground: uncovered airports | engine with W1 | W1 |
| W6 | Year in titles/meta, one dated batch | Tom decides | decision by Dec 1 |

### W0 — Fix the worst now (no `contentUpdatedAt` change)

**Before editing any post, save its JSON** (GET by id → file). Posts have no versions, and the
admin's table editor can mangle engine tables. Diff after saving. Or use the engine's Lexical
round-trip (`update-links.ts` pattern) with a dry run.

- **Remove AI artifacts:**
  - `newark-airport-parking-rates-p6` ("wait, let's be precise")
  - `dfw-airport-parking-receipt-phone-number` ("No competitor article…")
  - "5/day … 13/day" in both Newark posts
- **Correct wrong official facts:**
  - Seattle rates ($8/hr, $37/day, $222/week, Port of Seattle, as of Oct 2026) and its 14
    competitor links
  - DFW receipt post: rates and hours
  - Newark promo-P6: direct bus, not AirTrain
  - DFW veteran post: cut to what DFW's site says (SB 792 waiver, 90-day limit, (972) 973-3112,
    finparkingrev@); remove "TSA PreCheck free for veterans" and the unsourced phone/email/TollTag
    claims
- **Promo-code posts:**
  - LGA deals: **remove the code strings entirely** (they belong to a lot we sell and push readers
    to book direct) and the "Working Coupon and Promo Codes" heading
  - LAX H1: drop "Verified"
  - DFW: drop "codes updated for 2025 and 2026"; **link to DFW's official parking offers page**
    instead of naming the dated EARLYBIRD code, which would go stale on Nov 13
  - Newark rates: remove "codes up to 40 %"
- **Logan Terminal E title:** "2028" → fix.
- **About 10 posts.** Corrections, not refreshes. Edits show within 1–3 h, occasionally one more
  stale serve (CMS CDN SWR).

### W0b — Stop the bleeding (needs Vin)

- **Q1:** what stamps `contentUpdatedAt`? The rhythm (Sep 23, Oct 13) suggests another run around
  early November, inside the pilot. Pause it until W1.7.
- **Q2:** which engine copy runs, and who runs batches? Pause new batches for airports that
  already have posts until the W1.1 guard exists.

### W1 — Engine guardrails (in the copy that runs; reconcile first; PR #96 touches the same code)

1. **Duplicate guard before writing.**
   - **Compare** the normalised keyword with every slug at that airport, **any status**, plus the
     redirect map. The map is a JSON file in the repo that both app and engine import.
   - **Normalise:** drop airport names/codes and for/in/near/at/the; fold cost ≈ price ≈ rates ≈
     fee ≈ per day, shuttle ≈ bus, pick-up ≈ visitor ≈ waiting.
   - **Intent words stay distinct:** long-term, hourly, terminal X, garage name.
   - **Paging:** the site-wide `getAllPublishedSlugs()` call (`index.ts:254`) stops at 500 of
     4,530; page it.
   - **On a match** the job becomes "update that page"; refusals go to a log a person reads.
   - **Search Console query→page pairs** (`fetchQueryPagePairs`, `gsc.ts:470-497`) are advisory
     only: pull once per run, cache to disk. They need interactive OAuth and lag 2–3 days, so the
     guard must work without them.
2. **Cluster context for the writer:** the airport's posts ranked by similarity, not the first 20
   in default order (`payload.ts:159-175`).
3. **Facts:**
   - official figures only from the data file or a cited official URL, with "as of"
   - one variable for each "from $X"
   - percentages computed in code
4. **Lint before publish (fails the write):**
   - artifact phrases ("wait,", "let's be precise", "competitor article", "as an AI")
   - money without "$"/"C$"
   - "verified"/"working" next to a code
   - code strings not in an approved list
   - a non-current year in title/metaTitle
   - "save up to N %" without a source
   - "no codes" copy next to our own 10 %-off capture (confirm P3a's savings-claim removal covers
     the template CTA)
5. **Promo posts:** "how to save" framing. Name a code only if the airport or lot publishes it
   (URL + date in data).
6. **Lot/hotel posts:** only for lots we sell that are in the channel snapshot (PR #96's
   "sellable only").
7. **`contentUpdatedAt` in git:** set only by the apply step when the diff changes facts. The same
   step writes the visible "verified <month>" text.
8. **Lot prices:** P3c (prompt change + deny-by-default pre-publish check). Not repeated.
9. **Fix while there:** the in-repo engine sends `status: 'review'` (`claude.ts:639`,
   `index.ts:486`), which the CMS rejects (only draft/published exist). Remove or restrict
   `delete-post.ts`, which deletes the first 10 posts of any status.

### W2 — Consolidation

**How a merge works:**

1. **Cluster by intent per airport** (principle 1).
   - Two posts are candidates when most of each one's Search Console impressions come from the
     same queries **and** their normalised slugs match.
   - Generic rates, long-term, hourly and each terminal/garage stay separate clusters.
   - **Hubs are never merged.**
   - **A person signs off every cluster.**
2. **One survivor rule** (used for W3's pages too). Score each post on the cluster's queries:
   - Google clicks + impressions
   - **GA4 sessions from every source (Google, Bing, AI referrers)**
   - attributed bookings

   Then:
   - **Prefer the published sub-pillar** when one is in the cluster, since it's the `parentSlug`
     for the airport's other posts.
   - **Never redirect a post that has bookings or a distinct top query** unless a person approves
     it.
3. **Merge in one apply** through the preview → apply path (§W3.4).
   - The survivor gets any fact it lacks, plus (for the 4 pilot rates pages) the W3.2 rewrite. One
     write, not two.
   - **Re-parent children:** if a merged post is anyone's `parentSlug`/`hubSlug`, PATCH those
     children to the survivor in the same run. Otherwise breadcrumbs and "complete guide" callouts
     vanish silently (`SpokeLayout.tsx:15-16`, `SubPillarLayout.tsx:11`) and `validatePrerequisites`
     (`queue.ts:49,57`) blocks new posts under it.
4. **Redirect.**
   - **Check the map first**, before `getPostBySlug`, in `blog/[slug]/page.tsx`; a hit calls
     `permanentRedirect()`, which returns 308 in Next 16.1.6 and is cached by ISR.
   - A new deployment starts with a fresh ISR cache, so the 308 applies as soon as the map
     deploys, whatever the CMS status. That makes an accidental republish harmless.
   - **Then** set the merged post's CMS status to `draft`, which removes it from every listing (all
     filter `published`: `cms.ts:173, 201, 230, 245, 268, 281`).
   - **Revert order:** republish first, then remove the map entry.
   - **Unit test on the map:**
     - flattened (no chains, no loops)
     - no key is a survivor
     - every survivor is published (a daily check can verify against the CMS)
   - **`draft` caveat:** in this team, `draft` reads as "awaiting review". The map-first check
     makes a mistaken republish harmless. A dedicated `merged` status is a possible later CMS
     change (needs a migration); not for the pilot.
5. **Internal links:** the engine's link pass never rewrites existing links (`update-links.ts:1-12`).
   So the blog page rewrites `/blog/<merged>` hrefs to the survivor at render time, using the same
   map. This is a link-target swap, not the prose filter Decision 7B rejected.

**Pilot: 4 airports.**
- **Which:** BWI (worst duplication), LAX, BOS, and **EWR**, our most booking-heavy blog airport,
  so a loss would show.
- **What merges:** the generic-rates cluster at each, plus the BWI shuttle cluster and the Logan
  cost cluster.
- **Expected size:** about 40–70 posts merged into ~8–10 survivors. The real number comes from the
  sign-off.
- **Before merging, export per post:** Google clicks/impressions, GA4 sessions by source, bookings.

**Rollout:** airport by airport after the readout.
- **Hotel-brand posts** (393; most not about a lot we sell) merge into one hotel-parking page per
  airport.

**Measurement limit:** bookings can be counted only on the survivor. Attribution records the path
after the 308 (`attribution-capture.tsx:55,91`), so the pre-merge export is the baseline.

### W3 — Monthly rates pages

**One rates page per airport, the W2 survivor of its generic-rates cluster, kept up to date every
month.**

**Decided (Tom, 2026-10-19): one page per airport, updated monthly — not a new post each month.**
Evidence:
- **Nobody searches by month.** Month-named queries are effectively zero of rate-search
  impressions (0.002 %); year-named ones are a fraction of a percent (0.31 %).
- **Google's own guidance:** *doorway abuse* ("pages are created to rank for specific, similar
  search queries"), *scaled content abuse*, and "changing the date of pages to make them seem fresh
  when the content has not substantially changed".
- **Our data:** too many similar pages already. Not certain: Google doesn't publish its ranking.
  §7 measures it.

**W3.1 The page:**
- **The airport's official rates,** labelled, with "as of".
- **Our lots by name** (channel snapshot) with "see today's prices for N lots", linking to the
  airport page's live, fee-inclusive table (`components/airport/rates-table.tsx`). The booking
  widget is already above every post (`page.tsx:246`).
- **No prices for lots we sell** (P3c).
- **This month:** what changed, what's coming, booking advice. Facts only.

**W3.2 One-time rewrite:** done in the W2 merge apply. Covers body, FAQ, `excerpt`, `seo.metaTitle`
(that's the `<title>`, `page.tsx:43`), `seo.metaDescription`.

**W3.3 Not included:**
- **Live price block.** ≈ 3,000+ ResLab calls/day for 8 airports; needs its own plan.
- **Price history.** A past price acts as a "was" price.
- **New CMS fields.**
- **Month in the title.**

**W3.4 Preview → apply** (the shared write path for W2 merges, W3 refreshes and W4 fixes). Payload
has no versions for staged edits to an *already-published* post; generate-as-draft still works for
*new* posts.

1. `--preview`:
   - Reads the post (`findPostBySlug`, `payload.ts:38`, any status), the official rates (data
     file), and our lot list from a new read-only app endpoint with an engine token (Q3).
   - Writes a local preview + diff: "This month", metaTitle ≤ 60, metaDescription ≤ 160,
     excerpt ≤ 300, FAQ.
   - Every number must appear in the supplied facts. The P3 pre-publish check and W1 lint run.
2. A person reads it. `--apply`:
   - Re-reads the post and PATCHes by id (`payload.ts:31`), never sending `slug`.
   - Reuses `update-links.ts`'s Lexical round-trip and image guard (`:257-284`).
   - **Sets `contentUpdatedAt` only if the facts diff is non-empty:** official rates, lot list, or
     "This month" facts.

**Cadence:**
- **First refresh in early December,** after the November merges.
- **Then the first business days of each month,** one person, one engine writer at a time.
- **About 15 min per airport:** ≈ 1 h/month for the 4 pilot airports.
- **The 40-day digest line means "re-verify"** (check the airport's page). A page whose facts
  didn't change keeps its old date.

**W3.5 Pre-pilot:**
- **Re-verify the 4 airports' data files** (last verified Feb–Apr 2026). EWR's file must exist or
  be added.
- **Candidate survivors** come from the W2 rule, not the v2 table. v2 picked by rate-query
  position and missed the real leaders: LAX `lax-car-parking-price` gets several times the clicks
  of v2's pick; BWI's top-impression page is `bwi-airport-parking-hourly`.

### W4 — Content

- **P3c's lot-price removal runs on P3's schedule** (California first, highest traffic first), as a
  narrow pass over existing posts. It isn't held for W2.
  - The trade-off: a few posts get touched twice (P3c now, W4 later). That beats months of bare
    lot prices with P3d blocked behind them (P3 lines 290, 328).
- **W4 proper** (after W2 at each airport, survivors only, highest traffic first):
  - official facts re-checked with "as of"
  - artifacts and unsupported claims removed
  - title promises met (a "map" post gets a map, or a new title)
  - our "no codes" copy reconciled with the 10 %-off capture
  - `contentUpdatedAt` only on a facts diff
- **Hours are estimated after the pilot** sets survivor counts.

### W5 — New ground

- **Which airports:** the 39 with no posts, ordered by bookings and inventory. TYS, ROC, CHS, OKC,
  ORF, DSM, GSO, SYR first.
- **About 5–8 pages each, separate intents:** hub, generic rates, long-term/economy, off-site +
  shuttle, pick-up/cell lot, one per lot we sell.
- **Booking-intent topics first.**
- **Starts after W1**, so the guard and lint apply.
- **Recurring themes later** (holiday pages yearly; deals with official codes only) on W3's
  machinery.

### W6 — Year in titles (decide by Dec 1)

- **Scope:** "2026" in 3,598 titles, 3,620 `seo.metaTitle`s (the actual `<title>`), 1,501 meta
  descriptions and 2,093 excerpts.
- **Recommended:**
  - Keep the year only on pages refreshed on a schedule (W3) and on survivors when W4 sweeps them.
  - Remove it from title, metaTitle, metaDescription and excerpt everywhere else.
  - Do it in **one dated batch** covering pilot and control airports alike, with the date logged
    for the readout.
  - No `contentUpdatedAt` change.
- **Leave the 27 slugs with "2026" alone:** a slug change needs a redirect, for no gain.
- **Not** a blanket bump to 2027: that's fake freshness.

## 4. Order

1. **This week:**
   - W0 fixes (with JSON backups).
   - Ask Vin Q1 + Q2 (they block W0b, W1 and the pilot).
   - P3a/P3c continue on P3's schedule.
2. **Next 2–3 weeks:**
   - W1.1 guard + W1.4 lint + W1.7 stamping rule.
   - The redirect map + map-first check + link rewrite (app PR → `/scoped-review`).
   - The read-only lot-list endpoint (Q3).
   - The preview → apply command.
   - Pilot clustering and sign-off.
3. **Mid/late November:** pilot merges at 4 airports (with survivor rewrites in the same apply).
4. **Early December:** first W3 refresh.
5. **By Dec 1:** W6 decision; the batch is dated and logged.
6. **8–12 weeks after the merges** (~February): readout against §7's pre-registered criteria.
7. **Then:** roll W2 out airport by airport, each followed by W4. W5 starts once W1 is in.

## 5. Risks

- **Merging away bookings.**
  - Clusters split by intent; posts with bookings or a distinct top query need sign-off.
  - Pre-merge export by source.
  - EWR in the pilot so a loss is visible.
  - Stop criterion in §7.
- **Map/CMS drift:** the map-first check makes the CMS status irrelevant to the redirect; unit test
  plus daily check.
- **Hierarchy breakage:** hubs never merged; children re-parented in the same apply.
- **Two engines, one outside git:** nothing in W1 helps until the running copy is the guarded one
  (Q2).
- **Measurement noise:** holiday season, P3a/P3c deploys, the W6 batch. Dates logged; controls
  used; only large moves count.

## 6. Not doing

- Mass deletion.
- Monthly new posts.
- Bulk date bumps.
- A live price block (for now).
- New CMS fields for the pilot.

## 7. Measurement (pre-registered)

**What:**
- Position and impressions on each pilot cluster's **query set**, at query level (property-wide),
  not page level.
- GA4 sessions to the survivor by source (Google, Bing, AI).
- Bookings landing on the survivor vs the pre-merge baseline of the merged posts.

**Against:** comparable untouched airports (hub/business airports, not Florida leisure).

**Success:** the cluster's query set average position improves by 5+ places, or clicks rise 50 %+
vs controls, at 8–12 weeks.

**Stop and revert a cluster:**
- query-set impressions fall 30 %+ vs controls after 6 weeks, or
- the survivor's bookings + sessions fall clearly below the merged posts' baseline (EWR is the
  check).

**Index health:** re-run URL Inspection on the same 75-post sample monthly, plus the survivors'
status.

**W5:** new pages indexed and earning impressions within 8 weeks; bookings at those airports vs the
prior 90 days.

**Readout logs the dates of:** W0, W6, P3a/P3c deploys, each merge.

## 8. Decisions for Tom (and Vin)

1. **Pause variant batches** for covered airports until the W1 guard exists (recommended).
2. **Redirect, not canonical,** for merged copies (recommended; replaces v2's choice).
3. **Pilot:** 4 airports (BWI, LAX, BOS, EWR). Generic-rates cluster at each, plus BWI shuttle and
   Logan cost.
4. **W6:** remove the year except on scheduled-refresh pages, in one dated batch (recommended).
5. **P3c stays on P3's schedule;** some posts get touched twice (recommended).

## 9. Open questions

1. What stamped `contentUpdatedAt` on 1,971 posts (778 Sep 23, 696 Oct 13), and on what rule?
   (Vin) **Blocks W0b.**
2. Which engine copy runs? Live evidence says it's outside git: posts created already `published`,
   `publishedAt` set by code no ref contains. What produced the Oct 13–17 batch? How do the copies
   get reconciled? (Vin) **Blocks W1 and the pilot.**
3. The read-only lot-list endpoint with an engine token (`/api/admin/availability` is
   session-cookie only). **Blocks W3.1's lot list.**
4. Does P3c's bulk pass use the preview → apply path for edits to published posts? (P3 owners)

## 10. Review ledger (v1 → v2, rates pages)

R1 = logic/failure modes, R2 = plan-vs-code. Both Opus. Summary: the drafts Critical
(R1-1/R2-1 → preview → apply); 13 High (stamping by another engine, P3 Decision 7B, the live block's
P3 conflicts and load, price history, consolidation, the airport page's live table, data-file age,
stale FAQ/meta, metaTitle, snapshot); 13 Medium; Lows. All handled in v2. W3 carries the result.

## 11. Review ledger (v3 → v3.1)

L = logic/SEO reviewer, C = plan-vs-code reviewer. Both Opus.

| Finding | Sev | v3.1 |
|---|---|---|
| L-C1: "rates cluster" merges different intents and would redirect the booking-earning sub-intent posts; v2 candidates aren't the leaders; two survivor rules | Critical | Principle 1 intent split; W2.1 intent clusters + sign-off; W2.2 one rule incl. bookings; never redirect booked/distinct-query posts without approval; W3.5 survivors from the rule |
| C-H1: merging a rates sub-pillar breaks breadcrumbs/callouts and blocks new spokes (`SpokeLayout.tsx:15-16`, `queue.ts:49,57`) | High | W2.2 prefer sub-pillar; W2.3 re-parent children; hubs never merged |
| L-H1 / C-H2: map checked only after the CMS returns null — republish undoes merges; cache lag; chains | High | W2.4 map-first; flatten + unit test + daily check; revert order |
| C-H3 / L-M6: link pass never rewrites links | High | W2.5 render-time href swap via the map |
| L-H2: P3c delayed by months | High | W4: P3c on P3's schedule; double-touch accepted |
| L-H3: clustering/survivor/measurement Google-only; a real share of bookings on 0-click posts; Bing/AI ≈ ⅓ | High | W2.2 score incl. GA4 all sources + bookings; export by source; §7 by source |
| L-H4: timeline doesn't fit 2 people; Q1–Q3 not marked blocking; stamping may rerun ~Nov 3 | High | Q1–Q3 marked blocking; pilot 4 airports; merge + rewrite in one apply; first refresh December; W0b |
| L-M1: "98 %" overstated; pilot can't see booking loss | Medium | §1 reworded; EWR in pilot; §7 pre-registered success/stop; query-level position |
| L-M2 / C-M4: W6 must include metaTitle/meta/excerpt; contaminates readout; year slugs | Medium | W6 scope + one dated batch on pilot and controls; slugs left alone |
| L-M3: sub-pillar hierarchy ignored | Medium | W2.2/2.3 |
| L-M4: apply always stamps; staleness alert pushes re-stamping | Medium | W3.4 stamp on facts diff only; alert = re-verify |
| L-M5: hand edits have no undo; EARLYBIRD goes stale; LGA codes push to direct booking; DFW veteran post missing | Medium | W0 JSON backups; official offers link; codes removed; veteran post added |
| C-M1: `draft` means "awaiting review" here | Medium | map-first makes republish harmless; `merged` status later |
| C-M2: guard can't see merged slugs; 500 cap is the site-wide call (`index.ts:254`) | Medium | W1.1 any status + map; page the site-wide call |
| C-M3: GSC guard needs interactive OAuth, lags 2–3 days | Medium | W1.1 advisory, cached; guard works without it |
| C-M5: P3c drafts statement overstated | Medium | W3.4 reworded (new posts can be drafts) |
| C-M6: bookings can't be tied to redirected copies | Medium | W2 measurement limit; pre-merge baseline |
| L-L1: 17 % range wide | Low | §1 ≈ 450–850 |
| L-L2: rate-post conversion size unreliable | Low | §1 direction only |
| L-L3: volume claim; October batch | Low | §1 caveat |
| L-L4: 308 behaviour | Low | confirmed by C (Next 16.1.6 → 308, cached) |
| L-L5: "save up to 70 %", "no codes" vs 10 % capture | Low | W1.4 lint; W4; confirm P3a covers the CTA |
| L-L6: hotel-brand posts unaddressed | Low | W2 rollout: one hotel page per airport |
| C-L1: CDN SWR can serve stale once more | Low | W0 note |
| C-L2: sitemap segments shift when posts unpublish | Low | harmless, noted |
| C-L3: engine sends `status: 'review'` the CMS rejects | Low | W1.9 |
| C-L4: `delete-post.ts` deletes any status | Low | W1.9 |
| C-L5: revert order | Low | W2.4 |

*Created October 18, 2026 — v1; v2 same day. v3 October 19 — widened to the whole blog after the
audit; v3.1 same day after 2 Opus reviews. Public copy (figures removed) added October 21, 2026.*
