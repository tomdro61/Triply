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
| MVP scope | New York (JFK + LGA), Reservations Lab inventory |
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

> **Not set up yet:** CI (tests/typecheck on every PR) + `main` branch
> protection. Until those exist, the local `build` + `test` + review in steps
> 2–4 **are** the gate — don't skip them.

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

- `npm run build` + `npm test` (app) — must pass.
- Self-review the diff against the anti-patterns below.
- Customer-facing or money/booking code → get a second set of eyes. (Tom runs a
  multi-agent `/scoped-review` skill; ask if you want it wired into this repo.)

## Anti-patterns (hard rules — from bugs actually shipped here)

- **No silent fallback defaults for user-supplied data.** Never `searchParams.get("x") || "default"` for booking data — validate at the boundary and reject when missing.
- **No swallowed errors on money/auth paths.** Don't `catch { /* continue */ }` an API response — distinguish 401/403/404/5xx and surface the right message.
- **No `any`; no casts through `unknown`.** TypeScript strict. Zod schemas at API boundaries.
- **Don't remove a safety check** (a `disabled` prop, an early `if (!x) return`, a validation gate, a try/catch around a money path) without understanding what it protected.
- **Booking times are literal airport-local strings** — never apply `toISOString()` / `new Date()` math / timezone conversion to them. (Checkout/payment code — mostly Tom's area, but know the rule.)

---

## 🔐 Security (this repo is PUBLIC)

- **Never commit secrets.** `.env` files are — and must stay — gitignored. The blog engine's `scripts/blog-engine/.env` holds **real API keys** (Anthropic, Payload). `.env.example` is the only env file that's committed.
- If you add a new config file that holds a key, add it to `.gitignore` **before** the first commit, and double-check `git status` doesn't show it.

---

## Common commands

```bash
# Main app (triply/)
npm run dev              # dev server on :3000
npm run build            # production build (Vercel typechecks the whole project)
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
environment, not here. Last updated: July 23, 2026.*
