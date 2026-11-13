---
name: post-deploy-check
description: "Verify a production deploy actually shipped correctly. Run immediately after a PR merges to main, or to diagnose a suspect deploy. Checks the Vercel deploy completed, the production URLs serve the new code, Sentry has no new errors, and any migrations are in place. A merged PR is not the same as a working production app; this closes that gap."
---

# /post-deploy-check — Post-deploy verification gate

A merged PR means GitHub accepted the merge. It says nothing about
whether Vercel built it, whether the prod URL is serving the new code,
or whether Sentry started seeing crashes. This skill walks through
those checks.

**When to invoke:**
- Immediately after a PR merges to `main`
- Before declaring a release "done"
- When a customer reports something broken after a recent deploy and
  you want to triage whether the deploy itself is the cause

---

## Step 1 — Confirm the merge is on `main`

`main` is protected: nothing is pushed to it, a PR is merged. Run:

```
gh pr view <n> --json state,mergedAt,mergeCommit   # state MERGED + the merge commit
git fetch origin
git merge-base --is-ancestor <merge commit> origin/main && echo "on main"
```

If the PR is not `MERGED`, or `origin/main` does not contain its merge
commit, stop and tell the user. Never "re-push".

Capture the merge commit SHA — the rest of the checks reference it.

---

## Step 2 — Vercel deploy status

Triply auto-deploys via Vercel's GitHub integration, under the `triply`
project (not `triply-cms`). A deployment should appear within about 30
seconds of the merge.

With the Vercel MCP tools: list the project's deployments, find the
production one whose commit is the SHA from Step 1, and confirm:
- ✅ State: `READY` (not `ERROR` or `CANCELED`)
- ✅ Target: production, and it is the current production deployment
- ✅ Build duration is reasonable (typically 60-180s for this project;
  much longer suggests something stuck)
- ✅ No build warnings about `next build` failures or missing env vars
  (read the build log; a `READY` build can still carry them)

No Vercel tools in this session? Ask the user to check the same four
things in the Vercel dashboard. Say in the report which way it was checked.

If the state is `ERROR`, read the build logs (deployment events) and
diagnose. Common failure modes seen in this project:
- TypeScript error from a code path not exercised in `npx tsc --noEmit`
  locally
- Missing env var (e.g., `RESEND_API_KEY` in production environment)
- ESLint error from `react-hooks/purity` triggering on a `Date.now()`
  call (we have several pre-existing — they shouldn't fail builds, but
  flag if a NEW one is the cause)

---

## Step 3 — Production URL liveness check

For the `triply` project, the production URL is
`https://www.triplypro.com`.

Run:

```bash
curl -s -o /dev/null -w "%{http_code}" https://www.triplypro.com/
curl -s -o /dev/null -w "%{http_code}" https://www.triplypro.com/search?airport=JFK
curl -s -o /dev/null -w "%{http_code}" https://www.triplypro.com/help
```

All three should return 200. If any return 5xx, the deploy is up but
broken — pull Sentry errors (Step 5) and rollback if necessary.

If the change touched a specific page, also verify THAT page returns
200:
- Touched `confirmation/`? A confirmation page can only be opened with
  a real booking's own link. Never put a customer's booking number or
  email in a command or in this file: ask the user to open one of our
  own test bookings in their browser and confirm.
- Touched `admin/`? Don't verify with curl — admin needs auth. Tell
  the user to open it in their browser and confirm.

For the CMS (`https://cms.triplypro.com/admin`) — only verify if the
CMS deploy was triggered by this change (CMS lives in a separate repo,
usually NOT in the same change).

---

## Step 4 — Verify the change actually deployed (not stale CDN)

A 200 response from a URL doesn't mean it's serving the new code. To
confirm:

- If the change added/modified a visible string, `curl` the page and
  grep for the new string. Example: if the email-link fix added the
  "Open Your Confirmation Link" text, hit
  `/confirmation/FAKE123?email=foo@example.com` and grep for that
  string in the response. (FAKE123 won't exist, so this exercises the
  not-found / auth-required path which renders that text.)

- If the change was a server-side API behavior (e.g., a Zod schema
  tightened), test it with `curl` against the API endpoint with a
  payload that the OLD code would have accepted but the NEW code
  rejects. A 400 confirms the new code is live.

- If you can't construct a string-grep or behavioral test, at minimum
  fetch the response headers and check `x-vercel-deployment-url` or
  similar — the value should reference the new deploy ID.

---

## Step 5 — Sentry error scan

With the Sentry MCP tools, search issues in organization `triply-dp`,
project `triply` (the main app):
Run all three searches. Each catches something the others miss.

1. **New issues:** unresolved, **first seen in the last 24 hours**
   (`is:unresolved firstSeen:-24h`). Not a shorter window: on November 12,
   2026 two 1-hour checks reported clean and a 24-hour re-check found an
   issue they had missed. For each one, read its release and first-seen
   time: is it from this deploy, or an earlier one today?
2. **Old issues that are active since the deploy:** unresolved, last seen
   since the deploy time (`is:unresolved lastSeen:-<minutes since deploy>m`),
   sorted by event count. Compare each one's rate before and after the
   deploy: a jump is a spike.
3. **Regressions:** issues that were resolved and came back
   (`is:regressed`), last seen since the deploy.

No Sentry tools in this session? Ask the user to check the same three
filters in the Sentry dashboard, and say so in the report.

Look for:
- ❌ NEW error events that didn't exist on the previous deploy. New
  events tied to files that changed in this merge are especially
  suspect.
- ⚠️ Spike in existing errors (event count jumps after deploy time).

If new errors appear that look related to the change, rollback first
and diagnose second. The rollback path:
1. Vercel Instant Rollback: promote the previous production deployment (dashboard → Deployments). It needs neither GitHub nor CI.
2. Then open a revert PR (`git revert <merge-commit-sha>` on a branch). `main` is protected; never push to it directly.
3. Vercel auto-deploys the revert
4. Then debug at leisure on a feature branch

---

## Step 6 — DB migration verification (if applicable)

If the change includes `supabase/migrations/*.sql`:

- Was the migration applied **before** the code deploy? Migrations are
  not applied by CI. Development, previews and production share one
  database, so a migration is applied **once**: by Claude's migration
  script, only after **Tom's** explicit OK naming that migration number
  ("apply 044"), or by Tom himself. Nobody else's OK counts, whoever's
  session this is.
- If the migration wasn't applied first, the new code may be hitting
  schema it expects but doesn't exist (or vice versa). Roll back, or
  get Tom's OK and apply it. Never apply one unasked.

Verify against the production DB. Production reads are Tom's: write a
read-only script, Tom runs it. The check is:
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = '<changed-table>' AND column_name = '<changed-column>';
```

For migration `007` (TIMESTAMPTZ → TIMESTAMP on bookings.check_in/out):
expected to show `timestamp without time zone`. If it shows
`timestamp with time zone`, the migration didn't run.

---

## Step 7 — Customer-facing soak

For 5–10 minutes after deploy:
- Keep Sentry tab open and watch for new events
- If you have access to Vercel Analytics or any traffic dashboard,
  watch for an error-rate spike
- Check the most recent few bookings in admin to confirm they look
  normal (correct times, correct totals, no error states)

If anything looks off, bias toward rolling back. Triply customers
make a booking once and rarely come back — a 10-minute window of
broken checkout costs revenue you don't recover.

---

## Step 8 — Report

Summarize each step with ✅ / ❌ / ⚠️ and a one-line note. End with:
- ✅ "Deploy verified — production is healthy on commit `<sha>`"
- ❌ "Deploy has issues — rollback initiated / pending decision"
- ⚠️ "Deploy live but inconclusive — N checks couldn't run, manual
  verification recommended"

If anything was rolled back, log the incident in `REVIEW-FINDINGS.md`
under a new entry (so the next review pass can incorporate the lesson).

---

## Don't

- Don't declare a deploy verified until production URL liveness is
  confirmed. Vercel "Ready" is necessary but not sufficient.
- Don't skip the Sentry check just because the URL returned 200 —
  some bugs only surface for specific user paths.
- Don't run `git revert` without telling the user first. Rollbacks
  visible to customers need their explicit go-ahead.
- Don't run this skill against staging deploys — it's prod-only.
  Staging is for `/verify-flow` and `/scoped-review`.
- Don't substitute this for monitoring. Sentry should be checked
  daily; this is a deploy gate, not ongoing observability.
