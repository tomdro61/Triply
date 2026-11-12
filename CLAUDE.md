# Triply — CLAUDE.md (shared team contract)

> **This file is committed to the `triply` repo and is read automatically by
> everyone's Claude Code when they work in this repo.** It's the shared source of
> truth for *how we work on this codebase together* — the dev process,
> collaboration rules, and project essentials.
>
> Keep it focused on that. Personal notes, session history, and ops logs stay in
> your own environment, **not** in this file.

---

## Who this applies to

If you cloned this repo and you're running Claude Code in it, these rules apply
to you and your Claude session. Today that's **Tom** (app, checkout, payments)
and **Vin** (blog engine + CMS content).

---

## Project overview

| Field | Value |
|---|---|
| Project | Triply — airport parking aggregator |
| Domain | triplypro.com · staging: staging.triplypro.com |
| What it does | Aggregates third-party parking lots; earns commission on bookings |
| Scope | 85 airports; Reservations Lab inventory plus direct lots |
| Stack | Next.js 16 (App Router), TypeScript **strict**, Supabase, Stripe, Payload CMS |

## The two repos

| Repo | GitHub | Contains | Deploys to |
|---|---|---|---|
| **triply/** (this repo) | `tomdro61/Triply` | Next.js app **+ the blog engine** (`scripts/blog-engine/`) | triplypro.com |
| **triply-cms/** | `tomdro61/triply-cms` | Payload CMS — the blog content store | cms.triplypro.com |

Both repos are **public** (required for Vercel auto-deploy) — see Security below.

---

## 🚨 Git & dev workflow (the core shared contract)

**`main` is the single source of truth. `staging` is a disposable, re-pointable
deploy target — NOT a branch where work lives.** All work happens on short-lived
feature branches cut from `main`.

### Start-of-task ritual — do this before writing any code

```bash
git checkout main && git pull
git checkout -b feat/<short-name>
```

All commits for the task go on that branch. **Never commit work directly to
`main` or `staging`.** (Skip the branch only for pure Q&A or read-only
investigation.)

### The flow

1. **Cut a `feat/*` branch** off the latest `main` (ritual above).
2. **Develop + commit** on the branch. Before pushing, verify locally:
   - App code → `npm run build` + `npm test` in `triply/`
   - Blog-engine code → run the relevant engine command and/or `npx tsc --noEmit` in `scripts/blog-engine/`
3. **Push the branch** — `git push -u origin feat/<name>`. Vercel auto-deploys a **preview URL** you can click-test.
4. **Review the diff** (see Code review below).
5. **Open a PR into `main`** — `gh pr create --base main`. Self-merge is fine; the PR exists for the diff view + record, not approval ceremony.
6. **(Optional) Soak on the real staging domain** — to test on staging.triplypro.com (not just the preview URL): `git push origin feat/<name>:staging --force-with-lease`. staging is disposable, so force-pushing it is expected.
7. **Merge the PR** → Vercel deploys to production.
8. **Delete the branch** (`git branch -d feat/<name>` + `git push origin --delete feat/<name>`).

### CI is the merge gate (since November 2026)

Every PR runs `.github/workflows/ci.yml`. `main` is protected: a PR can merge only when
both required checks are green and the branch includes the latest `main`. This applies to
everyone, admins included.

| Check | What it runs |
|---|---|
| `app (typecheck, test, build)` | `npm run typecheck`, `npm test`, `npm run build` |
| `blog-engine (typecheck, test)` | in `scripts/blog-engine/`: `tsc --noEmit`, `tsx --test src/*.test.ts` |
| `lint (advisory)` | `npm run lint`. Not required yet (existing errors need a cleanup PR). |

- **Run the same checks locally before pushing**; CI is the backstop, not the first try.
- **A red check:** open it on the PR, read the failing step, fix on the branch, push again.
- **"Branch is out of date":** `git merge origin/main` into your branch and push. The checks re-run.
- **A check stuck on "Expected":** push an empty commit (`git commit --allow-empty -m "ci: re-run"`).
- **Red `main` = stop the line.** Fix or roll back before merging anything else.
- **Production rollback is Vercel Instant Rollback** (promote the previous deployment), then a revert PR. Never a direct push to `main`.
- **The job names are load-bearing:** branch protection names them. To rename or remove one, change protection first.
- **CI needs no secrets.** The build uses dummy keys and `.invalid` hosts. Never add a real key to the workflow.

---

## 🤝 Working together (two devs, no collisions)

1. **Always `git pull` `main` before cutting a branch.** Both of us.
2. **One feature branch per task. Never two people on the same branch.** Never commit to `main`/`staging` directly.
3. **Small, frequent PRs** beat big long-lived branches — far fewer merge conflicts.
4. **Divide ownership to avoid collisions** *(proposed default — adjust as needed)*:
   - **Vin:** `scripts/blog-engine/` + blog content + `triply-cms/` collections
   - **Tom:** app, checkout, payments, ResLab / Stripe / Resend integration
   - Need to touch the other person's area? Say so first (Discord) so you don't both edit the same files.
5. **`staging` is a shared, disposable soak target — one person at a time.** For everyday testing use your own per-branch preview URL. Only use the `staging` *domain* for coordinated pre-merge soaks — force-pushing it clobbers whatever was there.

---

## 📝 Blog engine: code vs content (read before running it)

The blog engine (`scripts/blog-engine/`) is a **local CLI**, not a deployed
service — **Vercel never runs it.** It generates SEO blog content and writes it
into the CMS over the Payload API. That splits "changes" into two kinds that
live in two different places and are governed differently:

| Change | Lives in | Governed by |
|---|---|---|
| **Engine code** (`.ts`, prompts, scoring logic) | Git (this repo) | The git flow above |
| **Content it produces** (posts, images, queue) | The CMS **database** (Payload → Postgres) | The CMS's own draft→published status — **NOT git** |

### Running the engine safely

- **Where content lands is decided by one line in `scripts/blog-engine/.env`:** `PAYLOAD_CMS_URL`.
  - `http://localhost:3001` → your own local CMS (isolated).
  - `https://cms.triplypro.com` → **writes straight to production content.**
- **The CMS database is a single shared production store** — staging and prod use the same Supabase project. There is no separate "staging blog." Treat any write to the prod CMS as a live change.
- **The content review gate is the post status, not a git branch.** The engine `generate`s posts as `draft`/`review`; they don't go live until someone runs `publish` or clicks Publish in the Payload admin.
  - ✅ **generate as draft → review in the Payload admin → publish.**
  - ❌ Never auto-generate straight to `published` against prod — that's the content equivalent of pushing to `main` with no review.
- **Coordinate who runs generation against prod** so you don't both mutate the same live content at once.

---

## Code review

Before opening a PR:

- `npm run typecheck` + `npm test` + `npm run build` (app) — must pass. CI runs the same three.
- **Check the diff against [`docs/review-lessons.md`](docs/review-lessons.md)** and list the lessons
  you checked in the PR body. Every lesson there is a mistake our reviews keep finding; most PRs
  needed 2–8 review rounds for them.
- Self-review the diff against the anti-patterns below.
- Customer-facing or money/booking code → get a second set of eyes: run
  `/scoped-review` (committed to this repo — see **Skills** below).
- When a review of your PR finds something, add one line to the **Log** in
  `docs/review-lessons.md` (the reviewer adds it when they fix it on your branch).

### When each check is required

| When | Run | Applies to |
|---|---|---|
| **Before writing code** | `/sketch-flow` | A new async handler in `src/components/checkout/**`, `src/lib/checkout/**`, `src/app/api/{checkout,reservations,webhooks}/**`, or any UI handler that calls Stripe / ResLab / Park Guard / Resend / Supabase. A new `useState` in **any** file with a multi-step state machine. Any async work tied to PaymentIntent state, **anywhere**. Removing ANY safety check (`disabled`, an early `return`, a lock, a validation gate, a try/catch on a money path). |
| **Before a PR** | `/scoped-review` | Any change under `src/app/api/`, `src/lib/{reslab,stripe,resend,validation}/`, `src/lib/utils/time.ts`, `src/components/{checkout,confirmation,lot,search}/`, the checkout / confirmation / admin pages, `supabase/migrations/`, or the hooks (`.githooks/`, `.claude/hooks/`, `.claude/settings*.json`). Any change over ~50 lines or 3 files. Any new or changed Zod schema, server action or API route. Not for typos, docs or changes under ~10 lines. |
| **Before calling it done** | `/verify-flow <flow>` | Any change to a customer-facing flow: checkout, payment, confirmation, the emailed links, lot and search pages, a UI state machine, or what the customer sees of money math. Always after fixing a customer-reported bug: walk the exact customer flow. |
| **After merging to `main`** | `/post-deploy-check` | Every merge. |

- **`/scoped-review` decides the size; this file doesn't repeat its rules.** The skill counts
  the diff first and runs its full sweep when the change is over 200 lines or touches money,
  checkout, reservations, webhooks, auth or a migration. If you think a lighter review is
  enough, say so before running it.
- **After review:**
  - Fix every Critical before merge; triage High/Medium (with Tom).
  - Re-run the silent-failure reviewer on the fixes (fixes introduce bugs).
  - Add a Log line in `docs/review-lessons.md`.
  - If you have the wrapper repo, add a `REVIEW-FINDINGS.md` entry for a Critical or High.
- **Plans get reviewed too:** plan → review (two Opus agents) → build. Never plan → build.
- A type-clean, test-green change can still be wrong in the browser. CI does not replace the walk.

### Codex (OpenAI) is part of review

`/scoped-review` also runs an adversarial review from OpenAI's Codex (a second model) on full
sweeps and on any diff touching money, checkout, reservations, webhooks, auth, migrations, or
what an AI is told to say (Step 4.5 of the skill). Verify every Codex finding against the code.
A run that never read the code is a FAILED review, not a clean one. No plugin → the review says
"Codex SKIPPED". **Machine setup: [`docs/codex-setup.md`](docs/codex-setup.md).**

## Hooks (checks that run by themselves)

Two hooks are committed to this repo. Both have unit tests that CI runs.

| Hook | When it runs | What it does |
|---|---|---|
| **Pre-commit gate** (`.githooks/`) | Every `git commit` made by Claude Code. A commit you type yourself skips it. | Refuses a commit on `main` or `staging`. Runs what the staged files can break: typegen + typecheck + tests for app files, the engine's typecheck + tests for `scripts/blog-engine/`. A docs-only commit runs nothing. Then prints which review the staged paths call for. |
| **Guard** (`.claude/hooks/guard.mjs`, registered in `.claude/settings.json`) | Before Claude runs a shell command or a Vercel deploy tool | Asks a person to approve, including in auto mode: skipping the gate (`git commit --no-verify`, a change to `core.hooksPath`, setting or clearing `CLAUDECODE` next to a git command); merging (`gh pr merge`, the API merge routes); changing what production serves (`vercel --prod` / `--target production` / `promote` / `rollback` / `alias` / `redeploy`, and the matching Vercel tools). |

- **Install:** `npm install` sets `core.hooksPath` to `.githooks` and prints what it did. It won't replace a hooks path you already set. Check with `git config core.hooksPath`.
- **A branch cut before the hooks has none** until `main` is merged in: git finds no `.githooks/` folder there and runs nothing, without a warning.
- **A full app commit takes about a minute.** `.claude/settings.json` raises the Bash tool's default timeout to 5 minutes so the commit isn't killed half-way; a session started in a parent folder should pass a timeout of 300000 on commits.
- **The gate tests the working tree, not the exact staged content.** Unrelated half-done work can fail a good commit. If the failure isn't caused by your commit, `git commit --no-verify` asks a person to approve skipping it. CI still tests the exact commit.
- **`git merge`, `cherry-pick` and `revert` don't run the gate** (git doesn't call pre-commit for them). CI checks those commits.
- **A checkout with no `node_modules` skips the checks** and says so. The branch rule still applies.
- **The guard is a guardrail, not a lock.** A git alias or an edited hook file gets past it. Required CI checks and branch protection are the real gate.
- **A session started in a parent folder** doesn't load this repo's `.claude/settings.json`; register the guard in that folder's settings too. The pre-commit gate needs nothing extra.
- **Hook code runs from whatever branch is checked out.** Before checking out someone else's branch, read its diff for `.githooks/`, `.claude/hooks/` and `.claude/settings*.json` (`gh pr diff <n>`). Never check out a fork's branch that changes them.
- The hooks can't check that a review was run. The rules in **Code review** still apply.

## Skills (in `.claude/skills/`)

Custom skills committed to this repo — invoke by name (`/<name>`). **Caveat:** some dispatch sub-agents or MCP tools that come from **plugins** (`pr-review-toolkit:*`, `feature-dev:*`, Playwright, the Codex plugin) — you need those installed for the skill to fully run. The skill *instructions* travel via git; the plugin/MCP dependencies don't.

| Skill | Use it for |
|---|---|
| `/scoped-review` | Multi-agent code review scoped to what changed, plus a Codex (OpenAI) second opinion on risky diffs. Before declaring a feature done / before a PR. |
| `/sketch-flow` | Required state-machine sketch **before** writing any new async handler touching Stripe / ResLab / Supabase / Park Guard from a UI handler. |
| `/verify-flow <flow>` | End-to-end verification of a customer flow (checkout, confirmation) via local dev + Playwright — after a customer-facing change. |
| `/post-deploy-check` | Verify a prod deploy actually landed (Vercel Ready, URL 200, Sentry quiet, migrations applied) — after merging to `main`. |
| `/code-audit` | Senior-dev health audit of the whole repo or a folder: dead code, unused exports/deps, duplication, oversized files, type holes, slow patterns. Report only by default; `fix` ships the top batch as one small behaviour-preserving PR. Monthly, or when a folder feels messy. |
| `/end-session` | Session-wrap ritual: update docs/notes + post a team digest to Discord. |
| `/harden-plan` | **Heavy, opt-in.** Adversarial multi-agent review of a *plan / RFC / migration doc* before writing code — spawns 60+ agents, spends millions of tokens. For real designs, not small changes; catches money/concurrency/timezone bugs pre-code. |
| `/triply-frontend` | Triply frontend conventions + guidance. |

## Anti-patterns (hard rules — from bugs actually shipped here)

- **No silent fallback defaults for user-supplied data.** Never `searchParams.get("x") || "default"` for booking data — validate at the boundary and reject when missing.
- **No swallowed errors on money/auth paths.** Don't `catch { /* continue */ }` an API response — distinguish 401/403/404/5xx and surface the right message.
- **No `any`; no casts through `unknown`.** TypeScript strict. Zod schemas at API boundaries.
- **Don't remove a safety check** (a `disabled` prop, an early `if (!x) return`, a validation gate, a try/catch around a money path) without understanding what it protected.
- **Booking times are literal airport-local strings** — never apply `toISOString()` / `new Date()` math / timezone conversion to them. (Checkout/payment code — mostly Tom's area, but know the rule.)
- **Wall-clock times are stored in `TIMESTAMP`, never `TIMESTAMPTZ`.** A date-only `"YYYY-MM-DD"` parses as UTC midnight: use `parseDateSafe()`.
- **The one allowed default:** a pricing-only fallback (search "from $X" at the default 10 AM–2 PM window) is on purpose; don't "fix" it. It must carry an inline comment saying why it never reaches a booking. Time props on booking emails and components are required parameters: no `?`, no default value.
- **Forward auth params end to end.** If a link carries something the API needs, the page's fetch must send it. Trace link → page → fetch → API → render.
- **Gate the UI on the fetch status before other state**, or stale cached data renders a happy page on a failed request. Unexpected errors go to Sentry (`captureBookingError`, `captureAPIError`, `capturePaymentError`).
- **Commits:** conventional prefixes (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`), one concern per commit, and the message must match what the commit contains.

---

## 🔐 Security (this repo is PUBLIC)

- **Never commit secrets.** `.env` files are — and must stay — gitignored. The blog engine's `scripts/blog-engine/.env` holds **real API keys** (Anthropic, Payload). `.env.example` is the only env file that's committed.
- If you add a new config file that holds a key, add it to `.gitignore` **before** the first commit, and double-check `git status` doesn't show it.
- **A security fix in a public repo:** apply the database half before the branch is pushed, and ship privacy guards before the secret they protect.

---

## Common commands

```bash
# Main app (triply/)
npm run dev              # dev server on :3000
npm run build            # production build (it does NOT type-check test files)
npm run typecheck        # tsc over everything, test files included
npm test                 # Vitest unit tests

# CMS (triply-cms/)
npm run dev -- -p 3001   # CMS admin on :3001

# Blog engine (triply/scripts/blog-engine/)
npm run generate         # generate content (creates posts as draft/review)
npm run score            # SEO scoring pass
npm run publish          # promote draft/review posts to published
```

---

*Shared team CLAUDE.md — committed to the `triply` repo so every contributor's
Claude Code reads the same rules. Personal/ops notes stay in each dev's own
environment, not here. Last updated: November 11, 2026 — "When each check is required" table (moved from the wrapper file); `/scoped-review` owns review sizing; Codex machine setup moved to `docs/codex-setup.md`; CI is the merge gate (`.github/workflows/ci.yml`, `npm run typecheck`); rollback = Vercel Instant Rollback. November 6, 2026 — `docs/review-lessons.md`: check every PR against it (Code review). October 12, 2026 — Codex reviews moved to `gpt-6.1-sol` (Astra drained the Plus allowance).*
