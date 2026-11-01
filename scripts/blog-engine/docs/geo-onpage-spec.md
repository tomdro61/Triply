# On-Page GEO Spec — for Tom (frontend / CMS)

**Goal:** make blog articles maximally *citable* by AI search engines (Google AI Overview today; ChatGPT/Perplexity crawlers already allowed via `robots.txt` + `llms.txt`). The engine side now **measures** AI-Overview citation per article (`maintain geo`), so these on-page levers can be validated against real citation-rate movement.

**What already exists (good — no action):** Article + FAQPage + BreadcrumbList JSON-LD; `robots.txt` welcomes GPTBot/ClaudeBot/PerplexityBot/OAI-SearchBot; `llms.txt`; sitemap with `lastmod`. This spec is only the gaps.

---

## 1. Confirm `contentUpdatedAt` exists on Posts  *(verify — may already be done)*
The engine writes `post.contentUpdatedAt` on every content refresh (`perf-apply.ts`, `index.ts`). Audit flagged it may **not** be defined in `triply-cms-main/src/collections/Posts.ts`. If missing, PATCHes silently drop it.
- **Action:** ensure a `contentUpdatedAt` (date) field exists on Posts. Confirm JSON-LD `dateModified`, OG `article:modified_time`, and sitemap `lastmod` read from it (falling back to `publishedAt`). Freshness is a ranking + AI-trust signal.

## 2. Dedicated `quickAnswer` + `keyTakeaways` fields + a `QuickAnswerBox` component  *(highest GEO value)*
Today the engine prepends `<h3>Quick answer</h3><p>…</p>` **inline** into Lexical content — an unstable extraction target with no distinct markup.
- **CMS:** add `quickAnswer` (textarea, ~40–75 words) and `keyTakeaways` (array of text) to Posts. The engine can populate these directly instead of splicing into the body.
- **Frontend:** render a `QuickAnswerBox` at the top of the article (semantic `<div id="quick-answer">` / `<section>`), and a "Key Takeaways" list. Distinct DOM = clean AI extraction + a Speakable target (below).
- **Why:** answer-first, clearly-delimited blocks are what AI Overviews quote.

## 3. Speakable JSON-LD
Add `speakable` to the Article schema pointing at the quick-answer + FAQ:
```json
"speakable": {
  "@type": "SpeakableSpecification",
  "cssSelector": ["#quick-answer", ".faq-answer"]
}
```
- **Why:** explicitly marks the passages best suited for voice/AI answer surfaces.

## 4. Author + source (E-E-A-T / citation trust) markup
- **Author:** emit `author` as a `Person` with `jobTitle`, `url`, and `sameAs` (LinkedIn/author page) rather than a bare name — LLMs weight identifiable expertise.
- **Sources:** where an article cites external data (rates, airport facts), emit schema.org `citation` on the Article, and render visible source links. AI answers preferentially cite pages that themselves cite sources.

## 5. (Optional) per-cluster entity clarity
Ensure `about`/`mentions` on the Article reference the airport as a `Place`/`Airport` entity (IATA code, name). Sharpens topical entity association for AI retrieval.

---

## Priority order
1. **#2** (dedicated answer fields + box) — biggest citation lever, and gives #3 a target.
2. **#1** (contentUpdatedAt) — quick, may already be done.
3. **#3** Speakable, **#4** author/source markup.
4. **#5** entity markup.

**Validation:** after each ships, the engine's `maintain geo capture` + `maintain learn` will show whether corpus citation rate and quick-answer/faq *citation win rate* move — so we can measure these instead of guessing.
