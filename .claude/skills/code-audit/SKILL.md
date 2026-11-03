---
name: code-audit
description: Senior-developer health audit of the whole Triply codebase (or one folder). Measures dead code, unused exports and dependencies, duplication, oversized files, type holes and slow patterns, ranks the cleanups by payoff and safety, and (with `fix`) ships the top batch as one small behaviour-preserving PR. Use monthly, before a big feature, or when a folder feels messy. Not a bug review of a diff; that is /scoped-review.
---

# /code-audit — keep the codebase clean, small and consistent

You are a senior engineer who owns this codebase's long-term health. Your job is to
**keep it lean and boring**: less code, one way of doing each thing, files a new
contributor can read in one sitting. Not to rewrite it in your own style.

How it differs from the other skills:

| Skill | Looks at | Finds |
|---|---|---|
| `/scoped-review` | a diff | bugs in what just changed |
| `/end-session` | the session | stale docs and status lines |
| **`/code-audit`** | **the whole repo or a folder** | **mess: dead code, duplication, bloat, drift from conventions** |

## Invocation

| Command | Does |
|---|---|
| `/code-audit` | Full audit, report only. Changes nothing. |
| `/code-audit <path>` | Audit one folder (e.g. `src/lib/reslab`), report only. |
| `/code-audit fix` | Audit, then ship **the top batch** from the report as one PR. |
| `/code-audit fix <n>` | Ship batch `<n>` from the latest report (`notes`/PR body). |

Run from `triply/` (where `package.json` lives).

---

## Ground rules (read before touching anything)

1. **Behaviour-preserving only.** A cleanup PR changes no output, no API shape, no
   DB write, no email, no price. If a change might alter behaviour, it is not a
   cleanup. Report it as a finding for a human.
2. **Money and booking paths are report-only** unless tests pin the behaviour:
   `src/lib/booking/**`, `src/lib/reslab/**`, `src/lib/accounting/**`,
   `src/app/api/**/checkout*`, `src/components/checkout/**`, Stripe, Park Guard.
   You may delete *provably unused* code there (zero references, `npm run build`
   passes), but never restructure it. `create-booking.ts` is big for a reason.
3. **Every CLAUDE.md anti-pattern is a hard rule.** Never "simplify away" a
   validation gate, an early return, a try/catch on a money path, or a
   `disabled` prop. Never touch booking-time string handling.
4. **Small PRs, one theme each.** Max ~400 changed lines (deletions of dead files
   can go higher). "Remove unused exports in src/lib" is one PR. "Split
   admin/bookings page" is another. Never a mixed "cleanup" grab-bag.
5. **No mass reformatting, no renames for taste, no new dependencies, no new
   abstractions** unless the abstraction removes ≥3 real copies of the same code.
6. **Blog engine and CMS rules still apply.** Never run `generate`/`publish`
   against prod as part of an audit.
7. **This repo is public.** Never paste env values, keys or customer data into the
   report or PR.

---

## Step 1 — Measure (tools, no installs into package.json)

Run these and keep the raw numbers for the report. `npx` downloads a throwaway
copy, so none of them are added to `package.json`.

```bash
npm run build                      # baseline must pass before any audit
npm test                           # baseline: note failures, don't fix them here
npx --yes knip --no-progress       # unused files, exports, dependencies, types
npx --yes jscpd src scripts/blog-engine/src --min-lines 12 --reporters console --silent \
  --ignore "**/__tests__/**,**/*.snap"   # copy-paste blocks
npm run lint -- --max-warnings=0 || true   # lint debt count (don't fix yet)
```

Then the size and type checks (plain shell, works in Git Bash):

```bash
# Biggest source files (skip tests and snapshots)
git ls-files 'src/**/*.ts' 'src/**/*.tsx' 'scripts/blog-engine/src/**/*.ts' \
  | grep -vE '__tests__|\.test\.|\.snap$' | xargs wc -l | sort -rn | head -20
# Type holes: any, casts through unknown, suppressions
git grep -nE ': any\b|as any\b|as unknown as|@ts-ignore|@ts-expect-error|eslint-disable' -- src scripts/blog-engine/src
# Leftovers
git grep -nE 'console\.log\(|TODO|FIXME|XXX' -- src | grep -v __tests__
# Client components (bundle weight): files marked "use client"
git grep -l '"use client"' -- src | wc -l
```

If a tool fails to run (network, Windows path), say so in the report and carry on
with the rest. Don't install anything globally.

---

## Step 2 — Review (parallel reviewers, read-only)

Dispatch these in parallel with the Agent tool (general-purpose), one per lens.
Give each one the Step 1 output for its lens, the scope path, and the Ground
rules above. Each returns findings as
`file:line · what · why it matters · proposed change · risk (low/med/high) · lines saved`.

| Lens | What it looks for |
|---|---|
| **Dead code** | knip hits verified by `git grep` (dynamic imports, Next.js route files, `page.tsx`/`route.ts`/`layout.tsx`, scripts run by cron/Vercel, and anything in `vercel.json` are NOT dead even with no import). Unused env vars, feature flags that have been on/off for months (flag it, don't delete it). |
| **Duplication** | jscpd blocks plus near-copies it misses: the same Supabase query, date/price formatter, airport lookup or fetch wrapper written in 3+ places. Propose one home for it that already exists (`src/lib/...`) before proposing a new file. |
| **Size and shape** | Files over ~600 lines or components over ~300, functions over ~80 lines, props drilled 3+ levels, one file doing fetch + transform + render. Propose a split along a seam that already exists. For money paths: report only. |
| **Types and safety** | `any`, `as unknown as`, `@ts-ignore`, missing Zod at API boundaries, non-null `!` on data from the network. Each is a finding with the real type to use. |
| **Efficiency** | Sequential `await`s that could be `Promise.all`, N+1 Supabase calls in loops, `select('*')` on wide tables in hot paths, client components that could be server components, heavy imports in client bundles, repeated ResLab calls without caching. Real impact only: name the page or route that gets faster. |
| **Consistency** | Drift from CLAUDE.md and `/triply-frontend`: two ways of doing the same thing (error handling, data fetching, logging, naming). Pick the way most of the codebase already uses. |

Skip a lens if its Step 1 numbers are clean. On a folder audit, skip lenses that
don't apply to it.

**Verify every finding yourself** before it goes in the report: open the file and
`git grep` the symbol. Drop anything you can't confirm. A reviewer's "unused" is a
claim, not a fact. Dynamic usage, string-built imports and Next.js conventions fool
static tools.

---

## Step 3 — Report

Rank by **payoff × safety**: big deletions with zero risk first, then
duplication, then splits. Group into **batches**. Each batch is one future PR,
one theme, ≤ ~400 changed lines.

```
# Code audit — <date> — <scope>

Health: <files> files · <lines> lines · unused exports <n> · unused deps <n> ·
duplicate blocks <n> · files >600 lines <n> · any/ts-ignore <n> · lint warnings <n>
(vs last audit: <deltas, if a previous report exists>)

## Batch 1 — <theme>  (risk: low · ~<lines> lines · <files> files)
- file:line — what — proposed change
...
Verify: npm run build · npm test · <any page to click-check>

## Batch 2 — ...

## Report-only (needs a human: behaviour or money path)
- file:line — what — why it isn't an automatic cleanup

## Tools that didn't run
```

Save the report as the body of the PR in `fix` mode. In report-only mode, print it,
and offer to open batch 1. If the session has the wrapper repo, also save it to
`../notes/audits/<date>-code-audit.md` so the next audit can show deltas.

---

## Step 4 — Fix (only with `fix`)

1. `git checkout main && git pull`, then `git checkout -b chore/audit-<theme>`.
2. Apply **one batch only**. Change nothing outside it.
3. `npm run build` and `npm test` must pass. Test count must be unchanged or higher.
   If a test fails, revert that item and move it to Report-only. Never edit a test
   to make a cleanup pass.
4. Run `/scoped-review staged` on the result. A cleanup that a reviewer flags as
   changing behaviour comes out of the batch.
5. `git push -u origin chore/audit-<theme>` and
   `gh pr create --base main --title "chore(audit): <theme>"` with the batch's part of
   the report as the body, plus: lines removed / added, and how you verified it.
6. Don't merge. A cleanup PR gets the same human look as any other.

---

## What good looks like

- Net lines go **down** on almost every audit PR.
- After a few audits: knip clean, no new `any`, no file over ~800 lines outside
  `src/lib/booking`, one formatter/one fetch helper per job.
- No cleanup PR has ever needed a revert. If one does, add the lesson to the
  Ground rules above in the same PR as the fix.
