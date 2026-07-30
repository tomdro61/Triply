---
name: verify-flow
description: End-to-end verification of customer-facing booking flows on Triply. Walks through real user journeys (email link click, checkout, confirmation page, admin display) using the local dev server and Playwright when available. Use after fixing a customer bug or making changes to checkout/confirmation/email/admin flows — code review alone misses bugs that require actually clicking through. Existing flows: email-link, checkout, confirmation, admin, lot-detail.
---

# /verify-flow — End-to-end customer-flow verification

You are walking through an actual user journey in the running app, not
just reading a diff. Code review can declare "ship it" while a flow is
still broken — that's how the `?email=` forwarding bug got past three
reviewers in this session. This skill closes that gap.

**Context this skill needs to know:**
- Triply's dev server typically runs on `http://localhost:3000` or
  `:3001` (Next.js auto-selects when 3000 is taken).
- `.env.local` in `triply/` points to **production Supabase** by default,
  so the dev server can read real bookings (e.g., `EXAMPLE12345` is
  the customer's booking from the May 2026 incident — useful for verification).
- Stripe is in **test mode** locally — use card `4242 4242 4242 4242`
  for any flow that touches payment.
- ResLab uses test locations 194 (TEST-OH) and 195 (TEST-NY) when in
  sandbox.

---

## Step 1 — Pick the flow

Parse `$ARGUMENTS` to identify which flow to verify. If no arg, infer
from the recent diff (`git diff --name-only` and match the file paths
to the flow-mapping table below). If still ambiguous, ask the user.

| Flow keyword | Files in scope (if any of these are in the diff, suggest this flow) |
|---|---|
| `email-link` | `src/lib/resend/templates/booking-confirmation.tsx`, `src/lib/resend/send-booking-confirmation.ts`, `src/app/api/reservations/[id]/route.ts`, `src/app/(main)/confirmation/**` |
| `checkout` | `src/app/(main)/checkout/**`, `src/components/checkout/**`, `src/app/api/checkout/**`, `src/app/api/reservations/route.ts`, `src/lib/stripe/**` |
| `confirmation` | `src/app/(main)/confirmation/**`, `src/components/confirmation/**`, `src/app/api/reservations/[id]/route.ts` |
| `admin` | `src/app/(main)/admin/**`, `src/app/(main)/partner/**` |
| `lot-detail` | `src/components/lot/**`, `src/app/(main)/[slug]/airport-parking/[lot]/**`, `src/components/search/product-detail-slider.tsx` |
| `search` | `src/app/(main)/search/**`, `src/components/search/**`, `src/app/api/search/**` |

---

## Step 2 — Confirm the dev server is up

Run `curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/` (or
3000) and check for a 200. If it's down, ask the user to start it via
`npm run dev` in the `triply/` directory before continuing. Don't try to
start it yourself — long-running processes need user oversight.

If both ports return non-200, stop and tell the user the server isn't
running. Don't fake the verification.

---

## Step 3 — Walk through the scenarios

Use Playwright (`mcp__plugin_playwright_playwright__*` tools) for browser
automation when available. If Playwright tools aren't accessible in the
session, fall back to `curl` for HTTP-level checks and explicit manual
instructions for the user.

### Flow: `email-link`

**Scenario 1 — Guest with valid email param**
- Build URL: `http://localhost:3001/confirmation/EXAMPLE12345?email=customer@example.com`
- Open in browser (Playwright `browser_navigate`)
- Assert: page renders the confirmation card (look for confirmation
  number, customer name "Example Customer", check-in date, "8:00 AM" time)
- Assert: NO "Booking Not Found" or "Open Your Confirmation Link" headline

**Scenario 2 — Guest without email param (auth-required path)**
- URL: `http://localhost:3001/confirmation/EXAMPLE12345`
- Assert: page shows "Open Your Confirmation Link" headline (NOT
  "Booking Not Found" — those are different messages)
- Assert: copy mentions checking the original confirmation email

**Scenario 3 — Guest with WRONG email param**
- URL: `http://localhost:3001/confirmation/EXAMPLE12345?email=wrong@example.com`
- Assert: page shows "Open Your Confirmation Link" headline
- This is acceptable — the API returns 403 for both "no email" and
  "wrong email" by design

**Scenario 4 — Truly missing reservation**
- URL: `http://localhost:3001/confirmation/FAKE123?email=any@example.com`
- Assert: page shows "Booking Not Found" (NOT "Open Your Confirmation
  Link")

### Flow: `checkout`

Note: requires test Stripe card. Don't run this on production keys.

**Scenario 1 — Reserve flow blocks until times are picked**
- Navigate to `http://localhost:3001/`
- Search for JFK
- Click any lot → opens slider
- Assert: Reserve button is disabled
- Pick check-in time → check-out time
- Assert: Reserve button enables

**Scenario 2 — Checkout missing time params**
- Direct nav: `http://localhost:3001/checkout?lot=reslab-194&checkin=2026-06-01&checkout=2026-06-05`
  (no `checkinTime`/`checkoutTime`)
- Assert: page shows the missing-times error message, "Go Back" button
  works

**Scenario 3 — Full checkout (only if testing payment changes)**
- Complete a booking with test card `4242 4242 4242 4242`
- Assert: redirected to `/confirmation/[id]?lot=...&email=...`
- Assert: confirmation email arrives in Resend dashboard with correct
  times (NOT 10am/2pm defaults)

### Flow: `confirmation`

**Scenario 1 — Real booking displays**
- URL: `http://localhost:3001/confirmation/EXAMPLE12345?email=customer@example.com`
- Assert: check-in time shows "8:00 AM", check-out "11:30 PM"
- Assert: payment summary, customer info, vehicle info populated
- Assert: QR code renders

**Scenario 2 — Calendar export**
- On the confirmation page, click "Download .ics"
- Assert: ICS file downloads
- Open the ICS file content, verify `DTSTART` and `DTEND` lines reflect
  picked times (not midnight/noon defaults)

### Flow: `admin`

**Scenario 1 — Admin booking row shows literal customer-picked time**
- Navigate to `http://localhost:3001/admin/bookings`
- Find EXAMPLE12345 row
- Assert: Check-in column shows "8:00 AM" (NOT 4:00 AM — that's the
  pre-migration TIMESTAMPTZ bug; if you see 4 AM, the migration didn't
  run on this DB)
- Click row → modal opens
- Assert: Modal shows "May 10, 2026, 8:00 AM" in check-in field

**Scenario 2 — Different timezone view (optional, only if env permits)**
- Same booking, but viewer browser in PT (use Playwright's tz emulation
  via `browser_evaluate`)
- Assert: still shows "8:00 AM" — should NOT shift by viewer tz

### Flow: `lot-detail`

**Scenario 1 — Required-times gating**
- Navigate to a lot detail page directly: `http://localhost:3001/new-york-jfk-jfk/airport-parking/[some-slug]?checkin=2026-06-01&checkout=2026-06-05`
- Assert: time dropdowns are EMPTY by default (orange-bordered "Select"
  placeholder)
- Assert: Reserve button is DISABLED with the inline error message
  visible
- Pick both times
- Assert: dropdowns turn gray (filled state), error disappears, Reserve
  enables

### Flow: `search`

**Scenario 1 — Search produces results**
- `http://localhost:3001/search?airport=JFK&checkin=2026-06-01&checkout=2026-06-05`
- Assert: lot cards render with prices
- Assert: NO time dropdowns in the search header (they were removed)

---

## Step 4 — Report

For each scenario, report:
- ✅ PASS — what you verified
- ❌ FAIL — what didn't match expectations, with the exact value seen
  vs. expected
- ⚠️ SKIP — couldn't verify (e.g., Playwright not available, dev server
  down, no test data)

End with a one-line verdict:
- "Flow verified — safe to merge"
- "Flow broken at scenario N — see details"

---

## Don't

- Don't claim PASS without actually running the scenario. If you can't
  hit the URL, mark SKIP and tell the user.
- Don't run payment scenarios with live Stripe keys. If `.env.local`
  isn't in test mode, mark payment scenarios as SKIP.
- Don't auto-create test bookings unless explicitly asked — use
  existing data (e.g., EXAMPLE12345) to verify display behavior.
- Don't substitute this skill for `/scoped-review`. They cover
  different gaps — review reads the diff, this clicks through the UI.
- Don't fake Playwright steps when the tool isn't actually available.
  Run `mcp__plugin_playwright_playwright__browser_navigate` and check
  the response. If it errors, fall back to manual instructions.

---

## Adding new flows

When a new customer-facing flow is built, add it here with:
1. The keyword (`/verify-flow <keyword>`)
2. The file paths in scope (for auto-detection)
3. Concrete scenarios with URLs, asserts, and expected values
4. Any test data prerequisites (booking IDs, customer emails)

Update `REVIEW-FINDINGS.md` if a flow verification ever catches a bug
that review missed — the lesson belongs in the skill's matrix.
