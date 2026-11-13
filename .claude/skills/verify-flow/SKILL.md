---
name: verify-flow
description: "End-to-end verification of customer-facing booking flows on Triply, in a real browser on the PR's preview deployment. Walks the journeys a customer takes (emailed link, checkout, confirmation page, admin display, lot page, search). Use after fixing a customer bug or changing checkout, confirmation, email or admin flows; code review alone misses bugs that need clicking through. Flows are email-link, checkout, confirmation, admin, lot-detail, search."
---

# /verify-flow — End-to-end customer-flow verification

You are walking through an actual user journey in the running app, not
just reading a diff. Code review can declare "ship it" while a flow is
still broken. This skill closes that gap.

## Hard rules (read first)

1. **Run on the PR's Vercel preview. Never on localhost, never on the
   live site.** Localhost has no secret for booking links (guest pages
   answer 503) and talks to **production** ResLab; previews talk to
   **staging** ResLab. All of them share one database.
2. **Never open, look up or cancel a test booking on localhost or on
   triplypro.com**, and never with `scripts/cancel-reservation.mjs`. A
   test booking's number means something else in production ResLab.
3. **Never use a customer's booking.** Never write a real booking number,
   key, name or email into this file, a commit, a PR or a comment. The
   test booking lives in a local file (Step 2).
4. **Never claim PASS for a scenario you did not run.** The only results
   are PASS, FAIL and SKIP, by the rules in Step 5.
5. **Don't create a booking unless the user said so for this run.** Each
   one writes a row in the shared database that is never removed.

## What a preview is

| | PR preview |
|---|---|
| Stripe | test mode: card `4242 4242 4242 4242`, any future date, any CVC |
| ResLab | staging |
| Database | the production database (test bookings are rows with `livemode = false`) |
| Test lots (ResLab 194–197) | listed |
| Crons | don't run |
| Analytics | loads, and reports to the production GA4 property |

---

## Step 1 — Pick the flow and the deployment

Parse `$ARGUMENTS` for the flow. With no argument, infer it from the diff
(`git diff --name-only main...HEAD`) and the table. If still unclear, ask.

| Flow keyword | Files in scope (if any are in the diff, suggest this flow) |
|---|---|
| `email-link` | `src/lib/resend/templates/booking-confirmation.tsx`, `src/lib/resend/send-booking-confirmation.ts`, `src/lib/confirmation/**`, `src/app/api/reservations/[id]/route.ts`, `src/app/(main)/confirmation/**` |
| `checkout` | `src/app/(main)/checkout/**`, `src/components/checkout/**`, `src/app/api/checkout/**`, `src/app/api/reservations/route.ts`, `src/lib/stripe/**` |
| `confirmation` | `src/app/(main)/confirmation/**`, `src/components/confirmation/**`, `src/app/api/reservations/[id]/route.ts` |
| `admin` | `src/app/(main)/admin/**`, `src/app/(main)/partner/**` |
| `lot-detail` | `src/components/lot/**`, `src/app/(main)/[slug]/airport-parking/[lot]/**`, `src/components/search/product-detail-slider.tsx` |
| `search` | `src/app/(main)/search/**`, `src/components/search/**`, `src/app/api/search/**` |

**Find the deployment.** The branch must be pushed. Take the preview
deployment built from the branch's **head commit** (Vercel tools: list
deployments by that SHA; or `gh pr checks <n>`). Use that deployment's
own URL, not a branch alias, and confirm its state is `READY`. Call it
`BASE` below.

**Get in.** Previews are protected. Get a share link for `BASE` (Vercel
tool `get_access_to_vercel_url`; it lasts 23 hours and covers that one
deployment) and open it once in **every** new browser context before
anything else. No way in → every scenario is SKIP ("no preview access").

**Dates.** Never use a fixed date. Work out `CHECKIN` = today + 30 days
and `CHECKOUT` = `CHECKIN` + 4 days (`YYYY-MM-DD`). A date in the past is
refused, and nothing can be booked more than 100 days out.

---

## Step 2 — The test booking (fixture)

The `email-link`, `confirmation` and `admin` flows need one standing
test booking, made once on a preview and reused.

**Where it lives:** the path in `TRIPLY_VERIFY_FIXTURE`, else
`~/.triply/verify-fixture.json`. Outside every git repo. Shape:

```json
{
  "number": "…", "key": "…", "email": "…",
  "firstName": "…", "lastName": "…",
  "lotName": "…", "airport": "…",
  "checkin": "YYYY-MM-DD", "checkinTime": "8:00 AM",
  "checkout": "YYYY-MM-DD", "checkoutTime": "6:00 PM",
  "createdAt": "YYYY-MM-DD", "madeOn": "<preview host>"
}
```

**Before using it, check it is usable:**
- No file → SKIP those flows: "no test booking; build one (below)".
- `checkin` is today or earlier → SKIP: "the test booking has expired; rebuild it".
- Otherwise use it. What its pages show decides PASS or FAIL (Step 5).

**Building it (only with the user's OK for this run):**
1. On `BASE`, open `/search?airport=<code>&checkin=…&checkout=…` for an
   airport that lists a **test lot** (name starts with "TEST"; they have
   been listed under CVG). No test lot → stop and say so. Never book a
   real lot.
2. Use a check-in about 90 days out, so the booking lasts.
3. **Block analytics first** in that browser context (abort requests to
   `googletagmanager.com`, `google-analytics.com`, `clarity.ms`). An
   automated `purchase` in GA4 looks like a bot buying.
4. Walk the checkout (the steps are under the `checkout` flow). First
   name `Verify`, last name `Fixture`, the user's own inbox, "No
   protection", no promo code.
5. On the confirmation page read the key from
   `sessionStorage['triply_confirmation_key:<number>']`.
6. Write the file. Tell the user what was created: one test row, one
   staging ResLab reservation, one confirmation email, one `[TEST]` alert.

**Do not cancel the fixture.** A cancelled booking loses its QR code and
calendar file.

---

## Step 3 — Browser rules

Use the Playwright tools. If they are not available, every browser
scenario is SKIP; `curl` cannot stand in for a page that renders in the
browser.

- **Every guest scenario starts in a fresh, signed-out browser context.**
  The confirmation page keeps the key and email in `sessionStorage` per
  tab and sends them again on later visits, and a signed-in session takes
  a different path through the API. Reusing a tab makes a scenario pass
  for the wrong reason.
- **Run `admin` last**, then sign out.
- **Try limits.** A refused email lookup costs one try: 5 per booking
  number, 10 per email, 30 per address, per 24 hours. **Every preview and
  staging share the same counters**, and nothing clears them. A run of
  this skill spends two (scenarios 4 and 5 of `email-link`). Don't repeat
  refused lookups to "make sure". A matching email, a key, or no proof at
  all costs nothing.
- The first refused lookup sends a Sentry warning (`guest-lookup-refused`).
  That is expected from a run of this skill.

---

## Step 4 — The scenarios

`N` = the fixture's number, `K` = its key, `E` = its email.

### Flow: `email-link`

**1 — The key alone opens the booking**
- Open `BASE/confirmation/N?booking_key=K` (no email).
- Assert: headline "Booking Confirmed!", the fixture's name, lot, dates
  and both times.
- Assert (network): the request to `/api/reservations/N` answered 200 and
  carried **no** `x-booking-email` header. The emailed link carries a key
  and an email, and the app falls back to the email when the key fails;
  only a key-alone request proves the key works.
- Assert: after the page settles, the address bar no longer shows
  `booking_key`.

**2 — The email alone opens the booking**
- Open `BASE/confirmation/N?email=E`.
- Assert: "Booking Confirmed!". The address bar no longer shows `email`.
- A change is planned so bookings made after a cutoff open only by key or
  sign-in. The PR that ships it must rewrite this scenario; until then
  this is the expected result.

**3 — No proof**
- Open `BASE/confirmation/N`.
- Assert: headline "Open Your Confirmation Link", with the field "Or
  enter the email you booked with" and a "View booking" button.

**4 — Wrong email on a real booking** (costs one try)
- Open `BASE/confirmation/N?email=verify-<8 random letters>@example.com`.
- Assert: "Open Your Confirmation Link". The booking's details appear
  nowhere on the page.

**5 — No such booking** (costs one try)
- Make a number that cannot exist: `RTL9` followed by 11 random digits.
- Open `BASE/confirmation/<that>?email=verify-<8 random letters>@example.com`.
- Assert: "Open Your Confirmation Link". **Not** "Booking Not Found": a
  guest gets the same answer for a missing booking and a wrong email, on
  purpose.

**6 — A bad key and no email**
- Open `BASE/confirmation/N?booking_key=short`.
- Assert: "Open Your Confirmation Link". (Use a short key. A wrong key of
  the right length, 22 characters, raises a Sentry warning.)

Other headlines, for reading a failure: 429 "Too Many Tries"; 503 "We
Can't Open This Booking Right Now"; 404 "Booking Not Found" (signed-in
viewers only); anything else "Something Went Wrong"; a cancelled booking
shows "Booking Cancelled".

### Flow: `confirmation`

**1 — The booking displays** (open with the key, as in `email-link` 1)
- Assert: check-in and check-out show the fixture's dates and times,
  exactly as stored. Not shifted by a time zone, not a default time.
- Assert: payment summary, customer details and vehicle details are filled.
- Assert: the QR code renders.

**2 — Calendar file**
- Click "Download .ics".
- Assert: the file downloads, and its `DTSTART` and `DTEND` carry the
  fixture's times (not midnight, not noon).

**3 — Another time zone** (when the change touches dates or times)
- Same page with the browser's time zone set to `America/Los_Angeles`,
  then `Asia/Tokyo`.
- Assert: the same dates and times as in scenario 1.

### Flow: `checkout`

**1 — Reserve stays off until both times are picked**
- Open `BASE/search?airport=JFK&checkin=CHECKIN&checkout=CHECKOUT`.
- Click a lot: the side panel opens.
- Assert: "Reserve Now" is disabled. Pick a check-in time, then a
  check-out time. Assert: "Reserve Now" is enabled.

**2 — Checkout without times**
- Open `BASE/checkout?lot=reslab-194&checkin=CHECKIN&checkout=CHECKOUT`
  (no `checkinTime` / `checkoutTime`).
- Assert: "Unable to Load Checkout", "Please select check-in and
  check-out times before continuing.", and a "Go Back" button that leaves
  the page (to the previous page, or the home page when there is none).

**3 — A full booking** (only when checkout or payment code changed, only
with the user's OK for this run, only on a test lot, only if the `admin`
flow can run so it can be cancelled)
- Block analytics first (Step 2, item 3).
- Step 1, Your Details: First Name, Last Name, Email Address, Phone Number.
- Step 2, Vehicle Info: Make, Model, Color, License Plate, State /
  Province, and any fields under "Additional Information" (plain fields
  take `N/A`, number fields `0`, a flight-number field needs a real-looking
  flight number).
- Step 3, Payment: choose "No protection" (a choice is required), tick
  the terms box, pay with the test card. The button reads "Complete
  Booking - $X", or "Pay Now - $X" when part is due at the lot.
- Assert: the browser lands on `/confirmation/<number>?lot=…&checkin=…`
  with "Booking Confirmed!". The address carries **no** email and no key
  (they travel in `sessionStorage`). Wallet and 3-D Secure payments pass
  through `/checkout/complete` first.
- Assert: the total charged matches the total shown before paying.
- Ask the user to confirm the email arrived with the picked times.
- Afterwards cancel it in **this preview's** `/admin/bookings`. Say in
  the report that a test row remains in the database.
- The Stripe test webhook is delivered to staging, not to this preview,
  so this scenario does not exercise the PR's webhook code. Say so.

### Flow: `lot-detail`

**1 — Times are required**
- From `BASE/search?airport=JFK&checkin=CHECKIN&checkout=CHECKOUT`, open
  a lot's own page (its address has the shape
  `/new-york-jfk/airport-parking/<lot-slug>`). Take the link from the
  results; don't type a slug from memory.
- Assert: both time dropdowns are empty (orange border, "Select").
- Assert: Reserve is disabled and the inline message is showing.
- Pick both times. Assert: the dropdowns turn gray, the message goes,
  Reserve is enabled.

### Flow: `search`

**1 — Search returns lots**
- Open `BASE/search?airport=JFK&checkin=CHECKIN&checkout=CHECKOUT`.
- Assert: lot cards with prices.
- Assert: no time dropdowns in the search header (only a sort control).

### Flow: `admin` (last)

Needs the user to sign in, with email and password, **in the automated
browser window** on `BASE`. (Google sign-in returns to the live site, so
it does not work on a preview.) No sign-in → SKIP the flow, and never
run `checkout` scenario 3.

**1 — The booking in the list**
- Open `BASE/admin/bookings`. The "Live or test bookings" control
  defaults to test bookings on a preview.
- Find the fixture's row. Columns are: Confirmation #, Customer,
  Location, Inventory, Dates, Total, Status, Source, Actions. "Dates"
  shows dates only.
- Assert: the dates match the fixture.

**2 — The detail window**
- Click the row.
- Assert: "Check-in:" shows weekday, date and time, for example
  `Sun, May 10, 2026, 8:00 AM`, with the fixture's own date and time.
  A time several hours off means a time-zone conversion crept in.

**3 — Sign out.** Close the context.

---

## Step 5 — Results

| Result | When |
|---|---|
| **PASS** | You ran it and every assert held. |
| **FAIL** | An assert did not hold. Give the exact value seen and the value expected. A fixture page answering 403 (scenarios 1 and 2), 500 or 503 is a FAIL: that is the bug this skill exists to catch. |
| **SKIP** | It could not be run: no preview access, no Playwright, no fixture, an expired or cancelled fixture, a 404 on the fixture (staging ResLab dropped it: rebuild), "Too Many Tries" (the shared try limit: say so, don't retry), no admin sign-in. Say which. |

List every scenario of the flow with its result. Then one line:
- "Flow verified: N passed." (only if nothing failed and nothing was skipped)
- "Flow verified in part: N passed, M skipped (reasons)."
- "Flow broken at scenario N: see above."

A run with skipped scenarios is not a full verification. Say what the
user must do to get the rest.

---

## Don't

- Don't substitute this skill for `/scoped-review`. Review reads the
  diff; this clicks through the app.
- Don't fall back to localhost when the preview is not ready. Wait for it.
- Don't put fixture values in a URL you paste into a PR, a commit or a
  chat with anyone but the user.
- Don't "fix" a failing scenario by changing its expected value without
  reading the code that produces the page.

---

## Adding or changing a flow

When a customer-facing flow is built or changed, update this file in the
same PR:
1. The keyword and the file paths in scope.
2. Scenarios with addresses, asserts and the exact text expected, taken
   from the code, not from memory.
3. What it costs to run (a try, an email, a database row).

*Rewritten November 13, 2026: moved from localhost to the PR preview; every scenario re-read against the code; a standing test booking kept outside git.*
