---
name: post-deploy-check
description: Verify a production deploy actually shipped correctly. Runs after merging staging → main. Checks the Vercel deploy completed, the production URL serves traffic, Sentry hasn't lit up with new errors, and any DB migrations are reflected in production. Use immediately after pushing to main, or to retroactively diagnose a suspect deploy. A merge that returns 200 from `git push` is not the same as a working production app — this closes that gap.
---

# /post-deploy-check — Post-deploy verification gate

A `git push origin main` returning success means GitHub accepted the
push. It says nothing about whether Vercel built it, whether the build
errored on a typecheck, whether the prod URL is serving the new code,
or whether Sentry started seeing crashes. This skill walks through
those checks.

**When to invoke:**
- Immediately after `git push origin main` (or after merging
  `staging → main`)
- Before declaring a release "done"
- When a customer reports something broken after a recent deploy and
  you want to triage whether the deploy itself is the cause

---

## Step 1 — Confirm the merge actually pushed

Run these in parallel:

```
git rev-parse main                    # Current main commit on local
git rev-parse origin/main             # Current main commit on remote
git log -1 --format="%h %s" main      # Subject of latest commit
```

If local and remote diverge, the push didn't take. Stop and tell the
user — re-push or investigate.

If they match, capture the commit SHA — we'll reference it through the
rest of the checks.

---

## Step 2 — Vercel deploy status

Triply auto-deploys via Vercel's GitHub integration. The deploy:

1. Is listed at `https://vercel.com/dashboard` under the `triply`
   project (not `triply-cms`)
2. Should show "Building" or "Ready" within ~30 seconds of the push
3. Status is queryable via Vercel API once we have a token

**Until Vercel API integration is wired up:**
Tell the user to open the Vercel dashboard, find the deploy matching
the SHA from Step 1, and confirm:
- ✅ Status: "Ready" (not "Error" or "Canceled")
- ✅ Build duration is reasonable (typically 60-180s for this project;
  much longer suggests something stuck)
- ✅ No build warnings related to `next build` failures or missing env vars

If "Error" — fetch the Vercel build logs (user will paste) and
diagnose. Common failure modes seen in this project:
- TypeScript error from a code path not exercised in `npx tsc --noEmit`
  locally
- Missing env var (e.g., `RESEND_API_KEY` in production environment)
- ESLint error from `react-hooks/purity` triggering on a `Date.now()`
  call (we have several pre-existing — they shouldn't fail builds, but
  flag if a NEW one is the cause)

**Future enhancement:** add Vercel API token to `.env.local`
(`VERCEL_TOKEN`), then this step can be automated via `curl` to
`https://api.vercel.com/v6/deployments?projectId=<id>&sha=<sha>`.

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
- Touched `confirmation/`? Hit `/confirmation/EXAMPLE12345?email=customer@example.com`
  and check for 200 + the expected content (search the response body
  for "EXAMPLE" or "8:00 AM" — substring match is fine).
- Touched `admin/`? Don't verify with curl — admin needs auth. Tell
  the user to open it in their browser and confirm.

For the CMS (`https://cms.triplypro.com/admin`) — only verify if the
CMS deploy was triggered by this push (CMS lives in a separate repo,
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

Open `https://sentry.io/organizations/triply/issues/` (or whatever
the org URL is — `SENTRY_ORG` in `.env.local`).

Filter:
- Project: `triply` (the main app)
- Time range: "Last 15 minutes" or since deploy timestamp
- Status: Unresolved

Look for:
- ❌ NEW error events that didn't exist on the previous deploy. New
  events tied to files that changed in this push are especially
  suspect.
- ⚠️ Spike in existing errors (event count jumps after deploy time).

If new errors appear that look related to the change, rollback first
and diagnose second. The rollback path:
1. `git revert <merge-commit-sha>` on `main`
2. `git push origin main`
3. Vercel auto-deploys the revert
4. Then debug at leisure on a feature branch

**Future enhancement:** add Sentry API integration via
`SENTRY_AUTH_TOKEN` (already exists for source maps) — this step can
auto-query for new issues since the last release.

---

## Step 6 — DB migration verification (if applicable)

If the change includes `supabase/migrations/*.sql`:

- Was the migration applied to production Supabase **before** the
  code deploy? (For Triply, migrations are applied manually via
  Supabase dashboard SQL editor — not auto-applied by CI.)
- If the migration wasn't applied first, the new code may be hitting
  schema it expects but doesn't exist (or vice versa). Rollback or
  apply the migration immediately.

Verify by querying the production DB:
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
