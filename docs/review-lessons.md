# Review lessons — what our reviews keep finding

**Read this before you open a PR, and have your Claude check the diff against it.** Every rule below comes
from a real finding in a review of our own PRs. Most were caught before merge, at the cost of 2–8 review
rounds each. Checking these yourself first is cheaper.

How to use it:
1. Before `gh pr create`, ask Claude: *"Check this diff against docs/review-lessons.md — for each
   lesson, does the diff hit it? Show me where."*
2. Say in the PR body which lessons you checked ("Lessons checked: 1–12").
3. When a review of your PR finds something, it gets a line in the **Log** at the bottom. If it's a new
   kind of mistake, it becomes a new lesson.

---

## The lessons

### 1. Every sentence a customer, a bank or Google reads must be true for every case the code can reach

If it is true only for most bookings, it is false. When unsure, say less, or leave the field blank for
a human.
- **#149:** dispute evidence said "Charged $X" from `grand_total`, which is the lot's total: wrong for
  every booking with our fee, Park Guard or a pay-at-lot part. It also said "no refund was due" on
  refunded bookings, and named the account holder instead of the person who checked out. Stripe takes
  ONE evidence submission, so a false line can lose a dispute we'd win.
- **#156:** auto-replies promised "we'll make the change", "our team has been alerted right now", and
  self-cancel when it was switched off.
- **#152:** an FAQ said off-airport lots cost less than the cheapest on-airport lot; live prices
  contradicted it at ORD, MCO and ATL.
- **#150:** evidence said "the customer ticked the terms box". We can prove the gate (Pay is disabled
  until it's ticked), not the act.
- **How to check:** for each new customer-facing sentence, name the data that proves it and the case
  where it would be false.

### 2. Never claim a figure or a fact the current source doesn't hold

- **Hub posts, Nov 5:** the Atlanta Thanksgiving line said 82% vs the Hourly Deck. The index had been
  corrected to 57% vs the Daily decks on Nov 2.
- **#143:** hand-written prose carried other sites' lot prices that went stale on every refresh.
- **Rule:** figures come from the live source at write time (the index, the data file, live search),
  never from memory or an older draft.
- **Rule:** never name or price a lot we don't sell, never print a rival's promo code, and never link a
  competitor as if it were us.

### 3. Mark something "sent" or "done" only AFTER it succeeded

- **#149 / #150:** the alert was marked sent before calling Resend, so one hung send meant the alert was
  lost forever, with every retry seeing "already sent".
- **Fix pattern:** a short lease while the send is in flight, then `sent_at` written after success. The
  worst case becomes a duplicate, never a missing alert.

### 4. Every network call on a request, webhook or cron path has a timeout, and the total fits `maxDuration`

- **#156:** a DB lookup with no limit ran before the message was saved, so a hang lost the customer's
  message.
- **#149:** Stripe and Resend calls had no timeout.
- **#49:** a ResLab call could outlive the route.
- **Rule:** a "fail open" that depends on a catch block doesn't fail open when the function is killed.
- **Bounds we use:** DB `.abortSignal(AbortSignal.timeout(3000))`; Resend in a `Promise.race`; Stripe
  steps capped. Count the worst case against the route's `maxDuration`.

### 5. A partial, failed or fallback answer is never treated as complete

- **#160:** search answers flagged `directUnavailable` were accepted, so a CMS outage would have marked
  The Parking Point JFK unsellable. An all-empty answer would have marked every lot gone.
- **#125 and others:** PostgREST returns at most 1,000 rows; a `.limit(N)` above that is silently
  capped. Page with `.range()`.
- **Rule:** when a source can be partial, refuse to write from it, and say so in the output. "No data"
  is not "nothing exists".

### 6. Weak evidence never writes data that later code trusts as strong

- **#160:** name, token and address matches wrote ResLab ids. From then on both tools match by id first,
  so a wrong id sticks. Two products at one address (SAN Aladdin Airport and Aladdin Port) could swap.
- **Rule:** weak evidence goes in a report for a human. Never overwrite an established id on weaker
  evidence.

### 7. One owner per field

- **#160:** lot-sync wrote a one-date price (a stay starting the day after Thanksgiving) over
  refresh-rates' 3-date median.
- **#158:** chart captions and data files held different on-airport rates (MCO, BNA).
- **Rule:** if two tools can write the same field, decide which one owns it and make the other report,
  not write.

### 8. Know which environment's data you are touching

- Staging and production share ONE database, so a staging test writes real rows. Filter by `livemode`.
- Staging uses a SEPARATE ResLab account: different ids, and the test lots aren't hidden.
- **#160:** `TRIPLY_SITE_URL` could point lot-sync at a preview and write staging ids into production
  files. `--apply` now refuses anything but production.
- **#156:** staging test tickets would have landed in the production inbox and pinged `@here`.

### 9. A public endpoint must not reveal private facts, through its content or its timing

- **#156:** the contact form waited on a Discord alert only when the booking matched and the trip was
  today. Response time revealed whether someone was travelling. That work now runs after the response
  (`after()`).
- **#146:** a new link key went to GA4 and Clarity, the very tools it was meant to keep the email out
  of.
- **How to check:** ask what each tool RECORDS (GA4, Clarity, Sentry headers and spans, referrers), not
  only what the diff changes.

### 10. A switched-off feature behaves exactly like today

- **#156:** with the flag off, the contact page still showed tips promising the urgent workflow.
- **Rule:** flag off means byte-for-byte today's behaviour. A flag read in a static page needs a
  redeploy to change, so say so in the PR.

### 11. Live content (the production CMS) is changed only with a shown, approved change

- **Nov 5:** a script saved all 25 airport hub posts with no review, and one figure was wrong (lesson 2).
- **Steps:**
  1. Show the exact change.
  2. Get Tom's OK.
  3. Take a backup.
  4. Refuse to write if the post changed since the backup.
  5. Re-read to verify.
  6. Ping IndexNow.
- The engine writes drafts. Publishing is a separate, reviewed step.

### 12. Provider contracts are not what you'd guess — read them

- **Resend:** rejects a reused idempotency key with a different payload (#156); a key built from message
  text blocked a customer's second message. Free plan: 100 emails a day.
- **Supabase Auth and Resend** return `{ error }` and never throw, so a try/catch alone catches nothing.
- **PostgREST:** rejects `.or()` on UPDATE; use two conditional updates.
- **stripe-node at `maxNetworkRetries: 0`:** sends no idempotency key yet still retries a first
  ECONNRESET, and its own retries can sleep 60 s. Pass your own key.
- **Stripe disputes:** one evidence submission per dispute.
- **ResLab:** prices Canadian lots in CAD. Extra fields are mandatory; `flight_number` is validated.

### 13. A test must be able to fail

- **#160:** an `every(...)` assertion passed on an empty map.
- **#158:** a test could not fail.
- **How to check:** for each test of a fix, remove the fix and watch the test fail.

### 14. A commit (and generated data) matches its message and the final code

- **#160:** the data files came from an earlier version of the code. That run had applied weak matches
  the final code refuses. Re-run the final code to produce the data you commit.
- **#141:** a `&&` patch chain stopped early and left claimed edits unapplied.
- **How to check:** `git show --stat` each commit against its message before pushing.

### 15. Every fix gets reviewed again

- In nearly every multi-round review (#143 took 8 rounds, #149 4, #156 4), the next round found bugs in
  the previous round's fixes.
- A fix adds branches. Ask: *what does this new branch do when its own operation fails?*

---

## Log

One entry per reviewed PR: what the review found, by lesson number. Newest first.

- **#160 lot-sync (Nov 6):**
  - Lesson 5: a direct-lot outage was accepted as a complete answer.
  - Lesson 6: weak matches re-pointed ids, and a shared address could swap products.
  - Lesson 7: lot-sync overwrote refresh-rates' prices with a Thanksgiving-weekend sample.
  - Lesson 1 / 2: cruise and downtown lots were still named and priced on airport pages and hub tables.
  - Lesson 8: `--apply` could write from a preview.
  - Lesson 13: a test passed on an empty map.
  - Lesson 14: the data came from an earlier code version.
  - Fixed on the branch, and the data was rebuilt.
- **Hub posts (Nov 5, live CMS, no PR):**
  - Lesson 11: 25 posts edited without review.
  - Lesson 2: ATL said 82% vs the Hourly Deck; the index says 57% vs the Daily decks.
- **#158 price gate (Nov 5):**
  - Lesson 7: chart captions came from a separate table.
  - Lesson 13: a test that couldn't fail.
  - 4 gaps left open while the gate is off.
- **#156 support inbox (Nov 5):**
  - Lesson 9: response timing.
  - Lesson 4: unbounded steps.
  - Lesson 10: the flag-off page differed from today.
  - Lesson 1: reply wording.
  - Lesson 12: Resend key reuse.
  - Lesson 8: staging tickets.
- **#150 disputes 2 (Nov 5):**
  - Lesson 1: "the customer ticked".
  - Lesson 3: fraud-alert lease.
  - Lesson 1: the fraud email advised a Stripe-only refund, which leaves the ResLab reservation live.
- **#149 disputes 1 (Nov 5):**
  - Lesson 1: amount, refund, contact and policy claims.
  - Lesson 3: alert marked sent before sending.
  - Lesson 4: no timeouts.
  - Lesson 12: stripe-node retries.
- **#152 hub copy (Nov 5):**
  - Lesson 1: off-airport-is-cheaper claims contradicted live.
  - Lesson 2: BWI Clarion described wrongly.
- **#146 guest email (Nov 3):** lesson 9, the new key went to the analytics it was meant to avoid.
- **#143 airport data (Nov 2):** lesson 2, stale lot prices in prose. It took 8 rounds, each finding
  bugs in the last round's fixes (lesson 15).

*Created November 6, 2026 — from REVIEW-FINDINGS.md (wrapper repo) and the reviews of #143–#160.*
