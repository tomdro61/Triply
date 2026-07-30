---
name: scoped-review
description: Scoped multi-agent code review for the Triply codebase. Looks at the diff, picks the right reviewers based on what changed, dispatches them in parallel, returns consolidated findings. Use before declaring features done, before commits, and before merging staging → main. Anti-patterns and routing are tuned to Triply's actual shipped bugs (silent default times, timezone storage, query-param forwarding, payment integration).
---

# /scoped-review — Scoped multi-agent code review (Triply)

You are the dispatcher for a scoped code review. Your job:
1. Figure out what changed
2. Match changes against the routing matrix below
3. Dispatch only the relevant agents in parallel
4. Consolidate their findings into a triaged report

**Don't run all reviewers by default.** Match the scope to the change. A 30-line API change runs 2 agents. A whole feature runs 3-4. Pre-merge runs all of them. A typo runs zero.

The routing rules and anti-patterns below are anchored in **bugs Triply has actually shipped** — silent default booking times, `TIMESTAMPTZ` shifting admin display, the `?email=` query param not being forwarded to the API, the missing `customerEmail` prop on the email template. Don't treat them as generic advice.

Most commands run inside the `triply/` submodule (where `src/` and `package.json` live). All file patterns below are relative to that.

---

## Step 1 — Determine the diff scope

Parse the user's argument (passed as `$ARGUMENTS`):

| User invocation | Diff to review | Use case |
|---|---|---|
| `/scoped-review` (no arg) | `git diff` (uncommitted working tree) | Most common — "check the work I just did" |
| `/scoped-review staged` | `git diff --staged` | Pre-commit check |
| `/scoped-review feature` | `git diff main...HEAD` + uncommitted | "Review everything I've done on this branch" |
| `/scoped-review merge` | `git diff main...HEAD` + uncommitted, **full sweep** | Pre-merge to main — production deploy gate |
| `/scoped-review <ref>` | `git diff <ref>...HEAD` + uncommitted | Custom diff range |

Run `git diff --name-only <scope>` first to get the file list. If empty, tell the user there's nothing to review and stop.

---

## Step 1.5 — Expand scope beyond the diff (the "ripple" check)

**This step closes the single biggest gap in earlier versions of this skill.** A diff-only scope misses files that don't change but read/write data whose semantics DID change. Past production bugs were caught in pass 3+ of multi-pass reviews because consumers of changed data weren't in scope on pass 1.

Before categorizing, expand the file list when ANY of these conditions hit:

### A. Schema migrations in the diff

If the diff includes `supabase/migrations/*.sql` that adds, drops, or changes a column on an existing table:

1. Extract the column names from the migration (e.g., `protection_plan`, `protection_plan_price`, `pg_identifier`).
2. For each column name, run:
   ```
   grep -rn "<column_name>" --include="*.ts" --include="*.tsx" src/
   ```
3. **Add every matched file to the review scope, even if it's not in `git diff`.** The matching files are consumers of the changed column; they may need updates to keep pace with the new semantics. The reviewer should flag inconsistencies.

### B. Column-write semantic changes

If the diff modifies a `.insert()` or `.update()` call on a Supabase table — especially adding/removing math from a stored value (e.g., `grand_total + premium`) — grep for all `select.*<column>` and `.<column>` consumers across `src/` and add them to scope. This is exactly the gap that produced the pass-3 finding "admin total math is correct only by accident."

### C. Money-handling feature surface

If the diff touches any of:
- `src/lib/parkguard/`, `src/lib/stripe/`, `src/lib/resend/`
- `src/app/api/{checkout,reservations}/**`
- A new fee/charge/premium added to checkout
- `src/components/checkout/checkout-form.tsx` (price math)

…**always include these standard money-handling surfaces in scope, even if not in `git diff`**:

| Path | Why it matters |
|---|---|
| `src/app/api/admin/bookings/cancel/route.ts` | Cancellation/refund flow — must mirror new line items |
| `src/app/api/admin/stats/route.ts` | Admin revenue queries — must include new amounts |
| `src/app/api/webhooks/stripe/route.ts` | `charge.refunded` / `dispute.created` must handle new state |
| `src/app/(main)/admin/page.tsx` (overview) AND `src/app/(main)/admin/bookings/page.tsx` (list+modal) | Both admin surfaces show totals |
| `src/components/reservations/reservation-card.tsx` + `src/app/(main)/reservations/page.tsx` | Customer-facing list — must match email math |
| `src/lib/resend/templates/*.tsx` (booking + cancellation + admin notification) | All three emails reference money totals |
| `src/lib/analytics/gtag.ts` | `trackPurchase` revenue / commission |
| `src/app/(main)/partner/page.tsx` and `src/app/api/partner/**` | Verify partner totals correctly EXCLUDE pass-throughs (PG premium, service fee) |

The reviewer should check that each surface either correctly handles the new amount or correctly excludes it (with rationale). A consumer that silently doesn't know about a new line item is exactly the failure mode passes 3-4 caught.

### D. Cross-route flags

If a new flag flows through multiple routes (e.g., `hasProtectionPlan` set in `/api/checkout/lot` POST → consumed in `/api/reservations` POST → returned by `/api/reservations/[id]` GET), explicitly note this in the prompt for the reviewer, and ask them to verify end-to-end consistency: client-tampering protection (server-side cross-check against Stripe metadata), no path where the flag could be true on one endpoint and false on another.

---

## Step 2 — Categorize the change

For each changed file, classify it. A file can match multiple categories. Maintain a set of categories triggered:

| File pattern | Category |
|---|---|
| `src/app/api/**/route.ts` | `api-routes` |
| `src/lib/reslab/**/*.ts` | `reslab-integration` |
| `src/lib/stripe/**/*.ts` | `payment-integration` |
| `src/lib/resend/**/*.{ts,tsx}` | `email-integration` |
| `src/lib/validation/**/*.ts` | `validation-schemas` |
| `src/lib/utils/time.ts` | `time-handling` |
| `src/lib/utils/**/*.ts` (excluding time.ts), `src/lib/utils.ts` | `pure-utils` |
| `src/lib/sentry.ts`, `src/middleware.ts` | `infra` |
| `src/components/checkout/**/*.tsx` | `checkout-flow` |
| `src/components/confirmation/**/*.tsx` | `confirmation-ui` |
| `src/components/lot/**/*.tsx`, `src/components/search/**/*.tsx` | `booking-ui` |
| `src/app/(main)/checkout/**/*.tsx` | `checkout-page` |
| `src/app/(main)/confirmation/**/*.tsx` | `confirmation-page` |
| `src/app/(main)/admin/**/*.tsx`, `src/app/(main)/partner/**/*.tsx` | `admin-pages` |
| `supabase/migrations/**/*.sql` | `db-migration` |
| Anything not covered + line count > 50 | `general` |

Also scan the diff for these *content* triggers (use `git diff <scope>` and grep):

| Diff content pattern | Category |
|---|---|
| Adds `searchParams.get(...)  \|\| "..."` (silent fallback for user data) | `silent-failure-risk` |
| Adds `= "10:00 AM"` / `= "2:00 PM"` / similar default props for booking data | `silent-failure-risk` |
| Adds/modifies `try { ... } catch`, `.catch(`, or `{ data }` from supabase without `error` | `silent-failure-risk` |
| Adds `toISOString()`, `+ "Z"`, `AT TIME ZONE`, or new Date math on booking times | `time-handling` |
| Adds new `interface`, `type`, generic `<T>`, or Zod schema | `new-types` |
| Adds JSDoc comments (`/** ... */`) or multi-line `// ... ` blocks | `comments` |
| Adds new logic worth testing (utils, validators, calculation helpers, state machines) | `needs-tests` |
| Refactor patterns (similar code blocks, near-duplicates, copy-paste indicators) | `simplification-candidate` |
| Modifies `package.json`, `next.config`, `tsconfig`, `globals.css` | `config-or-build` |

Total line count > 200, OR `/scoped-review merge`: trigger `full-sweep`.

---

## Step 3 — Choose agents

For each triggered category, dispatch the matching agents. **Deduplicate** — if two categories both want `silent-failure-hunter`, run it once with a combined focus prompt.

| Category | Agents to dispatch | Focus prompt |
|---|---|---|
| `api-routes` | `feature-dev:code-reviewer`, `pr-review-toolkit:silent-failure-hunter` | Zod validation at boundary (no `.optional()` for required user data); admin email auth on `/api/admin/*`; Stripe webhook signature verification; replay protection on reservation creation; CORS + rate limiting on public endpoints |
| `reslab-integration` | `feature-dev:code-reviewer`, `pr-review-toolkit:silent-failure-hunter` | Token refresh (60-min JWT); raw `YYYY-MM-DD HH:mm:ss` time format with NO UTC conversion (ResLab interprets as airport-local); error propagation through ReslabError; idempotency around create-reservation |
| `payment-integration` | `feature-dev:code-reviewer`, `pr-review-toolkit:silent-failure-hunter` | Stripe webhook signature verification; `paymentIntent.status === "succeeded"` check before ResLab create; replay protection (lookup booking by `stripe_payment_intent_id`); amount verification server-side, never trust client total |
| `email-integration` | `pr-review-toolkit:silent-failure-hunter`, `feature-dev:code-reviewer` | NO default values for booking-data props (`= "10:00 AM"` is the exact bug pattern that bit us); times must be REQUIRED parameters end-to-end; CTA URLs must include auth params guests need (`?email=` for the confirmation page); template renders gracefully with empty inputs |
| `validation-schemas` | `feature-dev:code-reviewer`, `pr-review-toolkit:type-design-analyzer` | `.optional()` discipline — don't allow user-input data to silently default; regex correctness for `YYYY-MM-DD HH:mm:ss`; required-field coverage on `reservationSchema`, `checkoutSchema`, etc. |
| `time-handling` | `pr-review-toolkit:silent-failure-hunter`, `feature-dev:code-reviewer` | No UTC conversion (`toISOString`, `+ "Z"`, `AT TIME ZONE`) on booking times; `convertTo24Hour`/`convertTo12Hour` symmetry on edge cases (empty, single-digit, missing seconds); when DB writes/reads are involved, verify column type is `TIMESTAMP` (not `TIMESTAMPTZ`); DST + leap-year handling |
| `checkout-flow` | `feature-dev:code-reviewer`, `pr-review-toolkit:silent-failure-hunter` | Required-time enforcement before Reserve enables; payment-then-reservation order (Stripe `succeeded` check before ResLab create); double-submit prevention; error surfacing to the user, not just console |
| `confirmation-page` | `pr-review-toolkit:silent-failure-hunter`, `feature-dev:code-reviewer` | Forward URL params to API call (especially `?email=` for guest auth — this was a critical miss); distinguish 401/403/404 with different user-facing messages; gate render on fetch status BEFORE checking `lot` presence (otherwise stale sessionStorage produces a placeholder happy-path UI); Sentry capture on unexpected errors |
| `confirmation-ui` | `feature-dev:code-reviewer` | Required time props (no `?`, no defaults — the email/page/calendar all received customer-picked times that the props silently overrode); graceful empty-string handling; ICS RFC 5545 compliance for all-day events (exclusive `DTEND`) |
| `booking-ui` | `feature-dev:code-reviewer` | Time picker validation; disabled-state correctness on Reserve button; URL param round-trip on lot navigation; visual differentiation of empty (orange) vs filled selectors |
| `checkout-page` | `feature-dev:code-reviewer`, `pr-review-toolkit:silent-failure-hunter` | URL param parsing without silent fallbacks; required props passed through to `<CheckoutForm>`; error UI for missing-times case; safe `router.back()` with `/search` fallback |
| `admin-pages` | `feature-dev:code-reviewer` | Admin email allowlist check; correct rendering of DB times (after migration 007 `bookings.check_in/out` returns ISO without offset); CSV export correctness |
| `db-migration` | `feature-dev:code-reviewer` | `USING` clause correctness for column type changes; backfill semantics (does the conversion preserve customer-original data?); lock duration / table size; rollback impact; document the rationale inline |
| `pure-utils` | `pr-review-toolkit:type-design-analyzer`, `pr-review-toolkit:pr-test-analyzer`, `pr-review-toolkit:code-simplifier` | Null/empty/undefined handling; edge cases (zero, negative, NaN); date/timezone correctness; suggest tests; flag duplication |
| `infra` | `feature-dev:code-reviewer` | Sentry tag correctness; middleware matcher coverage |
| `config-or-build` | `feature-dev:code-reviewer` | Build implications, env-var dependencies, breaking changes for Vercel deploy |
| `silent-failure-risk` | `pr-review-toolkit:silent-failure-hunter` | (Default prompt + Triply context: customer-facing booking data must never silently default; URL params for auth must be forwarded end-to-end) |
| `new-types` | `pr-review-toolkit:type-design-analyzer` | (Default prompt) |
| `comments` | `pr-review-toolkit:comment-analyzer` | (Default prompt) |
| `needs-tests` | `pr-review-toolkit:pr-test-analyzer` | (Default prompt — focus on edge cases the new logic introduces) |
| `simplification-candidate` | `pr-review-toolkit:code-simplifier` | (Default prompt) |
| `general` | `feature-dev:code-reviewer` | General correctness, project conventions per CLAUDE.md |

**Special: `full-sweep`** — pre-merge gate. Dispatch ALL of the following in parallel, each with a self-contained prompt referencing this skill's anti-patterns:

**Whole-diff reviewers (6 distinct types — one instance each):**

- `pr-review-toolkit:silent-failure-hunter` — silent fallbacks, swallowed errors. **Highest-signal reviewer for this codebase based on shipped-bug history. Always include.**
- `pr-review-toolkit:code-reviewer` — project conventions, naming, dead code, style
- `feature-dev:code-reviewer` — bugs, logic errors, regressions (whole-diff scan)
- `pr-review-toolkit:type-design-analyzer` — type system correctness, generic constraints
- `pr-review-toolkit:comment-analyzer` — comment correctness, JSDoc rot, technical-debt markers
- `pr-review-toolkit:pr-test-analyzer` — test coverage gaps for the new logic
- `pr-review-toolkit:code-simplifier` — duplication, redundancy, refactor opportunities

**Area-scoped reviewers (one `feature-dev:code-reviewer` instance per affected category):**

Instead of one general review trying to cover everything, fan out: dispatch a separate `feature-dev:code-reviewer` for each major category triggered by the diff, each with a tight focus prompt from the matrix above (e.g., one for `api-routes`, one for `email-integration`, one for `checkout-flow`, etc.). Each instance reads only the files in its scope.

Total agent count for a typical merge sweep: 7 whole-diff + 3-6 area-scoped = **10-13 parallel dispatches**.

For non-merge invocations (the default), only dispatch the area-scoped agents matching the categories the diff actually touches, plus silent-failure-hunter if any of the silent-failure triggers fired. That keeps the typical review at 2-4 agents.

---

## Step 4 — Dispatch in parallel

Send all matched agent invocations in **a single message with multiple Agent tool calls** so they run concurrently.

Each agent prompt must include:
- The diff scope (e.g., `git diff main...HEAD -- <files-in-this-category>`)
- Project context (Next.js 16 App Router, Supabase, ResLab booking API, Stripe payments, TypeScript strict — see `triply/CLAUDE.md`)
- The focus prompt from the matrix above
- Triply-specific anti-patterns from the section below
- Instruction to report **high-confidence findings only** with severity (Critical/High/Medium), file:line, and suggested fix
- Pre-existing issues outside the diff scope should NOT be flagged (the standard list: `Date.now` purity warnings, unused legacy props, unescaped apostrophes, the `let [hours, minutes]` destructuring in `convertTo24Hour`)

---

## Step 5 — Consolidate

As each agent reports back, keep a running consolidated list. When all are in:

1. Group findings by severity (Critical / High / Medium)
2. Deduplicate (same file:line from multiple agents → one entry, note all sources)
3. Recommended fix order (top 5-10)
4. End with a one-line verdict: "Ready to merge" / "Fix N criticals before merge" / "Significant rework needed"

---

## Step 6 — Multi-pass discipline (HARD REQUIREMENT)

**Every fix gets a second pass.** This isn't optional. In real reviews on this codebase, fixes have introduced their own bugs and pass 2 has caught them. Don't skip.

### Required pass sequence

For any review that turns up Critical or High findings:

1. **Pass 1:** initial review (this skill, Steps 1-5)
2. **User fixes findings**
3. **Pass 2 (REQUIRED):** dispatch ONLY `pr-review-toolkit:silent-failure-hunter` against the post-fix patch. The prompt must:
   - List the specific fixes that were applied (1-line each)
   - Ask whether the fixes introduced new silent failures, narrow-scoped fixes, or regressions
   - Ask whether other consumers of the changed semantics (per Step 1.5.A/B) were missed

4. **If pass 2 finds new Critical or High:** fix → pass 3.
5. **If pass 3 finds new Critical:** fix → pass 4.
6. Stop when a pass reports zero new Critical AND zero new High findings.

### Expected trajectory

Based on production patterns in this codebase:

| Pass | Typical finding profile |
|---|---|
| 1 | Bugs in the new code (legitimate) |
| 2 | Narrow-scoped fixes from pass 1 — e.g., you fixed the protection-opted booking-insert error path but left the non-protection case still silent |
| 3 | Files NOT in `git diff` whose contract was implicitly changed — caught by Step 1.5 expansion if you did it; otherwise found here |
| 4-5 | Pre-existing silent-failure patterns in adjacent code paths the new feature touches/exercises (webhook handlers, admin notifications, partner pages). These were always there; the feature surfaced them. |
| 6+ | Defensive cleanups — diminishing returns |

**Tell the user this trajectory in the consolidated report** so they know what to expect from later passes. Otherwise they'll think you broke something every time pass N finds new issues.

### Pre-merge gate

For `/scoped-review merge`, if ANY Critical is found, do not let the merge proceed. The merge gate is `pass.findings.critical.length === 0 && pass.findings.high.length === 0` after the most recent pass.

---

## Don't

- Don't run agents serially. Always parallel.
- Don't run `full-sweep` unless the diff is huge (>200 lines) or the user explicitly invoked `/scoped-review merge`.
- Don't run agents for empty / trivial diffs (whitespace, doc-only, single-line fixes).
- Don't summarize findings beyond what the agents reported. You're a router, not a reviewer.
- Don't forget: agents have no conversation context. Every prompt must be self-contained.
- Don't skip silent-failure-hunter on customer-facing or auth-adjacent changes. It's the highest-value reviewer for this codebase based on shipped-bug history.
- Don't let `/scoped-review merge` ship a Critical finding "as a follow-up."
- **Don't skip Step 1.5 (scope expansion).** A diff-only scope is the single biggest source of missed findings on this codebase. If a migration is in the diff or money-handling code is touched, expand scope per the rules even if the user just wanted a "quick check."
- **Don't skip Step 6 (multi-pass discipline).** A single review pass is incomplete. The expectation is 2-4 passes for any non-trivial change.
- **Don't tell the user "all clean" after pass 1 if any Critical or High was found.** They need pass 2. Tell them so.

---

## Triply-specific anti-patterns (treat as hard rules during review)

These are recurring failure modes from actual shipped bugs:

**Silent fallback defaults for user-supplied data:**
- `searchParams.get("checkinTime") || "10:00 AM"` is the exact pattern that produced wrong booking times. If data is required for a customer transaction, validate at the boundary, reject when missing.
- Default props on email templates, `<CheckoutForm>`, `<BookingDetails>`, `<WhatsNext>`, `<AddToCalendar>` for booking data — make them REQUIRED parameters (no `?`, no `= "default"`).
- Pricing-only fallbacks for search "from $X" estimates are acceptable; they MUST be commented inline with WHY they're safe (don't reach the booking record).

**Timezone handling:**
- Booking times are LITERAL airport-local strings — no `toISOString()`, no `new Date()` arithmetic, no implicit tz conversion.
- DB columns storing wall-clock times use `TIMESTAMP` (not `TIMESTAMPTZ`). Postgres silently interprets raw strings as UTC if the column is timezone-aware.
- Investigating "wrong time" bugs: column type matters as much as JS code. Always check the schema.

**Forwarding query params end-to-end:**
- If a URL contains an auth param (e.g., `?email=`), the page's `fetch()` call MUST forward it. Adding params to a link without consuming them server-side is a no-op with a misleading "Booking Not Found" error.
- When a fix involves a URL change, trace the full request: link → page route → fetch URL → API endpoint → response shape → render.

**Error handling:**
- NEVER `catch { /* continue with fallback */ }` for API responses. Distinguish 401/403 (auth required) from 404 (truly missing) from 5xx (transient) and surface different messages.
- Unexpected errors → Sentry via `captureBookingError`, `captureAPIError`, `capturePaymentError`.
- Gate the rendered UI on the fetch status BEFORE checking other state. Otherwise stale sessionStorage data renders a happy-path UI on a failed request.

**Verification:**
- After fixing a customer-reported bug, test the EXACT customer flow end-to-end. Click the email link, complete a booking, view the confirmation page. Code review is not a substitute for end-to-end testing.

**Types:**
- No `any`. No casts through `unknown` to "fix" type errors.
- Zod schemas at API boundaries. Don't trust raw `searchParams.get()` or unvalidated request bodies.

---

## Example dispatch decisions

**Diff: 30 lines, modified `src/app/api/reservations/route.ts`**
Categories: `api-routes` (file pattern), `silent-failure-risk` (if any new try/catch or `||` fallback)
Agents: `feature-dev:code-reviewer`, `pr-review-toolkit:silent-failure-hunter`
**2 agents.**

**Diff: 60 lines, new email template variant + modified `send-booking-confirmation.ts`**
Categories: `email-integration`, `new-files`
Agents: `pr-review-toolkit:silent-failure-hunter` (focus on default-prop traps), `feature-dev:code-reviewer` (focus on required-prop coverage)
**2 agents.**

**Diff: 200 lines across confirmation page + email template + API route, plus a Supabase migration**
Categories: `confirmation-page`, `email-integration`, `api-routes`, `db-migration`, likely `silent-failure-risk` and `new-types`
Agents: `feature-dev:code-reviewer`, `pr-review-toolkit:silent-failure-hunter`, `pr-review-toolkit:code-reviewer`, `pr-review-toolkit:type-design-analyzer`
**4 agents (full-sweep equivalent).**

**Diff: a SQL migration changing booking column types, no other files**
Categories: `db-migration`
Agents: `feature-dev:code-reviewer` with explicit prompt about backfill, lock duration, rollback path
**1 agent.**

**Diff: 5 lines, fixed a typo in JSX**
**0 agents.** Tell the user it's too small to review.

---

## Money-feature completeness checklist

When a feature adds, modifies, or removes a customer-facing charge (parking + fees + premium + discount + refund), use this checklist to drive Step 1.5.C scope expansion and to validate the consolidated report addresses every surface:

- [ ] **Charge math** — Stripe `chargeAmount` is server-verified, not client-trusted
- [ ] **Booking insert** — Supabase row stores all amounts in fields with documented semantics (no conflated columns)
- [ ] **Customer email** (booking confirmation) — itemizes the new amount, total reconciles
- [ ] **Confirmation page** — itemizes the new amount, total reconciles, gates on actual state (not just "premium paid")
- [ ] **Customer reservations list** (`/reservations`) — shows correct total per booking
- [ ] **Reservation card component** — total math matches email
- [ ] **Admin overview** (`/admin`) — recent-bookings totals match
- [ ] **Admin bookings list + modal** — totals match, CSV export math matches
- [ ] **Admin stats endpoint** (`/api/admin/stats`) — revenue queries select + sum the new amount
- [ ] **Admin cancel route** — refund math correctly reflects the new amount being returned/retained
- [ ] **Cancellation email** — itemizes refund breakdown, total reconciles
- [ ] **Stripe webhook handlers** — `charge.refunded` / `dispute.created` correctly notify any third-party integrations affected by status changes
- [ ] **Partner page** — partner totals correctly EXCLUDE pass-throughs (premium, service fee), include only their parking revenue
- [ ] **Analytics** (`gtag.trackPurchase`) — commission base excludes pass-throughs; NaN-defensive
- [ ] **Cross-route flag consistency** — server-side cross-check (e.g., Stripe metadata vs request body) prevents client tampering between endpoints

A money feature that fails ANY checkbox is incomplete. Pass-3 of the Park Guard review (May 2026) would have been Pass-1 if this checklist had existed.

---

## Common gaps caught in past multi-pass reviews

These are the gap categories that cost the most time to discover. Treat them as a pre-flight checklist before sending the final consolidated report:

### Gap 1: Files outside `git diff` that consume changed semantics
- **Symptom:** "Admin total math is correct only by accident" — admin reads a column whose meaning changed
- **Root cause:** diff-based scope; reviewers can't see consumers
- **Mitigation:** Step 1.5.A grep for column consumers, Step 1.5.B for write-semantics changes

### Gap 2: Money features that miss ancillary surfaces
- **Symptom:** Pass 3 finds the cancel route doesn't notify Park Guard; pass 4 finds admin stats under-counts
- **Root cause:** the feature touches the happy path but not refund/admin/analytics paths
- **Mitigation:** Step 1.5.C money-handling auto-include + completeness checklist above

### Gap 3: Narrow-scoped fixes from pass 1
- **Symptom:** Pass 2 finds "your fix covered the protection-opted case but left the non-protection case still silent"
- **Root cause:** developer fixed the specific Critical, not the underlying anti-pattern
- **Mitigation:** Step 6 multi-pass discipline; pass 2 silent-failure-hunter is required

### Gap 4: Pre-existing silent failures the new feature surfaces
- **Symptom:** Pass 4-5 finds outer try/catch silent failures, webhook Supabase error swallows, email-send failures with no Sentry — bugs that have been there forever
- **Root cause:** new feature exercises code paths under more load or with different inputs
- **Mitigation:** acknowledge in the consolidated report; fix as the feature scope demands; track separately in REVIEW-FINDINGS.md if not blocking

### Gap 5: Customer-facing UI states the new feature creates
- **Symptom:** Pass 6 finds confirmation page shows "Protection Active" when premium was paid but PG never acknowledged
- **Root cause:** UI rendered on "is the field set" rather than "is the operation actually complete"
- **Mitigation:** Step 1.5.D cross-route flag check; explicitly include UI surfaces in the prompt for any flag-driven feature

### Gap 6: Math-display bugs in fixes that try to itemize
- **Symptom:** Pass 5 finds the cancel email I just rewrote shows "$74 - $9.99 - $5 = $69.99" which doesn't reconcile
- **Root cause:** subtraction-style breakdowns are easy to get wrong; addition-style ("Refund = A + B; Service fee retained separately") is harder to get wrong
- **Mitigation:** prefer addition-style breakdowns where possible; clamp inputs defensively

---

## Skill maintenance log

Treat this skill itself as code subject to the same discipline. When a multi-pass review of this codebase turns up a gap that would have been caught earlier had the skill been more thorough, **update the skill before declaring the review done**. Record what gap was added below and the date.

- **2026-05-08** — Added Step 1.5 (scope expansion), elevated multi-pass to Step 6 hard requirement, added money-feature completeness checklist, and added "Common gaps" appendix. Driven by 6-pass review of the Park Guard feature where pass 3 found 4 Critical/High in files outside diff scope and pass 6 found a fix-introduced UI state bug.
