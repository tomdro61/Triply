# Spec — Bookings-per-URL as a maintenance signal (GA4)

**Why:** the maintenance engine currently ranks/optimizes blog articles by Google impressions & position and AI-Overview citation — all *proxies*. The true-north metric is **bookings**. This spec wires per-article booking attribution so the tiering can prioritize (and the learning loop can measure) by revenue, not proxies.

**Good news:** the heavy lift is mostly **config + a backend read**, not a frontend rebuild. GA4 already fires a `purchase` event (`gtag.ts`) with `value`/`transaction_id`. We attribute it to the blog article via GA4's **session landing-page** dimension — no new client event required for v1.

---

## Attribution model (v1 — first-touch landing page)

GA4 knows the **landing page** that started each session (`landingPagePlusQueryString`). If a user lands on `/blog/jfk-airport-parking`, browses, and books, that session's landing page is the blog article. So:

> `purchases` (and `purchaseRevenue`) grouped by `landingPagePlusQueryString`, filtered to paths starting `/blog/`  →  bookings & revenue attributed to the article that *started* the journey.

This is honest first-touch attribution and needs **zero frontend changes** beyond GA4 marking `purchase` as a key event. (A more precise multi-touch model is the v2 note below.)

---

## Tom's part (GA4 admin + access) — small

1. **Mark `purchase` as a Key Event** (GA4 → Admin → Events / Key events). This makes it queryable as a conversion.
2. **Create a Google Cloud service account**, download its JSON key.
3. **Grant that service account `Viewer`** on the GA4 property (GA4 → Admin → Property Access Management).
4. **Give us the `GA4_PROPERTY_ID`** (the numeric property id) + the service-account JSON (store like `gsc-oauth.json` — kept out of git).

That's it for Tom. No component or event changes for v1.

## Our part (engine — we build, once the above exists)

1. **Deps/env:** add `@google-analytics/data`; add `GA4_PROPERTY_ID` + `GA4_SA_KEY_PATH` to `config.ts` env schema (both optional, like the SerpAPI keys).
2. **`src/ga4.ts`** — a `BetaAnalyticsDataClient` wrapper:
   ```
   runReport({
     property: `properties/${GA4_PROPERTY_ID}`,
     dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
     dimensions: [{ name: 'landingPagePlusQueryString' }],
     metrics: [{ name: 'keyEvents' }, { name: 'purchaseRevenue' }],
     dimensionFilter: { filter: { fieldName: 'landingPagePlusQueryString',
       stringFilter: { matchType: 'BEGINS_WITH', value: '/blog/' } } },
   })
   ```
   → return `Map<slug, { bookings, revenue }>` (strip `/blog/` + query string → slug).
3. **Join into the record:** extend `PerfSnapshot` with optional `bookings?: { count: number; revenue: number; window: string }`, populated during `buildSnapshot` when GA4 is configured (cheap — one report call covers all URLs, cache per run).
4. **Use it:**
   - **Tier tie-breaker** (`maintain-tier.ts`): among due candidates, a page with real bookings outranks a same-tier page with none; a Tier-0 "winner" with zero bookings despite traffic is worth a commercial-intent look.
   - **Learning loop** (`maintain-learn.ts`): report bookings-per-treatment so ROI is measured in revenue, not just impressions/citations.
   - **Reporting:** cost-per-booking-gained per cycle.

## Cost / cadence
- GA4 Data API is free within generous quotas. One `runReport` per maintenance cycle covers the whole corpus. No per-article cost (unlike SerpAPI).

## v2 (optional, later — more precise attribution)
If first-touch landing page proves too coarse (e.g., users find lots via search, not blog), add a **custom dimension**: on the client, when a session originates on a `/blog/*` page, stamp the slug into a GA4 user/session-scoped custom dimension and read it on `purchase`. That captures blog-assisted conversions even when the blog wasn't the literal landing page. This *does* need a small frontend change — defer until v1 data shows it's needed.

## Sequencing
This is the deferred **#1 elite lever**. It's gated only on the GA4 admin steps above + ~4 weeks of attributed data. Everything else (tiering, learning loop, holdout, GEO track) already works on proxies today and will simply gain a revenue signal when this lands.
