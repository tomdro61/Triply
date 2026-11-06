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
| data | **`generate` refuses an airport whose data file is missing, has any lot without a `sellable` flag, has no sellable lot, or was verified more than 90 days ago** (`--allow-stale-data` for the last one; an unreadable date counts as stale). Checked for every item BEFORE any scrape or batch submission, together with the live-slug check (a LIVE slug needs `--publish`). Every figure comes from the data block, so the block has to be real. | `index.ts` |

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
The map stays empty until the W2 merge test. `buildBlogRedirects` validates the map at build time (slug → slug,
no self-redirect, no chain) and fails `next build` on a bad entry — a 308 is cached by browsers, so a wrong
entry must never ship. Tests: `src/lib/blog/__tests__/blog-redirects.test.ts` and
`src/config/__tests__/blog-redirects.test.ts`. The sitemap and post cards build URLs from CMS slugs, so a merged
post must also be unpublished, or the sitemap keeps listing a URL that redirects.

**`apply-edit` (B-4): the one way to change an existing post.**

```
npx tsx src/apply-edit.ts --slug <slug> --edit edit.json --preview
npx tsx src/apply-edit.ts --slug <slug> --edit edit.json --apply [--stamp]
```

`edit.json` holds `fields` (title, excerpt, seo, faqItems — **`faqItems` replaces the whole list**, so send every
item you want to keep; the preview diff shows what goes), `insert`
(`{ "underHeading": "...", "html": "<p>...</p>", "position": "end" | "start" }`) and/or `replace`
(below).
- `--preview` reads the post by slug in any status and applies the edit in memory. It runs the lint
  (existing-post rules), the **P3 price check** and the link/image guard. It then writes
  `reports/apply-preview/<slug>.html`, `.diff.txt` and `.meta.json`. Nothing goes to the CMS.
- The P3 price check is deny by default. Every `$`/`C$` figure the edit adds must be in
  `data/airports/<code>.json`, with lots already limited to sellable ones, or sit in a paragraph that links its source.
- `--apply` re-reads the post and refuses if it changed since the preview. It re-runs every check,
  backs up the live JSON, then PATCHes by id. Only the new section goes through HTML → Lexical; the rest
  of the body is spliced untouched. It re-reads to confirm no link or image was lost, that no link or image the
  edit removed is still there, and that the stored body matches what was sent by structure (node types, text,
  link URLs, media ids — not just the text), then pings IndexNow when the post is published. A PATCH that throws
  is settled by the same structural comparison.
- `contentUpdatedAt` moves only with `--stamp` **and** a non-empty facts diff, meaning a number-bearing
  sentence was added or removed in the body or the FAQ (stamp.ts rule: titles and metadata are not facts).
- Review fixes (Nov 2026): `edit.json` is validated strictly (unknown keys, a bad `position`, an empty
  `faqItems` are refused); a heading that is missing or appears twice is refused, as is an insert whose text is
  already under the heading (a retry after a lost PATCH response would otherwise add it twice); the price
  allow-list is what the writer prompt sees for the airport (`figureSource`), not every number in the file, and
  only an **external** link sources a paragraph; `--apply` refuses unless it is the same post, unchanged, with
  the same `edit.json` producing the same patch as the preview (hashes in `.meta.json`); a PATCH that throws is
  settled by re-reading the post (applied / not live / unknown, naming the backup); lint errors already in the
  live post are reported, not blocking.

**`replace` (Nov 2026): remove or rewrite stale body text** instead of inserting a correction above it (which
leaves the post contradicting itself). An array of operations, run in order, before any `insert`:

```json
{ "replace": [
  { "section": "Off-site lots", "html": "<p>...</p>", "heading": "optional new heading text" },
  { "remove": "Old lot price table" },
  { "text": "The DoubleTree costs about $26/day.", "html": "<p>The DoubleTree costs about $15/day.</p>" }
] }
```

- `section`: replaces everything between that heading and the next heading of the same or higher level
  (sub-headings included). The heading stays unless `heading` renames it (same level; the
  heading is FOUND ignoring case and whitespace, but a rename is decided case-sensitively, so a case-only fix renames). The new html may hold
  lower-level sub-headings, never one that would split the section.
- `remove`: drops the heading and its whole section.
- `text`: replaces ONE block (paragraph, quote, list, list item or table) whose whole plain text equals `text`
  (whitespace and case ignored; table cells and list items are joined with a space). `"html": ""` deletes it.
  A list item is replaced inside its list (`html` may be `<li>…</li>` or inline HTML).
- Headings and texts must match exactly once. 0 or 2+ matches are refused, and the error lists the nearest
  headings / blocks so you can copy the exact text. An operation may not target content an earlier operation wrote:
  a `section` or `remove` refuses any range that holds earlier output, and a whole-list `text` op is refused after an
  item edit in that same list. Operations run in order, so op 2 sees the post as op 1 left it.
- Lint: errors already in the live post (every match, block by block, not just the first per rule) are reported as
  pre-existing, not blocking; an error in the inserted / replaced html always blocks.
- Links and images inside removed content are expected to go: the guard allows exactly those (by URL / media id)
  and still blocks any other loss. The preview log and `.diff.txt` list every removed link and image (`✂`).
- `.diff.txt` starts with `REPLACE OPERATIONS` (every removed and added line, op by op), then the full text diff.
- The new html gets the full price check (blocking). For every body edit (`insert` included, not only `replace`)
  the price check also runs on the whole resulting body and
  lists figures still in the post that the allow-list lacks (`⚠ figures still in the post…`, in the log, the
  diff and `.meta.json`) — so a stale `$26/day` two paragraphs down is still seen. It warns, it does not block:
  old posts carry computed totals the allow-list never holds.

Review round 2 (Nov 2026) — each with a regression test in `src/apply-edit-replace.test.ts` (R1–R10):
- **The booking CTA is protected.** `booking-links` appends the "Compare … parking rates" paragraph as the last
  root node of ~3,700 posts. A section never runs into it: when a section reaches the end of the post, it stops
  before trailing booking-CTA paragraphs (so `remove` / `section` on the last heading, and `insert` at `"end"`, leave
  the CTA last). As a backstop, an edit whose result has no link to the airport's booking page, when the live post
  had one, is **refused** unless edit.json sets `"allowBookingLinkRemoval": true` (strict like every key, bound by
  the preview hash; the preview log, `.diff.txt` and `.meta.json` then say the link goes). To remove a CTA on purpose,
  target it with a `text` op and set the flag.
- **Links and images must survive conversion.** HTML → Lexical silently drops an `<img>` inside a `<p>`/`<li>`/`<td>`/
  `<a>`, an `<img>` with no numeric `data-media-id`, and a link with no text. Every op's html (and `insert` html) is
  compared with what it converts to, by URL / media id, and any loss is refused before the removed-content allowance
  exists. Put each image in its own block (`<img data-media-id="…">` or `<figure>`).
- **Prices are checked block by block**: each converted node on its own, and the html as written, split at every
  block tag (conversion merges the `<p>`s of a `<blockquote>`, so a converted quote could carry a source link the
  author put in another paragraph). `lint.ts priceCheck` now also splits at `</blockquote>`, and the whole-body
  warning list is computed root node by root node, so no figure borrows another block's external link.
- **Promo codes:** new html is checked for unapproved codes whenever the post (before or after the edit) talks about
  promo / coupon codes, even if the new html itself doesn't ("SpotHero's SPOT10 offer…" used to pass, reported as
  pre-existing, when the live post already printed SPOT10).
- **Unsold lots:** new html, renamed headings and new field text may not name a lot in the airport file's
  `unsellableLotNames` (same name matching as the writer prompt, `unsellableNameMatchers` in `prompts/write.ts`).
- **Table-pattern lists** (bullet lists the site draws as a table: every item `<strong>Header:</strong> … | …`, 2+
  items, `RichText.tsx isTablePattern`): an item edit that breaks the pattern is refused, and the error shows the
  `<li><strong>Lot:</strong> … | <strong>Rate:</strong> …</li>` shape to use. Replace the whole list or section to
  change it into something else.
- An op may not target anything an earlier op wrote, **including list items inside a list it wrote**.
- A `text`, `section`, `remove` or `insert` target that is empty once whitespace is ignored is refused (it matched
  empty blocks and every image). Whitespace-only `insert` html is refused too.
- **A check that could not run is said out loud**: with no `airportCode` or no `data/airports/<code>.json`, the log,
  `.diff.txt` and `.meta.json` (`notRun`) carry `whole-body price check NOT RUN: <reason>` (and the same for the
  unsold-lot check) instead of an empty list.

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
- A PATCH that throws is settled by re-reading the post (`src/settle-patch.ts`): edit present = applied, absent = rollback entry removed, re-read failed = entry kept with `patchUnverified` (skipped by perf measure / maintain learn / GEO measure, still cooling down) and a warning telling the operator to check the CMS and clear it or `perf revert`.
- Prompts: no more "use hedging language (typically, around)", no "save up to 60%" examples, no fake-research phrases, no stale "February 2026"; the editor sees the sellable-lot rule; competitor names are filtered out of "entities to mention"; US-only sources are dropped for Canadian airports in every list.
- `src/publish-lga.ts` (published every LGA draft, ignored errors) deleted.

## Verify

```
cd scripts/blog-engine && npm install
npx tsc --noEmit        # the XLSX namespace errors in the import-queue scripts are known and pre-existing
npm test                # node:test — guard, lint, stamp, html-to-lexical, gsc paging, retry …
npm run generate -- -a JFK -n 1 --dry-run
npx tsx src/apply-edit.ts --slug <slug> --edit edit.json --preview
```

No secrets: `.env` is gitignored; `.env.example` lists every variable.

*Updated November 6, 2026 — apply-edit `replace` review round 2: booking-CTA protection + `allowBookingLinkRemoval`, conversion-loss refusal, per-block price check, promo/unsold-lot/table-pattern checks, structural settle + post-save check, NOT RUN notices.*
