# Blog engine in `main` — what moved, the flags, how to run

PR: roadmap step 1 (Blog Growth Roadmap v3.4 §5 Q2; plan v3.2 §W1). Until this PR the engine that
actually wrote posts lived on Vin's local branch `vin/main`; `main` had an older copy with no publish
path, no IndexNow ping and no duplicate guard. This PR makes the in-repo engine the one that runs.

## What moved in

| Area | Files | Notes |
|---|---|---|
| Core | `src/index.ts`, `payload.ts`, `claude.ts`, `config.ts`, `queue.ts`, `retry.ts`, `preflight.ts`, `generate-batch.ts`, prompts (`write`, `write-v2`, `write-switch`, `edit`) | retry + timeout on every CMS call, batch mode, per-step model overrides |
| Indexing | `src/indexnow.ts`, `index-coverage.ts`, `unindexed-merge-map.ts`, `gsc.ts` (paged) | key file: `public/a36d16ee395347eb33ed68ef73858f5f.txt`; env `INDEXNOW_KEY` |
| Maintenance | `backlinks.ts`, `monthly-prices.ts`, `differentiate-titles.ts`, `perf-*.ts`, `maintain*.ts`, `booking-links.ts`, `inject-coupon.ts`, … | the weekly/monthly tools the running copy had |
| One-off scripts | `reports/new-airports/*.mts` + `WRITER-RULES.md`, `reports/lot-rewrite/{api-rewrite,publish,export,preview,stale-swap,make-infographics}.mts` + `RULES.md`, `reports/publish-price-index.mts` | the scripts that wrote Oct 13–24 content |
| Docs | `docs/OPERATORS-GUIDE.md` and the specs | |

**Left out on purpose:** generated data (`reports/articles/`, batch JSONs, images, logs), the GSC OAuth
token files, `.env`, `.bak` files, the Thanksgiving price-index markdown (now read from
`PRICE_INDEX_MD=<path>`). The Discord webhook that was hard-coded in `weekly-report.ts` is now
`DISCORD_WEBHOOK_URL` in `.env` — set it or the digest is only printed.

## The W1 guardrails (new in this PR)

| W1 | What | Where |
|---|---|---|
| 1.1 | **Duplicate guard.** Keyword normalised (airport names/codes and fillers dropped; cost≈price≈rates≈fee≈per day, shuttle≈bus, pick-up≈visitor≈waiting folded; long-term / hourly / terminal X / garage names kept distinct) and compared with every slug at the airport in ANY status + the redirect map. A match is refused, logged to `logs/duplicate-refusals.log`, and the queue item is marked error "update /blog/<slug> instead". | `src/duplicate-guard.ts`, `generate` in `index.ts` |
| 1.1 | Redirect map both app and engine read: `src/config/blog-redirects.json` (repo root, flattened, `{}` for now) with a unit test (no chains, no loops). | `src/config/__tests__/blog-redirects.test.ts` |
| 1.1 | `getAllPublishedSlugs()` pages past the old 500 cap; `getAllSlugsAnyStatus()` added. | `src/payload.ts` |
| 1.4 | **Lint fails the write:** artifact phrases, money with no `$`/`C$`, "verified"/"working" near a code, code strings not in `src/config/approved-promo-codes.json`, "save up to N %" with no source link in the paragraph; new posts only: a non-current year in title/metaTitle. | `src/lint.ts` |
| 1.7 | **Stamping.** `contentUpdatedAt` is set only when a run passes `--stamp` AND the caller says facts changed; every other call logs why the date stayed. Gated: `index.ts` regenerate, `perf-apply.ts`, `monthly-prices.ts`, `inject-coupon.ts`, `lot-rewrite/publish.mts`, `new-airports/fix.mts`, `new-airports/update-hub.mts`. New posts never get a stamp. | `src/stamp.ts` |
| 1.9 | `status: 'review'` (rejected by the CMS) is gone: a post under the hard floor stays a draft and is called out. `delete-post.ts` needs `--id` or `--slug` plus `--yes`. | `claude.ts`, `delete-post.ts` |
| 1.10 | **Answer first.** Writer rule 16a: a rates/cost post's first paragraph carries the direct answer with a sourced `$` figure and "as of <Month YYYY>"; the lint enforces it for new posts. | `prompts/write.ts`, `write-v2.ts`, `lint.ts` |
| 1.11 | **IndexNow** `pingIndexNow(urls)` (alias of `submitUrls`) on every publish and every update: `generate`, `update-links`, `booking-links`, `perf-apply`, `inject-coupon`, `differentiate-titles`, `monthly-prices`, all `reports/*` writers. Warns loudly when `INDEXNOW_KEY` is unset. | `src/indexnow.ts` |
| publish | **`generate` writes drafts by default.** `--publish` creates posts live (the old behaviour). This matches CLAUDE.md: generate as draft → review in Payload → `npm run publish`. | `index.ts` |

| 1.2 | Writer and cluster context ranked by similarity to the keyword (hub first), across all the airport's posts. | `src/similarity.ts`, `payload.ts` `getClusterContext`, `index.ts`, `generate-batch.ts` |
| 1.3 | `$` figures not in the airport data file and not next to a source link are flagged (warning, does not block yet). | `lint.ts` `knownFigures` |
| 1.5 | Promo posts framed as "how to save"; prompts no longer ask for "verified"/"working" codes or promise one use per customer. | `prompts/write*.ts` rule 16b, `edit.ts`, `inject-coupon.ts` |

Still open in W1: 1.6 sellable-only CAD helpers (Tom's PR #96; it conflicts on `airport-data.ts`,
`external-links.ts`, `infographics.ts`, `prompts/*`), 1.8 P3c (waits on P3).

## Redirects and the preview → apply path (stacked PR, roadmap steps 17–18)

**Redirect map wiring (B-3).** `src/config/blog-redirects.json` (repo root, flattened `{ old: new }`)
now feeds two places through `src/lib/blog/blog-redirects.mjs`:
- `next.config.mjs` `redirects()`: every entry becomes `/blog/<old>` → `/blog/<new>`, `permanent: true` (308).
- `src/components/blog/RichText.tsx`: any link to `/blog/<old>` renders as `/blog/<new>`, whether it is
  absolute (`triplypro.com`, with or without `www`) or relative, and keeps any trailing slash, query or `#fragment`.
  Readers and crawlers never hop through the redirect.
The map stays empty until the W2 merge test. Tests: `src/lib/blog/__tests__/blog-redirects.test.ts` and
`src/config/__tests__/blog-redirects.test.ts` (no chains, no loops).

**`apply-edit` (B-4): the one way to change an existing post.**

```
npx tsx src/apply-edit.ts --slug <slug> --edit edit.json --preview
npx tsx src/apply-edit.ts --slug <slug> --edit edit.json --apply [--stamp]
```

`edit.json` holds `fields` (title, excerpt, seo, faqItems) and/or `insert`
(`{ "underHeading": "...", "html": "<p>...</p>", "position": "end" | "start" }`).
- `--preview` reads the post by slug in any status and applies the edit in memory. It runs the lint
  (existing-post rules), the **P3 price check** and the link/image guard. It then writes
  `reports/apply-preview/<slug>.html`, `.diff.txt` and `.meta.json`. Nothing goes to the CMS.
- The P3 price check is deny by default. Every `$`/`C$` figure the edit adds must be in
  `data/airports/<code>.json`, with lots already limited to sellable ones, or sit in a paragraph that links its source.
- `--apply` re-reads the post and refuses if it changed since the preview. It re-runs every check,
  backs up the live JSON, then PATCHes by id. Only the new section goes through HTML → Lexical; the rest
  of the body is spliced untouched. It re-reads to confirm no link or image was lost and pings IndexNow
  when the post is published.
- `contentUpdatedAt` moves only with `--stamp` **and** a non-empty facts diff, meaning a number-bearing
  sentence was added or removed.

## Flags

```
npm run generate -- -a JFK -n 3                 # drafts; guard + lint on; no stamp; no ping (drafts aren't public)
npm run generate -- -a JFK -n 3 --publish       # live, IndexNow pinged
npm run generate -- -s <slug> --publish --stamp # regenerate one existing post and move contentUpdatedAt
npm run generate -- ... --skip-duplicate-guard  # DANGEROUS; only when a person has read the refusal log
npx tsx src/monthly-prices.ts --apply --stamp
npx tsx reports/lot-rewrite/publish.mts atl --apply --stamp
npx tsx src/delete-post.ts --slug <slug> --yes
```

`STAMP_CONTENT_UPDATED=1` in the environment is the same as `--stamp`.

## Verify

```
cd scripts/blog-engine && npm install
npx tsc --noEmit        # the XLSX namespace errors in the import-queue scripts are known and pre-existing
npm test                # node:test — guard, lint, stamp, html-to-lexical, gsc paging, retry …
npm run generate -- -a JFK -n 1 --dry-run
npx tsx src/apply-edit.ts --slug <slug> --edit edit.json --preview
```

No secrets: `.env` is gitignored; `.env.example` lists every variable.
