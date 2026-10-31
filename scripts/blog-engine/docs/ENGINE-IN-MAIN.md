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
| 1.4 | **Lint fails the write:** artifact phrases, money with no `$`/`C$` (times, counts and ranges excluded), "verified"/"working" near a promo code, code strings not in `src/config/approved-promo-codes.json` (only in posts that talk about promo/coupon codes), "save up to N %" / "N % off" / "N-M % below" with no OUTSIDE source link in the paragraph or FAQ answer (our own approved code is its own source); new posts only: a non-current year in title/metaTitle. Runs before every write: `generate`, `perf-apply`, `inject-coupon`. | `src/lint.ts` |
| 1.7 | **Stamping.** `contentUpdatedAt` is set only when a run passes `--stamp` AND a sentence with a figure actually changed (`factsDiff()` in `stamp.ts`; `monthly-prices` skips an identical block outright; coupon, FAQ, quick-answer and title edits never count). Every other call logs why the date stayed. New posts never get a stamp. | `src/stamp.ts` |
| 1.9 | `status: 'review'` (rejected by the CMS) is gone: a post under the hard floor stays a draft and is called out. `delete-post.ts` needs `--id` or `--slug` plus `--yes`. | `claude.ts`, `delete-post.ts` |
| 1.10 | **Answer first.** Writer rule 16a: a rates/cost post's first paragraph carries the direct answer with a sourced `$` figure and "as of <Month YYYY>"; the lint enforces it for new posts. | `prompts/write.ts`, `write-v2.ts`, `lint.ts` |
| 1.11 | **IndexNow** `pingIndexNow(urls)` (alias of `submitUrls`) on every publish and every update: `generate`, `update-links`, `booking-links`, `perf-apply`, `inject-coupon`, `differentiate-titles`, `monthly-prices`, all `reports/*` writers. Warns loudly when `INDEXNOW_KEY` is unset. | `src/indexnow.ts` |
| publish | **`generate` writes drafts by default.** `--publish` creates posts live (the old behaviour). This matches CLAUDE.md: generate as draft → review in Payload → `npm run publish`. A regenerate of a LIVE post also needs `--publish` (it replaces the body in place); a regenerate never flips a post's status, and the queue item follows the post's real status. `npm run publish` sets `publishedAt`, reads the post back, then pings IndexNow. | `index.ts` |
| data | **`generate` refuses an airport whose data file is missing, carries no `sellable` flag on any lot, or was verified more than 90 days ago** (`--allow-stale-data` for the last one). Every figure comes from the data block, so the block has to be real. | `index.ts` |

| 1.2 | Writer and cluster context ranked by similarity to the keyword (hub first), across all the airport's posts. | `src/similarity.ts`, `payload.ts` `getClusterContext`, `index.ts`, `generate-batch.ts` |
| 1.3 | `$` figures not in the airport data file and not next to a source link are flagged (warning, does not block yet). | `lint.ts` `knownFigures` |
| 1.5 | Promo posts framed as "how to save"; prompts no longer ask for "verified"/"working" codes or promise one use per customer. | `prompts/write*.ts` rule 16b, `edit.ts`, `inject-coupon.ts` |

Still open in W1: 1.6 sellable-only CAD helpers (Tom's PR #96; it conflicts on `airport-data.ts`,
`external-links.ts`, `infographics.ts`, `prompts/*`), 1.8 P3c (waits on P3).

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

Only `--stamp` on the command line moves the date; there is no environment switch (one in `.env` would
stamp every edit of every writer with nothing visible on the command). `inject-coupon` needs `COUPON_CODE`
set to a code that is in `src/config/approved-promo-codes.json` — there is no default code.

## Review fixes (Oct 30, 2026 — Opus ×3 + Codex on this PR)

- `npm run publish` never published: `generatedPost` is a relationship (a number or an object), the code checked for a string. Fixed; it also sets `publishedAt`, verifies the status after the write and pings IndexNow.
- Regenerate ignored the draft default on live posts; `--publish` on an existing draft marked the queue published while the post stayed a draft. Both follow the post's real status now.
- Lint refused ordinary copy ("open from 5:00 a.m.", "only 2 levels", "a QR code", "$25–35/day", "As of October 2026") and passed "save up to 60%" on any link. Fixed with tests.
- Duplicate guard: "Terminal A" no longer folds into the terminal page, economy stays distinct from long-term, the redirect map only answers for its own airport, and two equivalent keywords in one batch cannot both pass.
- Creates (posts, categories, tags) are never replayed blindly after a timeout; media uploads are not retried after a timeout; IndexNow has a 15 s timeout; perf-apply and inject-coupon write the rollback record before the live edit and skip posts with no perf record; `delete-post` and `monthly-prices` exit non-zero on failure; `generate` exits non-zero when any item failed, so `maintain` no longer counts a failed rewrite as done.
- Prompts: no more "use hedging language (typically, around)", no "save up to 60%" examples, no fake-research phrases, no stale "February 2026"; the editor sees the sellable-lot rule; competitor names are filtered out of "entities to mention"; US-only sources are dropped for Canadian airports in every list.
- `src/publish-lga.ts` (published every LGA draft, ignored errors) deleted.

## Verify

```
cd scripts/blog-engine && npm install
npx tsc --noEmit        # the XLSX namespace errors in the import-queue scripts are known and pre-existing
npm test                # node:test — guard, lint, stamp, html-to-lexical, gsc paging, retry …
npm run generate -- -a JFK -n 1 --dry-run
```

No secrets: `.env` is gitignored; `.env.example` lists every variable.
