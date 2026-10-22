# SEO Findings — October 2026 (Google + AI search + Bing)

**What this is:** the most current research we have on how Triply gets found: Google, the AI assistants
(ChatGPT, Gemini, Copilot, Perplexity, Claude) and Bing/DuckDuckGo. It is the evidence base for the next
blog plan (v3.2). No plan is written here.

**Date:** October 21, 2026.

**How it was made:**
- Eight research agents, each on one area, read primary sources: Google/Bing/OpenAI/Vercel documentation,
  papers and large industry studies.
- One agent analysed Triply's own GA4, Search Console and booking data.
- Two more agents fact-checked the key citations. None of them was made up. A few were overstated and are
  corrected below (see "Corrections").

> **The rule this document is written to.** SEO means Google **and** AI assistants **and** Bing, and it is
> what drives Triply's bookings. A recommendation counts as safe only if the evidence says it helps all of
> them and hurts none. Anything we can't show is safe for every channel is listed as a test, not a step.

> **Public copy.** This repo is public, so our own traffic and booking figures appear only as rough shares.
> Tom has the full numbers (wrapper `notes/2026-10-21-geo-research.md` and the private findings page).

---

## 1. Bottom line

1. **Each AI assistant searches its own index, and most of them aren't Google.**
   - ChatGPT most likely runs its own index plus scraped Google results; OpenAI hasn't confirmed which.
   - Claude uses Brave's index, and Perplexity has its own.
   - Google's AI Overviews and AI Mode use Google's index; Copilot uses Bing's.
   - So a post Google barely ranks can still be the one an AI assistant cites, and our data shows that
     happening.
2. **Being found for the exact question matters far more than page features.** The strongest new study
   (90 days, ChatGPT/Gemini/Perplexity) found that whether the engine's own search returns a page explains
   about 10× more of citations than anything on the page. Within one site, a title and opening paragraph that
   match the question were what helped. FAQ blocks, schema and author boxes didn't.
3. **The biggest single risk is Google judging the blog as mass-produced, and it would take AI visibility
   down too.**
   - Google's May 2026 guide says separate pages for every variation of a question, made mainly to rank,
     violate its scaled-content policy, explicitly including AI answers.
   - Bing says AI systems group near-identical pages and pick one copy, possibly an outdated one.
   - In a documented case, a Google scaled-content penalty was followed by the site dropping out of AI
     Overviews, AI Mode **and ChatGPT**.
4. **Merging our near-duplicate posts is not proven safe either.**
   - A large share of AI and Bing bookings land on posts a Google-led merge would redirect.
   - In one Perplexity test, half of its sources for a Newark question were Triply copies.
   - No study shows merging raises AI citations.
5. **Trust signals around the brand matter, and ours have gaps.** When asked "is triplypro.com legit",
   Perplexity called Triply "unverified". It pointed to an unsourced homepage rating badge and a stale FAQ,
   and it found almost no independent reviews.

---

## 2. How each engine finds and cites pages

| Engine | Index it searches | Crawler(s) that matter | What we know | Confidence |
|---|---|---|---|---|
| **ChatGPT** | Mostly its own index ("Labrador", per Peec's analysis) plus scraped Google results; Bing appears mainly in Deep Research | **OAI-SearchBot** (search inclusion), ChatGPT-User (fetches when a user asks), GPTBot (training only) | Breaks one prompt into several searches ("fan-out"), more since mid-2026. Usually tags links `utm_source=chatgpt.com`, but GPT-6 dropped the tag and the referrer ~Oct 9–13, reportedly fixed Oct 15. The mobile app often strips the referrer. | Medium on index mix; high on bots |
| **Google AI Overviews / AI Mode** | Google's normal Search index | Googlebot (Google-Extended does **not** control these) | Page must be indexed and snippet-eligible. Uses query fan-out. Only ~38% of AI Overview citations rank top-10 for the query itself (Mar 2026), down from ~76%. | High |
| **Gemini** | Google infrastructure | Googlebot; Google-Extended controls Gemini training/grounding | Little published on source choice. Small share of AI referrals. | Medium |
| **Copilot** | Bing's index | Bingbot | Bing reports Copilot citations in its AI Performance report. | High |
| **Perplexity** | Its own index (200B+ URLs) | PerplexityBot, Perplexity-User (generally ignores robots.txt) | Usually passes a referrer. | High |
| **Claude** | Brave Search's index (~79–87% citation overlap) | Claude-SearchBot, Claude-User, ClaudeBot (training); all honour robots.txt | Our GA4 shows Claude referrals vanished in mid-September, consistent with it no longer passing a referrer. | Medium |
| **DuckDuckGo / Yahoo** | Mostly Bing | Bingbot | Covered by Bing work. | Medium-high |

**What this means:**
- Bing visibility is **not** a stand-in for ChatGPT visibility. When Bing deindexed one site, its ChatGPT
  citations kept growing.
- Google visibility matters for Google's AI features, and a Google penalty spread to ChatGPT in the case above.
- Each channel needs its own measurement.

---

## 3. What gets a page cited

**Evidence that holds up:**
- **Retrieval first, page features second.** Chen & Koudas, Univ. of Toronto, arXiv 2610.15033, Oct 2026:
  - 651 queries, two 90-day collections, ~158K answers, ~468K citations.
  - Retrieval explains ~32% of citation variance; page properties ~2.8%.
  - **Within a site:** a better best-paragraph match gave +15.5% citations per standard deviation; title
    match gave +14.1%.
  - FAQ blocks, schema and author boxes looked helpful **across** sites but had **no significant effect
    within** a site.
  - Caveat: one vertical (US fiber internet).
- **Title match predicts ChatGPT citation.** Ahrefs, 1.4M prompts, Apr 2026:
  - Prompt-to-title similarity is 0.602 for cited pages and 0.484 for uncited ones.
  - Natural-language slugs were cited 89.8% vs 81.1% of the time. This is correlation.
- **Ranking for the fan-out searches matters.** Surfer, 10K keywords, 174K URLs, Sep 2026:
  - Pages ranking for the main query **plus** at least one fan-out query were 51.2% of AI Overview
    citations, against 19.6% for pages ranking for the main query only.
  - Correlation, measured per URL. One page that answers the sub-questions counts the same as several.
- **Freshness is a modest tie-breaker.** AI-cited pages skew newer than Google results, and ChatGPT shows the
  strongest preference (Ahrefs, 17M citations, 2025). Google calls changing dates without real changes a
  negative.
- **Engineered phrasing fails.**
  - Replications of the 2024 GEO paper find most "rewrite for AI" tricks neutral or negative on real
    engines (C-SEO Bench, NeurIPS 2025; critical survey arXiv 2607.14035, Jul 2026).
  - Keyword stuffing is negative everywhere.
  - Bing's Feb 2026 guidelines call "artificially engineered language" meant to trigger AI citations abuse.

**Evidence that it doesn't help:**
- **Schema for AI.** Ahrefs tracked 1,885 pages adding JSON-LD (May 2026): ChatGPT and AI Mode changes were
  statistically zero. Keep schema for Google rich results; Bing says it uses it.
- **llms.txt.** 97% of files got zero requests (Ahrefs, 137K domains, Jun 2026). No major assistant says it
  reads them.
- **Chunking content into small pieces.** Google says it isn't needed. Microsoft's advertising blog advises
  modular Q&A formatting, so the two disagree. No test shows a gain.

**Unproven either way:**
- **More pages vs fewer, stronger pages.** No credible study isolates it for AI citations.
- **The indirect evidence points both ways:**
  - **Supports specific pages:** within-site citations follow pages that match the specific question.
  - **Against near-copies:**
    - Google and Bing explicitly warn against them.
    - Bing says AI picks one page per near-duplicate cluster.
    - Site page count barely correlates with AI visibility.
  - **What follows:** keep pages that answer *different questions*. Pages that *reword the same question*
    are the risk.

---

## 4. Google, 2025–2026

**Policy (official docs, fact-checked):**
- **AI optimization guide** (May 15 2026, updated Jul 10):
  - "While it might be tempting to create separate content for every possible variation of how people might
    search … (for example … fan-out queries) … doing so primarily to manipulate rankings or generative AI
    responses in Google Search violates Google's scaled content abuse spam policy."
  - "A high quantity of pages doesn't make a website higher quality or more relevant to users."
  - "There's no requirement to break your content into tiny pieces."
- **Spam policies:**
  - Since May 15 2026 they also cover "attempting to manipulate generative AI responses in Google Search."
  - The long-standing doorway rule covers "substantially similar pages that are closer to search results
    than a clearly defined, browseable hierarchy."
- **Helpful-content self-assessment** (updated Oct 2026) asks:
  - whether a site produces "lots of content on many different topics in hopes that some of it might
    perform well";
  - whether it uses "extensive automation";
  - and it names "changing the date of pages to make them seem fresh when the content has not substantially
    changed."
- **AI features doc** (Dec 2025): no special requirements, schema or AI files are needed for AI Overviews or
  AI Mode. A page must be indexed and snippet-eligible.
- **Mueller** (Jul 2026), on "Crawled – currently not indexed":
  - Asked whether it signals a quality problem, he said "Sometimes"; serious quality concerns lead to fewer
    pages indexed.
  - On generic AI text: "Anyone could have written this. This tells me nothing."
  - Our audit estimated ~450–850 older posts in this state.

**Enforcement and updates:**
- **Core updates:** Mar 2025, Jun–Jul 2025, Dec 2025, Mar–Apr 2026, May–Jun 2026.
- **Spam updates:** Aug–Sep 2025, Mar 2026, Jun 2026, Aug 2026, Sep 24–Oct 8 2026.
- **The "Mt. AI" case** (Glenn Gabe, Apr 2026): an 850K-URL AI local-news section surged, then got a
  scaled-content-abuse manual action. It left Google's index and dropped out of AI Overviews, AI Mode and
  ChatGPT.
- **March 2026 core update in travel** (Amsive/SISTRIX): official airport sites gained visibility (JFK +46%,
  LGA +49%, Reagan National +60%) while aggregators lost points. Sources beat aggregators.

**Duplicates and consolidation:**
- **No penalty for duplication itself.** Google picks one canonical. Redirects and canonical tags are strong
  signals.
- **Keep redirects at least a year.** Expect a few weeks of fluctuation.
- **Multiple pages ranking for one query isn't a problem in itself** (Mueller, Sep 2025).
- **Pruning evidence is thin.** The best recent case (Search Engine Land, Oct 2026):
  - Removed 198 of 600 low-traffic URLs and lost nothing measurable. The "+55% sessions" headline is
    confounded by a paid-search drop.
  - The author's lesson: redirect each page to its **closest match**, never a generic hub, and fix internal
    links in the same sprint.

**Measurement now available:** a Search Console generative-AI report (all sites since Aug 31 2026). It shows
impressions in AI Overviews and AI Mode by page; no clicks.

---

## 5. Bing

- **Feb 27 2026 guidelines rewrite** (via Search Engine Journal):
  - Names GEO and counts Copilot citations as outcomes.
  - Recommends one topic per URL, key facts near the top, consistent entity names.
  - Large-scale content without "oversight, quality control, or editorial review" may be excluded.
  - Engineered language aimed at AI citations is abuse.
- **Duplicates** (Bing Webmaster Blog, Dec 19 2025):
  - "LLMs group near-duplicate URLs into a single cluster and then choose one page to represent the set",
    which may be "outdated or not the one you intended."
  - Fixes: 301 consolidation, canonical tags, IndexNow.
- **Enforcement is by pattern.** A Bing engineer says they build a detector for a spam pattern and apply it
  to every site that shows it. Risk for any large templated set.
- **IndexNow:** speeds Bing discovery (18% of new URLs clicked in Bing came via IndexNow, Dec 2024). No
  evidence it reaches ChatGPT.
- **Bing Webmaster Tools AI Performance** (public preview since Feb 2026):
  - Copilot / Bing AI citations, cited pages and grounding queries (the searches the AI writes).
  - Sampled data, no clicks. A Topics Portfolio beta arrived Oct 2026.

---

## 6. Technical

- **AI bots come in three groups** (vendor docs). Blocking one group doesn't affect the others.
  - **Training only:** GPTBot, ClaudeBot, Google-Extended, Applebot-Extended, CCBot, Meta-ExternalAgent.
    Blocking these doesn't affect citations.
  - **Search indexing:** OAI-SearchBot, Claude-SearchBot, PerplexityBot, Bingbot, Googlebot. Block one and
    that engine's answers lose us.
  - **User-triggered fetches:** ChatGPT-User, Claude-User, Perplexity-User. OpenAI and Perplexity say
    robots.txt may not apply.
- **Vercel Bot Protection skips verified bots.** The verified list includes OAI-SearchBot, ChatGPT-User,
  Claude-SearchBot/User, PerplexityBot/User, Bingbot and Googlebot.
  - The separate **AI Bots ruleset must stay on Allow**: Deny blocks AI search and user fetches too.
  - Run Bot Protection in **Log** mode first. Unverified assistants and agent browsers could still be
    challenged.
- **Most AI crawlers don't run JavaScript** (Vercel/MERJ log study, Dec 2024; possibly changing). Content
  must be in the server HTML. **Ours is:** the full article text comes back for every bot user agent tested.
- **Content near the top of the page is cited more** (44% of ChatGPT citations came from the first 30% of the
  page; observational).
- **Triply today:**
  - robots.txt allows everything.
  - llms.txt exists.
  - JSON-LD: Article (author is "Triply Editorial Team", not a person), BreadcrumbList, FAQPage.
  - Sitemaps cover all posts with `lastmod`.
  - **Blog pages are served `Cache-Control: private, no-store`** despite `revalidate = 3600`, so every crawl
    renders at origin.
  - **The IndexNow submit code isn't in git.** Only the key file is; the ping runs in the engine copy outside
    git.

---

## 7. Brand, trust and off-site signals

- **Brand mentions on other sites correlate with AI visibility far more than backlinks.**
  - Ahrefs, 75K brands: branded web mentions 0.66, backlinks 0.22.
  - YouTube mentions are among the strongest predictors.
  - Correlational, and the sample is large brands.
- **Review sites matter most in travel.** Seer, 804K AI answers: brands with even a minimal Trustpilot
  profile were cited far more than brands with none, and travel showed the largest effect. Trustpilot
  co-promoted the study.
- **Reddit's citation share swings wildly** between model updates. It is a poor foundation, and undisclosed
  brand seeding is banned.
- **Google Business Profile isn't available to online-only businesses.** Wikipedia and Wikidata need
  independent coverage we don't have yet.
- **The FTC fake-reviews rule (16 CFR 465)** has been in force since Oct 2024, up to ~$53K per violation. It
  bans fake reviews, incentives tied to positive reviews, undisclosed insider reviews and suppressing bad
  ones.
- **Triply today:**
  - No Trustpilot profile.
  - The Organization schema lists our social profiles but no review profile, and its `url` is the non-www
    domain.
  - When asked "is triplypro.com legit", Perplexity called Triply "unverified", citing:
    - the homepage **"4.9 Rating" badge with no source**;
    - the homepage **FAQ saying we serve only JFK and LGA** (both confirmed live).

---

## 8. What Triply's own data shows (Sep 17 – Oct 21, 2026)

Attribution exists from Sep 17, so this covers about five weeks. Figures are rough shares (public copy).

**Where bookings start:**
- Google: about a third.
- AI assistants + Bing-family search + blog visits with no referrer: **more than half**.

**The no-referrer bookings look like AI, not Google:**
- They land on posts with zero Google clicks about as often as AI bookings do.
- They follow the same commercial topics.
- Google passes a referrer, and its clicks would show in Search Console.
- Counted as AI, they make AI roughly 40% of bookings.

**How visitors from each source behave:**
- **AI visitors book at roughly 10× the per-visit rate of Google visitors.** Bing-family visitors book at
  about 3×.
- **AI traffic lands on commercial questions:** prices and cost, long-term, off-site. Google and Bing traffic
  lean to maps, terminals, promo and help pages.
- **AI lands on the long tail:** a quarter of AI blog visits hit posts with **zero** Google clicks in 90 days,
  and most hit posts with ten or fewer.

**Merge exposure:** roughly 25–55% of AI and Bing bookings landed on posts that a merge choosing survivors by
Google clicks would have redirected.

**New posts get cited fast:**
- The Oct 13–17 batch covered 20 airports that had **no bookings in the prior 30 days**.
- Their first bookings came within ~5 days, mostly via ChatGPT and DuckDuckGo, while Google sent those posts
  almost nothing.

**Trends:**
- Recorded ChatGPT sessions are down from the summer peak, partly from the referrer loss.
- AI bookings are rising anyway.

**Perplexity spot checks** (single runs, logged out; examples, not statistics):
- "cheap off-site parking near Newark": 5 of 10 sources were Triply near-duplicate posts.
- "cheapest parking at JFK" and LAX queries: no Triply; SpotHero, Way.com, official airport sites,
  cheapairportparking.org and Reddit instead.
- "best website to book LaGuardia parking": official airport pages first.

---

## 9. What this means: sorted by the "helps every channel" rule

### Safe for every channel — do

1. **Homepage trust fixes.** Remove or source the "4.9 Rating" badge; fix the "JFK and LGA only" FAQ.
2. **Trustpilot profile.** Ask every customer the same neutral way, never conditioned on a positive review,
   and add it to the Organization schema's `sameAs`. Fix the Organization `url` to `https://www.triplypro.com`.
3. **Fix wrong facts** in live posts (the W0 list in the blog plan). AI assistants repeat what we publish.
4. **Honest dates.** Change "Updated" / `dateModified` only when the content substantially changes; no bulk
   stamps.
5. **Stop creating new rewordings of an existing question** in the engine. This lowers scaled-content risk on
   Google and Bing and removes no existing page.
6. **New ground:** pages for the 39 production airports with no posts. One page per *distinct* question
   (rates, long-term, off-site, shuttle, cell-phone lot, terminals, hotel park-and-fly), with real facts.
7. **For new posts, put the answer and the key numbers in the title and first paragraph.** This is the one
   on-page lever with within-site evidence, and it matches Bing's "key facts near the top".
8. **Technical:**
   - Put the IndexNow ping in git and send it on every publish **and** update.
   - Fix blog `no-store` so pages cache.
   - When Bot Protection goes on, use Log mode first and keep the AI Bots ruleset on Allow.
   - Name the main bots explicitly in robots.txt (cosmetic; all are already allowed).
9. **Measurement before any subtractive change:**
   - Bing Webmaster Tools AI Performance, exported weekly.
   - Search Console generative-AI report.
   - GA4 custom AI channel group: ChatGPT, Perplexity, Gemini, Copilot, Claude by source regex.
   - A "probable dark AI" segment (Direct visits to deep blog posts).
   - Per-page counts of OAI-SearchBot / ChatGPT-User / Claude / Perplexity / Bingbot hits from logs.
   - Weekly indexed-URL counts in Google and Bing, as an early warning of deindexing.

### Not worth the effort

- llms.txt work.
- Schema added for AI's sake.
- FAQ blocks for AI.
- Chunking content.
- Google Business Profile (ineligible).
- Wikipedia/Wikidata (not yet).
- Reddit seeding (banned).
- Chasing exact fan-out phrasings (only ~27% repeat run to run).

### Uncertain — small tests only, with Google + Bing + AI measured before and after

- **Merging existing rewordings.** If tested at all:
  - Only posts with no AI or Bing visits and no bookings.
  - A one-to-one 301 to the closest-intent page, never a hub.
  - IndexNow the same day; internal links repointed.
  - A held-out comparison set.
  - Watch 8–12 weeks. AI citations can stay on the old URL for 6–10 weeks.
- **Rewriting pages AI already cites.** Body-only rewrites cut retrieval in one benchmark.
- **Removing "2026" from titles.** No guidance either way.
- **The 20 new airports:** leave them alone for 60–90 days.

---

## 10. Open questions

- What share of ChatGPT's answers come from its own index, Google scrapes or Bing. Estimates conflict, and
  OpenAI hasn't confirmed anything.
- Whether OpenAI now renders JavaScript (one unconfirmed report, Sep 2026).
- Whether ChatGPT referrer tagging is reliably fixed after the Oct 9–15 gap.
- Whether near-duplicate breadth helps or hurts AI citation share. Needs our own controlled test once
  measurement is in place.
- What stamps `contentUpdatedAt`, and which blog-engine copy runs. Both are still with Vin from the blog plan.

---

## 11. Corrections from the fact-check

- Mueller said "crawled – currently not indexed" reflects quality concerns **sometimes**, not always.
- The doorway "substantially similar pages" wording is long-standing. The May 2026 change was the clause about
  AI responses.
- The Search Engine Land pruning case is dated Oct 19 2026. Its "+55% sessions" is confounded, and it shows no
  measured loss from hub redirects.
- The Ahrefs title-similarity comparison is 0.602 vs 0.484. The 0.656 figure is a different measure.
- "ChatGPT uses Microsoft Web IQ" is a Microsoft company marketing line. No named executive said "some
  answers", and the Bing announcement doesn't mention ChatGPT.
- The GEO critical survey does **not** say page count vs consolidation is untested. That was an inference.

---

## 12. Sources

Fact-checked as accurate unless noted.

**Official (Google, Bing, OpenAI, Vercel):**
- Google — Optimizing your website for generative AI features on Google Search (May 15 2026, updated Jul 10
  2026): https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
- Google — AI features and your website (Dec 10 2025):
  https://developers.google.com/search/docs/appearance/ai-features
- Google — Spam policies (updated Aug 28 2026):
  https://developers.google.com/search/docs/essentials/spam-policies
- Google — Search Console generative AI performance reports (Jun 3 2026):
  https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports
- Mueller on "crawled – currently not indexed" (Search Engine Roundtable, Jul 16 2026):
  https://www.seroundtable.com/google-crawled-not-indexed-quality-ai-content-41701.html
- Bing — Does Duplicate Content Hurt SEO and AI Search Visibility? (Dec 19 2025):
  https://blogs.bing.com/webmaster/December-2025/Does-Duplicate-Content-Hurt-SEO-and-AI-Search-Visibility
- Bing guidelines add GEO (Search Engine Journal, Feb 27 2026):
  https://www.searchenginejournal.com/bing-adds-geo-to-official-guidelines-expands-ai-abuse-definitions/568442/
- Bing Webmaster Tools AI Performance (Feb 10 2026):
  https://blogs.bing.com/webmaster/February-2026/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview
- OpenAI — Overview of OpenAI crawlers: https://developers.openai.com/api/docs/bots
- Anthropic — crawlers: https://support.claude.com/en/articles/8896518
- Perplexity — crawlers: https://docs.perplexity.ai/guides/bots
- Vercel — Bot management (updated Sep 10 2026): https://vercel.com/docs/bot-management

**Studies and case studies:**
- Chen & Koudas, "What Drives AI Citations?" (arXiv, Oct 2026): https://arxiv.org/abs/2610.15033
- Martinez, "Optimizing Visibility in Generative Engines: A Critical Survey of GEO (2023–2026)" (arXiv, Jul
  2026): https://arxiv.org/abs/2607.14035
- Aggarwal et al., "GEO: Generative Engine Optimization" (KDD 2024): https://arxiv.org/abs/2311.09735
- Puerto et al., "C-SEO Bench" (2025): https://arxiv.org/abs/2506.11097
- Ahrefs — Why ChatGPT cites pages (Apr 15 2026): https://ahrefs.com/blog/why-chatgpt-cites-pages/
- Ahrefs — Schema and AI citations (May 11 2026): https://ahrefs.com/blog/schema-ai-citations/
- Ahrefs — llms.txt study (Jun 15 2026): https://ahrefs.com/blog/llmstxt-study/
- Ahrefs — AI Overview citations vs top 10 (Mar 2 2026): https://ahrefs.com/blog/ai-overview-citations-top-10/
- Ahrefs — AI assistants prefer fresher content (2025):
  https://ahrefs.com/blog/do-ai-assistants-prefer-to-cite-fresh-content/
- Ahrefs — Brand mentions and AI Overviews (May 2025): https://ahrefs.com/blog/ai-overview-brand-correlation/
- Surfer — Query fan-out impact (Sep 2026): https://surferseo.com/blog/query-fan-out-impact/
- Glenn Gabe — When "Mt. AI" crumbles, ChatGPT can follow (Apr 20 2026):
  https://www.gsqi.com/marketing-blog/when-mt-ai-crumbles-chatgpt-follows/
- Glenn Gabe — Surging in ChatGPT, dead in Google (Jun 22 / Aug 3 2026):
  https://www.gsqi.com/marketing-blog/surging-in-chatgpt-dead-in-google
- Peec AI — ChatGPT built its own search index (Sep 2026; Peec's inference):
  https://peec.ai/blog/chatgpt-built-its-own-search-index
- ChatGPT drops UTM parameters (GPT-6) (Search Engine Roundtable, Oct 14 2026):
  https://www.seroundtable.com/utm-parameters-missing-chatgpt-42299.html
- Search Engine Land — Content pruning case study (Oct 19 2026):
  https://searchengineland.com/content-pruning-case-study-497056
- Amsive — March 2026 core update winners and losers (Apr 30 2026):
  https://www.amsive.com/insights/seo/google-march-2026-core-update-winners-losers-analysis/
- Seer Interactive — Reviews and brand presence in AI search (2026):
  https://www.seerinteractive.com/insights/study-of-800k-ai-responses-how-reviews-shape-brand-presence-in-ai-search
- Vercel — The rise of the AI crawler (Dec 2024): https://vercel.com/blog/the-rise-of-the-ai-crawler
- FTC Consumer Reviews and Testimonials Rule (16 CFR 465), via Venable (Dec 2025):
  https://www.venable.com/insights/publications/2025/12/ftc-signals-heightened-enforcement-of-new

*Created October 21, 2026. Evidence base for blog plan v3.2. Re-check sources older than 12 months before
relying on them.*
