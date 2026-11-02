# Triply Blog Engine — Operator's Guide

Everything you need to run the blog engine day to day. Two systems: one **writes**
articles, one **improves** them. Most of it runs on a schedule; you trigger the rest.

---

## 1. The mental model

```
  GENERATION (writes)                 IMPROVEMENT (makes them perform)
  keyword → research → write     →     measure → learn → treat → auto-revert
  → score → infographics                (weekly loop; watches GSC + AI Overviews
  → publish → ping Bing                  + user behavior; reverts what hurts)
```

- **Generation** is on-demand: you run it per airport cluster.
- **Improvement** is a weekly closed loop that's safe to leave running.
- The **dashboard** shows you what the improvement engine is doing, live.

---

## 2. What runs automatically vs. what you trigger

| Cadence | What | How |
|---|---|---|
| **On publish** (auto) | SEO scoring, infographics, Bing IndexNow ping | built into `generate` |
| **Daily** (scheduled) | Safe test: refresh GSC snapshots, preview treatments (applies nothing) | `run-daily-test.ps1` → task `TriplyBlogDailyTest` |
| **Weekly** (scheduled) | Real loop: measure → learn → treat → cannibalization audit | `run-weekly-maintenance.ps1` → task `TriplyBlogWeeklyMaintenance` |
| **On demand** | Generate a cluster, view dashboard, Clarity UX report, ad-hoc audits | commands below |

---

## 3. Day-to-day commands

Run all of these from `scripts/blog-engine/`.

### See what's happening
```bash
npm run dashboard                 # → http://localhost:4319   live improvement-engine view
```
Read-only, auto-refreshes every 60s. Tiers, positions, treatment verdicts, GEO
citation, cannibalization, and Clarity friction — all in one page.

### Improvement loop (usually scheduled, but you can run by hand)
```bash
# Full weekly cycle on one cluster (safe to run manually):
powershell -File run-weekly-maintenance.ps1 -Airport MSP -Limit 10

# Daily safe test (no edits applied — just refreshes data + previews):
powershell -File run-daily-test.ps1 -Airport SAN

# Preview/measure pieces individually:
npm run maintain -- status                 # tier distribution, what's due (no API calls)
npm run maintain -- plan --refresh -a MSP  # pull fresh GSC + classify tiers
npm run maintain -- run -a MSP --limit 5   # DRY-RUN preview (add --apply to actually edit)
npm run perf -- measure --all              # judge past edits, auto-revert regressions
npm run maintain -- learn                  # update treatment ROI + policy
```

### Keep the whole corpus tracked
```bash
npm run track-all                          # snapshot EVERY published article (1 bulk GSC query)
```
Backfills/refreshes a record for all ~3,600 published posts so the dashboard and loop
see the full corpus, not just recently-touched articles. Cheap (~40 calls); runs
automatically as step 0 of the daily + weekly scripts. Run once now to backfill.

### Diagnostics (on demand)
```bash
npm run cannibalization -- -a ATL          # pages of yours competing for the same query
npm run clarity -- suggest                 # user-behavior data → Claude UX fixes (max ~10/day)
npm run indexnow -- --all                  # ping Bing about every published URL (backfill)
```

### Generate new content
```bash
npm run generate -- -a DTW -n 10 --min-sv 0            # generate 10 articles for DTW
powershell -File run-generate-arm.ps1 -Arm haiku -a DTW -n 8   # A/B: cheaper analyze+edit
npm run analyze-logs                                   # compare cost/quality (incl. arm A/B)
```

---

## 4. The improvement loop, explained

The weekly cycle (`run-weekly-maintenance.ps1`) does, in order:

1. **Pre-flight** — checks Anthropic + SerpAPI have credit; skips spend-steps if a key is dead.
2. **`perf measure --all`** — for each past edit older than its 28-day window, pulls fresh
   GSC and assigns a verdict (helped / hurt / neutral). **Auto-reverts** anything that hurt.
3. **`maintain geo measure`** — records whether GEO edits gained/lost AI-Overview citation.
4. **`maintain geo capture`** — refreshes AI-Overview citation for top ranking pages (SerpAPI).
5. **`maintain learn`** — tallies what works by fix type; disables tactics that measurably lose.
6. **`maintain run --apply`** — treats the highest-demand DUE articles by tier (rewrites gated):
   - **Tier 3** (page 1, pos 4–10): title/meta CTR rescue.
   - **Tier 2** (striking distance, pos 11–20, or AI-Overview capture): quick-answer / FAQ for citation.
   - **Tier 1** (real demand, failing rank): full rewrite — **human-approved only**.
   - **Tier 0**: watch, leave alone.
7. **Cannibalization audit** — refreshes the duplicate-page report (GSC-only).

**Why weekly, not daily:** whether an edit helped needs ~28 days of Google data, and an
edited article is frozen in a 28-day cooldown. Daily *applying* would just hit cooldowns.
The daily test therefore only refreshes data + previews — the weekly run is what edits.

---

## 5. One-time setup checklist

- [ ] **`.env`** present with keys (see `.env.example`): `ANTHROPIC_API_KEY`, `PAYLOAD_*`,
      `SERPAPI_API_KEY` (+ `_2`), `SERP_CACHE_TTL_HOURS`, `INDEXNOW_KEY`, `CLARITY_API_TOKEN`.
- [ ] **`npm run gsc:auth`** once → creates `gsc-token.json` (needed for all perf/maintain).
- [ ] **Register the two scheduled tasks** (elevated PowerShell — see
      `docs/weekly-maintenance-schedule.md` and `docs/daily-test-and-dashboard.md`).
- [ ] **IndexNow key file** hosted at `https://www.triplypro.com/<INDEXNOW_KEY>.txt` (Tom).
- [ ] **Clarity JS tag** on the frontend (already live).
- [ ] **`npm run track-all`** once to snapshot every published article into the engine.

---

## 6. Cost & quota knobs

| Lever | Where | Effect |
|---|---|---|
| `SERP_CACHE_TTL_HOURS` | `.env` (default 144) | reuse recent SERP pulls; protects SerpAPI quota |
| `-GeoLimit` / `-Limit` | weekly script params | cap SerpAPI captures / treatments per run |
| `--no-serp` | perf/maintain | skip live SERP (uses GSC + cache only) |
| `MODEL_ANALYZE`, `MODEL_EDIT` | `.env` | set to `claude-haiku-4-5-20251001` for ~3× cheaper analyze/edit |
| `PROMPT_VERSION` | `.env` | `v1` (default, proven) or `v2` (mobile-first/GEO A/B) |
| Batches API | `src/batch.ts` | 50% cheaper text (async) — not yet wired into generation |

**Current SerpAPI status:** two keys with auto-rotation; keep an eye on quota (the cache
+ weekly-only geo capture keep spend low). `npm run preflight` reports credit on both.

---

## 7. Reading the dashboard

- **KPIs** — articles tracked, avg position, changes applied vs. measured vs. auto-reverted,
  how many are due, AI-citation rate.
- **Position buckets / tiers** — where pages sit and their maintenance tier.
- **Verdicts / ROI** — which fix types actually help (fills in ~28 days after edits).
- **GEO** — AI-Overview citation gained / lost / held.
- **Cannibalization** — queries where 2–5 of your pages compete (consolidate or differentiate).
- **Clarity** — pages with the most dead/rage clicks (UX fixes, mostly for Tom).
- **Article table** — sortable; position-trend sparkline grows a point per daily run.

Empty panels are honest, not broken: verdicts/tiers/GEO fill in as the loop runs.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard blank / "port in use" | `DASHBOARD_PORT=4320 npm run dashboard`, or it's already running |
| `Not authenticated` (GSC) | `npm run gsc:auth` |
| Clarity "429 / daily limit" | wait — Clarity API is capped at ~10 calls/day |
| A batch stalls | check credit: `npm run preflight` |
| `maintain run` finds "nothing due" | expected — articles are in their 28-day cooldown |
| A weekly step errored | it's logged and skipped, not fatal — see `reports/maintenance-logs/` |

---

*Generated as part of the 2026 blog-engine improvement work. Companion docs:
`weekly-maintenance-schedule.md`, `daily-test-and-dashboard.md`, `Triply-Blog-Engine-Explained.pdf`.*
