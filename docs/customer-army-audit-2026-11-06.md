# Triply booking-flow audit: simulated customer army

**Date:** 2026-11-06 · **For:** Vin and Tom · **Scope:** live triplypro.com plus `upstream/main` (e11996bc) · **Status:** report only. Nothing has been implemented, pushed, booked or paid.

> **Read this first.** The 100 customers here are simulated. They are not real customers and they are not survey data. When several squads agree, that is not statistical proof. Findings are ranked by severity × how many journeys they touch × evidence strength. The report makes no conversion or revenue claims.

**Evidence tags:**
- **[LIVE]** = reproduced in the browser on triplypro.com today (mobile 375×812 and/or desktop), or present in the live API snapshot.
- **[CODE]** = read on `upstream/main`.
- **[INFERRED]** = reasoning only.

Repro IDs **D1–D13** are listed in Appendix B.

---

## 1. Prioritised UI change list

### P1: fix first (a customer is blocked or misled before paying)

- **1. Show minimum-stay rules before Reserve, and explain a disabled Reserve button.**
  - *Evidence:* [LIVE D1] On mobile, JFK Bolt Parking (min 6 days) is listed at $152.28 for a 5-day trip. In the slider, Reserve Now is `disabled` and no reason is visible. The reason exists only in a `title` tooltip, which touch screens never show. [CODE] `product-detail-slider.tsx:158-168,537`. Cards and the search page never read `minimumBookingDays`. The lot page *does* show a red banner (`booking-widget.tsx:354-361`). 53 lots at 36 airports have a min stay of 2+ days.
  - *Obstacle:* The customer picks a lot, sets times, and taps a dead button with no explanation. Short-trip business travellers are hit hardest: ORD 1-night gives 3 of 6 lots unbookable.
  - *Change:*
    1. The card shows a "Min N days" chip whenever the searched stay is below the lot's minimum.
    2. Such lots sort below bookable lots and can never carry "Lowest total" or "Most booked".
    3. The slider renders the `reserveDisabledReason` as visible text above the footer, for every disabled reason (min days, sold out, not open yet).
  - *Acceptance:*
    - JFK, Nov 20–24: Bolt shows a "Min 6 days" chip and is ranked below bookable lots.
    - Opening Bolt shows "Minimum 6 days required", visible at 375px without hovering.
    - No badge is ever on a lot the current stay can't book. Covered by a unit test on the ranking.

- **2. Tell the truth about shuttles on cards and hubs.**
  - *Evidence:*
    - [LIVE D3] EWR Red Carpet Inn ("No Shuttle. Uber and Lyft…") is #1 with "Lowest total" and its card has no warning.
    - [LIVE D6] The EWR hub tags the same lot "Shuttle" and "Best Price", and the rates table says Shuttle **Yes**.
    - [CODE] The "No Shuttle" chip keys on amenities (`lot-card.tsx:49-54`), and 0 of 246 lots have a shuttle amenity, so it can never fire. Hubs test only that `shuttleInfo` exists (`lot-grid.tsx:58-63`, `rates-table.tsx:60`).
    - The "24/7 Access" chip actually comes from ResLab's "24/7 Front Desk" (`lot-card.tsx:87-88`). It shows on 189 lots, 87 of which have no 24/7 shuttle.
    - 25 lots have no shuttle or a suspended one, and "Lowest total" lands on such a lot at 14 airports.
  - *Obstacle:* The customer books the cheapest lot expecting a shuttle and discovers at the lot that they need an Uber both ways. This is a trust-breaking surprise after payment.
  - *Change:*
    1. Derive a shuttle status from `shuttleInfo.summary`: **24/7**, **hours (e.g. 6 AM–11:30 PM)**, **On demand**, or **No shuttle**.
    2. Show it as a chip on search cards, the mobile map card, hub cards and the rates table.
    3. Rename "24/7 Access" to "24/7 front desk".
    4. Make the phone-field helper copy ("shuttle coordination") conditional on the lot having a shuttle.
  - *Acceptance:*
    - EWR Red Carpet shows "No shuttle" on the search card, the hub card and the rates table (which says "No").
    - ATL Routes shows "Shuttle 6 AM–11:30 PM".
    - No card shows "24/7 Access" unless it is derived from 24/7 shuttle or 24/7 gate data.
    - A fixture test covers each summary pattern in the snapshot (none, suspended, window, on-demand, 24/7).

- **3. Warn when the chosen drop-off or return time is outside shuttle hours.**
  - *Evidence:* [LIVE D2] At ATL Routes (shuttle 6:00 AM–11:30 PM), a 4:00 AM drop-off with a 1:00 AM return books with no warning. [CODE] Times are never compared with shuttle hours anywhere in search, lot or checkout. ~46–50% of lots are not 24/7.
  - *Obstacle:* Early-flight and red-eye travellers book a lot they physically can't use. This is the classic "stranded at 1 AM" failure.
  - *Change:*
    1. Parse shuttle windows (same parser as #2).
    2. When the chosen check-in or return time falls outside them, show an amber inline warning under the time select: "Shuttle runs 6:00 AM–11:30 PM. Your 4:00 AM drop-off is outside these hours." Do not block the booking, because some lots allow after-hours drop-off.
    3. Repeat the warning in the checkout summary.
  - *Acceptance:*
    - Routes ATL at 4:00 AM shows the warning in the slider and at checkout; 7:00 AM shows none.
    - Sky Lot (24/7) never warns.
    - Any lot with an unparseable summary shows no warning and is logged.

- **4. Make the cancellation promise match the actual rule.**
  - *Evidence:*
    - [LIVE D4] The slider says "Free Cancellation" for a check-in *tomorrow*.
    - [LIVE D5] At checkout for the same booking, the "Free cancellation up to 24 hours…" block is gone and nothing replaces it.
    - [CODE] `product-detail-slider.tsx:310-312`, `hero-section.tsx:34`, `booking-widget.tsx:165` ("Full refund if cancelled"), `checkout-form.tsx:101` (`leadDays >= 2`).
    - The step-3 terms checkbox does state the 24h rule (`terms-acceptance.ts:13-16`).
    - The confirmation email says "Late cancellations may incur fees", which contradicts the terms.
  - *Obstacle:* Same-day and next-day buyers are promised free cancellation, then lose it once inside 24h, which they learn only from fine print at payment.
  - *Change:*
    1. Replace every unconditional label with a computed one: "Free cancellation until Fri Nov 6, 10:00 AM" (check-in − 24h, in the lot's timezone).
    2. When that moment has already passed or is under 24h away, show "Not cancellable online. Email support".
    3. Keep the checkout block for all lead times and switch its wording the same way.
    4. Align the email line with the terms.
  - *Acceptance:*
    - A check-in 30h away shows a dated cutoff in the slider, lot widget and checkout.
    - A check-in 10h away shows "not cancellable online" in all three.
    - The email copy matches the terms 5.3 wording.
    - The hub hero stays generic ("Free cancellation up to 24h before check-in on most bookings").

- **5. Stop sending people into empty airports.**
  - *Evidence:*
    - [LIVE D8] SLC search shows only "No parking lots found for your search criteria." The SLC hub says "booked or unavailable for the next week" and suggests ABQ, GEG and IDA, which are all empty too.
    - [LIVE] Coverage: 15 of 85 marketed airports return 0 lots (ABE ABQ AZO DAL GEG IDA MEM ROA RSW SLC SNA YOW YUL YYC YYZ). /airport-parking lists all 85 equally, under "85+ airports".
    - [CODE] The blog widget gates on `enabled` (`ArticleBookingPrompt.tsx:19` → `config/airports.ts:1076-1079`), so articles for zero-lot airports preselect a dead search. Squad 10 counted ~136 YYZ/YYC/YUL/YOW posts in the CMS, plus Love Field posts that route to DFW.
  - *Obstacle:* Organic and blog visitors hit a dead end with no next step. "Booked or unavailable" implies they should keep retrying dates.
  - *Change:*
    1. **Empty state:** name the situation ("We don't have bookable lots at SLC yet"), show the nearest airports *that have inventory* with their live "from" price, and offer the existing waitlist/notify form inline.
    2. **Hub:** replace "booked or unavailable for the next week" with that same copy when the airport has had no inventory in the last N days. Filter "Other Airport Parking" to airports with lots.
    3. **/airport-parking:** visually mark the zero-lot airports ("Coming soon") or sort them last.
    4. **Blog widget:** gate on live inventory, not `enabled`. For a zero-lot airport, show the notify form plus the nearest covered airport.
  - *Acceptance:*
    - SLC search and hub show nearby covered airports (e.g. DEN, with a live price) and a notify form. No link from any hub points to a 0-lot airport.
    - A YYZ article no longer renders a search widget that returns 0 results.
    - The DAL article does not silently switch to DFW. It either says "Love Field not available; DFW is 15+ mi away" or shows the notify form.

### P2: high friction or trust risk

- **6. Make the lot slider a real dialog (keyboard, screen reader, Back button).**
  - *Evidence:* [LIVE D9] There is no `role=dialog`/`aria-modal`, focus stays on `BODY` when the slider opens, both time selects have no label (no id, aria-label or `<label for>`) and are 26px tall, 4 visible buttons have no name, and Reserve Now is white on #F87356 = **2.77:1**. [LIVE D10] Phone Back with the slider open leaves /search entirely. [CODE] `product-detail-slider.tsx:219-235,329-354`.
  - *Obstacle:* Screen-reader and keyboard users can't reliably pick times, which are mandatory, or find Reserve. Phone users lose their results by pressing Back.
  - *Change:*
    1. Use the existing Radix Dialog/Sheet primitive: focus moves to the heading on open, is trapped, Escape closes, and focus returns to the card.
    2. Add `<label htmlFor>` to the check-in and check-out time selects, and add aria-labels to the close and photo arrows.
    3. Push a `?lot=<slug>` history entry when the slider opens, so Back closes it.
    4. Darken the CTA orange to ≥4.5:1 with white text (or use dark text).
    5. Make the time selects ≥44px tall with 16px text, which also stops iOS zoom-on-focus.
  - *Acceptance:* axe shows 0 critical/serious issues on /search with the slider open. With VoiceOver, opening a lot announces "dialog, <lot name>", each select reads "Check-in time", and Escape returns to the same card. Android/iOS Back closes the slider and leaves the results in place. Measured CTA contrast is ≥4.5:1.

- **7. State "Pay now $X · Pay at lot $Y" wherever a pay-at-location price appears.**
  - *Evidence:* [LIVE D7] 6 of 10 JFK cards show a "Pay at Location" chip with no amount. The PARK AC slider shows a $84.12 total, "Due at location $61.23" and "Payment will be collected on-site at check-in", but never the ~$22.89 charged now. Checkout does state Due Now and Due at Location on every step (`order-summary.tsx:250-265`), but on mobile that summary is below the form (D5). 21 lots take 63–89% of the total at the lot.
  - *Obstacle:* Customers can't tell whether they are paying twice or how much is charged now. "Collected on-site" reads as if the whole amount is due there.
  - *Change:*
    1. Card: "Pay at Location" becomes "$22.89 now · $61.23 at lot".
    2. The slider, the lot page price box and the sticky footer show the same two-line split.
    3. Reword "Payment will be collected on-site" to "The remaining $61.23 is paid at the lot at check-in".
  - *Acceptance:* For every `dueAtLocation` lot, the card, slider, lot page and checkout show identical now/at-lot amounts that sum to the total, checked against the API for JFK PARK AC and EWR Apex.

- **8. Put the order total above the form on mobile checkout.**
  - *Evidence:* [LIVE D5] At 375px, the price summary and promo field render after the Step 1 form. [CODE] `checkout-form.tsx` grid `grid-cols-1 lg:grid-cols-3`.
  - *Obstacle:* Rushed mobile users type their personal details without seeing what they will pay. This is a common abandonment point (INFERRED).
  - *Change:* Add a compact, sticky "Total $63.70 · details ▾" bar at the top of mobile checkout. It expands to the full summary, including the now/at-lot split (#7) and the cancellation line (#4).
  - *Acceptance:* At 375×812, the total is visible without scrolling on all 3 steps. Expanding the bar shows the same line items as the desktop summary.

- **9. Ask for times at search, or say which times the prices assume.**
  - *Evidence:* [LIVE D13] Search has no time fields, so cards are priced at a hidden 10:00 AM → 2:00 PM default (`utils/time.ts:120-121`). Fri→Tue therefore bills "5 days" ($11.55 × 5). Squad 2 measured live that EWR Red Carpet is $33.33 at the defaults and $27.85 at 8 AM/8 AM. The slider then forces the customer to choose times again.
  - *Obstacle:* The card price changes after times are chosen, and the billed day count looks wrong for a 4-night trip.
  - *Change:*
    1. Add optional drop-off and return time selects to the search header, defaulting to the current behaviour, and carry them into the slider so the customer doesn't choose twice.
    2. Under the results count, show "Prices for 10:00 AM drop-off → 2:00 PM return. Change times".
    3. Next to "× 5 days", add a tooltip: "Lots bill in 24-hour blocks from drop-off".
  - *Acceptance:* Changing times in the header re-prices the cards, and the slider opens with those times preselected. The day-count explanation is visible next to every "× N days" line.

- **10. Use one price definition everywhere: hub, rates table, articles and search.**
  - *Evidence:* [LIVE D6] The EWR hub says "from $5.20/day" while the same lot's card says $7.46/day. Hubs use pre-tax, pre-fee `minPrice` (`rates-table.tsx:64`). Squad 10 found Four Points ATL at $10.01 in an article, $9.67 on the hub and $12.29 on search. The home-page savings calculator compares against $14/day, while live JFK's cheapest is $12.73 and the median is ~$25.83.
  - *Obstacle:* "Bait" feeling. The price rises at every click from a landing page.
  - *Change:*
    1. Hubs and the rates table show the all-in per-day figure, the same as search (`grandTotal + service fee) / days`), labelled "incl. taxes & fees".
    2. Recompute the calculator from live medians, or remove its specific numbers.
    3. Articles render prices from the same source, or say "from" with the all-in figure.
  - *Acceptance:* For a given airport and sample trip, the hub "from" price equals the cheapest search card per-day figure for the same dates (±$0.01). The calculator values are traceable to a dated data pull.

- **11. Replace hard-coded arrival instructions on the confirmation page and email with the lot's own.**
  - *Evidence:* [CODE] `whats-next.tsx:29-46` and `booking-confirmation.tsx:281,529` always say "Scan your QR code at the entrance gate". Per squad 4's count, 134 of 246 lots need a front-desk check-in. The fallback copy says "Board the complimentary shuttle" even for no-shuttle lots. The email QR is an external `api.qrserver.com` image, which disappears when images are blocked.
  - *Obstacle:* On arrival, the customer follows the wrong instructions at the gate or lobby. This is a post-purchase trust failure.
  - *Change:*
    1. Lead "What's next" with the lot's own arrival step: the first sentence of `shuttleInfo.details`, split into Arrival / Transfer / Return.
    2. Show the generic QR line only for lots known to use gate scanning.
    3. Render the QR inline (as a data URI or attachment) and always print the confirmation number as text beside it.
  - *Acceptance:* An EWR Red Carpet confirmation says "check in at the front desk" and does not mention a shuttle. With images blocked, the email still shows the confirmation number in text.

- **12. Give guests a one-step way to manage or cancel.**
  - *Evidence:* [CODE] /reservations sends guests straight to login (`reservations/page.tsx:55-56,69,97`), and the email has no manage or cancel link (`booking-confirmation.tsx:535-541`). Checkout copy: "booking as a guest? sign up later with this email". [LIVE] The FAQ says to sign in with the same email first.
  - *Obstacle:* A guest whose plans change has to create an account, confirm the email, attach the booking and then cancel. Under time pressure they email support instead and wait 24–48h.
  - *Change:*
    1. Add a "Manage booking" button to the confirmation page and email, using a signed link that opens the booking with Cancel available when more than 24h out.
    2. Add a guest lookup on /reservations (confirmation number + email).
  - *Acceptance:* A guest can cancel an eligible booking from the email in ≤2 clicks without creating an account. The lookup returns the booking for a correct number+email pair and a generic message otherwise.

- **13. Add a visible "plans changed / problem at the lot" path for inside-24h issues.**
  - *Evidence:* [LIVE] The FAQ says "There's no edit option yet" and support is email only, 24–48h on business days. The live /contact topics lack "Change my reservation" and "Problem at the lot". [CODE] `help/page.tsx:49-61,103,216`. The confirmation page does have a "Call Facility" button.
  - *Obstacle:* Delayed flights, wrong plates and late returns all happen inside 24h, when email support is too slow.
  - *Change:*
    1. On the confirmation page and email, add a "Something changed?" box with 3 rows: running late or extending (call the lot, number shown); wrong plate or vehicle (with a prefilled contact topic); cancel (#12).
    2. Add the missing contact topics plus a reservation-number field.
  - *Acceptance:* The confirmation page shows the lot's phone and those 3 actions above the fold on mobile. /contact has the new topics and the reservation-number field, and that field sets the urgent flag.

### P3: polish, data hygiene, accessibility completeness

- **14. Fix checkout form semantics.**
  - *Evidence:* [CODE] The checkout labels are not tied to their inputs (`customer-details-step.tsx:51,78,106,133`), and checkout uses no `autoComplete` attributes at all. Errors carry no `aria-invalid`, `aria-describedby` or `role=alert`, and the stepper has no `aria-current`.
  - *Change:*
    - Add `htmlFor`/`id` pairs.
    - Set `autoComplete`: given-name, family-name, email, tel.
    - Add `aria-invalid`, link each error with `aria-describedby`, and announce errors with `role=alert`.
    - Add `aria-current="step"` to the stepper.
  - *Acceptance:* iOS and Chrome autofill complete Step 1 in one tap. With VoiceOver, each field is announced by its label, and a blank email is announced as an error.

- **15. Filter out or flag bad ResLab lot data before it reaches customers.**
  - *Evidence:* [LIVE snapshot]
    - TPA "241 Car Services" is a cruise-port valet lot ("shuttle is only to the port") listed in TPA airport results.
    - Grand Hyatt TPA's return number has a 502 (Louisville) area code.
    - BWI Clarion appears twice (reslab-370/371, same slug and same $41.74 price).
    - PARK AC's overview says "0.5 miles" while its card says "2.5 mi".
    - The POE hub promises port shuttles, but most POE lots are FLL hotels; Fairfield "does not offer cruise parking" yet holds "Lowest total".
    - The hub template says "shuttles every 5–15 minutes" on every hub (`content.ts:68,119`).
  - *Change:*
    1. Dedupe by slug.
    2. Add a "port only" exclusion for airport searches.
    3. Run a weekly data-lint report (area-code vs airport, distance in text vs field, duplicate slugs) for ops.
    4. Replace the templated shuttle-frequency copy with the airport's real range.
  - *Acceptance:* BWI lists Clarion once. TPA 241 is absent from TPA airport results (or labelled "Cruise port only"). The lint report runs and lists today's known cases.

- **16. Long-stay window: allow the return to fall after day 100 if ResLab accepts it.** (Needs one proof first.)
  - *Evidence:* [CODE] Both picker legs and `validateSearchDates` cap at today+100 (`booking-window.ts:87-91`), while the stated ResLab wall applies to check-in. Unproven: that ResLab accepts a later checkout.
  - *Change:* Confirm with ResLab first. If it accepts, cap only check-in.
  - *Acceptance:* A 42-day trip starting on day 70 can be searched and priced.

- **17. Fix the date-picker "Invalid Date" path.** (Needs a repro first.)
  - *Evidence:* [CODE] The first click clears the return date in parent state (`date-picker.tsx:99-105`). The collapsed mobile bar then formats "" (`search-header.tsx:81`), and Update prices a defaulted range (`search/page.tsx:93-105`). Not reproduced live, because the browser pane timed out.
  - *Acceptance:* Picking only a check-in date and closing the picker shows "Select return" (not "Invalid Date") and keeps Update disabled.

- **18. Oversize vehicles and family rules.** (Needs one proof first.)
  - *Evidence:* [CODE] ResLab checkout always books one spot of `parkingTypes[0]` (`checkout/lot/route.ts:113-123,140`). Lot rules in `specialConditions` (70 lots) appear only on the lot page, never in the slider. Shuttle text holds 4-passenger caps, cash-only notes and garage clearance limits.
  - *Change:*
    1. Show `specialConditions` and any detected "Large vehicle / passenger cap / cash only" phrases as callouts in the slider.
    2. Check whether ResLab exposes Large Vehicle types for these lots before building a selector.
  - *Acceptance:* MIA Premier's slider shows "Cash only at lot" and "Max 4 passengers per shuttle" callouts.

- **19. Small fixes.**
  - **Calendar links:** Google and Outlook links are all-day events, and Google drops the return day. Use timed events (`add-to-calendar.tsx:59-88`). *Acceptance:* the Google event spans drop-off → return at the correct local times.
  - **/reservations:** an in-progress trip shows under "Past". Split on `check_out` (`reservations/page.tsx:144-152`). *Acceptance:* a trip that started yesterday appears under Upcoming/Active.
  - **Sort:** changing sort re-fetches with a full spinner. Sort client-side (`search/page.tsx:165-170`). *Acceptance:* switching sort makes no new /api/search request.
  - **Mobile map card:** add the pay-at-lot, min-days and shuttle chips. *Acceptance:* the map card shows the same chips as the list card.
  - **Blog CTA:** carry dates (or prompt for them). Compute "today" in the airport's timezone, not UTC (`search/page.tsx:43-51`). *Acceptance:* an article CTA clicked at 9 PM ET opens search starting today ET.
  - **Receipt:** add an itemised receipt link (PDF or print view) with a tax line and an optional company name. *Acceptance:* the confirmation page has "Download receipt".
  - **Accessibility filter:** add a "Wheelchair accessible" filter chip (85 lots carry the amenity). *Acceptance:* the filter narrows results to lots with `wheelchair_access`.
  - **Trust numbers:** substantiate or remove "4.9 Rating", "5,000+ travelers" and "100+ Verified Parking Partners" (hard-coded in `hero.tsx:237`, `newsletter.tsx:159`, `footer.tsx:67`). *Acceptance:* each number has a source, or it is removed.
  - **Cookie banner:** add a "Decline non-essential" button. This is a legal call for Vin and Tom (`cookie-banner.tsx:29-35`).

---

## 2. What is not a UI problem (don't fix in code)

- **Inventory:**
  - 15 of 85 airports have no lots.
  - Lot minimum stays (53 lots), shuttle hours, pay-at-location lots (21) and passenger caps are lot policy. Only *showing* them is UI (#1, #2, #3, #7).
- **Commercial decisions:**
  - The $5.95 service-fee floor (`service-fee.ts`, max($5.95, 6%)) is 27% of a $22.37 stay [LIVE D5], and it is charged on the full base, including the part paid at the lot.
  - ResLab's 24-hour-block billing.
  - The 100-day check-in wall.
- **ResLab data:**
  - No reviews or ratings on any of the 246 lots.
  - "Valet" tags on self-park lots.
  - Text truncation (TPA 241's "…886-158").
- **Parked as preference:**
  - Spanish/i18n.
  - Saved vehicles and "book again".
  - An express wallet button at the top of checkout (Stripe already offers wallets on step 3).
  - Drive time instead of miles.
  - Live chat or a phone line (policy, covered under #13).

## 3. Confirmed non-issues (checked, works)

- UI totals reconcile exactly: API grandTotal + service fee = card = slider = checkout.
- "Lowest Total" sort and badge agree.
- Park Guard is not pre-selected.
- The service fee is refunded on cancel.
- The 24h cancel gate is enforced server-side in the lot's timezone.
- The cancel dialog shows the computed refund.
- Same-day slot filtering uses the airport timezone and honours `hoursBeforeReservation`.
- A return before pickup is blocked.
- 42-day stays price correctly across the year boundary.
- Stripe uses manual capture (authorise, then capture after ResLab confirms), so no double charge.
- Lot cards are real `<button>`s, and the viewport allows zoom.
- No horizontal overflow at 375px.
- Lot phone numbers are present for all 246 lots.
- All article lot links resolve.

## 4. Method and limits

- **Coverage verified first:** live `/api/search` for all 85 marketed airports (Nov 20–24, tagged `surface=featured` to stay out of customer analytics): **70 airports with ≥1 lot, 246 lots; 15 with zero.**
- **Breadth:** 10 squads ran as **10 independent Sonnet sub-agents** in two bounded waves (≤5 concurrent). Each wrote 10 scenarios (**100 scenarios from 10 agents**, not 100 agents) without seeing the other squads' output. The squads used the snapshot, `upstream/main` code, and ≤15 public page GETs / ≤3 tagged API calls each. No squad used the browser.
- **Depth:** the orchestrator reproduced the highest-risk journeys in the built-in browser on mobile (375×812) and desktop (Appendix B). The pane was hidden during the session, so screenshots weren't possible; evidence is DOM text, attributes and computed styles.
- **Adversarial review:** one independent reviewer re-checked every Medium+ claim on `upstream/main` and re-ran all counts. It refuted or corrected 11 claims and found one new defect, the "24/7 Access" chip (Appendix C).
- **Restrictions kept:** no bookings, no payments, no form submission, no personal data entered, no sign-in, no code changes, nothing pushed. Checkout steps 2–3 were read from code only; a test-mode order on a staging host is needed to exercise them.
- **Not reproduced live:** the lot-page min-stay banner (code-verified), the "Invalid Date" path (#17), the cookie banner overlapping the sticky footer, the iOS zoom-on-focus behaviour, and real screen-reader runs.

---

# Appendix A — Full scenario coverage (100 scenarios, 10 squads)

Squad themes: 1 Rushed mobile · 2 Price-sensitive · 3 Families · 4 First-time off-airport · 5 Business · 6 Skeptical/trust · 7 Early/late/long trips · 8 Changed plans · 9 Accessibility · 10 Search/blog/airport-page entry. Raw squad output, unedited; superseded where Appendix C refutes a claim.

---

## Squad 1

### Squad 1 — Rushed mobile travelers (simulated reactions, not real customer data)

Method: code read on `upstream/main` (file:line), coverage snapshot, 3 live GETs (search shell, SLC hub). No browser, no search API calls, nothing submitted. Today = Fri 2026-11-06.

Confirmed non-issues (checked, work as intended):
- Same-day logic is solid: `bookableCheckinTimes` hides slots < now+30 min (or lot notice) in the airport's timezone, `resolvePricingTimes` prices same-day at the earliest open slot, API returns `same_day_too_late` / `closedForToday` with plain-English copy. [CODE] `src/lib/utils/time.ts:112-182,204-255`; `search/page.tsx:126-147`
- Date window: pickers capped at 100 days, `validateSearchDates` gates submit. [CODE] `src/lib/booking-window.ts:11,68-93`
- Viewport allows pinch zoom (`maximum-scale=5`). [TESTED-LIVE] search + SLC hub HTML
- `type="email"` / `type="tel"` give the right phone keyboards. [CODE] `customer-details-step.tsx:115,142`
- Mapbox is NOT mounted on phones in list view. [CODE] `search/page.tsx:78-82,362-371`
- Apple Pay / Google Pay come through Stripe `PaymentElement` (layout "tabs"), and the submit order was fixed so Safari can open the wallet sheet. Availability depends on Stripe-side domain verification, which code can't show. [CODE] `stripe-payment-form.tsx:193-217,413-420`
- Page weight: search route HTML is small (23 KB raw / ~5 KB gz, 27 script refs). Total JS transfer NOT measured (asset fetch returned 0 bytes). [TESTED-LIVE partial]

---

### 1.1 Same-day tonight, iPhone SE, JFK
- Profile: iPhone SE 375px, Safari; JFK; check-in TODAY (Fri 11-06) ~evening, out Mon 11-09 (3 nights); solo, sedan; leaving in ~2 h; wants a lot with a shuttle now; objection: "I'm fumbling with tiny dropdowns while driving to the airport".
- Goal: pick a lot and reach checkout in under 3 minutes.
- Entry point: `https://www.triplypro.com/search?airport=JFK&checkin=2026-11-06&checkout=2026-11-09`
- Attempted journey: results load (priced at earliest open slot) -> tap "View Details" on a card -> slider opens with check-in/out time selects showing "Select" -> tap check-in select -> pick time -> tap check-out select (48 half-hour options, all of them) -> Reserve Now.
- Friction:
  - Both time `<select>`s are `text-xs` (12px), `py-1` (~24px tall), `w-28`: iOS Safari auto-zooms the page on focus for <16px controls; target is far under the 44px guideline. Page then sits zoomed with the sticky footer shifted.
  - Selects have no `<label for>` / `aria-label` (the "Check-in" label is a bare `<label>` with no association).
  - Times must be re-picked in the slider even though the search never asked for them (one extra decision per booking, by design).
  - Check-out list is unfiltered: nothing stops picking a check-out time before the check-in time on a same-day stay; only the live price/Reserve gate would react.
- Likely abandonment point: the zoomed, tiny time selects in the slider (before Reserve).
- Evidence: [CODE] `product-detail-slider.tsx:348-364,391-407` (text-xs, py-1, w-28, no label/aria); [CODE] `:329,372` (label has no htmlFor); [CODE] `:404` (checkout options = all `timeOptions`, no min vs check-in); [CODE] `time.ts:148-162` (same-day filter works); [INFERRED] iOS zoom-on-focus <16px; [TESTED-LIVE] walkthrough: select had no accessible label, default "Select".
- Severity: Medium
- Type: UX gap
- Proposed improvement: time fields become 16px, >=44px tall native selects (or a bottom-sheet list of times), each with `aria-label` ("Check-in time"); check-out options filtered to > check-in when dates are equal. Acceptance: on iPhone SE Safari, focusing a time field does not change page zoom and the tap target >=44px; same-day check-out options all later than the chosen check-in.
- Needs browser repro?: yes (mobile, iPhone 375px emulation + real iOS Safari if possible): focus the time select and compare `visualViewport.scale` before/after; measure select height.

### 1.2 Next-morning 5 AM flight, LGA, 4 AM check-in
- Profile: iPhone 15, Safari; LGA; check-in Sat 11-07 4:00 AM, out Mon 11-09 9:00 PM (2 nights); flight 6:10 AM; wants the cheapest lot that actually runs a shuttle at 4 AM; objection: "I don't want to stand at a gate with no shuttle".
- Goal: find a lot whose shuttle runs at 4 AM.
- Entry point: `https://www.triplypro.com/new-york-lga/airport-parking`
- Attempted journey: hub search -> results -> sorts "Lowest Total" -> opens top card (Queens Crossing LAZ, "Lowest total" badge) -> slider -> selects 4:00 AM check-in -> Reserve.
- Friction:
  - The "Lowest total" lot has shuttle 6:30 AM-10:30 PM (every hour); Hyatt Place Flushing 7 AM-10 PM; Hearthstone "No Shuttle". Only 4 of 8 LGA lots advertise 24/7 service.
  - Slider accepts a 4:00 AM check-in with no warning that the shuttle is off at that hour; shuttle text sits far below the fold (after photos, times, overview, amenities).
  - The card itself shows only a generic amenity tag, not the shuttle hours.
- Likely abandonment point: either leaves after reading shuttle hours deep in the slider, or books and finds no shuttle at 4 AM (worse).
- Evidence: [TESTED-LIVE snapshot] LGA: Queens Crossing `badges=['lowest_total']`, shuttle "6:30 AM - 10:30 PM ... No shuttle" 10:30 PM-6:30 AM; Hyatt Place Flushing "7 AM - 10 PM"; Hearthstone "No Shuttle"; [CODE] `product-detail-slider.tsx:462-473` (shuttle block placed after Overview/Amenities), `:38-47,361,404` (all 48 slots always offered, no shuttle-hours check); [TESTED-LIVE walkthrough] ATL Four Points 5 AM-12 AM shuttle accepted 5:00 AM / 11:30 PM with no warning.
- Severity: High
- Type: UX gap
- Proposed improvement: parse shuttle hours (data already in `shuttleInfo`); when the chosen time falls in a "No shuttle" window, show an amber inline warning under the time select ("No shuttle at 4:00 AM — runs 6:30 AM-10:30 PM") and add a one-line shuttle-hours chip on cards. Acceptance: for LGA Queens Crossing + 4:00 AM, a visible warning appears before Reserve; every card shows shuttle hours or "24/7".
- Needs browser repro?: yes (mobile): in the slider pick 4:00 AM on a lot with a 6:30 AM shuttle and confirm no warning appears and Reserve enables.

### 1.3 One-night business trip, ORD, Android on slow 4G
- Profile: Android Chrome, mid-range phone, throttled 4G; ORD; check-in Mon 11-09 6:00 AM, out Tue 11-10 8:00 PM (1 night); solo, SUV; wants cheapest and reliable; objection: "page is slow and every lot I tap won't let me book".
- Goal: reserve the cheapest suitable lot for one night.
- Entry point: `https://www.triplypro.com/search?airport=ORD&checkin=2026-11-09&checkout=2026-11-10`
- Attempted journey: results (6 lots) -> taps Crowne Plaza (limited) -> slider -> picks times -> Reserve Now stays grey -> taps Pride, then Marriott Suites: same.
- Friction:
  - Crowne Plaza, Pride and Marriott Suites have a 3-day minimum (`minDays=3`); for a 1-night stay 3 of 6 ORD lots can never be reserved, yet cards list them with a total price.
  - In the slider (the main mobile path) the reason ("Minimum 3 days required") is only the button's `title` attribute — not visible on touch. The lot-page widget shows a red banner; the slider doesn't.
  - Cheapest card (Super 8, "Most booked" + "Lowest total") has no shuttle at all (guests arrange own transport) — not visible on the card.
  - Slow-4G: search is a client-side fetch after hydration; spinner "Searching for parking..." only, no skeleton or timeout copy.
- Likely abandonment point: after the second/third greyed "Reserve Now" with no visible reason.
- Evidence: [TESTED-LIVE snapshot] ORD: Crowne Plaza minDays=3, Pride minDays=3, Marriott Suites minDays=3; Super 8 shuttle "No shuttle, guests must arrange their own airport transportation", badges most_booked + lowest_total; [CODE] `product-detail-slider.tsx:158-168,537` (`title={reserveDisabledReason}` only), `:419-424` (visible message covers times only); [CODE] `booking-widget.tsx:353-360` (lot page DOES show min-days banner); [CODE] `search/page.tsx:258-264` (spinner only); [CODE] `lot-card.tsx` has no min-days text (grep: none).
- Severity: High
- Type: Defect (disabled CTA with invisible reason) / UX gap
- Proposed improvement: render `reserveDisabledReason` as visible text above the sticky footer (and as `aria-describedby`); on search, either hide/mark lots whose `minimumBookingDays` > searched days ("3-day minimum") on the card. Acceptance: for ORD 1-night, each of the 3 lots shows "3-day minimum" on the card and, if opened, a visible red line in the slider; no greyed Reserve without visible text.
- Needs browser repro?: yes (mobile): open Crowne Plaza in the slider on a 1-night search, pick both times, confirm Reserve is disabled and that no visible text explains why.

### 1.4 Three-week trip, DEN, picking dates one-handed
- Profile: Android Chrome (Pixel-class, 412px); DEN; Sat 11-21 -> Sat 12-12 (21 nights); couple, Subaru; planning on the couch; objection: "I tapped dates, closed the calendar, and the results don't match".
- Goal: price a 3-week stay and compare lots 5-9 miles out.
- Entry point: `https://www.triplypro.com/search?airport=DEN&checkin=2026-11-20&checkout=2026-11-24` (then change dates in the header)
- Attempted journey: collapsed header bar -> tap to expand -> tap "Parking check-in" -> calendar -> taps 21 Nov (first tap clears return to "") -> accidentally taps outside / scrolls away -> collapsed bar shows the range -> "Update Search".
- Friction:
  - The picker's first tap sets check-in AND clears the return (`onEndChange("")`) before a return is chosen; closing the popover now leaves return empty.
  - Collapsed summary formats `returnDate` via `new Date("" + "T00:00:00")` -> expected to render "Invalid Date" in the bar.
  - With an empty return, `fetchResults` skips date validation and the API prices a "defaulted range" — the customer gets results for dates they did not choose, with no message.
  - Mobile header is collapsed by default (one extra tap before any edit); date range is cleared on each reopen if only the start is clicked.
  - DEN lots are 5-9 mi out (hotel lots); card shows miles only, no drive time.
- Likely abandonment point: confusion at mismatched dates/"Invalid Date", or silently booking a wrong-length stay.
- Evidence: [CODE] `date-picker.tsx:99-105` (first click clears return), `:121`; [CODE] `search-header.tsx:37-40,81` (formatShortDate with ""), [CODE] `search/page.tsx:97-105` (validation skipped when return empty; comment says API prices defaulted range); [TESTED-LIVE snapshot] DEN distances 5.0-8.8 mi.
- Severity: Medium
- Type: Defect (suspected)
- Proposed improvement: do not commit the start date to parent state until the return is chosen (or keep previous return until replaced); block "Update Search" with an inline "Pick a return date" when return is empty; never render "Invalid Date". Acceptance: after tapping only check-in and dismissing, header shows the previous valid range or a "Select return" prompt, and Update Search is disabled/explains.
- Needs browser repro?: yes (mobile 412px): tap check-in only, dismiss the popover, read the collapsed bar text, tap Update Search and note which dates the results are for (URL + API request).

### 1.5 In the car, MCO, three-step checkout with a thumb
- Profile: iPhone 15, Safari, Face ID/autofill set up; MCO; Fri 11-20 10:00 AM -> Tue 11-24 2:00 PM; family of 4, minivan; has already chosen Gold Park; needs to finish in the 10 minutes before the kids are back; objection: "typing on a phone, I just want to pay with Apple Pay".
- Goal: book with minimal typing.
- Entry point: `https://www.triplypro.com/checkout?lot=<id>&checkin=2026-11-20&checkout=2026-11-24&checkinTime=10%3A00+AM&checkoutTime=2%3A00+PM` (reached from search slider "Reserve Now")
- Attempted journey: Step 1 First/Last/Email/Phone -> Continue -> Step 2 Make/Model/Color/Plate/State -> Continue -> Step 3 protection choice (required), terms checkbox, Payment Element (Apple Pay tab) -> Complete.
- Friction:
  - No `autocomplete` (given-name, family-name, email, tel) and no `inputMode`/`autocapitalize`/`autocorrect` on any checkout field: iOS contact-card autofill is hit-or-miss; Make/Model/Plate are autocorrected/auto-capitalized by the keyboard.
  - Labels are not bound to inputs (no `htmlFor`/`id`) — tapping a label doesn't focus the field; screen-reader users get unnamed fields (extra-fields DO have ids).
  - 11 required inputs across two typed steps before the wallet is even visible; no Express Checkout (Apple Pay button) at top. Pay is gated by a required protection pick ("Select a protection option above") and the terms checkbox.
  - On a phone the form comes FIRST and the order summary / promo field / price sit below it (single column), so the total isn't visible until the payment button on step 3.
  - State is a 63-option native select (fine on iOS wheel).
- Likely abandonment point: step 2 (vehicle typing) or the protection gate on step 3.
- Evidence: [CODE] repo-wide grep: no `autoComplete`/`inputMode` in `src/components/checkout/*` (only confirmation, contact, partners, waitlist, blog forms have them); `customer-details-step.tsx:51-159` and `vehicle-details-step.tsx:102-250` (labels without htmlFor); [CODE] `checkout-form.tsx:1249-1251,1385` (`grid-cols-1 lg:grid-cols-3`, summary in second column) ; [CODE] `stripe-payment-form.tsx:413-420,495-527` (PaymentElement only, Pay gated); [TESTED-LIVE walkthrough] 3 steps, all four step-1 fields required; footer lists Apple Pay.
- Severity: Medium
- Type: UX gap
- Proposed improvement: add `autoComplete` (given-name/family-name/email/tel), `autoCapitalize="characters"` + `autoCorrect="off"` on plate, `autoCorrect="off"` on make/model, `htmlFor`/`id` pairs on every label; add a compact price/total bar on mobile above the form. Acceptance: iOS Safari offers Contact autofill on step 1 and one tap fills all four fields; label tap focuses its field; mobile shows total price without scrolling.
- Needs browser repro?: yes (mobile, iOS Safari): check autofill chip appears on step 1, plate keyboard capitalization, and where the price appears on a 375px screen.

### 1.6 Late-night return, SEA, red-eye lands 11:50 PM
- Profile: iPhone 15, Safari; SEA; check-in Wed 11-18 5:30 AM, out Sun 11-22 (lands 11:50 PM); solo; objection: "the latest checkout time they offer is before my flight even lands".
- Goal: choose a check-out time that matches the landing.
- Entry point: `https://www.triplypro.com/seattle-sea/airport-parking`
- Attempted journey: search 11-18 -> 11-22 -> opens Evods Parking (24/7 shuttle) -> slider check-out time select: scrolls the list to the bottom (11:30 PM is last) -> considers 11:30 PM or changing check-out date to 11-23 at 12:00 AM.
- Friction:
  - Time list ends at 11:30 PM; a pick-up at 11:50 PM+ has no honest option: choose 11:30 PM (customer will be "late") or move the date to next day (likely billed an extra day).
  - No explanation of how late return/grace is handled; the generic FAQ says only "you may be charged".
  - Motel 6 SEA (lowest total, "limited") shuttle is hourly 7 AM-10 PM — a late return cannot use it; not visible on the card.
- Likely abandonment point: check-out time select (hesitation), possibly pick 11:30 PM and get late-fee surprise.
- Evidence: [CODE] `product-detail-slider.tsx:38-47` (last slot 11:30 PM); [TESTED-LIVE walkthrough] "Fri 10AM->Tue 2PM billed 5 days" (day-count billing); [TESTED-LIVE snapshot] SEA Motel 6 "7am to 10pm once an hour", badges lowest_total, avail=limited; [CODE] `help/page.tsx:128-130` (late-return answer is vague); [INFERRED] a 12:00 AM next-date check-out adds a billed day.
- Severity: Medium
- Type: UX gap / Copy-trust
- Proposed improvement: add a line under the check-out select ("Landing after 11:30 PM? Choose 11:30 PM — the lot's late-return rule: ...", or offer 11:59 PM) and show the price change when picking the next day. Acceptance: after picking 11:30 PM, a visible note explains late returns; picking 12:00 AM next day shows the added day in the price breakdown before Reserve.
- Needs browser repro?: yes (mobile): in the slider compare the price/billed days for 11:30 PM vs next-date 12:00 AM; read whether any late-return copy appears.

### 1.7 Train commuter on a flaky connection, BOS, map carousel
- Profile: Android Chrome on a moving train, intermittent 4G; BOS; Sat 11-21 8:00 AM -> Tue 11-24 8:00 PM; couple, small car; objection: "every time I change the sort the list reloads and I lose my place".
- Goal: compare lots on the map card carousel and pick one.
- Entry point: `https://www.triplypro.com/search?airport=BOS&checkin=2026-11-21&checkout=2026-11-24`
- Attempted journey: list loads -> taps floating "Map" -> swipes carousel (88vw cards) -> taps "Book Now" on Ramada Boston -> slider.
- Friction:
  - Map card shows price + 3 amenities only: no "Pay at Location", no "limited" availability, no minimum days. Ramada Boston `minDays=5` (a 4-night trip fails) is invisible on the card; list card does show Pay at Location.
  - Changing the sort select re-runs the full live search (`sortBy` effect -> `fetchResults()`), replaces the list with the full-screen spinner, even though results are also sorted client-side; on poor signal each sort change is a multi-second wait or the "couldn't load" panel.
  - The sort select is `text-xs` (iOS zoom on focus).
  - Page root is `h-screen` (100vh): on mobile browsers with a collapsing toolbar the bottom of the list/carousel can sit under the URL bar; the floating Map/List pill covers content at `bottom-6`.
  - Cheapest card (Broadway Motor Service, lowest total) has no shuttle.
- Likely abandonment point: spinner/error after a sort change on bad signal, or booking Ramada then hitting the 5-day minimum.
- Evidence: [CODE] `mobile-map-card.tsx:40-125` (no due-at-lot / limited / min-days), `lot-card.tsx:136,177-180` (list card has limited + Pay at Location); [CODE] `search/page.tsx:165-170,173-197` (sort -> refetch AND client sort), `:227,376-393` (`h-screen`, fixed pill); [CODE] `search-results-list.tsx:61-64` (text-xs sort select); [TESTED-LIVE snapshot] BOS Ramada minDays=5; Broadway "No shuttle"; [INFERRED] `100vh` toolbar overlap on iOS/Android.
- Severity: Medium
- Type: UX gap / Defect (sort refetch)
- Proposed improvement: drop the refetch on sort (client sort only; keep server sort for API param if needed); add Pay-at-Location, availability and min-night chips to MobileMapCard; use `h-dvh`. Acceptance: changing sort causes no network request and no spinner; map card shows the same chips as list card; last list item fully visible on iOS Safari with toolbar shown.
- Needs browser repro?: yes (mobile 375 + 412): toggle sort and watch network requests; open map view and compare card chips; scroll to list bottom on iOS Safari.

### 1.8 Booking tonight for a 6 AM flight, LAS, relies on "Free Cancellation"
- Profile: iPhone 15, Safari; LAS; check-in Sat 11-07 6:00 AM (<24 h away), out Mon 11-09; solo, sedan; objection: "my plans might change — it says Free Cancellation".
- Goal: book only if she can still cancel.
- Entry point: `https://www.triplypro.com/las-vegas-las/airport-parking`
- Attempted journey: hub hero reads "Free Cancellation / Instant Confirmation" -> search -> slider shows green check "Free Cancellation" -> Reserve -> checkout step 1: the free-cancellation line is gone -> she wonders why.
- Friction:
  - Hub hero and slider show "Free Cancellation" unconditionally; the real rule is cancel online only >24 h before check-in, and checkout deliberately hides the line when check-in is <2 calendar days out. So for tonight/tomorrow bookings the promise is shown at search and silently dropped at checkout.
  - Help/FAQ: "Cancellations within 24 hours of check-in can't be done online"; support is email-only (24-48 h).
  - Also a lot with `cancel=null` (JFK The Parking Point) still gets the same unconditional "Free Cancellation" label.
  - LAS: Fairfield Inn (lowest total) is "NO SHUTTLE"; Best Western shuttle has gaps (1:00-4:30 PM none) — rushed buyer won't see this on the card.
- Likely abandonment point: checkout step 1 when the cancellation reassurance disappears (or a later complaint if booked).
- Evidence: [CODE] `product-detail-slider.tsx:310-312` (hard-coded), `hero-section.tsx:34`, `customer-details-step.tsx:12-18,171` + `checkout-form.tsx:101` (hidden when lead <2 days); [CODE] `help/page.tsx:56,103,216` (24 h rule, email-only support); [TESTED-LIVE walkthrough] FAQ copy; [TESTED-LIVE snapshot] JFK The Parking Point `cancel=null`; LAS Fairfield "NO SHUTTLE", Best Western shuttle gaps.
- Severity: High
- Type: Copy-trust
- Proposed improvement: make the slider/hub label conditional: "Free cancellation until 24 h before check-in" when lead >=2 days, and "Non-refundable within 24 h of check-in" (amber) when check-in is today/tomorrow; same text in the checkout step instead of dropping the line. Acceptance: for a check-in tomorrow, slider shows the 24 h notice, and checkout step 1 shows a visible cancellation note (not absent).
- Needs browser repro?: yes (mobile): set check-in to tomorrow, compare slider label vs checkout step 1 trust list vs order summary.

### 1.9 Zero-inventory airport, SLC, from a Google result
- Profile: iPhone 15, Safari; SLC; check-in Fri 11-20 10:00 AM, out Tue 11-24; solo; arrives from an organic search for "Salt Lake City airport parking"; objection: "I just want to see something I can book".
- Goal: find any bookable lot (or a clear alternative).
- Entry point: `https://www.triplypro.com/salt-lake-city-slc/airport-parking`
- Attempted journey: hub hero ("Free Cancellation, Trusted Lots, Instant Confirmation") -> search with dates -> `/search?airport=SLC&...` -> "No parking lots found for your search criteria." -> scrolls to "Other Airport Parking" and taps ABQ (also 0 lots).
- Friction:
  - Hub already states "No Online Availability for the Next Week" while the hero promises instant confirmation; the user is still invited to search.
  - Results page for a zero-lot airport is a bare line of grey text: no waitlist, no nearby airport, no "why".
  - "Other Airport Parking" on the SLC hub links ABQ, GEG and IDA — all three also return 0 lots. (Also lists DEN, BOS, JFK, ORD which do.)
  - The waitlist prompt exists only behind a "Traveling further out?" link in the hub search widget (framed around far-future dates), not on the dead-end search page.
  - /airport-parking lists all 85 airports equally (15 have none).
- Likely abandonment point: the empty results page (immediate bounce, likely to a competitor).
- Evidence: [TESTED-LIVE] SLC hub HTML (title, hero trust badges, "No Online Availability for the Next Week", "Other Airport Parking" = ABQ, BUR, DEN, FAT, GEG, IDA, ATL, BOS, DFW, JFK, MIA, ORD); [TESTED-LIVE snapshot] SLC, ABQ, GEG, IDA = 0 lots (SLC "considered 2"); [CODE] `search-results-list.tsx:106-109` (empty state), `search-widget.tsx:139-148` (waitlist only via hub link); [TESTED-LIVE walkthrough] /airport-parking lists all 85.
- Severity: High
- Type: Inventory-pricing limitation + UX gap
- Proposed improvement: for 0-lot airports show a real empty state with (a) email waitlist inline, (b) nearest airports that HAVE inventory for the same dates, and drop zero-lot airports from "Other Airport Parking". Acceptance: SLC search with 0 results renders the waitlist form + >=1 working alternative; no "Other airports" tile leads to a 0-lot airport.
- Needs browser repro?: yes (mobile): load `/search?airport=SLC&checkin=2026-11-20&checkout=2026-11-24` and confirm the empty state; click each "Other Airport" tile and note which are empty.

### 1.10 Flight cancelled, ATL, needs to cancel or change from the gate
- Profile: Android Chrome, in a terminal, 20 % battery; ATL; booked as a GUEST last week via the blog widget, check-in tomorrow 9:00 AM (<24 h); airline cancelled the trip; wants to cancel/change now; objection: "I can't find a way to cancel without an account, and there's no phone number".
- Goal: cancel or move the reservation tonight.
- Entry point: `https://www.triplypro.com/reservations` (via confirmation email / FAQ)
- Attempted journey: Reservations -> redirected to `/auth/login?redirect=/reservations` -> no account (booked as guest) -> sign-up with same email -> claims booking -> cancel button.
- Friction:
  - Cancel/change requires sign-in (account created after the fact); redirect to login happens before any lookup by confirmation number.
  - Within 24 h of check-in the online cancel is unavailable by policy (help FAQ); only path is support email with 24-48 h reply, or calling the lot.
  - No edit option at all ("cancel + rebook").
  - Rushed mobile user must create a password/verify email on a phone to learn they can't cancel.
- Likely abandonment point: login wall, then the "contact support" dead end.
- Evidence: [CODE] `reservations/page.tsx:55-56,69,97` (redirect to login); [CODE] `help/page.tsx:51,56,61,103,216` (no edit; <24 h not online; email-only 24-48 h; guest must sign in with same email); [TESTED-LIVE walkthrough] home FAQ same copy; [INFERRED] mobile friction of signup/verification.
- Severity: Medium
- Type: UX gap / policy
- Proposed improvement: add guest lookup (confirmation number + email, magic link) on the reservations page and, for <24 h, show the lot's phone number and a "contact the lot" button directly on the same screen. Acceptance: guest can open a booking with confirmation # + email without a password; <24 h bookings show the lot phone number in one tap.
- Needs browser repro?: yes (mobile): open `/reservations` logged out and note the redirect and any lookup option.

---

## Squad top findings
1. Disabled "Reserve Now" in the search slider explains min-night / sold-out reasons only in a `title` tooltip (invisible on touch); ORD 1-night has 3 of 6 lots unreservable and un-flagged on cards. [CODE] `product-detail-slider.tsx:158-168,537` + [TESTED-LIVE snapshot] ORD minDays=3
2. "Free Cancellation" is shown unconditionally (slider, hub hero) but cancel is online only >24 h out; checkout silently drops the line for next-day bookings — worst for same/next-day travelers. [CODE] `product-detail-slider.tsx:310-312`, `checkout-form.tsx:101`, `help/page.tsx:56`
3. Zero-inventory airports are dead ends: bare "No parking lots found" and the SLC hub's "Other Airports" include ABQ/GEG/IDA (also 0 lots). [TESTED-LIVE] SLC hub + snapshot; [CODE] `search-results-list.tsx:106-109`
4. "Lowest total" and other badges steer early/late travelers to lots with no shuttle at their hour (LGA Queens Crossing 6:30 AM-10:30 PM; ORD Super 8 none); slider takes any time with no warning. [TESTED-LIVE snapshot] + [CODE] `product-detail-slider.tsx:38-47,462-473`
5. Checkout has zero `autoComplete`/`inputMode`/autocorrect attributes, unbound labels, no express wallet before 2 typed steps, and the price is below the form on phones. [CODE] repo grep + `customer-details-step.tsx`, `vehicle-details-step.tsx`, `checkout-form.tsx:1249-1385`
6. Sort change refetches the live search (spinner) on mobile despite client sort; time/sort selects are 12px (iOS zoom) and map cards omit Pay-at-Location/limited/min-days. [CODE] `search/page.tsx:165-170`, `search-results-list.tsx:64`, `mobile-map-card.tsx`

---

## Squad 2

### Squad 2 — Price-sensitive customers comparing total trip cost

Simulated reactions grounded in evidence; no conversion/revenue numbers invented. Read-only: 3 `surface=featured` API calls (A/B/C below), 4 page GETs (PHL hub, EWR hub, Apex lot page, one 404), no browser pane.

Live API calls used (all `&surface=featured`):
- A = EWR 2026-12-18 → 12-22, times 8:00 AM / 8:00 AM (4 billed days)
- B = EWR same dates, NO times (server default 10:00 AM → 2:00 PM, 5 billed days)
- C = EWR 2026-12-05 → 12-21, no times (17 billed days)
Customer total below = API `grandTotal` + service fee = grandTotal + max($5.95, 6% of (subtotal+feesTotal)) `src/lib/utils/service-fee.ts:35-57`.

Why UI totals exceed API grandTotal (answered once, referenced below): `grand_total` from ResLab = parking + ResLab fees + tax. Triply then adds its own service fee, floor $5.95 [CODE service-fee.ts:28, 35-38; customerTotalFromPricing :48-57]. Card/slider/checkout all show grandTotal + serviceFee (+ optional Park Guard − promo) [CODE lot-card.tsx:111, price-view.ts:67, checkout-form.tsx:327]. It is not rounding days; day count is ResLab's `number_of_days`. Reconciles exactly for every lot I recomputed (ATL Four Points 55.48+5.95=61.43; Sky Lot 57.75+5.95=63.70) [TESTED-LIVE snapshot + CODE]. Not a defect, but the flat fee is 18–21% of the total on the cheapest lots (5.95/33.33; 5.95/28.45 DFW Clarion) [TESTED-LIVE snapshot].

---

### 2.1 "Same-time-back" 4-night EWR flyer (hidden default times)
- Profile: iPhone 14, 390px, Safari. EWR. Fri 18 Dec 2026 early flight, back Tue 22 Dec. Wants to land at 8 AM and be out of the lot by ~8 AM on return day = 4 nights. Solo, sedan. Budget-driven; compares against EWR P6 economy.
- Goal: Pay for 4 days, not 5.
- Entry point: `https://www.triplypro.com/search?airport=EWR&checkin=2026-12-18&checkout=2026-12-22`
- Attempted journey: search -> sees Red Carpet Inn "Lowest total" at $33.33 ($6.67/day) -> reads it as 4 nights x ~$8 -> taps View Details -> slider asks for times -> picks 8:00 AM in / 8:00 AM out -> total changes.
- Friction:
  - Search has no time fields, but the server prices every card at a hidden 10:00 AM -> 2:00 PM, so a "4-night" trip is billed 5 days on every card. API B (default) Red Carpet Inn $33.33 (5 days) vs API A (8 AM/8 AM) $27.85 (4 days): -$5.48. Apex $59.14 -> $48.50 (-$10.64). Renaissance $83.71 -> $70.22 [TESTED-LIVE live-A/live-B].
  - Nothing on the card or header says "priced for 10:00 AM–2:00 PM" [CODE search/page.tsx:402-403 passes empty times; resolvePricingTimes defaults time.ts:120-121, 204-251].
  - In the slider, picking only the check-in time makes the total vanish ("Select your times to see your total") until the check-out time is also chosen, then a 400 ms debounced quote loads [CODE use-live-price.ts:62-68, 138; shown-price.ts:16-17]. Price disappearing mid-interaction reads as broken.
  - Selecting times lowers the price, which helps this user, but the reverse also happens: a 2 PM-return user who picks 11:30 PM pays the same 5 days as the card; a 10 AM-in/11 AM-out user is silently billed an extra day. Customer cannot tell why via the card.
  - Day-count rule (partial 24 h block = full day) is not explained anywhere I found on the card, slider or checkout; checkout shows only "Duration 5 days" [CODE order-summary.tsx:130-133].
- Likely abandonment point: Not abandonment — a trust hit. The card price ($33.33) the user shortlisted is not the price they will pay, and they only learn it after opening the slider and picking both times. A user who compares across tabs (SpotHero) with exact times sees Triply's card as ~20% too high and may bounce before View Details.
- Evidence: [TESTED-LIVE] A/B numbers; [CODE] default times, empty header times, needs_times state; [INFERRED] users won't discover the slider re-price.
- Severity: High
- Type: UX gap (copy-trust)
- Proposed improvement: Add check-in/check-out time selects to the search header (default them visibly to 10:00 AM / 2:00 PM) or show "Priced for 10 AM–2 PM · billed in 24-hour days" under the sort bar; keep the previous total visible (greyed, "Updating…") while one time is picked. Acceptance: for the same dates, card total equals slider total when the customer's times equal the displayed header times; no state where a previously shown total is replaced by a message with no figure after one select change.
- Needs browser repro?: yes — mobile 390px: open the EWR URL, View Details on Red Carpet Inn, pick 8:00 AM check-in only (confirm total disappears), then 8:00 AM check-out (confirm $27.85 vs card $33.33).

---

### 2.2 Spreadsheet comparer reconciling ATL card vs slider vs checkout vs "API grandTotal"
- Profile: MacBook Air, 1440px, Chrome, DevTools open. ATL, Fri 20 Nov 10:00 AM -> Tue 24 Nov 2:00 PM (4 nights). One mid-size SUV. Methodical; keeps a sheet with each lot's per-day, total and due-now.
- Goal: Prove which lot is cheapest all-in and that the card total is what he will be charged.
- Entry point: `https://www.triplypro.com/search?airport=ATL&checkin=2026-11-20&checkout=2026-11-24`
- Attempted journey: opens Network tab -> sees `/api/search` returns `grandTotal: 55.48` for Four Points vs card $61.43 -> opens slider -> reads breakdown -> proceeds to checkout summary to compare.
- Friction:
  - Card $61.43 vs API grandTotal 55.48: the $5.95 difference is Triply's service fee; explained above. Totals reconcile exactly across card, slider (same `priceViewFromPricing`) and checkout (`grandTotal + serviceFee`) [CODE price-view.ts:67, checkout-form.tsx:327]. Confirmed non-issue arithmetically.
  - Two different "per day" numbers in the same slider: headline "$12.29/day" = total/days (61.43/5) but breakdown line reads "$11.10 x 5 days" (parking only, 55.48/5) [CODE price-view.ts:70, price-breakdown.tsx:15-18; TESTED-LIVE orchestrator: Sky Lot $12.74 vs "$11.55 x 5 days"]. A comparer will spot the mismatch and wonder about the $1.19/day.
  - Cent rounding visible on a live lot page (Apex EWR, 8 days): "$9.00 x 8 days" = "$72.04" (not $72.00) next to $11.09/day for $88.68 [TESTED-LIVE lot-apex.html; CODE price-breakdown.tsx:17]. Same pattern in checkout "$X x N days" [CODE order-summary.tsx:156-162].
  - "Taxes & fees included" is true but ATL Four Points hides a $20.73 ResLab fee (60% on top of its $34.75 base) inside the per-day rate — the breakdown shows only "Parking" [TESTED-LIVE snapshot; CODE price-view.ts:62 parking = subtotal+fees]. The lot with the "Lowest total" badge is therefore cheap only because of a total, not its advertised-looking rate; honest, but a comparer who sees $34.75 base on ResLab/SpotHero will think it is higher.
  - "Taxes & fees included" sits next to a total that includes the Triply service fee; the same word "fees" covers ResLab fees (rolled in) and Triply's (listed separately as "Service fee") [CODE taxes-fees-included.tsx; price-breakdown.tsx:24].
  - Billed "5 days" for a 4-night Fri 10 AM -> Tue 2 PM trip (see 2.1).
- Likely abandonment point: Does not abandon; leaves with a screenshot noting two per-day numbers. Risk is low unless a competitor shows a single consistent rate.
- Evidence: [TESTED-LIVE] snapshot + lot page; [CODE] service-fee.ts, price-view.ts, price-breakdown.tsx, checkout-form.tsx.
- Severity: Low (arithmetic is correct) / Medium for the dual per-day rate
- Type: Copy-trust
- Proposed improvement: In the breakdown, label the line "Parking & fees: $55.48 (5 days)" without a per-day multiplier, or make the headline per-day equal the multiplied rate; add one line "Day count: 5 (every 24 h or part of one)". Acceptance: no breakdown row where `rate x days` is displayed and does not equal its amount to the cent; headline per-day is visibly labeled "all-in per day".
- Needs browser repro?: no for the math (verified from code and live JSON); yes (desktop) to screenshot the slider showing $12.29/day vs $11.10 x 5.

---

### 2.3 "Pay at Location" budget parker (EWR, 21 lots like this)
- Profile: Pixel 7, 412px, Chrome. EWR. Fri 20 Nov 10 AM -> Tue 24 Nov 2 PM. Compact SUV. Wants the lowest cash outlay today and no surprises at the gate.
- Goal: Pick between Apex ($59.14 total, "Pay at Location") and ARB Parking ($72.75, pay-in-full online).
- Entry point: `https://www.triplypro.com/new-york-ewr/airport-parking` -> search -> `https://www.triplypro.com/search?airport=EWR&checkin=2026-11-20&checkout=2026-11-24`
- Attempted journey: card shows $59.14 + a tiny amber "Pay at Location" tag -> View Details -> breakdown shows "Due at location $44.01" -> Reserve -> checkout: Total $59.14, "Due Now $15.13", "Due at Location $44.01" -> step 3 notice "$44.01 will be collected on-site at check-in".
- Friction:
  - The card shows the full total as the headline and only a 10px "Pay at Location" tag with NO amount [CODE lot-card.tsx:177-182]. The amount due at the lot appears only after View Details (slider breakdown) [CODE price-breakdown.tsx:29-34]; the amount due now only appears at checkout [CODE order-summary.tsx:250-267]. Customer comparing "what do I pay today?" cannot see $15.13 until checkout.
  - Homepage says "anything paid at the lot is shown before you pay" — true at the slider, but not on the card [CODE comparison.tsx steps/trustProps].
  - Scale: 21 lots across 12 airports (BUR, DTW, EWR, HPN, JFK, LGA, MCI, MCO, MIA, ORD, TYS) take 63–82% of the card total at the lot, e.g. EWR Apex $44.01 of $59.14 (74%), JFK Bolt $115.85 of $152.28 (76%), ORD Pride $83.68 of $101.83 (82%) [TESTED-LIVE snapshot, computed].
  - Lot page and slider say only "Payment will be collected on-site at check-in" — no accepted payment methods (cash/card). Only JFK A1 mentions "accepts credit cards" in its description; the other 20 are silent [CODE booking-widget.tsx:340-349; TESTED-LIVE snapshot descriptions].
  - Extras not in any total: Apex "Small SUV $5/Day, Large SUV $7/Day, Truck $10/Day" (a 5-day SUV adds $25-$35 at the lot, +42–59% of the $59.14 card); EWR Airport Parking "oversized +$3/day on site"; "If you pick up your vehicle later than your reservation states, the location will charge accordingly" [TESTED-LIVE lot-apex.html + EWR.json specialConditions]. The vehicle-size selector exists only for Triply-direct lots (ResLab lots get text only) [CODE vehicle-size-selector.tsx:11, 110].
  - Search's Pay-at-Location lots sort by full total, so they look dearer than their charge-today price; a user who thinks in "what leaves my card now" may skip the cheapest cash outlay. (Fairness is correct for total-trip cost.)
  - Refund clarity: Help says the at-lot part "was never charged by us" — fine, but this is only on /help [CODE help/page.tsx:103].
- Likely abandonment point: At the slider, when the breakdown reveals the lot will collect ~three quarters of the money, with no payment-method or size-surcharge info — a price-sensitive user with an SUV compares total-with-surcharge and defaults to the pay-in-full lot.
- Evidence: [TESTED-LIVE] snapshot + lot page; [CODE] lot-card.tsx, price-breakdown.tsx, order-summary.tsx, stripe-payment-form.tsx:365-370, 449-461.
- Severity: Medium-High
- Type: UX gap / Inventory-pricing limitation
- Proposed improvement: On the card, replace the bare tag with "Pay $15.13 now · $44.01 at lot" (use `dueAtLocationAmount`, already on the lot object [CODE reslab/search.ts:217-218]); show the lot's own surcharge text in the slider next to the "Due at location" line. Acceptance: on all 21 pay-at-lot cards the amount due now and at the lot are visible without opening the slider.
- Needs browser repro?: yes — mobile 412px: confirm card shows only the tag; confirm slider "Due at location" row; checkout (read-only: stop at step 1) Due Now row.

---

### 2.4 Minimum-stay trap — cheapest-looking MCI lot can't be booked
- Profile: iPhone SE (2022), 375px, Safari. MCI. Fri 20 Nov 10 AM -> Tue 24 Nov 2 PM (billed 5 days). Tight budget, single traveler, in a hurry at a gate-adjacent coffee shop.
- Goal: Book the second-cheapest lot (Travelodge, $31.16) after the sold-out-looking cheapest.
- Entry point: `https://www.triplypro.com/search?airport=MCI&checkin=2026-11-20&checkout=2026-11-24`
- Attempted journey: sorts "Lowest Total" -> Quality Inn $26.69 (badge) then Travelodge $31.16 -> taps View Details on Travelodge -> picks times -> "Reserve Now" is greyed out.
- Friction:
  - Travelodge MCI has `minimumBookingDays: 6`; the search is 5 billed days; the card still shows $31.16 as bookable, with no min-stay hint [TESTED-LIVE MCI.json; CODE lot-card.tsx has no min-stay field]. Same for JFK Bolt Parking (min 6, card $152.28, pay at lot) [TESTED-LIVE JFK.json]. Only these two lots in the 246-lot snapshot exceed the 5-day search, but 80 lots carry a minimum of 1–6 days (53 of them 2+), so any 2–3 night search will meet this at many airports [TESTED-LIVE snapshot count; INFERRED for shorter stays].
  - In the search slider, the only explanation is `title="Minimum 6 days required"` on the disabled Reserve button — a hover tooltip that does not exist on touch screens [CODE product-detail-slider.tsx:158-165, 537]. The lot page, by contrast, shows a visible red "Minimum Booking Days Warning" [CODE booking-widget.tsx:352-356 region]. On a phone the user sees a grey button and no reason.
  - The disabled-state message "Please select check-in and check-out times" can still be on screen at the same time, pointing the user at the wrong fix [CODE slider lines 419-422].
  - Cheaper hit rate: such lots take up a slot in "Lowest Total" ordering above bookable ones.
- Likely abandonment point: After picking both times, Reserve stays grey; the user does not know whether to change the date, retry, or leave. High abandonment risk on touch.
- Evidence: [TESTED-LIVE] MCI/JFK JSON; [CODE] slider lines cited.
- Severity: High (for the affected cards); Medium overall
- Type: Defect (silent disabled state) / UX gap
- Proposed improvement: Either filter lots whose `minimumBookingDays` exceeds the billed days (or demote them with a "Min 6 days" chip) on the card, and render the `reserveDisabledReason` as visible text above the Reserve button. Acceptance: on a 375px viewport, for Travelodge MCI at 5 days, the card shows "Minimum 6 days" and the slider shows the same text without hover.
- Needs browser repro?: yes — mobile 375px (touch emulation): open the MCI URL, View Details on Travelodge, pick times, confirm no visible explanation next to the disabled Reserve button.

---

### 2.5 "Lowest total" badge vs "will I need an Uber?" — PHL, shuttle vs no shuttle
- Profile: Windows laptop, 1440px, Firefox. PHL. Sat 5 Dec 9 AM -> Tue 8 Dec 11 PM (3 nights, billed 4). Compares Triply vs PHL Economy ($15/day on-airport per Triply's own hub copy) and a round-trip Uber.
- Goal: Choose the truly cheapest all-in door-to-gate option.
- Entry point: `https://www.triplypro.com/philadelphia-phl/airport-parking` -> "View Details"/search
- Attempted journey: sorts Lowest Total -> Motel 6 gets the green "Lowest total" badge at $42.01 -> next is Regal Philly $42.55 -> reads amenity chips only -> opens slider -> reads shuttle text.
- Friction:
  - Motel 6 PHL ("No shuttle, but airport is a few minutes away by Uber/Lyft?Taxi") wins "Lowest total" by $0.54 over Regal Philly Parking (shuttle 24/7 every 10–15 min) [TESTED-LIVE snapshot]. Card chips for Motel 6: only "24/7 Front Desk", "Restaurant" — the card renders amenities, not `shuttleInfo`, and "No Shuttle" appears only if an amenity name contains "shuttle" [CODE lot-card.tsx:46-103, 186-207; the file never references shuttleInfo].
  - Same pattern at 13 airports where the "Lowest total" badge sits on a no-shuttle lot: BNA, BOS, BUR (walkable), EWR (Red Carpet Inn, also "Limited"), LAS, LAX (9750 Airport Blvd), MSY, ORD, PHL, PHX, RIC, SAV, SFO [TESTED-LIVE snapshot, counted from shuttle summary text].
  - Badge logic is only "lowest card total among a complete result" and ignores shuttle, minimum stay, availability [CODE ranking.ts:114-121]. It is mathematically correct and consistent with sort ("Lowest Total" and badge agree) [CODE ranking.ts:33-41, search/page.tsx:172-181] — a confirmed non-issue as arithmetic; an issue as a "best" signal.
  - Shuttle-hour windows also change real cost: ATL Four Points has no shuttle 12 AM–5 AM; BWI Clarion no shuttle 2 PM–10 AM (listed twice with different schedules) [TESTED-LIVE snapshot]. The slider accepted 5:00 AM/11:30 PM times in the walkthrough with no warning.
  - Park By The Ports Cruise Parking (FLL and POE both return it at $117.30) has "7 AM to 2 PM" shuttle only [TESTED-LIVE snapshot].
- Likely abandonment point: Not a drop — a wrong choice. The $0.54 saver is booked, then a rideshare or a long walk eats the saving (cost of rideshare not measured here; do not quantify).
- Evidence: [TESTED-LIVE] snapshot; [CODE] lot-card.tsx, ranking.ts.
- Severity: Medium-High
- Type: UX gap / Copy-trust
- Proposed improvement: Show a "No shuttle" chip (from `shuttleInfo.summary` or a structured flag) and a "Shuttle 24/7" chip on the card; do not award "Lowest total" to a no-shuttle lot unless it is labelled "Lowest total · no shuttle". Acceptance: all 13 no-shuttle badge lots show a visible no-shuttle chip on the card; badge text on those cards includes the caveat.
- Needs browser repro?: yes — desktop: PHL results, confirm Motel 6 has the badge and no shuttle chip; BWI to see the duplicate Clarion card.

---

### 2.6 Three-week-ish family trip, EWR 16 nights — long-stay math and the 17th day
- Profile: Dell XPS, 1366px, Edge. EWR. Sat 5 Dec 2026 10 AM -> Mon 21 Dec 2 PM (16 nights). Family minivan. Wants the cheapest "all-in" and sees ARB/Motel 6 at multiples.
- Goal: Decide between a $99 lot and a $177–$239 field.
- Entry point: `https://www.triplypro.com/search?airport=EWR&checkin=2026-12-05&checkout=2026-12-21`
- Attempted journey: sorts by Lowest Total -> Red Carpet Inn $99.02 ("Lowest total", Limited) -> Motel 6 $177.24 -> Apex $190.29 (pay at lot) -> checks hub claim "P6 Economy $21/day pre-booked".
- Friction:
  - 16 nights = 17 billed days at default times (10 AM -> 2 PM) [TESTED-LIVE live-C numberOfDays 17]; picking 9 AM pick-up would save a day (see 2.1).
  - Service fee jumps from the $5.95 floor to 6% above a $99.17 base: Motel 6 $9.11, Apex $9.45, Renaissance $12.27, Courtyard $12.07 [TESTED-LIVE live-C; CODE service-fee.ts:5-9]. The percentage is visible only as "Service fee $X" in the slider.
  - The $99.02 lot is the "Lowest total" but is Limited, no shuttle ("Uber and Lyft are readily available" per lot text), min stay 1; the next cheapest is 79% higher ($177.24). Large gaps make the cheapest lot an outlier; the user cannot see whether it is bookable for 16 nights without opening the slider [TESTED-LIVE live-C, EWR.json].
  - Pay-at-lot rows: Motel 6 $134.34 of $177.24 due at the lot, Apex $149.64 of $190.29; large cash/card at a lot gate for a 17-day stay [TESTED-LIVE live-C].
  - Slider price breakdown can show a "Long-stay discount" row when ResLab discounts; none appeared in live-C (parts equal grandTotal) — non-issue observed [TESTED-LIVE live-C; CODE price-view.ts:25-27, 63-73].
  - No visible cap on stay length: page accepts 16 nights; I found no max-stay validation in the search API (waitlist is capped at 60 days) [CODE search/route.ts schema; booking-window.ts:20-30]. Booking window itself is 100 days [CODE booking-window.ts:10].
- Likely abandonment point: At the slider when the family sees $177–$190 and 75% due on-site for the "real" lots, or at "Limited" on the $99 one.
- Evidence: [TESTED-LIVE] live-C; [CODE] service-fee.ts, price-view.ts.
- Severity: Medium
- Type: Inventory-pricing limitation
- Proposed improvement: Add a one-line "Billed 17 days (16 nights + 4 h)" under the price; show the all-in per-day on the slider consistently (see 2.2). Acceptance: any stay > 7 days shows billed-days explanation and a Service fee % note when above the floor.
- Needs browser repro?: yes — desktop: confirm 17 days in slider, service fee line values.

---

### 2.7 JFK/LGA savings calculator vs the live cards
- Profile: Galaxy S23, 360px, Chrome. Home page. JFK, plans "7 days". Believes "Save up to 60%" and wants to see if the $14/day holds.
- Goal: Validate the claim before searching.
- Entry point: `https://www.triplypro.com/` (Why Choose Triply section)
- Attempted journey: selects JFK, 7 days -> reads On-Site $245 / With Triply $98 / "You Save $147, 60% OFF" -> clicks search for JFK, same dates.
- Friction:
  - Hard-coded rates: JFK on-site $35/day, Triply $14/day; LGA $32 vs $12 [CODE comparison.tsx:20-23, 77-85]. Only JFK and LGA exist in the dropdown; EWR (where the on-airport comparison is most quoted) is not offered.
  - Live all-in per day at JFK (5-day snapshot): $12.73 (Parking Point) to $44.69 (TWA Hotel); 10 lots; median ≈ $25.83. At the median the saving versus $35 is ≈26%, not 60%; only the cheapest lot reaches ≈64% [TESTED-LIVE snapshot, computed]. LGA: cheapest all-in $14.27/day (> the calculator's $12); median ≈ $20.52/day [TESTED-LIVE snapshot].
  - The $35/day on-site is unsourced in the UI; footnote "Rates shown are averages" is small gray text [CODE comparison.tsx:342-344]. The EWR hub says P6 Economy is $21/day pre-booked vs $35 drive-up; pre-booking is the apples-to-apples comparison a savvy user will make [TESTED-LIVE hub-ewr.html].
  - "Save Up to 60%" is repeated in hub meta/titles and /airport-parking [CODE airport-parking/page.tsx:12,19,82; [slug]/airport-parking/page.tsx:91]; the internal knowledge-base says "Triply does not measure individual savings" [CODE ai/knowledge-base.ts:30].
  - The "days" buttons (3, 5, 7, 10, 14, 21) are billed-days, not nights.
- Likely abandonment point: At search results when the cheapest JFK lot ($63.66 for 5 days) is fine but the median is nearly double the calculator's rate; trust drops, especially if the user also saw a competitor's page.
- Evidence: [CODE] comparison.tsx; [TESTED-LIVE] snapshot; [INFERRED] user perception.
- Severity: Medium
- Type: Copy-trust
- Proposed improvement: Drive the calculator from live search data (cheapest and median for the selected airport/length) or relabel as "Cheapest lot vs drive-up"; add a source/date for the on-site rate. Acceptance: calculator figures for JFK/LGA match the cheapest live all-in per-day within $1 on the same dates, and carry an "as of" date.
- Needs browser repro?: yes — mobile 360px: read the calculator, select 21 days, compare the footnote's legibility.

---

### 2.8 SERP landing on a hub — "from $6/day" vs the card
- Profile: iPhone 15, 393px, Safari. Arrives from Google on "cheap PHL parking". Mon 14 Dec -> Fri 18 Dec. Anchors on title price.
- Goal: Confirm the $6 headline.
- Entry point: `https://www.triplypro.com/philadelphia-phl/airport-parking`
- Attempted journey: reads title/hero "from $6.25/day", rates table "Regal Philly Parking — Best Price $6.25/day" -> taps search with dates -> sees $8.51/day on the same lot.
- Friction:
  - PHL hub: title "…Rates from $6", hero "Compare 5 parking lots near PHL from $6.25/day", table "Rates shown for a sample 7-day trip" with Regal "Best Price" $6.25, Motel 6 $6.30 [TESTED-LIVE hub-philadelphia-phl.html]. Source is `lot.pricing.minPrice` = (subtotal+fees)/days, before tax and before the $5.95+ service fee [CODE reslab/search.ts:195-197; hero-section.tsx:12-26; rates-table.tsx:13-17].
  - Search card for the same lot (5 days) is $8.51/day all-in ($42.55 total), +36% [TESTED-LIVE snapshot]. EWR: hub "from $5.20/day" (title "from $5") vs Red Carpet Inn $6.67/day (5 days) or $6.96/day (4 days) [TESTED-LIVE hub-ewr.html, live-A/B].
  - Hub's "Best Price" is Regal; search's "Lowest total" is Motel 6 ($42.01) — two cheapest labels, different lots [TESTED-LIVE].
  - Hub body copy is more careful ("a search with your dates shows your total with taxes and fees"), but the headline numbers are not [TESTED-LIVE hub-philadelphia-phl.html].
  - Known in flight: memory notes PR #152 (hub copy, no prices) open on Tom's repo as of 3 Nov; live main still carries prices [TESTED-LIVE 6 Nov fetch].
  - Hub says "Compare 10 parking lots near EWR" while the dated search returned 11–12 lots [TESTED-LIVE hub-ewr.html vs live-B].
- Likely abandonment point: On the card, 36% above the hub headline; user returns to SERP.
- Evidence: [TESTED-LIVE] two hub pages, snapshot; [CODE] hero/rates/minPrice.
- Severity: Medium
- Type: Copy-trust
- Proposed improvement: Merge PR #152 (no prices in titles/hero) or switch hub figures to the all-in per-day with "for 5 days, taxes & fees included". Acceptance: hub per-day equals the search card's per-day for the sample stay to within a cent, or no per-day figure appears on the hub.
- Needs browser repro?: no — static HTML and API already show it; optionally mobile screenshot of the table.

---

### 2.9 Checkout price-shock — Park Guard and promo at the last step (BWI)
- Profile: iPhone 13, 390px, Safari. BWI, Fri 11 Dec 6 AM -> Mon 14 Dec 11 PM (billed 4). Cheapest-lot buyer (Doubletree Baltimore $36.74); has a 20% code from an email.
- Goal: Pay as little as possible; apply the code.
- Entry point: `https://www.triplypro.com/search?airport=BWI&checkin=2026-12-11&checkout=2026-12-14` -> checkout
- Attempted journey: card $36.74 -> slider -> Reserve -> step 1 (promo field is in the summary) -> step 2 -> step 3 Payment where Parking Protection appears.
- Friction:
  - Parking Protection is NOT pre-selected (non-issue); Plan A "Recommended" $12.99 ($49.73 total, +35%), B $7.99, C $4.95; "No protection — I agree to park at my own risk" must be chosen; Pay Now is disabled until a choice is made [CODE protection-plan.tsx:51-72, 93; stripe-payment-form.tsx:112, 181; plans.ts:82-107]. Price first appears only on step 3, after name/phone/email and vehicle entry.
  - Total changes after the user already typed card digits? The amount updates on pick with "Updating total…" and Pay disabled while settling [CODE protection-plan.tsx:94-99; stripe-payment-form.tsx:163]. Fine.
  - Promo: the field lives only in the checkout summary — no hint on search/slider/lot page [CODE git grep promo: only comments in search/lot]. On phones the grid is `grid-cols-1`, so the summary (promo, price breakdown) sits below the whole step form [CODE checkout-form.tsx:1249-1251, 1385-1386; INFERRED mobile scroll position].
  - Promo is locked on step 3 ("Promo codes can't be added once payment is initialized. Click Back") — a user who finds the field late must go back [CODE promo-code.tsx:89-96].
  - A percentage promo applies to the base parking subtotal only: `discount = costData.subtotal * pct`, with service fee, ResLab fees and tax unchanged [CODE checkout-form.tsx:313-327]. A 20% code on $29.75 = $5.95 off (a 16% reduction of $36.74); the $5.95 service fee is untouched. The user expecting 20% of the total sees less.
  - Card "total" excludes protection and promo by design ("before optional protection or a promo") but the card says nothing about protection existing [CODE lot-card.tsx:107-110].
  - Service fee is refunded on cancel (non-issue) [CODE terms/page.tsx:96; help/page.tsx:103]; Park Guard is partly non-refundable.
- Likely abandonment point: Step 3, when protection options appear as the first new cost; for a $36.74 booking a $12.99 "Recommended" card is large. The wording "park at my own risk" may cause some to back out to compare.
- Evidence: [CODE] files cited; [INFERRED] mobile scroll and perception; steps 2–3 not exercised live (read-only).
- Severity: Medium
- Type: UX gap / Copy-trust
- Proposed improvement: Mention optional Park Guard price range on the slider ("Optional protection from $4.95") and show the promo input in step 1's form column on mobile; describe the discount base ("20% off parking subtotal"). Acceptance: on a 390px viewport the promo input is visible without scrolling past the details form; protection prices appear before any personal data is requested.
- Needs browser repro?: yes — a test-mode/staging order (cannot be done read-only): phone viewport, check promo position and the step-3 protection cards.

---

### 2.10 Zero-inventory airport — DAL (Love Field) shopper falls off
- Profile: iPad (10th gen), 768px, Safari. Dallas Love Field. Fri 20 Nov -> Tue 24 Nov. Compares Triply to Love Field's own lot and SpotHero.
- Goal: Find any Love Field-area lot and its total.
- Entry point: `https://www.triplypro.com/airport-parking` (lists all 85 equally) -> DAL -> `https://www.triplypro.com/search?airport=DAL&checkin=2026-11-20&checkout=2026-11-24`
- Attempted journey: picks DAL -> results page.
- Friction:
  - DAL returns 0 lots (considered 1, not degraded) [TESTED-LIVE coverage snapshot]. Results show only "No parking lots found for your search criteria." — no sold-out vs not-served distinction, no nearby airport, no waitlist/notify, no clear next step [CODE search-results-list.tsx:108].
  - 15 of the 85 marketed airports return 0 (ABE ABQ AZO DAL GEG IDA MEM ROA RSW SLC SNA YOW YUL YYC YYZ) and the /airport-parking list does not show which [TESTED-LIVE snapshot + walkthrough].
  - The "best price" alternative the user would want is DFW (Clarion $28.45 Limited, Westin $50.52) — roughly 15 mi from Love Field; none offered [TESTED-LIVE DFW.json; INFERRED distance].
  - Hero "85+ airports" and "Save up to 60%" are already in the user's head.
- Likely abandonment point: Immediately on the empty results page; user opens a competitor.
- Evidence: [TESTED-LIVE] snapshot; [CODE] empty-state line.
- Severity: Medium (traffic leak, not a bug)
- Type: Inventory-pricing limitation / UX gap
- Proposed improvement: Mark the 15 airports on /airport-parking ("coming soon / notify me") and make the empty state offer a waitlist plus the nearest airport with inventory. Acceptance: for DAL the results page shows a specific message and at least one alternative link.
- Needs browser repro?: yes — desktop and iPad: confirm the exact empty-state copy and the lack of any CTA.

---

## Squad top findings
1. Hidden default pricing times (10 AM -> 2 PM) make every card bill a partial day: EWR 4-night trip $33.33 vs $27.85 with 8 AM/8 AM; user is never told. [TESTED-LIVE live-A/B; CODE time.ts:120-121, search/page.tsx:402-403]
2. Minimum-stay lots (MCI Travelodge min 6, JFK Bolt min 6) are listed and sortable at 5 days; the slider explains the disabled Reserve only via a hover `title` — invisible on touch. [TESTED-LIVE MCI/JFK JSON; CODE product-detail-slider.tsx:158-165, 537]
3. Pay-at-Location (21 lots) shows the full total with a tiny tag; 63–82% is due at the lot and the amount appears only in the slider/checkout; size surcharges and late-pickup fees sit outside any total. [TESTED-LIVE snapshot + Apex lot page; CODE lot-card.tsx:177-182]
4. "Lowest total" is awarded to no-shuttle lots at 13 airports (e.g. PHL Motel 6 by $0.54 over a 24/7-shuttle lot) with no shuttle chip on the card. [TESTED-LIVE snapshot; CODE lot-card.tsx, ranking.ts:114-121]
5. Hub and calculator headlines are pre-tax/pre-fee ("from $6.25/day" vs $8.51 on search; JFK calculator $14/day vs median $25.83; LGA $12 vs cheapest $14.27). [TESTED-LIVE hub + snapshot; CODE comparison.tsx:20-23, rates-table.tsx]
6. Confirmed non-issues: card/slider/checkout totals reconcile (API grandTotal + service fee), "Lowest Total" sort agrees with the badge, Park Guard is not pre-selected, service fee is refunded on cancel. The residual UI wart is the second per-day figure ($12.29 headline vs "$11.10 x 5 days") and cent rounding ("$9.00 x 8 days = $72.04"). [TESTED-LIVE + CODE]

---

## Squad 3

### Squad 3 — Families managing luggage, children, car seats and shuttle logistics

Simulated reactions grounded in evidence. Not real customer behaviour. No conversion or revenue numbers are claimed.
Evidence: coverage snapshot (check-in Fri 2026-11-20 10:00 AM to Tue 2026-11-24 2:00 PM, 5 billed days) plus 3 `surface=featured` API calls (MCO 12 nights, POE 7 nights, DEN 9 nights), 10 public page GETs (hubs and lot pages: MCO Best Rate, EWR Red Carpet, MIA Premier, POE hub, EWR hub, BOS hub, JFK Parking Point, /help, SLC hub) and code on `upstream/main`.

Cross-cutting facts used below (verified):
- ResLab checkout is hard-wired to ONE spot and ONE parking type: `number_of_spots: 1` and `parkingTypes[0]` (cheapest-rate type). [CODE] `src/app/api/checkout/lot/route.ts:113-140`; `src/lib/reslab/get-lot.ts:80-95`; `src/components/checkout/checkout-form.tsx:476,909,1132`. No vehicle-size choice, no "Large Vehicle" rate, no 2nd car, no passenger count for ResLab lots.
- The oversize flow (modal, checkout selector, at-lot estimate) exists ONLY for direct lots. [CODE] `src/components/lot/vehicle-size-modal.tsx`, `src/components/checkout/vehicle-size-selector.tsx`. In the snapshot only 1 of 246 lots is `source: direct` (The Parking Point JFK). [TESTED-LIVE] snapshot `cov/JFK.json`.
- Lot policy text (oversize rates, passenger caps, height limits, cash only) lives in ResLab `specialConditions` / `shuttleInfo.details` / `description`. The search slider renders description + shuttle summary/details but NOT `specialConditions`. [CODE] `src/components/search/product-detail-slider.tsx:~410-475` (Overview, Amenities, Shuttle, Directions only; no specialConditions); `specialConditions` is rendered in `src/components/lot/lot-overview.tsx:55-80` (lot page "Important Information") and in the confirmation page only.
- Search cards never show shuttle status. Card chips come from ResLab `amenities` only (10 distinct names in the snapshot, none contains "shuttle"), so the "No Shuttle" chip branch is dead code. [CODE] `src/components/search/lot-card.tsx:49-54`; [TESTED-LIVE] amenity-name census of `cov/*.json` (names: 24/7 Front Desk, Restaurant, Wheelchair Access, Security, Valet, Free Internet/Wifi, Fitness Center, Covered/Garage, Breakfast Included, Room Service).
- Hub pages and rates table mark every lot "Shuttle / Yes" if `shuttleInfo` exists, including "No Shuttle" lots. [CODE] `src/components/airport/lot-grid.tsx:58`, `src/components/airport/rates-table.tsx:60`; [TESTED-LIVE] EWR and BOS hubs.
- No "outside shuttle hours" warning anywhere in search, slider or checkout code. [CODE] grep of `upstream/main:src` finds the idea only in blog/airport-content text.
- Help FAQ says shuttles "typically run every 10-15 minutes" and "most" facilities offer one; there is no FAQ on oversize vehicles, child seats or party size. [TESTED-LIVE] /help; [CODE] `src/app/(main)/help/page.tsx:123-126`.
- Approximate lot counts from regex over 246 snapshot lots (treat as ±3): ~25 mention an oversize rate/option, ~39 say "no extra charge" for vans/large SUVs, ~19 restrict oversize/RV/trucks, ~12 cap shuttle at 4 passengers or similar, ~10 state a height/clearance limit. [TESTED-LIVE] `cov/*.json` regex scan.

---

### 3.1 Disney minivan family, 12 nights over Christmas
- Profile: iPhone 14, 390x844, Safari. MCO. Sat 2026-12-19 7:00 AM to Thu 2026-12-31 9:00 PM (12 nights, billed 13 days). 2 adults + 3 kids (ages 3, 7, 10), Honda Odyssey, 4 suitcases, stroller, 2 car seats. Booking 6 weeks out, no rush. Objection: "Will they charge extra for my van, and what do I pay today?"
- Goal: cheapest lot that takes a minivan without surprise fees, with a shuttle that copes with 9 PM landing and a pile of bags.
- Entry point: `https://www.triplypro.com/orlando-mco/airport-parking` then search.
- Attempted journey: opens MCO hub, enters Dec 19 to Dec 31, sorts by Lowest Total. Sees 4 lots only. Gold Park $84.12, Omni $94.61, Holiday Inn $151.65, Best Rate $485.58. Opens each "View Details" slider looking for "van" or "minivan".
- Friction:
  - Best Rate shows $485.58 total but $449.58 of it is "Due at location"; the card says only "Pay at Location" with no amount. [TESTED-LIVE] MCO 12-night API; [CODE] `lot-card.tsx:177-182`, slider "Payment will be collected on-site" with no amount `product-detail-slider.tsx:~495-505`.
  - Best Rate's rule "All oversized vehicles must book under the 'Large Vehicle' rate... Large SUVs, Vans" is in `specialConditions`, which the slider omits; it appears only on the lot page under "Important Information". [TESTED-LIVE] lot page text; [CODE] slider has no specialConditions.
  - Even a user who reads it cannot comply: checkout always books `parkingTypes[0]` and 1 spot. [CODE] `checkout/lot/route.ts:113-140`. "Failure to do so may result in the additional charge being collected at the location" stays an unquantified risk.
  - Gold Park (cheapest, $6.47/day) says nothing about vans or SUVs anywhere in description, special conditions or shuttle text. Only Omni states "No extra charge for full-size vans, pick-up truck and large SUV's" (end of description). [TESTED-LIVE] `cov/MCO.json`.
  - Best Rate shuttle stops 10:00 PM ("No shuttle" 10 PM-4 AM) but slider accepts a 9:00 PM check-out with a 9 PM landing and 5 bags. [TESTED-LIVE] shuttle text; [CODE] no hours check.
  - Best Rate is 5.8x the Gold Park price for the same dates and is the only lot with valet; a price outlier with no explanation. [TESTED-LIVE] API.
- Likely abandonment point: in the Gold Park/Omni slider if she cannot tell whether the Odyssey is charged extra; she leaves to phone the lot (phone is on the lot page only) or goes to a competitor. Support is email-only with a 24-48h reply window (walkthrough FAQ).
- Evidence: see tags inline.
- Severity: High
- Type: UX gap (policy text hidden) + Inventory-pricing limitation (no Large Vehicle rate selectable)
- Proposed improvement: (1) Render `specialConditions` in the slider under Shuttle Information as an amber "Important" block, same component as `lot-overview.tsx`. Acceptance: for Best Rate MCO, opening the slider shows the "Large Vehicle" sentence without leaving search. (2) On cards and slider with `dueAtLocation`, show "Pay online $X / pay at lot $Y". Acceptance: Best Rate MCO card reads about "$36 today, $449.58 at the lot". (3) Add a plain-language "Does this lot charge extra for vans/SUVs? Yes / No / Not stated" row, derived by ops for the top lots per airport, replacing silence.
- Needs browser repro?: yes. Mobile 390px: open the slider for Best Rate, confirm no "Important Information" block and that the Pay at Location box shows no amount; check whether the sticky footer Reserve button hides the Due-at-location line.

### 3.2 Cruise family of five, Port Everglades
- Profile: Pixel 7, 412x915, Chrome. POE (seaport page). Sun 2026-12-20 8:00 AM to Sun 2026-12-27 7:00 AM (7 nights). 2 adults + 3 kids, Chevy Suburban, 3 big suitcases + 2 carry-ons. Ship boards ~1 PM. Objection: "Does the shuttle take us to the PORT, and does it fit five of us?"
- Goal: cheapest lot with a shuttle to the cruise terminal for the whole family.
- Entry point: `https://www.triplypro.com/fort-lauderdale-poe/airport-parking` (Google "Port Everglades parking").
- Attempted journey: reads hub, sees "Best Price" Springhill Suites $7.04/day with a "Shuttle" tag, picks Fairfield Inn (a "Lowest total" badge in search), enters dates, taps View Details.
- Friction:
  - Hub copy (templated for every airport): "Most lots offer complimentary shuttle service to and from the terminal" and "Most off-airport lots run shuttles every 5-15 minutes to POE terminals". [TESTED-LIVE] POE hub; [CODE] `src/lib/airport-page/content.ts:50,68,119`.
  - Data contradicts it: 8 of 10 POE lots are FLL airport hotels whose shuttle goes to the AIRPORT, hourly on the hour (Springhill, Aloft, Marriott, Fairfield), with "No shuttle" 11:30 PM-4:30 AM at Springhill. [TESTED-LIVE] `cov/POE.json`.
  - Fairfield Inn & Suites, "Lowest total" in the snapshot ($46.99) and $65.78 for 7 nights, states "Airport parking only... This location does not offer cruise parking (transportation to/from port)". [TESTED-LIVE] `cov/POE.json`, `s3_poe.json`.
  - Courtyard: "complimentary AIRPORT shuttle. Cruise port shuttle is $20 per person" (family of 5 = $100, direction unstated). [TESTED-LIVE] `cov/POE.json`.
  - Only the two Park By The Ports lots serve cruisers properly: $182.23 (airport lot) and $184.46 (cruise lot) for 8 billed days; shuttle 7 AM-2 PM outbound; "up to 4 passengers per vehicle; every additional passenger is $10". Family of 5 pays extra and the cap is in `specialConditions`, which the slider hides. [TESTED-LIVE] `s3_poe.json`, `cov/POE.json`; [CODE] slider omits specialConditions.
  - 7-night trip is billed 8 days at daily-billed lots (Dec 20 to Dec 27 inclusive), 7 days at hourly lots, so the lot that fits cruisers costs ~2.8x the hotels with no on-page explanation of why. [TESTED-LIVE] `s3_poe.json` (`numberOfDays` 8 vs 7).
  - The POE page intentionally reuses FLL lots (`isSeaport`), so this is by design, but the copy and tags were written for airports. [CODE] `src/config/airports.ts:14-19`.
- Likely abandonment point: either (a) after reading the long shuttle paragraph in the slider, discovering "no cruise parking" and leaving, or (b) worse, not reading it, booking Springhill/Fairfield, and arriving at the port with an hourly airport shuttle that does not go there.
- Evidence: inline tags.
- Severity: Blocker for the booking-then-regret path, High for the search path
- Type: Copy-trust (templated hub copy) + UX gap
- Proposed improvement: for `isSeaport` airports, filter or label each lot with a port-shuttle status derived from ops data: "Shuttle to port", "Airport shuttle only", "No cruise parking". Replace the templated copy on seaport hubs. Acceptance: Fairfield on the POE page shows "Airport parking only - no port shuttle" and is excluded from the "Lowest total" badge; hub text never claims port shuttles for lots that don't run them.
- Needs browser repro?: yes. Mobile 412px: load `/search?airport=POE&checkin=2026-12-20&checkout=2026-12-27`, confirm the card for Fairfield carries a "Lowest total" badge and no cruise warning, and read where the "does not offer cruise parking" sentence sits inside the slider.

### 3.3 Miami cruise, cash-only garage and a party of five
- Profile: iPad Air, 820x1180, Safari. MIA (cruise lots). Fri 2026-11-20 10:00 AM to Tue 2026-11-24 2:00 PM (4 nights; price evidence matches). 2 adults + 3 kids, SUV about 6'4" with roof box. Objection: "Can all five of us ride, and what do I need at the garage?"
- Goal: a covered garage close to PortMiami with a kid-proof arrival.
- Entry point: `https://www.triplypro.com/miami-mia/airport-parking/premier-cruise-parking` (from a "Miami cruise parking" blog link).
- Attempted journey: reads Overview, shuttle, price box; tries WePark and Premier; goes to checkout to see passenger fields.
- Friction:
  - Premier: "Free shuttle for up to 4 passengers only. No exceptions." Five people means a 5th rideshare or a second trip. [TESTED-LIVE] lot page and `cov/MIA.json`.
  - Premier: "This location accepts CASH only. No credit cards." The lot is a due-at-location lot ($76.65 of $92.64 in the snapshot; $126.64 of $151.00 on the default 8-day page) but the cash-only fact sits only inside the shuttle paragraph, and the slider/card say only "Pay at Location". [TESTED-LIVE] lot page `Due at location $126.64`; `cov/MIA.json`.
  - Premier garage clearance 7'0"; WePark height cap 6'7" and "no oversize vehicles"; roof boxes are not mentioned and nothing prompts for vehicle height. [TESTED-LIVE] `cov/MIA.json`.
  - Shuttle windows: Premier embarkation 11:00 AM-3:15 PM, disembarkation 7:30-10:45 AM; WePark to terminal 11 AM-2:30 PM. The slider takes any time (a 9:00 AM drop-off) with no warning. [TESTED-LIVE] shuttle text; [CODE] no hours check.
  - Passenger count is a free-text extra field ("Number of Passengers" at Premier, "Number of guests traveling" at WePark) with a generic file icon, an "N/A" hint, no number input and no tie to the 4-passenger cap. [TESTED-LIVE] `extraFields` in `cov/MIA.json`; [CODE] `src/components/checkout/vehicle-details-step.tsx:~255-320` (`type="text"` unless ResLab says `number`), `src/lib/booking/required-extra-fields.ts` (required unless room-scoped).
  - "Covered" vs "uncovered": WePark's covered floors (7th/8th) vs uncovered (9th) are explained only in details; its card chips show only "Security". [TESTED-LIVE] `cov/MIA.json`.
- Likely abandonment point: at the shuttle paragraph (cap of 4 + cash) or, if she proceeds, at the checkout "Number of Passengers" field where "5" is accepted silently and she learns on cruise day that one child rides separately.
- Evidence: inline tags.
- Severity: High
- Type: UX gap (policy buried) + Copy-trust ("Pay at Location" hides cash-only)
- Proposed improvement: structured badges for "Cash only at lot", "Shuttle max 4 per vehicle", "Height limit 7'0\"", surfaced on card, slider and lot page. For lots with a passenger field, render a numeric stepper and show an inline warning when the number exceeds the lot's cap. Acceptance: entering 5 at Premier shows "This lot's free shuttle seats 4; extra riders must arrange transport", and the Premier card shows "Cash only at lot".
- Needs browser repro?: yes. Desktop or iPad: step through checkout steps 2-3 for Premier with a test-mode flow and confirm the passenger field type, label, and absence of a validation message (no data submitted).

### 3.4 Denver ski family, 9 nights, 5 AM departure
- Profile: Windows laptop, 1440x900, Chrome. DEN. Sun 2026-12-27 5:00 AM to Tue 2027-01-05 11:00 PM (9 nights). 2 adults + 2 teens, 2 ski bags + 2 boot bags + 4 suitcases, Subaru Outback with roof box. Objection: "Is the cheap hotel lot really a flat price?"
- Goal: cheapest reliable shuttle with room for ski bags, return at 11 PM.
- Entry point: `https://www.triplypro.com/denver-den/airport-parking` then search.
- Attempted journey: sorts by lowest total. Sees Embassy Suites $56.93 first, Hyatt Place $61.98 (limited), then Park2Jet $94.05. Opens the Embassy slider.
- Friction:
  - Embassy Suites: "A $8 per reservation fee will need to be paid at the front desk of the hotel for the round trip shuttle", "Staying hotel guests are prioritized over park and fly for the shuttle", "call 24hrs ahead to reserve shuttle spot", shuttle "drops off at the WEST Terminal only". None of this is in the price, `dueAtLocation` is False, and the card shows "Lowest total". [TESTED-LIVE] `cov/DEN.json`, `s3_den.json` (`due False 0`).
  - The Embassy surcharge makes the real cost about $65, which is still the cheapest, but the customer finds out from a paragraph and the "Taxes & fees included" label reads as "that's all". [INFERRED] reading of `TaxesAndFeesIncluded` next to a hidden $8; [CODE] `lot-card.tsx` renders that label for every lot.
  - Ski gear: only Park2Jet mentions "luggage assistance" and covered parking; no lot states roof-box clearance. [TESTED-LIVE] `cov/DEN.json`.
  - Daily-billed Embassy bills 10 days for 9 nights ending 11 PM on Jan 5. [TESTED-LIVE] `s3_den.json` (`days 10`).
  - 5:00 AM check-in accepted for all lots; Hyatt Place "No shuttle 12-4 AM" is fine here but nothing checks it. [TESTED-LIVE] shuttle text; [CODE] no check.
  - 6 of the 11 DEN results carry "Limited" (Hyatt Place, Residence Inn, Aloft, Spark, Holiday Inn Express, Hyatt House) with no spot count, which pressures a family to book fast on a holiday-week trip. [TESTED-LIVE] `cov/DEN.json`.
- Likely abandonment point: at the Embassy shuttle paragraph ("call 24 hrs ahead", "hotel guests prioritized") for a party with a 5 AM departure, shifting to Park2Jet or leaving.
- Evidence: inline tags.
- Severity: Medium
- Type: Copy-trust (total excludes a lot-collected fee)
- Proposed improvement: a lot-level `extraFeeNote` (ops-maintained) rendered as "+$8 shuttle fee paid at the hotel" under the price on card and slider, plus a "Reserve shuttle ahead" chip. Acceptance: Embassy Denver card shows the $8 note; its price headline stays unchanged.
- Needs browser repro?: yes. Desktop: confirm the slider paragraph renders as one run-on block (details have no spaces between sentences, e.g. "arrival.Shuttle service") and check readability at 1440px.

### 3.5 Newark budget minivan family, night arrival
- Profile: Samsung Galaxy S23, 360x780, Chrome. EWR. Fri 2026-11-20 10:00 AM to Tue 2026-11-24 2:00 PM (use 4 nights; the persona's 6-night variant scales the same). 2 adults + 3 kids, Toyota Sienna, 3 suitcases. Landing 11:30 PM on return. Objection: "Cheapest wins, as long as the van is free."
- Goal: lowest total with no van surcharge.
- Entry point: `https://www.triplypro.com/new-york-ewr/airport-parking`.
- Attempted journey: hub shows Red Carpet Inn "Best Price" with a "Shuttle" tag and Yes in the rates table. She books it from the top card.
- Friction:
  - Red Carpet Inn has NO shuttle ("No Shuttle. Uber and Lyft are readily available") and is 3.8 mi away in Irvington, but the hub card shows a "Shuttle" tag and the rates table shows Shuttle: Yes, plus "Best Price". [TESTED-LIVE] EWR hub text; [CODE] `lot-grid.tsx:58`, `rates-table.tsx:60`.
  - The search card has no shuttle indicator at all; the only chip is "Wheelchair Access". The "No Shuttle" chip branch can never fire. [CODE] `lot-card.tsx:49-54`; [TESTED-LIVE] amenities `['Wheelchair Access']`.
  - For a family of 5 with luggage at 11:30 PM the missing shuttle means a large rideshare, which is not priced or mentioned (no estimate, no XL note). [INFERRED]
  - Contrast on vehicle size: Red Carpet says "No extra charge for large SUV's or vans" (good, but only in description); Apex +$5/$7/$10 per day paid at the lot; Motel 6 "large vehicle option is for ALL trucks, vans, Ford Explorer" (not selectable at our checkout); EWR Airport Parking +$3/day "Minivans and SUVs are regular size". [TESTED-LIVE] `cov/EWR.json`; [CODE] `checkout/lot/route.ts:113-140`.
  - What good looks like: JFK's The Parking Point (direct lot) shows "Oversized vehicles +$5-$10/day, paid at the lot" under the price on its lot page and opens a modal before checkout. Working as designed; only 1 lot uses it. [TESTED-LIVE] JFK lot page; [CODE] `vehicle-size-modal.tsx`.
  - 4 of 11 EWR lots (Apex, Motel 6, Maas, EWR Airport Parking) are due-at-lot lots, so "Lowest total" comparisons mix online-paid and at-lot totals. [TESTED-LIVE] `cov/EWR.json` (`dueAtLot True 44.01/46.57/49/81`).
- Likely abandonment point: after booking, on arrival day (post-purchase regret, refund request), or pre-purchase if she opens the slider and reads "No Shuttle... Uber and Lyft" and compares to the card's "Shuttle" chip.
- Evidence: inline tags.
- Severity: High
- Type: Defect (misleading Shuttle tag/column) + UX gap
- Proposed improvement: derive a boolean `hasShuttle` from `shuttleInfo.summary` (pattern "no shuttle" / "uber|lyft|walk" / "temporarily suspended"). Show "No shuttle - rideshare/walk" on cards, hub grid and slider; set "Shuttle" column to "No". Acceptance: EWR Red Carpet Inn and BOS Broadway Motor Service render "No shuttle" in hub grid, rates table and search card; the generic hub copy stays accurate.
- Needs browser repro?: yes. Mobile 360px: check the hub card and the search card for Red Carpet Inn; confirm the badge row shows "Lowest total" and "Limited" without any shuttle line.

### 3.6 Boston: minivan, five riders, last shuttle 9 PM
- Profile: MacBook Air, 1440x900, Safari. BOS. Fri 2026-11-20 10:00 AM to Tue 2026-11-24 2:00 PM (snapshot dates; persona trip 5 nights). 2 adults + 3 kids, Chrysler Pacifica. Objection: "Every lot has a different rule for vans and people."
- Goal: reliable shuttle for 5 people, not the cheapest.
- Entry point: `https://www.triplypro.com/boston-bos/airport-parking`.
- Attempted journey: BOS has 4 bookable lots. Compares Se-lect valet $95.70, Ramada $104.74, Park N Boston $110.20, Broadway $62.74.
- Friction:
  - Se-lect: "Oversized vehicles will NOT be accepted", "No vehicles larger than a pick-up truck", transport for up to 4 passengers, "any party of more than 4 people will need to be dropped at airport before parking". A minivan is ambiguous. [TESTED-LIVE] `cov/BOS.json`.
  - Ramada: "complimentary for up to 4 people; additional passengers are $10.00 per person, each way", last shuttle 10 PM and "All Guests Should Arrive At Hotel By 9pm". The family of 5 pays about $20 more, off-screen. [TESTED-LIVE] `cov/BOS.json`.
  - Park N Boston: "Pick Up Trucks, Oversized SUV's & Vans are subject to the OVERSIZE RATE of an additional $10 per day... collected by lot at check-in". A van on a 5-day booking adds about $50 on top of $110.20 (+45%), and the lot is not marked due-at-location. [TESTED-LIVE] `cov/BOS.json` (`dueAtLot False`).
  - Broadway Motor Service (cheapest, "Lowest total") has no shuttle; the BOS hub shows "Shuttle" and "Yes" for it. [TESTED-LIVE] BOS hub; `cov/BOS.json`.
  - None of these rules appears in the slider (specialConditions hidden); the party-size cap sits in shuttle details as a long unbroken paragraph. [CODE] slider omits specialConditions; `lot-card.tsx` shows only amenity chips.
  - There is no way to enter vehicle type or party size at any stage for ResLab lots. [CODE] `vehicle-details-step.tsx` (make, model, color, plate only); `checkout/lot/route.ts` (1 spot).
- Likely abandonment point: after 3 slider reads and a mental total that no longer matches the card (roughly $160 for the van at Park N Boston), she leaves to book the lot directly or a competitor with a stated all-in van price.
- Evidence: inline tags.
- Severity: Medium
- Type: UX gap (policy fragmentation) + Inventory-pricing limitation
- Proposed improvement: add optional "Vehicle: standard / minivan or SUV / truck" and "Travellers: n" to the search header, store them, and use them to (a) show a per-lot "estimated at-lot extras" line from structured ops data, (b) warn when travellers exceed a lot's free cap. Acceptance: with Vehicle=minivan and Travellers=5, the BOS Park N Boston card reads "+$10/day van rate at the lot (~$50)" and Ramada reads "+$10 per extra rider each way".
- Needs browser repro?: no for the data facts (all are in the snapshot); yes for desktop layout of the slider paragraph only if the squad wants to confirm readability.

### 3.7 San Diego: full-size SUV, flexible-time flights, block-of-time rate
- Profile: iPad mini, 744x1133, Safari. SAN. Fri 2026-11-20 10:00 AM to Tue 2026-11-24 2:00 PM in the snapshot; persona trip 6 nights, return flight delayed by kids' connection. 2 adults + 3 kids, GMC Yukon. Objection: "I can't promise exact pickup time with three tired kids."
- Goal: a lot that takes a Yukon with predictable total and forgiving return time.
- Entry point: `https://www.triplypro.com/search?airport=SAN&checkin=2026-11-20&checkout=2026-11-24` (Bing result).
- Attempted journey: 4 lots only. Fox $103.19, Park Shuttle & Fly Lot A $112.12, Lot B $112.12, Aladdin $120.49. Compares oversize language and shuttle hours.
- Friction:
  - Park Shuttle & Fly: "Large Vehicles (SUVs, trucks, oversized vehicles) must purchase the large vehicle rate; otherwise they will be billed additional at location". Our checkout cannot purchase it. [TESTED-LIVE] `cov/SAN.json`; [CODE] `checkout/lot/route.ts:113-140`.
  - Same lot: "Customers reserve a Block of time. If the customer enters EARLY or picks up their car AFTER their chosen... time frames, the customer will be charged the lot's base FLAT rate of $24.95/24 hours plus a one-time $4.75 Airport Access fee." That is a delay-penalty rule, in description text only. [TESTED-LIVE] `cov/SAN.json`.
  - Fox: "Added charges for large vehicles will be collected on-site: Medium SUV/Trucks $3/day, Full-size SUV/Trucks $8/day" (6 days = $48); Fox also carries "most_booked" and "lowest_total" badges (both). [TESTED-LIVE] `cov/SAN.json`.
  - Fox shuttle: no shuttle 12:30-4:00 AM; fine for this trip, nothing validates it. [CODE] no check.
  - The slider's check-out time select forces a precise guess (48 half-hour options, default "Select", no accessible label per walkthrough) with no copy about what happens if the guess is wrong. [TESTED-LIVE] walkthrough; [CODE] `product-detail-slider.tsx:~395-410`.
  - Aladdin (indoor garage, valet-baggage drop-off, accessible buses with luggage help) is the best fit for a family but the priciest ($120.49); its card shows Covered/Garage as the 4th chip, so that part is visible, while the luggage-help and valet-baggage detail is only in the shuttle paragraph. [TESTED-LIVE] `cov/SAN.json`; [CODE] `lot-card.tsx:189-205` (first 4 chips).
- Likely abandonment point: at the Park Shuttle & Fly slider, when "block of time" and "large vehicle rate" appear together and the customer cannot pick the rate or give a safe return time.
- Evidence: inline tags.
- Severity: Medium
- Type: Inventory-pricing limitation + Copy-trust
- Proposed improvement: for lots whose text matches "must purchase the large vehicle rate", hide Reserve behind a "this lot requires its Large Vehicle rate - ask for support" notice, or add ResLab rate selection when parking types differ by vehicle size. Show "Late pickup is billed at the lot's flat rate (about $24.95/day)" next to the check-out time. Acceptance: Park Shuttle & Fly's slider displays both rules above the price box.
- Needs browser repro?: yes. Tablet 744px: check the slider's time-select layout and the Park Shuttle & Fly slider paragraph readability.

### 3.8 Nashville toddler family, car seats and a no-shuttle lowest price
- Profile: iPhone SE (3rd gen), 375x667, Safari. BNA. Thu 2026-11-26 8:00 AM to Mon 2026-11-30 9:00 PM (4 nights; snapshot prices are from Nov 20-24). 2 adults, a 3-year-old and a 6-month-old, 2 car seats, 1 double stroller. Objection: "Uber with two car seats is a mess. Can the shuttle even take the seats?"
- Goal: shuttle that takes car seats and a stroller, or a walkable alternative.
- Entry point: `https://www.triplypro.com/nashville-bna/airport-parking`.
- Attempted journey: lowest total is Southwestern $28.40, then Cambria $53.98, Best Western $56.25, others $56-60. Looks for any statement about car seats, strollers, luggage space.
- Friction:
  - The cheapest lot, Southwestern, carries the "Lowest total" badge and has no shuttle ("No Shuttle. Uber and Lyft are a convenient option"), and two required extra fields (plate, make). Card shows no chips and no shuttle status. [TESTED-LIVE] `cov/BNA.json` (`amen []`, badges `lowest_total`); [CODE] `lot-card.tsx`.
  - Across 246 lots exactly ONE (CVG Holiday Inn Express) mentions child seats ("the hotel does not provide child car seats; guests requiring them must bring their own... shuttle transport will be denied without proper seating"); 0 of the 7 BNA lots do. [TESTED-LIVE] `cov/CVG.json` and keyword scan.
  - Comfort Suites BNA says "the shuttle is not wheelchair accessible" and requires booking the shuttle at least an hour ahead by phone; neither is on the card. [TESTED-LIVE] `cov/BNA.json`.
  - No travellers/children field anywhere in search or checkout; the only passenger-ish inputs are lot-specific free-text extra fields (MIA only). [CODE] `src/components/airport/search-widget.tsx`, `search-header.tsx`, `vehicle-details-step.tsx`.
  - Help FAQ "How does the shuttle service work?" says shuttles run every 10-15 minutes; BNA hotels run hourly, on demand, or 20-minute with phone booking. [TESTED-LIVE] /help; `cov/BNA.json`.
  - Support is email-only (24-48h business days), so a question about car seats before booking has no fast channel. [TESTED-LIVE] walkthrough FAQ.
- Likely abandonment point: before the first booking click, after reading "No Shuttle" for the cheap lot and finding no car-seat language on the others; she either calls a lot (phone appears on the lot page) or picks an on-airport garage.
- Evidence: inline tags.
- Severity: Medium (Low-Medium for conversion, but trust-relevant for families)
- Type: UX gap
- Proposed improvement: add a family info row on the slider/lot page sourced from a small ops table: "Child seats on shuttle: bring your own / provided / unknown", "Shuttle takes strollers: yes/no/unknown", "Book shuttle ahead". Add an FAQ "Traveling with kids and car seats?" Acceptance: BNA lots each show a value (including "Ask the lot: <phone>") and the FAQ answers whether shuttles supply seats.
- Needs browser repro?: yes. Mobile 375px: check that the lot page phone number is tappable (`tel:`) and that the slider paragraph is readable.

### 3.9 Atlanta international family, 10 nights, domestic-only shuttle
- Profile: iPhone 15 Pro Max, 430x932, Safari. ATL. Wed 2026-12-23 4:00 AM to Sat 2027-01-02 11:30 PM (10 nights). 2 adults + 3 kids, Chevy Tahoe, flying Delta to Cancun from the International Terminal. Objection: "Which terminal does the shuttle actually serve?"
- Goal: shuttle that works at 4 AM and reaches the International Terminal.
- Entry point: `https://www.triplypro.com/atlanta-atl/airport-parking`.
- Attempted journey: 3 lots. Sky Lot $57.75 ("most booked"), Four Points $55.48 ("Lowest total"), Routes $103.45. Opens each slider and tries a 4:00 AM check-in.
- Friction:
  - Sky Lot: 24/7 every 15 min but "the shuttle currently runs only to and from the Domestic Terminal" (Plane Train for International). Domestic-only is in the details paragraph, not in the card. [TESTED-LIVE] `cov/ATL.json`.
  - Four Points: shuttle 5:00 AM-12:00 AM with no shuttle 12-5 AM; "For guests flying internationally... requires riding the ATL terminal-to-terminal bus". 4:00 AM check-in is accepted by the slider. [TESTED-LIVE] `cov/ATL.json`; walkthrough (slider accepted 5 AM / 11:30 PM without warning); [CODE] no hours check.
  - Routes: "Lot is closed outside shuttle hours" (6:00 AM-11:30 PM) and "Large vehicles that take more than one spot may be charged extra on site". A 4:00 AM drop-off is impossible and a Tahoe may be charged. The slider takes 4:00 AM anyway. [TESTED-LIVE] `cov/ATL.json`; [CODE] no hours check.
  - Four Points: "No extra charges for full-size vans, pick-up trucks and large SUV's; however, the vehicle must fit into one parking spot or you must pay for appropriate number of spots" (a Tahoe fits one spot, but nothing tells her). [TESTED-LIVE] `cov/ATL.json`.
  - Walkthrough note: UI totals differ from API (Four Points UI $61.43 vs API $55.48; Sky Lot UI $63.70). A price shift between card and checkout is a family-budget trust issue. [TESTED-LIVE] orchestrator walkthrough.
  - Hub copy has ATL guidance in `src/data/airport-content/atl.ts` ("Check the shuttle before you book") but it sits in the guide section far below the lot cards. [CODE] `src/data/airport-content/atl.ts:24-26,55`.
- Likely abandonment point: at the check-in time select: she picks 4:00 AM, nothing complains, she books Routes (closed) or Four Points (no shuttle until 5), and discovers it on travel day. Or at the shuttle paragraph, given no summary line on the card.
- Evidence: inline tags.
- Severity: Medium (High if she completes booking with an impossible time)
- Type: Defect (no time-vs-hours validation) + UX gap
- Proposed improvement: parse `shuttleInfo.summary` into hour windows (many are machine-formatted: "5:00 AM - 12:00 AM: Shuttle runs ...  12:00 AM - 5:00 AM: No shuttle") and show an inline warning on the check-in/check-out selects: "No shuttle at 4:00 AM - the first shuttle leaves at 5:00 AM". Acceptance: choosing 4:00 AM at Four Points shows the warning and keeps Reserve enabled; at Routes ("closed outside shuttle hours") it blocks the choice.
- Needs browser repro?: yes. Mobile 430px: set check-in 4:00 AM in the Four Points and Routes sliders and confirm no warning appears and Reserve stays enabled.

### 3.10 Salt Lake City ski family, zero-inventory dead end
- Profile: Dell XPS desktop, 1366x768, Chrome. SLC (zero results). Sat 2026-12-19 7:00 AM to Sat 2026-12-27 6:00 PM (8 nights). 2 adults + 3 kids, Ford Expedition, 5 ski bags. Objection: "Why does the site advertise 85+ airports and show nothing?"
- Goal: find parking near SLC, or at least learn quickly that it isn't available.
- Entry point: `https://www.triplypro.com/salt-lake-city-slc/airport-parking` (Google "SLC airport parking cheap").
- Attempted journey: reads hub hero ("Free Cancellation, Trusted Lots, Instant Confirmation"), dates, Search; reads empty state; follows "Other Airport Parking".
- Friction:
  - Hub hero promises free cancellation / instant confirmation and "Find and compare parking options near Salt Lake City International Airport", then shows "No Online Availability for the Next Week... booked or unavailable for the next week". For SLC the API returns 0 lots for the snapshot dates with 2 lots considered; the "next week" wording implies a temporary sell-out that a different date could fix. [TESTED-LIVE] SLC hub; `cov/SLC.json` (`total 0, locationsConsidered 2`); [CODE] `src/lib/airport-page/content.ts:198-201`.
  - "Other Airport Parking" for SLC lists Albuquerque, Burbank, Denver, Fresno, Spokane, Idaho Falls, Atlanta, Boston, Dallas... ABQ, GEG and IDA also have zero lots. Selection is by region and traffic only, not inventory. [TESTED-LIVE] SLC hub; `squad-brief` list of 15 zero-lot airports; [CODE] `src/components/airport/other-airports.tsx:28-50`.
  - The search page empty state is a single grey line "No parking lots found for your search criteria." with no cause, no alternative and no waitlist (the waitlist prompt only handles the 100-day booking wall). [CODE] `src/components/search/search-results-list.tsx:108`; `WaitlistPrompt` uses `MAX_ADVANCE_BOOKING_DAYS` only.
  - `/airport-parking` lists all 85 airports equally, so a family cannot know in advance. [TESTED-LIVE] walkthrough.
  - Related: RSW returns `message: "No parking locations found near this airport"`, showing the API can distinguish "none exist" from "none available", but the UI collapses both into the "next week" copy. [TESTED-LIVE] `cov/RSW.json`.
- Likely abandonment point: on the hub after the "No Online Availability" panel (immediate exit), the worst moment for a ski family comparing airports.
- Evidence: inline tags.
- Severity: Medium
- Type: Inventory-pricing limitation + Copy-trust
- Proposed improvement: use `locationsConsidered` and the sample window to pick copy: "We don't have online lots at SLC yet" vs "Booked for the next week". Order "Other airports" by lots > 0 only, and add "Notify me when SLC opens" email capture. Acceptance: SLC hub never suggests ABQ, GEG or IDA; the empty state names the cause and offers a notify form.
- Needs browser repro?: yes. Desktop: confirm the notify/alternatives behavior on `/search?airport=SLC&checkin=2026-12-19&checkout=2026-12-27` after the dates fully load.

---

## Squad top findings
1. Misleading "Shuttle" tag and "Yes" for lots with NO shuttle; cheapest-priced no-shuttle lots carry "Best Price"/"Lowest total" (EWR Red Carpet, BOS Broadway, BNA Southwestern). The card never shows shuttle status. [TESTED-LIVE] EWR and BOS hubs; [CODE] `lot-grid.tsx:58`, `rates-table.tsx:60`, `lot-card.tsx:49-54`.
2. POE (cruise) hub copy and tags promise port shuttles every 5-15 minutes; 8 of 10 lots are FLL hotels with hourly AIRPORT shuttles, Fairfield "does not offer cruise parking" yet earns "Lowest total". [TESTED-LIVE] POE hub, `cov/POE.json`; [CODE] `content.ts:50,68,119`.
3. Oversize rates are not selectable or visible at search time for ResLab lots: checkout always books one spot at `parkingTypes[0]`; lot policy text (`specialConditions`: "must book Large Vehicle rate", $5-$10/day van fees, "no trucks/SUVs") never appears in the slider; only 1 of 246 lots uses the built oversize modal. [CODE] `checkout/lot/route.ts:113-140`, slider; [TESTED-LIVE] MCO/EWR/BOS/SAN lots.
4. Shuttle capacity and handling rules are buried in unbroken paragraphs: 4-passenger caps (BOS, MIA, POE, FLL), cash-only at the lot (MIA Premier), $8 shuttle fee (DEN Embassy), 7'0" garage limits; passenger count is a free-text field at 2 lots with no cap check. [TESTED-LIVE] `cov/*.json`; [CODE] `vehicle-details-step.tsx`.
5. No validation of check-in/out times against shuttle hours or lot closures (Routes ATL "closed outside shuttle hours"; Best Rate MCO last shuttle 10 PM); slider accepts any of 48 times. [CODE] no check in search/checkout; [TESTED-LIVE] walkthrough.
6. Zero-inventory dead end: SLC hub says "No Online Availability for the Next Week" and suggests ABQ/GEG/IDA (also zero); search empty state is one grey line. [TESTED-LIVE] SLC hub; [CODE] `other-airports.tsx`, `search-results-list.tsx:108`.

Confirmed non-issue: direct-lot oversize flow (JFK Parking Point) works end-to-end by design (pre-Reserve surcharge line on lot page, modal with "No oversized vehicle" default, checkout selector, at-lot estimate). [TESTED-LIVE] JFK lot page; [CODE] `vehicle-size-modal.tsx`, `vehicle-size-selector.tsx`. Not exercised in a browser; browser repro would only confirm mobile layout.

---

## Squad 4

### Squad 4 — First-time off-airport parking customers (SIMULATED reactions, evidence-grounded)

Method: snapshot (`cov/*.json`, check-in 20 Nov 10:00 → 24 Nov 14:00, fetched 6 Nov), 6 live GETs (PIT hub, Globe lot page, TPA 241 lot page, RSW hub, /help, home), code on `upstream/main`. No forms, no search API calls, no browser pane.

Corpus facts used (computed from the 246-lot snapshot, [TESTED-LIVE]):
- 134/246 lots make the guest check in at a front desk/lobby; 33 need paperwork/sticker/tag/dashboard pass; 111 have shuttle "details" longer than 600 chars (max 1,693) — one run-on blob, no line breaks.
- 128 lots' shuttle summary says "on demand" or hourly; only 30 say "every 5/10/15 min".
- 17 lots have no shuttle or it is suspended; 18 mention a port/cruise terminal; 20 mention vehicle keys; 46 mention valet.
- Lot `directions` field is empty for 237/246 lots.
- No data mojibake found (0 lots with encoding corruption) — a checked non-issue.

---

### 4.1 Hub-page first-timer confused by "Valet" badge (PIT)
- Profile: iPhone 14 (390x844), Safari. PIT (Pittsburgh). Fri 20 Nov 6:30 AM → Fri 27 Nov 9:00 PM (7 nights). Solo, own sedan. Never used park-and-fly. Wants to know "do I hand over my keys?" Objection: does not want a stranger driving his car.
- Goal: pick a lot and understand exactly what happens at the gate and on return.
- Entry point: https://www.triplypro.com/pittsburgh-pit/airport-parking
- Attempted journey: reads hub → sees two lots both badged "Valet" + "Shuttle" + "24/7 Front Desk" → looks for a "how it works" section → opens Globe lot page → reads Shuttle Service block → still unsure about keys → leaves or books blind.
- Friction:
  - Both PIT lots show a "Valet" badge; Globe's own instructions say "park in front of the office and head inside to present your reservation receipt" (reads as self-park). The badge is derived from a ResLab amenity tag. [TESTED-LIVE] hub + lot page; [CODE] lot-card.tsx:69-70 maps any `valet` amenity key to "Valet" with a key icon.
  - The codebase itself admits the tag is unreliable: "valet / self-park: NOT shown — ResLab only tags it as a lot amenity, which doesn't say which kind". [CODE] src/components/park-stay/card-facts.ts:11-12 (park-stay hides it; parking cards still show it).
  - Hub has FAQ ("How do I book", shuttle, cancel) and "Tips" but no arrival/return explainer and no "do I keep my keys". Home FAQ likewise. [TESTED-LIVE] hub + home HTML.
  - Hub tips say "Most off-airport lots run shuttles every 5–15 minutes"; Globe is "on demand". [TESTED-LIVE] hub text vs snapshot.
  - Hub copy typo "daily rates ranging from $11–$11/day". [TESTED-LIVE]
- Likely abandonment point: hub, before opening a lot (keys/valet uncertainty), or silently at lot page.
- Evidence: all tags above.
- Severity: Medium
- Type: Copy-trust / UX gap
- Proposed improvement: (a) suppress the "Valet" badge unless the lot's `shuttleInfo.details` or description confirms key handover; otherwise show "Self-park or valet: see arrival steps" or nothing. (b) Add a 4-step "How park-and-fly works" strip (Drive to lot → check in → shuttle to terminal → call/wait for pickup on return) plus "Do I keep my keys? It depends on the lot — shown in each lot's arrival steps" to hub template. Acceptance: no lot whose details contain no "key"/"valet" text shows a Valet badge; hub for every airport with inventory contains the strip; "$11–$11" renders as a single price when min = max.
- Needs browser repro?: yes — mobile Safari 390px: confirm the badge and the absence of any explainer above the fold on the PIT hub; confirm FAQ answers are collapsed.

### 4.2 Hotel-garage lot that prioritises hotel guests (DCA)
- Profile: MacBook, Chrome. DCA. Fri 20 Nov 6:00 PM → Sun 22 Nov 11:45 PM (2 nights, late return). Couple, Camry. First time. Objection: "Is this a hotel parking deal? Do I need a room?"
- Goal: book the cheapest lot near DCA and be sure the return night works.
- Entry point: https://www.triplypro.com/search?airport=DCA&checkin=2026-11-20&checkout=2026-11-22
- Attempted journey: sees Westin Crystal City 0.8 mi $56.23 (4-night snapshot) and Sheraton Suites Old Town 2.6 mi $44.63 → opens details → reads description + details → picks times in the slider → Reserve Now.
- Friction:
  - Westin details: "boarding is accommodated on a first-come, first-served basis, with priority given to registered hotel guests. Guests may have to pay for an Uber or Lyft … if the shuttle is not available." So a paid-up parker can be bumped. [TESTED-LIVE] cov/DCA.json
  - Shuttle: 4:30 AM–10:30 PM, no shuttle 10:30 PM–4:30 AM; a 11:45 PM return is outside it. Sheraton: last shuttle 10:30 PM. [TESTED-LIVE] snapshot
  - Walkthrough showed the slider accepted 11:30 PM check-out on Sky Lot (24/7) with no warning; no shuttle-hours validation found in search/lot/checkout code. [TESTED-LIVE] orchestrator walkthrough (Sky Lot only); [CODE] absence of any shuttle-hours check in src/components/search, lot, checkout, lib/reslab (grep) — [INFERRED] it behaves the same for Westin.
  - Westin: must go to hotel front desk and fill a registration form or "you will be unable to exit the gate" on return — failure mode is stated only in a 1,000+ char blob. [TESTED-LIVE]
  - Description "Hotel guests must purchase parking directly through the hotel" implies the product is for airport customers only — good, but is buried mid-paragraph. [TESTED-LIVE]
- Likely abandonment point: reading the details blob (hotel priority / Uber caveat) or, worse, after booking when the late return finds no shuttle.
- Evidence: tags above.
- Severity: High
- Type: UX gap (time-vs-shuttle) + Inventory-pricing limitation
- Proposed improvement: in the slider and lot page, after times are chosen, compare to parsed shuttle hours and show an amber inline warning "Your return time (11:45 PM) is outside this lot's shuttle hours (last shuttle 10:30 PM) — you may need a rideshare" with a link to other lots. Acceptance: for any lot whose summary contains "No shuttle" windows, choosing a time inside that window shows the warning before Reserve Now; lots with 24/7 show none.
- Needs browser repro?: yes — desktop: DCA search → Westin → choose 11:30 PM check-out; verify no warning appears.

### 4.3 Early-flight traveller, hotel lot with 15-minute registration (IAD)
- Profile: iPad (810x1080), Safari. IAD. Sat 21 Nov check-in 4:30 AM → Wed 25 Nov 10:00 PM. Family of 3, minivan. 6:30 AM flight. First time.
- Goal: park, get on a shuttle, make a 6:30 AM flight.
- Entry point: https://www.triplypro.com/dulles-iad/airport-parking/hyatt-regency-dulles-airport (slug as in snapshot, via IAD hub)
- Attempted journey: reads shuttle block → chooses 4:30 AM check-in → books → opens confirmation page and email to learn what to do at 4:30 AM.
- Friction:
  - Hyatt: "All guests must check-in at the hotel front-desk prior to parking … allow approx 15 minutes to register"; shuttle every 30 min from 6:00 AM, "24/7 … then on demand" — contradictory (summary says "No shuttle" 11 PM–6 AM; details say 24/7 on demand). [TESTED-LIVE]
  - Confirmation page "What's Next" step 1: "drive to {lot}. Follow signs for check-in parking." Step 2: "At the entrance gate, scan your QR code or enter your confirmation number." Hotel lots have no gate scan; they need the front desk. [CODE] src/components/confirmation/whats-next.tsx:29-31, 40-45 (generic hard-coded steps), vs [TESTED-LIVE] IAD/DCA/CLE/TPA details.
  - Email "What to Expect" repeats "Scan your QR code at the entrance gate" and the banner says "Show the QR code below at the facility entrance". [CODE] src/lib/resend/templates/booking-confirmation.tsx:281, 528-534
  - Step 3 "Take the Shuttle" prints the whole details blob, which includes the Arrival instructions — so the arrival rule shows under the wrong step, as one paragraph. [CODE] whats-next.tsx:48-54
  - Phone for the lot shows only as a "Call Facility" button if present; the email's "Shuttle:" line renders only for direct lots (ResLab bookings pass no `shuttlePhone`). [CODE] booking-confirmation.tsx:215, 315-319
- Likely abandonment point: not abandonment — a post-booking failure: stands at a gate/garage with a QR code at 4:30 AM, loses the 15 minutes, risks the flight; then a support email (24–48h) and refund anger.
- Evidence: tags above.
- Severity: High
- Type: Defect (confirmation copy contradicts lot instructions) / UX gap
- Proposed improvement: replace the hard-coded 4 steps with lot-specific steps: parse `shuttleInfo.details` into Arrival / Transfer / Return (split on those headings, they are consistent in ~100+ lots) and render each under its own step; show the "scan QR at gate" step only if the details do not mention front desk/lobby/attendant/office. Add "Allow N minutes to register" if present. Acceptance: for IAD Hyatt the confirmation page and email step 1-2 say "check in at the hotel front desk before parking"; no lot whose details mention front desk shows "scan QR at entrance gate".
- Needs browser repro?: no for code evidence; yes (desktop+tablet) to render a real confirmation page — cannot be done read-only (needs a booking), so repro via a staging fixture/reservation id.

### 4.4 Same-day booker told to phone the lot (CLE)
- Profile: Pixel 7 (412x915), Chrome. CLE. Today Fri 6 Nov, check-in 8:00 PM → Mon 9 Nov 7:00 PM. Solo, SUV. Urgent — leaving tonight.
- Goal: book in minutes and drive straight there.
- Entry point: https://www.triplypro.com/cleveland-cle/airport-parking (hub), then Search.
- Attempted journey: hub says "Instant Confirmation" → opens CLE Park (1.6 mi) → reads details.
- Friction:
  - Hub hero badges: "Free Cancellation · Trusted Lots · Instant Confirmation" on every hub. [TESTED-LIVE] PIT/RSW hub HTML
  - CLE Park details: "Please call CLE Park if you are making a same day booking (to confirm)"; "Please pull up to lot gate and call the number displayed on it to have staff open it"; "if you are arriving earlier or later … call us to update"; pickup "on the ticketing level, not the baggage claim area". [TESTED-LIVE] cov/CLE.json. These contradict "Instant Confirmation" and are not surfaced above the fold at selection time.
  - Shuttle for check-in "starts 4 AM" — fine for 8 PM. 2 Birds: "Call 216-905-3680 for entrance into lot". [TESTED-LIVE]
  - Lot page default dates are tomorrow/+7 with times blank (Select) — a same-day user must change both dates and both times. [TESTED-LIVE] lot page HTML (Nov 7 → Nov 14, "Please select check-in and check-out times")
  - Booking-window rules for same-day not verified here. [INFERRED]
- Likely abandonment point: lot page — "call to confirm" for a same-day booking after paying; or a phone call to a lot that does not answer.
- Evidence: tags above.
- Severity: Medium
- Type: Copy-trust
- Proposed improvement: lift "action required" phrases (call/confirm/prior arrival) from details into a bordered "Before you go" callout on the lot page and slider (next to Reserve Now), with a tel: link. Acceptance: a lot whose details contain "call" + "prior to arrival|same day|gate" shows a callout with the sentence and the phone number tappable; hero "Instant Confirmation" is removed or qualified where `limited`/call-required.
- Needs browser repro?: yes — mobile: lot page for CLE Park; check callout presence and whether a same-day check-in time is selectable.

### 4.5 Three-week trip, single-lot airport, pre-arrival call required (IND)
- Profile: Dell laptop (1440x900), Firefox. IND. Thu 3 Dec 5:00 AM → Thu 24 Dec 11:00 PM (21 nights). Retiree couple, Buick. First time. Objection: "Is it per day? Will it cost more at the lot?" and "3 weeks is a long time to leave a car at a hotel."
- Goal: confirm total for 21 days and that it's safe.
- Entry point: https://www.triplypro.com/airport-parking → Indianapolis (IND) hub (1 lot).
- Attempted journey: hub → Wyndham Indianapolis Airport (2.1 mi, $33.47 4-night snapshot) → lot page → price block.
- Friction:
  - Only one lot returned for IND: no comparison; "on demand every half hour" and "Please call (317) 248-2481 prior to your arrival to confirm your shuttle spot" are the entire instructions; not shown before booking except in the details block. [TESTED-LIVE] cov/IND.json
  - Price: lot page headline "$11.94/day" but breakdown "$11.20 x 8 days = $89.59 + $5.95 service fee = $95.54" (PIT Globe sample); a first-timer sees two "per day" numbers. [TESTED-LIVE] lot page HTML. Night vs day count differs (7 nights → "8 days"). [TESTED-LIVE]
  - "Service fee $5.95" first seen on the lot page; search card says "Taxes & fees included". [TESTED-LIVE]
  - Nothing on lot page about long-stay (security, snow, battery) or max stay. [INFERRED]
  - 24/7 front desk: good trust signal but lot says nothing on keys. [TESTED-LIVE]
- Likely abandonment point: lot page, price breakdown (two different per-day figures) or no second lot to compare.
- Evidence: tags above.
- Severity: Medium
- Type: Copy-trust / Inventory-pricing limitation
- Proposed improvement: label headline as "$X/day average incl. fees" and show "N parking days = trip length rounded up" with a tooltip; add a one-line "Charged today: $Y. Due at lot: $0" under Reserve Now. Acceptance: headline per-day × days equals the Total shown within $0.01 on every lot page; "Due at lot" line present on every booking surface.
- Needs browser repro?: yes — desktop: pick 3 Dec 5:00 AM → 24 Dec 11:00 PM and compare headline/day × days to Total.

### 4.6 Print-oriented user, QR from a third-party host (SAT)
- Profile: iPhone SE (375x667), Gmail app with "load remote images" off. SAT. Sat 28 Nov 5:30 AM → Tue 1 Dec 8:00 PM. Solo, pickup truck. First time, 61 years old, wants a printed sheet.
- Goal: get a confirmation he can print and carry.
- Entry point: https://www.triplypro.com/help (searching "do I need to print")
- Attempted journey: FAQ says no printing needed → books Homewood Suites SAT ($33.22) → opens confirmation email on phone.
- Friction:
  - Homewood: "check in at the front desk, where you will be asked to email a copy of your reservation receipt directly to the front desk agent" — the guest must send an email on arrival; the booking page never says so outside the details blob. [TESTED-LIVE] cov/SAT.json
  - Email QR is an image from `api.qrserver.com`; with images off or blocked it shows alt text only (confirmation number remains text). [CODE] booking-confirmation.tsx:219, 290-296 — also a third-party service learning the confirmation number. [INFERRED] about blocked images.
  - Help: "No, you don't need to print anything … show your confirmation email or the QR code"; Globe PIT says "(printed or on your smartphone)". Compatible but no print link on confirmation page. [TESTED-LIVE] /help + cov/PIT.json; [CODE] help/page.tsx:71
  - Email says "Need help? Help Center | Contact Us" with no phone; support is email only 24–48h. [CODE] booking-confirmation.tsx:536-545; [TESTED-LIVE] home FAQ via walkthrough
- Likely abandonment point: post-booking anxiety (no printable sheet, receipt email step), not a conversion drop.
- Evidence: tags above.
- Severity: Low
- Type: UX gap
- Proposed improvement: add a "Print / save as PDF" button on the confirmation page that outputs confirmation number, lot address, lot phone, arrival steps and return steps; inline the QR as a hosted image on triplypro.com rather than qrserver. Acceptance: confirmation email renders a QR when images are loaded from triplypro.com only; print stylesheet produces a one-page sheet with the lot phone.
- Needs browser repro?: yes — desktop print preview of a confirmation page (fixture); email client with images blocked.

### 4.7 "Free shuttle" while the lot's shuttle is suspended (OKC)
- Profile: Samsung S23 (412x915), Chrome. OKC. Mon 7 Dec 9:00 AM → Fri 11 Dec 6:00 PM. Solo, no car share. First time. Objection: "I'm paying for the shuttle."
- Goal: choose the cheaper-feeling lot.
- Entry point: https://www.triplypro.com/search?airport=OKC&checkin=2026-12-07&checkout=2026-12-11
- Attempted journey: sees DoubleTree ($20.74 total, "Lowest total") and Wyndham Garden ($33.75) → opens Wyndham → reads "Free shuttle service … included with online purchase".
- Friction:
  - Wyndham Garden description: "Free shuttle service to and from airport included with online purchase"; details: "Shuttle service is currently suspended; however, the airport is just a short and convenient Uber or Lyft ride away". [TESTED-LIVE] cov/OKC.json (direct contradiction in one lot record)
  - Card badge logic maps amenity keys; the lot does carry no shuttle amenity here but the description sells a free shuttle. [CODE] lot-card.tsx:49-54 ("No Shuttle" badge only if the key says no_shuttle).
  - DoubleTree: shuttle 6 AM–10 PM hourly, "call to arrange pick-up", "if you show up 30 min…". [TESTED-LIVE]
  - 17 lots in the snapshot have suspended/no shuttle (e.g. BNA Southwestern, EWR Red Carpet, FAT Wyndham Garden). [TESTED-LIVE]
  - Price comparison: Wyndham is $13 more with no shuttle — and no card-level signal. [TESTED-LIVE]
- Likely abandonment point: either after booking (arrives, no shuttle) or on opening the lot (contradiction → distrust).
- Evidence: tags above.
- Severity: High
- Type: Defect (lot content) / Inventory-pricing limitation
- Proposed improvement: when `shuttleInfo` matches /suspend|no shuttle|not available/ and no hours window, show a red "No shuttle currently — rideshare to terminal" badge on card and slider, strip "Free shuttle" sentences from the description, and downrank in "Recommended". Acceptance: all 17 flagged lots show the badge; none has "Free Shuttle" chip; description string does not claim a free shuttle.
- Needs browser repro?: yes — mobile: OKC search → Wyndham Garden card and slider; screenshot the chips and the description.

### 4.8 Three near-identical hotel lots (SDF)
- Profile: Windows laptop, Edge. SDF. Fri 20 Nov 7:00 PM → Mon 23 Nov 9:00 PM. Couple with elderly parent (needs short walk to shuttle). First time.
- Goal: pick the lot with the easiest pickup.
- Entry point: https://www.triplypro.com/louisville-sdf/airport-parking (hub) → Search.
- Attempted journey: sees Hampton Inn, SpringHill Suites, Residence Inn all 1.2 mi, all $41.74, "24/7 on demand".
- Friction:
  - Three lots with identical price and distance; the only differentiator is amenities (restaurant / none). Hampton carries the "Lowest total" badge though the total is equal. [TESTED-LIVE] snapshot SDF
  - All three: "check in at the front desk", "Airlines suggest arriving 2 hours prior … ensure you arrive at the parking location before this 2-hour window", "shuttle service may be unavailable on major holidays" — a 23 Nov return is in Thanksgiving week. [TESTED-LIVE] cov/SDF.json
  - "No room reservation needed" appears in descriptions; guests still go to the hotel front desk — odd for a first-timer. [TESTED-LIVE]
  - Return step "call 502-366-8100" is in a long run-on text; the confirmation page shows it only in the details blob plus a "Call Facility" button. [CODE] whats-next.tsx:51, 137-146
- Likely abandonment point: search results — choice paralysis, or they pick randomly and abandon at "holiday shuttle unavailable".
- Evidence: tags above.
- Severity: Low
- Type: UX gap
- Proposed improvement: when 2+ lots tie on total, group them ("3 hotels, same price") and show the tie-breaker (hours, wait, return phone). Surface "shuttle may be unavailable on holidays" as a chip on dates inside a holiday window. Acceptance: tied lots render a one-line differentiator; holiday-window searches show the chip for lots whose details mention holidays.
- Needs browser repro?: yes — desktop: SDF search; look at badge on identical-price lots.

### 4.9 Cruise-port lot sold in an airport search (TPA)
- Profile: Galaxy A54, Chrome. TPA. Fri 20 Nov 10:00 AM → Tue 24 Nov 2:00 PM. Couple, sedan, flying Southwest. First time.
- Goal: cheapest lot near TPA with a shuttle to the terminal.
- Entry point: https://www.triplypro.com/search?airport=TPA&checkin=2026-11-20&checkout=2026-11-24
- Attempted journey: sees 241 Car Services (5.5 mi, $47.32) beside Grand Hyatt ($48.79) and Quality Inn Ybor ($41.82, "Lowest total") → opens 241's page.
- Friction:
  - 241's address is 1236 Channelside Dr (the Port of Tampa). Overview: "Free shuttle to and from the terminal" and "Don't pay $15 at the garage" (port garage); details: "Shuttle … to and from the Port of Tampa … shuttle is only to the port"; special condition "Shuttle is only to the port". A TPA airport guest gets no airport shuttle. [TESTED-LIVE] lot page HTML + cov/TPA.json
  - Shuttle 7:00 AM–3:00 PM only. Valet: "you will be required to leave your vehicle keys" is only in the blob; no key badge (amenities: wheelchair, security). [TESTED-LIVE]
  - Return phone "1-877-886-158" is truncated (lot phone is 1-877-886-1583). [TESTED-LIVE] cov/TPA.json (details vs `phone`) — 10 lots flagged by regex for possible phone truncation, only TPA verified.
  - Grand Hyatt Tampa return instruction: "call 502-579-0053" — a Louisville (502) number at a Tampa hotel; lot phone is (813) 874-1234. Looks like a copy-paste error from an SDF lot. [TESTED-LIVE] cov/TPA.json
  - Quality Inn Ybor: 7.9 mi, shuttle 10 AM–2 PM only, "Shuttle payment will be collected at that time." — a paid shuttle sold as a parking deal (not free); flagged as lowest total. [TESTED-LIVE]
- Likely abandonment point: none (conversion likely continues); defect surfaces after booking as no shuttle / wrong phone — highest real-world harm in the squad.
- Evidence: tags above.
- Severity: Blocker
- Type: Defect (lot content / inventory filter)
- Proposed improvement: add a per-lot override list (and a lint on sync) that excludes lots whose details say "only to the port|cruise" from airport searches, flags details phone numbers whose digits don't match the lot phone (or whose area code differs), and flags non-free shuttle. Acceptance: TPA search no longer returns 241 Car Services; a nightly check reports every lot whose details contain a phone not equal to `phone`.
- Needs browser repro?: yes — mobile: TPA search and lot slider; verify the exact text a customer sees, incl. whether "Free Shuttle" chip shows.

### 4.10 Zero-inventory airport via /help (RSW)
- Profile: iPhone 13 (390x844), Safari. RSW (Fort Myers). Sat 12 Dec 6:00 AM → Sat 19 Dec 10:00 PM. Family of 4, minivan. First time.
- Goal: understand how this works (via /help), then book RSW.
- Entry point: https://www.triplypro.com/help → "Airports" → https://www.triplypro.com/fort-myers-rsw/airport-parking
- Attempted journey: reads FAQ ("What do I do when I arrive?", "How does the shuttle service work?") → picks RSW from the 85-airport list → hub → searches dates.
- Friction:
  - /help: "show your confirmation QR code or email to the attendant … Some facilities have self-service kiosks"; "Most … offer free shuttle … Shuttles typically run every 10-15 minutes" — contradicted by lots on demand/hourly/suspended (128 on demand/hourly vs 30 at ≤15 min). [CODE] src/app/(main)/help/page.tsx:118-125; [TESTED-LIVE] snapshot counts
  - /airport-parking lists all 85 airports equally; RSW is one of 15 with no lots. [TESTED-LIVE] orchestrator walkthrough + snapshot
  - RSW hub: hero "Free Cancellation · Trusted Lots · Instant Confirmation", "Pick your dates to search", then "Parking Options Coming Soon … Use the search above to check for the latest availability." — the user is told to search an airport with zero lots. No waitlist prompt visible in the static hub HTML (WaitlistPrompt is rendered only inside search-widget after a failed search). [TESTED-LIVE] hub HTML; [CODE] src/components/airport/search-widget.tsx:148 (only when `waitlistRequested`).
  - The same footer says "100+ Verified Parking Partners" while this airport has 0. [TESTED-LIVE]
  - ABQ and 13 others behave the same (not re-fetched). [INFERRED]
- Likely abandonment point: after searching RSW and getting "no results" (sunk time), or at the hub on "Coming Soon" with hero trust badges that read as instant availability.
- Evidence: tags above.
- Severity: Medium
- Type: Inventory-pricing limitation / Copy-trust
- Proposed improvement: on zero-lot hubs, replace hero trust badges with "No lots yet — get notified" and render the waitlist form inline (email only, no data entered here); order /airport-parking with lots-first and mark the rest "Coming soon". Acceptance: the 15 zero-lot hubs show the waitlist form without needing a failed search; /airport-parking visually separates covered from uncovered airports; hub hero shows no "Instant Confirmation" badge when lot count is 0.
- Needs browser repro?: yes — mobile: RSW hub; check whether the waitlist form appears before search; submit nothing.

---

## Squad top findings
1. TPA "241 Car Services" is a cruise-port valet lot sold in airport results: shuttle only to the Port of Tampa, truncated return phone (…886-158), keys must be left; Grand Hyatt Tampa lists a 502 (Louisville) return number. [TESTED-LIVE] (cov/TPA.json, lot page HTML)
2. Confirmation page and email hard-code "scan your QR code at the entrance gate" and "follow signs for check-in parking", while 134/246 lots require a front-desk/lobby check-in; the lot's real arrival steps are dumped as one run-on blob under "Take the Shuttle". [CODE] whats-next.tsx:29-54, booking-confirmation.tsx:281, 528-534; [TESTED-LIVE] cov/*.json
3. Lots with suspended/no shuttle (17) and others with no-shuttle windows are sold with "Free shuttle" copy and no time-vs-shuttle-hours check (OKC Wyndham Garden "shuttle suspended" vs "free shuttle included"; DCA/IAD late returns). [TESTED-LIVE] cov/OKC.json, cov/DCA.json; [CODE] lot-card.tsx:49-54; absence of validation [CODE]
4. "Valet" badge on lots that read as self-park (both PIT lots) from an unreliable ResLab amenity tag; no "do I keep my keys" answer anywhere pre-booking. [TESTED-LIVE] PIT hub; [CODE] lot-card.tsx:69-70, card-facts.ts:11-12
5. Help/hub copy overpromises shuttle cadence ("every 5–15 minutes") while 128/246 lots are on-demand/hourly; no "how park-and-fly works" explainer on home/hub/lot pages. [CODE] help/page.tsx:123-125; [TESTED-LIVE] PIT hub + home HTML
6. Zero-inventory hubs (RSW) keep "Free Cancellation / Trusted Lots / Instant Confirmation" hero and "100+ Verified Parking Partners" while saying "Coming Soon"; waitlist only appears after a failed search. [TESTED-LIVE] RSW hub HTML; [CODE] search-widget.tsx:148

Confirmed non-issues: no mojibake in lot data (0/246); lot page does show address/phone/map and a Google Maps directions link exists in the email and confirmation; the email's "On return, call for shuttle pickup" matches most lots' return rule; Help FAQ clearly explains "Due at Location" and refund rules.

---

## Squad 5

### Squad 5 — Frequent business travelers (simulated reactions, evidence-grounded)

Extra live evidence gathered (3 API calls, all `&surface=featured`, 2026-11-06):
- SFO 2026-12-07 6:00 AM → 12-09 9:00 PM (2 nights): Best Western Grosvenor returned, `minimumBookingDays=5`, daily, grandTotal $46.99 (identical to the 4-night snapshot total). Other 4 lots hourly, $27.52–$37.88.
- ORD 12-07 6 AM → 12-08 11 PM (1 night): Crowne Plaza (min 3), Marriott Suites (min 3, daily, $56.70), Pride (min 3, due at lot) all returned alongside non-min lots.
- LGA 12-08 7 AM → 8 PM (same day): Purchase Park 2 Fly (min 2) returned at $53.56; Carvia and Parking Place flagged due-at-lot.
- Code (upstream/main): search page + lot-card + search-results-list contain NO reference to minimumBookingDays; it is enforced only in product-detail-slider.tsx:158-167 and booking-widget.tsx:190-206,354-361.

### 5.1 Monday-morning ORD 1-nighter, desktop
- Profile: MacBook Pro 14" 1512px, Chrome; ORD; Mon 2026-12-07 6:00 AM → Tue 12-08 11:00 PM (~41h); solo, company sedan; urgent (booking same morning as flight prep); wants cheapest safe, non-valet; objection: wasted clicks.
- Goal: book the cheapest ORD lot for 1 night in under 3 minutes.
- Entry point: https://www.triplypro.com/search?airport=ORD&checkin=2026-12-07&checkout=2026-12-08
- Attempted journey: sees 6 cards; sorts "Lowest Total"; top card is the cheapest; also eyes Marriott Suites ($56.70) and Crowne Plaza (badge "Limited", $38.79) because of hotel brand; opens Crowne Plaza "View Details".
- Friction:
  - Crowne Plaza / Marriott Suites / Pride appear as normal 1-night results but require 3 days; the card shows no minimum-stay note. The user only learns after opening the slider ("Minimum 3 days required", Reserve disabled). [TESTED-LIVE: API returned them for a 1-night search] [CODE: no minimumBookingDays in search page/lot-card; slider.tsx:158-167]
  - Total shown on card is the price for min-days billing, not 1 night, so ranking by "Lowest Total" mixes unbookable lots with bookable ones. [INFERRED]
  - Times not in search header; must be chosen again in slider. [TESTED-LIVE walkthrough]
- Likely abandonment point: after clicking into a "Limited" min-3 lot and finding Reserve greyed out; mild — user backs out and picks Super 8.
- Evidence: see tags above.
- Severity: High
- Type: Defect / UX gap
- Proposed improvement: In search results, when stay days < lot.minimumBookingDays, either hide the lot from the list or render it greyed with "Requires 3-day minimum" and exclude it from sort/"Lowest total" badge. Acceptance: for ORD 1-night search, no card is clickable-to-Reserve that cannot reach checkout; Lowest-total badge never lands on a below-minimum lot.
- Needs browser repro?: yes — desktop: run the ORD 1-night URL, confirm cards for Crowne Plaza/Marriott/Pride show no min-stay hint, open one and read the slider message; check badge/sort order.

### 5.2 SFO 2-night with the "Most booked" trap, phone
- Profile: iPhone 15 (393x852), Safari; SFO; Tue 2026-12-08 6:00 AM → Thu 12-10 9:00 PM; solo; rental-car-free; urgent (booking in Uber on the way); wants closest/shuttle; objection: "no shuttle" lots.
- Goal: pick a lot with a real shuttle at SFO and book on phone.
- Entry point: https://www.triplypro.com/search?airport=SFO&checkin=2026-12-08&checkout=2026-12-10
- Attempted journey: opens mobile map-card carousel; "Book Now" on the card with the "Most booked" badge (Best Western Grosvenor $46.99); taps through.
- Friction:
  - Best Western Grosvenor is `minimumBookingDays=5` + `limited` + "most_booked" yet returned for a 2-night search at a flat $46.99 (same price as 4 nights). A 2-night traveler is effectively sold a 5-day price. [TESTED-LIVE: SFO API call; snapshot SFO]
  - Its shuttle text has a gap (10:15 AM–5:00 PM no shuttle) and 3 of the other 4 SFO lots are "No shuttle / arrange Uber/Lyft" — shuttle info is not a card-level filter/badge differentiator beyond a generic "Free Shuttle" chip rule. [TESTED-LIVE: snapshot SFO shuttle fields] [INFERRED: chip logic on lot-card]
  - Mobile map-card "Book Now" label vs desktop "View Details": confirm Book Now still routes through time selection. [CODE: mobile-map-card snapshot "Book Now"] [INFERRED]
- Likely abandonment point: slider "Minimum 5 days required" (disabled Reserve) after tapping the most-promoted card.
- Severity: High
- Type: Defect / Inventory-pricing limitation
- Proposed improvement: Same fix as 5.1, plus: never apply "Most booked" badge to a lot the current stay cannot book; show a "No shuttle — rideshare" chip when shuttleInfo says so. Acceptance: SFO 2-night result has no min-5 card with a promo badge; shuttle chip text matches shuttleInfo for all 5 SFO lots.
- Needs browser repro?: yes — phone 393px: check carousel card for Best Western, what "Book Now" does (opens slider vs direct to checkout), whether min-days message appears and is readable.

### 5.3 Receipt-for-expenses seeker after checkout, desktop
- Profile: Windows laptop 1920x1080, Edge; LGA; Mon 2026-12-14 7:00 AM → Wed 12-16 8:00 PM; employee booking on a company card; objection: expense policy needs itemized receipt with company/billing name and tax line.
- Goal: after booking, get an itemized PDF receipt that shows tax, fees, and a company name.
- Entry point: https://www.triplypro.com/confirmation/<reservation-number> (post-booking) or https://www.triplypro.com/reservations
- Attempted journey: opens confirmation page; looks for "Download receipt / invoice"; checks /reservations card; checks /help for "receipt".
- Friction:
  - Confirmation page's only record-keeping action is the footnote "We recommend saving or printing this confirmation for your records" — no print button, no PDF, no invoice. [CODE: confirmation/[id]/page.tsx:604-609]
  - No field anywhere for company/business name or VAT/tax ID; checkout collects only name, email, phone, vehicle. [CODE: customer-details-step; checkout-form.tsx customerDetails shape] [INFERRED: absence in help]
  - Confirmation does render an itemized breakdown (lines → total → paid online/due), so the data exists; the receipt can be screenshot/printed. [CODE: booking-details.tsx:113-147]
  - /help has no receipt/invoice/expense entry (searched for receipt, invoice, expense, business, corporate: none). [CODE: help/page.tsx]
  - For due-at-lot lots (LGA Carvia $85.63 of $109.32 due on site) the online charge is only part of the total; the expense report needs the lot's own receipt. [TESTED-LIVE: snapshot LGA]
- Likely abandonment point: not abandonment of booking, but post-purchase churn — emails support (24–48h) and does not book again; or books a competitor that issues invoices.
- Severity: Medium (High for business segment)
- Type: UX gap
- Proposed improvement: Add "Print / Download receipt" on /confirmation/[id] and each /reservations card: itemized (subtotal, fees, tax, protection, paid online, due at lot), optional "Bill to" free-text. Acceptance: one click produces a PDF with line items + tax and a user-entered company name; works for guest confirmations.
- Needs browser repro?: yes — desktop: open a real confirmation and Print preview; confirm there is no print-specific stylesheet and that totals/tax lines are legible.

### 5.4 Saved-details repeat booker (30 trips/yr), desktop
- Profile: Dell XPS 1366x768 laptop, Chrome; CLT; Wed 2026-12-02 5:30 AM → Fri 12-04 9:30 PM; signed in from last trip; same car every time; objection: re-typing phone + plate + vehicle every trip.
- Goal: book Radisson/Sheraton CLT in under 60 seconds using saved info.
- Entry point: https://www.triplypro.com/search?airport=CLT&checkin=2026-12-02&checkout=2026-12-04 (signed in)
- Attempted journey: search → slider → Reserve → checkout step 1 → step 2 vehicle → pay.
- Friction:
  - Checkout prefill for a signed-in user sets only first/last name (split from auth metadata) and email — phone is NOT prefilled even though /account saves `phone` via PUT /api/user/profile. [CODE: checkout-form.tsx:137-152; account/page.tsx handleSaveProfile; api/user/profile/route.ts:9,63]
  - No saved vehicle anywhere: /account has name/phone/password only; vehicle step is typed every time. [CODE: account/page.tsx; vehicle-details-step.tsx] 
  - Name prefill is derived from `user_metadata.full_name`, not from the saved customer profile; an email/password account without full_name yields empty names. [CODE: checkout-form.tsx:141-148] [INFERRED re: account types]
  - Help says an account lets you "check out faster next time" — the claim is only partly true (email+name). [CODE: help/page.tsx:206]
- Likely abandonment point: none; but a conversion-speed loss — every one of 30 trips re-enters phone + make/model/plate.
- Severity: Medium
- Type: UX gap / Copy-trust
- Proposed improvement: Prefill phone from customer profile and add "Save this vehicle to my account" with one-tap restore at step 2. Acceptance: second booking by a signed-in user starts step 1 with name/email/phone populated and step 2 offers saved vehicle; step 1 → payment ≤ 2 clicks.
- Needs browser repro?: yes — desktop: needs a real account (cannot be done under read-only rules): check step 1 for phone prefill and step 2 for any saved-vehicle control.

### 5.5 "Book the same trip again" from past reservations, phone
- Profile: iPhone SE (375x667), Safari; BOS; weekly Mon 2026-12-07 6:00 AM → Thu 12-10 10:00 PM; signed in; objection: repeat weekly trip, wants one tap.
- Goal: rebook last week's Boston lot with new dates.
- Entry point: https://www.triplypro.com/reservations
- Attempted journey: Past tab → last booking card → look for "Book again"; falls back to "Book Another" on confirmation page.
- Friction:
  - Reservation card links only to the confirmation page; no "Book again / Rebook this lot" CTA, no pre-filled search. [CODE: reservation-card.tsx:143-147, 238-263 (only link + cancel)]
  - Confirmation page's "Book Another" goes to bare `/search` (no airport/lot/dates carried). [CODE: confirmation/[id]/page.tsx ~ "Book Another" Link href="/search"]
  - Past/Upcoming split uses `isPast(check_in)`, so an in-progress trip (checked in yesterday, returning today) sits in "Past" — a traveler away from home can't find "my active parking". [CODE: reservations/page.tsx upcoming/past filter; `isToday` rescues only same-day check-in]
  - Phone: default route requires being signed in; if not, redirect to /auth/login?redirect=/reservations. [CODE: reservations/page.tsx:50-56]
- Likely abandonment point: at "Book Another" landing on empty /search — user types airport and dates again, mild drop.
- Severity: Medium
- Type: UX gap
- Proposed improvement: Add "Book again" on each card → `/search?airport=<code>&checkin=<next same weekday>…` and make in-progress trips show under Upcoming/"Active". Acceptance: tapping Book again lands on a results page for the same airport with the previous lot highlighted; a trip whose checkout ≥ now is listed under Upcoming.
- Needs browser repro?: yes — phone 375px: needs signed-in account with a past booking; check card CTAs and the tab bucketing of an in-progress stay.

### 5.6 Calendar-add that drops the return day, desktop
- Profile: MacBook Air 1440px, Chrome + Google Workspace; MDW; Tue 2026-12-01 6:30 AM → Thu 12-03 10:00 PM; assistant forwards itinerary to the boss's calendar; objection: wrong end date means missing pickup reminder.
- Goal: add the booking to Google Calendar with correct times.
- Entry point: https://www.triplypro.com/confirmation/<reservation-number>
- Attempted journey: "Add to Calendar" → Google Calendar button.
- Friction:
  - Google/Outlook deep links use date-only values (`dates=YYYYMMDD/YYYYMMDD` for Google) → an all-day event; Google treats the end date as exclusive, so a trip ending 12-03 shows 12-01 to 12-02 and the return day is missing; check-in/out times appear only in the description. [CODE: add-to-calendar.tsx generateGoogleCalendarUrl; ends at `checkOut` not +1 day]
  - The .ics path does it right (timed DTSTART/DTEND, or all-day with +1 day); the web links and ICS behave differently. [CODE: add-to-calendar.tsx generateICSFile + addOneDayForICS]
  - "Apple Calendar" and "Download .ics" both do the same download (duplicate). [CODE: calendarOptions]
  - Event time zone is floating (no TZID) → shows in the viewer's zone, wrong when flying across zones. [CODE: ICS DTSTART without Z/TZID] [INFERRED]
- Likely abandonment point: none — silent wrong calendar entry; boss misses return pickup info.
- Severity: Medium
- Type: Defect
- Proposed improvement: Google/Outlook links pass timed start/end (`YYYYMMDDTHHMMSS/…`) with `ctz=<airport tz>`; ICS adds TZID. Acceptance: adding a Dec 1 6:30 AM → Dec 3 10 PM booking to Google yields a timed event spanning both dates in the airport's zone.
- Needs browser repro?: yes — desktop: click Google Calendar on a confirmation and inspect the event dates in the Google composer (can't without a real confirmation; can unit-test generateGoogleCalendarUrl).

### 5.7 DAL zero-inventory, phone, Southwest commuter
- Profile: Pixel 8 (412x915), Chrome; DAL (Love Field); Thu 2026-12-03 6:00 AM → Fri 12-04 10:00 PM; business; urgent; objection: just needs any lot.
- Goal: find parking at Love Field.
- Entry point: https://www.triplypro.com/airport-parking → tap Dallas Love Field (DAL)
- Attempted journey: picks DAL from the 85-airport list; lands on search; sees nothing; tries DFW as an alternative.
- Friction:
  - DAL is listed as an equal destination but the API returns 0 lots (considered 0). [TESTED-LIVE: snapshot DAL "0 lots (considered 0)"; walkthrough: /airport-parking lists all 85 equally]
  - Search page for DAL returns HTTP 200 and the empty state is a single line: "No parking lots found for your search criteria." — no suggestion of DFW, no "notify me", no explanation that DAL is unsupported (vs a bad date). [TESTED-LIVE: curl /search?airport=DAL → 200; CODE: search-results-list.tsx:108; no nearby/alternative string in search code]
  - "85+ airports" claim vs 70 airports with inventory; DAL specifically promises service. [TESTED-LIVE: snapshot 15 zero airports]
- Likely abandonment point: immediately at the empty list; user leaves the site.
- Severity: High
- Type: Inventory-pricing limitation / Copy-trust
- Proposed improvement: Mark zero-lot airports (or hide) on /airport-parking, and on an empty result show "We don't have lots at DAL yet" + "Try DFW (~9 mi)" link + email-me. Acceptance: DAL search shows alternatives list or notify form; /airport-parking visually distinguishes 70 vs 15.
- Needs browser repro?: yes — phone 412px: open the DAL search URL and screenshot the empty state (hydrated); confirm no alternative airport link.

### 5.8 Sort-by-Closest for DCA quick turn, desktop keyboard-only
- Profile: Lenovo ThinkPad 1920x1080, Firefox, keyboard-only (no mouse, uses Tab/Enter); DCA; Mon 2026-12-07 6:00 AM → Tue 12-08 8:00 PM; business; needs speed and a covered garage in winter; objection: mouse-only controls.
- Goal: pick the closest covered lot and finish checkout with the keyboard.
- Entry point: https://www.triplypro.com/search?airport=DCA&checkin=2026-12-07&checkout=2026-12-08
- Attempted journey: Tab to sort select → choose "Closest"; open View Details with Enter; Tab to check-in time select; Tab to Reserve.
- Friction:
  - Only 2 DCA lots; sort by Closest puts Westin Crystal City (0.8 mi, covered_garage, "most booked") first; fine. [TESTED-LIVE: snapshot DCA] [CODE: search/page.tsx:187-190 sorts by distanceFromAirport]
  - Slider time `<select>`s have no accessible labels (observed in walkthrough) → a screen-reader/keyboard user hears "combobox" with no name; default "Select". [TESTED-LIVE: walkthrough] [CODE: product-detail-slider.tsx time selects]
  - The slider is a fixed overlay (z-60) with a close button but no evidence in code of focus trapping or Escape handling; focus can drift to the page behind. [CODE: product-detail-slider.tsx:~200-215 close button + backdrop onClick only] [INFERRED: no Escape handler seen]
  - Whether Closest mode applies is only visible in the select; sorting is client-side (no URL param echo), so sharing/bookmarking loses it. [CODE: page.tsx adds sort to the API params; unclear if persisted in URL] [INFERRED]
  - Dist sort treats missing distance as 999 mi (sorted last) which is acceptable. [CODE: page.tsx:187-190] — confirmed non-issue.
- Likely abandonment point: at the unlabeled time selects/ focus trap; user times out or gives up on the keyboard path.
- Severity: Medium
- Type: UX gap
- Proposed improvement: Add `aria-label`s ("Check-in time"), `role="dialog"`/`aria-modal`, focus trap + Escape to close in the slider. Acceptance: axe shows no unlabeled-select violation; Tab never leaves the open slider; Esc closes and returns focus to the View Details button.
- Needs browser repro?: yes — desktop: keyboard-only pass on the live slider (Tab order, Esc, label names via read_page).

### 5.9 AUS hourly-vs-daily and 24-hour-block billing check, phone
- Profile: Samsung Galaxy S23 (360x780), Chrome; AUS; Mon 2026-12-07 8:00 AM → Wed 12-09 11:30 PM (63.5h); cost-conscious team lead who audits receipts; objection: "billed 3 days for 2 nights?"
- Goal: confirm the price before paying.
- Entry point: https://www.triplypro.com/search?airport=AUS&checkin=2026-12-07&checkout=2026-12-09
- Attempted journey: sees Comfort Suites AUS (limited, 24/7 Lyft shuttle); opens slider; sets times; reads price breakdown; compares with another airport.
- Friction:
  - ResLab hourly lots bill 24-hour blocks from the check-in time (ceil(hours/24)); daily lots bill calendar days inclusive. AUS Comfort Suites is hourly: 63.5h → 3 blocks; a 4-night snapshot said "4-night" but UI bills "5 days" for Fri 10AM→Tue 2PM (walkthrough). The UI does not explain the rule near the price. [CODE: reslab/client.ts:743-770 calculateDays] [TESTED-LIVE: walkthrough "5 days"] [CODE: price-breakdown.tsx / slider have no "24-hour block" explanatory copy — grep for "24-hour" returned only code comments]
  - For daily lots (BDL Days Inn, ORD Marriott, SFO Best Western) a 1-night trip is billed as 2 calendar days; the user cannot tell whether a lot is hourly or daily on the card. [TESTED-LIVE: snapshot `daily` flags] [INFERRED: not shown in lot-card]
  - Search list totals (no times) differ from slider totals (with times); UI total ($61.43) differs from API grandTotal ($55.48) in walkthrough, so figures a traveler screenshots for an expense preapproval can change. [TESTED-LIVE: walkthrough]
  - "Limited" badge with no remaining-count or time pressure semantics — fine as is. [TESTED-LIVE: snapshot]
- Likely abandonment point: in the slider when the displayed price jumps after times are chosen.
- Severity: Medium
- Type: Copy-trust / UX gap
- Proposed improvement: Under the total in slider and checkout: "Billed as N × 24-hour days (Mon 8:00 AM → Wed 11:30 PM)" with a "Add 30 min earlier checkout saves a day" hint when the overshoot is ≤ 1h. Acceptance: breakdown text shows billed-days rule and the day count matches API `days`.
- Needs browser repro?: yes — phone 360px: AUS slider, set 8:00 AM / 11:30 PM then change checkout to 7:30 AM, confirm total and day count change and whether copy explains it.

### 5.10 Same-week double booking and cancel/rebook, desktop
- Profile: HP laptop 1536x864, Chrome; DFW→ORD route (books ORD Tue and MDW Thu next week); signed in with work email but one booking made as guest with personal email; objection: two bookings, two emails, one confirmation page each.
- Goal: view both trips together; change Thursday's time (no edit).
- Entry point: https://www.triplypro.com/reservations
- Attempted journey: sees Upcoming; finds guest booking missing; "Add to my account" prompt; tries to change time; reads FAQ.
- Friction:
  - Guest booking under a different email isn't claimable (claim only works for the account's verified email). Prompt shows "We found N reservation(s) under your email". [CODE: reservations/page.tsx claimableCount block]
  - No edit/modify: must cancel (free >24h) and rebook — rebuild the whole booking incl. vehicle info; within 24h can't cancel online at all (email only, 24–48h business days). [TESTED-LIVE: FAQ walkthrough "There's no edit option yet"] [CODE: help/page.tsx:49-61]
  - Cancel flow exists and works only if `ENABLE_SELF_SERVE_CANCEL` is on; the page hides Cancel when the flag is off, so a business traveler could see no cancel option and no explanation. [CODE: reservations/page.tsx selfCancelEnabled gating]
  - Free cancel window is 24h; the snapshot cancel policy `{numberOfDays:0, percentage:100}` conflicts in wording with "24h before check-in" — our messaging is more restrictive than the supplier field. [TESTED-LIVE: snapshot cancellationPolicies] [INFERRED: policy is Triply-layered]
  - Support is email only (24–48 business hours) — for a 6 AM flight change the night before this is a dead end. [TESTED-LIVE: FAQ walkthrough]
- Likely abandonment point: trying to change a booking inside 24h — user gives up, eats the cost or no-shows.
- Severity: High (for the segment's flight-change reality)
- Type: UX gap / Inventory-pricing limitation
- Proposed improvement: Add "Change dates" that cancels+rebooks with prefilled lot/vehicle in one flow (when >24h), and a clear "Within 24h? Call/text X" fallback; show "Cancellation unavailable online" reason instead of silently hiding the button. Acceptance: reservation card for a >24h booking offers Change dates prefilled; <24h shows explanatory line with contact path.
- Needs browser repro?: yes — desktop: needs signed-in account; check button visibility with and without the flag, text for within-24h bookings.

## Squad top findings
1. Search results show lots that cannot be booked for the requested short stay (SFO Best Western min 5 for a 2-night trip at a flat $46.99, ORD Crowne Plaza/Marriott/Pride min 3 for 1 night, LGA Purchase Park min 2) with no card-level warning, sometimes with "most booked"/"limited" badges; enforcement only after opening the slider. [TESTED-LIVE + CODE: slider.tsx:158-167, no minimumBookingDays in search page/lot-card]
2. No receipt/invoice at all: confirmation has only a "save or print" footnote; no company name/tax-ID field; /help has no receipt entry. Business expense workflow is unsupported. [CODE: confirmation/[id]/page.tsx:604-609; help/page.tsx]
3. "Check out faster next time" is thin: signed-in prefill sets only name+email; phone saved in /account is not used; no saved vehicle; no "Book again" on /reservations cards; "Book Another" goes to bare /search. [CODE: checkout-form.tsx:137-152; reservation-card.tsx:143-263; confirmation page]
4. DAL (and 14 other marketed airports) dead-end: listed equally, search returns 200 with a one-line empty state, no alternate airport or notify option. [TESTED-LIVE: snapshot DAL + curl; CODE: search-results-list.tsx:108]
5. Change/cancel inside 24h has no online path and support is 24–48h email — high-severity for travelers whose flights shift. [TESTED-LIVE: FAQ walkthrough; CODE: help/page.tsx:49-61]
6. Google/Outlook calendar links are date-only (Google end exclusive), dropping the return day and times; .ics is correct; Apple and .ics buttons duplicate. [CODE: add-to-calendar.tsx]

---

## Squad 6

### Squad 6 — Skeptical customers: trust and payment

Simulated reactions grounded in evidence. No conversion or revenue numbers are claimed.
Fetched live this session (4 GETs): Apex EWR lot page, JFK Parking Point lot page, /terms, /contact. No search API calls. Code refs are `upstream/main` (`src/...`).

Facts reused across scenarios:
- Live Apex EWR lot page (8-day default stay): "Total $88.68 / Due at location $68.46 / Pay at Location - Payment will be collected on-site at check-in". Card charge = about $20.22 (derived; the page never states it) [TESTED-LIVE]. The widget footer reads "Full refund if cancelled", with no 24h mention [TESTED-LIVE].
- Live Apex page shows the lot's phone numbers and a partial street address, plus "Full address details will be sent to your email after booking confirmation" [TESTED-LIVE].
- Live /terms contains both "IE Holdings, L.L.C., (TriplyPro)" (section 13) and "Triply, Inc., New York, NY" (section 14). The footer says "Triply Inc." (`components/shared/footer.tsx:145`) [TESTED-LIVE + CODE].
- Live /contact: "We typically respond within 24-48 hours during business days"; email `support@triplypro.com`; no phone or chat [TESTED-LIVE].
- 21 of 246 lots return money due at the lot, and it is 77-89% of the total at most of them (snapshot, 4-night). Examples: EWR Apex $44.01 of $53.19; JFK Bolt $115.85 of $144.28; ORD Pride $83.68 of $95.88; MIA Premier Cruise $76.65 of $92.64; LGA Carvia $85.63 of $109.32 [TESTED-LIVE: snapshot].
- All 246 lots in the snapshot JSON carry a `phone` field; none carries a rating or review field (snapshot).

---

### 6.1 "Pay-at-lot math" mobile skeptic
- Profile: iPhone 14 (390x844), Safari. EWR. Fri 2026-12-04 4:30 AM to Tue 2026-12-08 11:30 PM (4 nights). 1 adult, mid-size sedan. Booking this evening. Needs a lot that is open for a pre-dawn departure. Objection: "Does this charge me the whole $60 now, or what? Where is the rest of my money going?"
- Goal: Find the cheapest lot near EWR and know exactly what the card is charged today versus what is owed at the lot.
- Entry point: `https://www.triplypro.com/new-york-ewr/airport-parking/apex-airport-parking` (from a Google result).
- Attempted journey:
  1. Reads headline "$11.09/day $88.68 Taxes & fees included" and a small amber "Pay at Location" box.
  2. Scrolls to the price breakdown and sees "Total $88.68 / Due at location $68.46".
  3. Tries to work out the card charge by subtraction.
  4. Taps Reserve Now.
  5. Reaches checkout step 1, where the summary shows Total, Due Now and Due at Location.
  6. Reaches the payment step with button "Pay Now - $X".
- Friction:
  - Box copy "Payment will be collected on-site at check-in" reads as if all payment is at the lot. Only 77% is [TESTED-LIVE; CODE `product-detail-slider.tsx:501-512`].
  - The lot page never states "You pay today: $X". The figure is only derivable by subtraction [TESTED-LIVE].
  - The headline "$88.68 ... Taxes & fees included" is the whole stay, not the card charge. The search card shows only a 10px "Pay at Location" tag next to that headline (`lot-card.tsx:108-110,177-180`) [CODE].
  - Checkout is explicit: "Due Now" / "Due at Location" rows (`order-summary.tsx:250-265`), an amber "Pay at Location - $Y will be collected on-site at check-in" (`stripe-payment-form.tsx:450-460`), and a "Pay Now - $X" button [CODE]. This works, but it first appears on step 3 of the funnel after the user has typed personal data.
  - Terms 5.2 says the at-lot share is "not charged by Triply" and is outside any refund [CODE `terms/page.tsx`; TESTED-LIVE /terms]. The lot-page copy never says the at-lot part follows the lot's own rules.
  - Apex's own panel lists "Small SUV $5/Day, Large SUV $7/Day, Truck $10/Day" extras [TESTED-LIVE], on top of the at-lot balance.
- Likely abandonment point: On the lot page, or at checkout step 2, when the user calls it "bait and switch" because the first number was $88.68 and the card number is about $20 plus an unknown balance.
- Evidence: see tags above.
- Severity: High
- Type: Copy-trust
- Proposed improvement: On search cards, the lot page and the slider, replace "Pay at Location" with a two-line split, "Pay today $20.22 by card / Pay at lot $68.46 (cash or card, ask the lot)". Acceptance: on every lot with `dueAtLocation`, the pay-today figure equals the checkout "Due Now" figure to the cent, and the string "Payment will be collected on-site" no longer appears for partial amounts.
- Needs browser repro?: yes. On iPhone-width Safari, check whether the split is visible without scrolling on the slider and the lot page. Check that the lot page's total and Due Now match checkout for an 8-day and a 4-day stay. Confirm what payment methods the lot accepts, which is unknown.

### 6.2 "Who is this company?" entity check
- Profile: Desktop Chrome 1440x900. JFK. Thu 2026-12-17 9:00 AM to Mon 2026-12-21 6:00 PM (4 nights). Business traveler, expenses the trip and needs a legal entity on the receipt. Objection: "Never heard of Triply. Is it a real company, or a reseller wearing a lot's name?"
- Goal: Confirm who is charging the card and who runs the lot before paying.
- Entry point: `https://www.triplypro.com/` then `/about`, `/terms`, `/privacy`.
- Attempted journey:
  1. Scans the home trust row, footer, About, Terms, Privacy and Contact.
  2. Looks for a street address, phone, registration number and the lot operator's legal name.
- Friction:
  - Three different names: footer "Triply Inc." [CODE `footer.tsx:145`]; Terms and Privacy "Triply, Inc., New York, NY" [CODE `terms/page.tsx:213`, `privacy/page.tsx:225`]; Terms section 13 "IE Holdings, L.L.C., (TriplyPro)" [TESTED-LIVE /terms]. None is a street address and none has a state of incorporation.
  - Terms 4.1 says the user contracts "with the parking facility operator" and Triply is "not a party". Section 7 disclaims "actions or omissions of parking facility operators". A skeptic reads this as "you have no recourse against Triply if the lot misbehaves" [CODE; TESTED-LIVE].
  - The operator is not named on search cards or the lot header in the evidence available. Lot names are brand names ("Apex Airport Parking") with no legal entity. ResLab appears nowhere in the customer UI (grep of `src/app/(main)` and `src/components`: only internal imports and admin pages) [CODE].
  - About says "Lots come from established booking partners" with no names [CODE `about/page.tsx`].
  - Contact is email only: support@, legal@ [TESTED-LIVE].
  - Copy-trust positive: Terms section 4.1 openly says Triply is an intermediary, which is honest.
- Likely abandonment point: At Terms section 13, when "IE Holdings, L.L.C." appears for the first time and does not match the footer. Some users leave to Google the entity and may not return.
- Evidence: see tags above.
- Severity: Medium (High for business/expense users)
- Type: Copy-trust
- Proposed improvement: Use one legal name consistently (footer, Terms, Privacy, Stripe statement descriptor, email footer). Add an "About / Who we are" block with the registered entity, state, mailing address and "DBA TriplyPro". Add "Operated by <lot legal name>" on each lot page. Acceptance: grep of production HTML for "IE Holdings", "Triply Inc" and "Triply, Inc" returns one consistent entity, and the operator name appears on every lot page.
- Needs browser repro?: no. The text is static, confirmed live. Optionally check the Stripe receipt descriptor, which only a real booking can show (not allowed).

### 6.3 "What if the lot is closed at 5 AM?" night-owl
- Profile: Pixel 7 (412x915), Chrome. ORD. Sat 2026-11-28 5:15 AM to Sat 2026-12-05 11:45 PM (7 nights). Traveling with an elderly parent, so no tolerance for being stranded. Objection: "Who do I call if the gate is shut and nobody answers?"
- Goal: Pick a lot that is staffed at 5 AM and find who to call at that hour.
- Entry point: `https://www.triplypro.com/search?airport=ORD&checkin=2026-11-28&checkout=2026-12-05`
- Attempted journey:
  1. Opens View Details on Pride Airport Parking, the pay-at-lot option.
  2. Reads the shuttle line and picks 5:15 AM in the time select.
  3. Looks for "what if closed" on the lot page, Help and Terms.
  4. Looks for an after-hours support number.
- Friction:
  - The time picker accepts any of 48 half-hour slots with no check against shuttle or staff hours. The orchestrator confirmed no warning for 5:00 AM at Sky Lot; lots with "No shuttle 12:00 AM-5:00 AM" exist (ATL Four Points) [TESTED-LIVE: walkthrough + snapshot]. ORD per-lot hours were not individually fetched [INFERRED for ORD].
  - Help and Terms have no entry for "lot refuses the booking / is closed / is overbooked". Searched `help/page.tsx` and `terms/page.tsx` for refus/honor/closed/overbook/turned away: no matches [CODE].
  - Terms section 6 puts the duty on the customer: "Arrive and depart during the facility's operating hours" [CODE]. The customer cannot see those hours when choosing a time.
  - Support is email-only with a 24-48 h response [TESTED-LIVE]. The contact form does flag urgent messages if a reservation number is entered ("On your trip right now? Add your reservation number — we flag urgent messages to our team straight away") [CODE `contact-page-client.tsx:91-92`]. That is a good mitigation, but it depends on the user having signal and going to the form rather than a phone.
  - Positive: the confirmation page has a "Call Facility" `tel:` button when the lot has a phone (`whats-next.tsx:137-143`), and all 246 snapshot lots carry a phone [CODE; TESTED-LIVE snapshot]. The phone also shows on the lot page pre-booking (Apex) [TESTED-LIVE].
- Likely abandonment point: In the slider, after choosing 5:15 AM and finding no statement that the lot will be open or staffed. The user either calls the lot, if they find the number, or leaves.
- Evidence: see tags above.
- Severity: High
- Type: UX gap
- Proposed improvement: Parse shuttle and front-desk hours into the time selects. Show an inline amber note when the chosen time falls outside shuttle hours ("This lot's shuttle does not run 12-5 AM"). Add a Help entry, "If the lot can't honor your booking", saying who Triply contacts and what Triply refunds. Acceptance: selecting a time inside a "No shuttle" window shows a visible warning before Reserve, and a Help FAQ exists that answers a lot refusing the booking.
- Needs browser repro?: yes. On Pixel-width Chrome, open the ORD slider for several lots, pick 5:15 AM, and screenshot whether any warning appears. Verify the shuttle strings for each ORD lot.

### 6.4 "Cruise lot, 83% at the lot" tablet booker
- Profile: iPad (820x1180), Safari. MIA. Sun 2026-12-13 10:00 AM to Sun 2026-12-20 4:00 PM (7 nights, Caribbean cruise). Couple, SUV. Booking 5 weeks ahead. Objection: "6 miles from the port, one-sixth paid online, who runs this?"
- Goal: Park for a week near a cruise port and confirm it is a real operation.
- Entry point: `https://www.triplypro.com/miami-mia/airport-parking/premier-cruise-parking`
- Attempted journey:
  1. Sees Premier Cruise Parking at about $92.64 for 4 nights, with $76.65 due at the lot (83%).
  2. Notices it is 6.3 mi from MIA.
  3. Sees `minDays=3 daily`.
  4. Proceeds to checkout and reaches the extra field "number of passengers".
- Friction:
  - For this lot only $15.99 of $92.64 is paid by card; the rest is at the lot [TESTED-LIVE: snapshot]. For a skeptic, the lot holds nearly all the risk, but Triply's guarantee covers only the online part (Terms 5.2) [CODE].
  - It is 6.3 mi from the airport and is a cruise lot. The Miami hub has no "port vs airport" explanation in anything checked here [INFERRED].
  - `minDays=3 daily` means daily billing. A 10 AM-to-4 PM return would be billed as 8 days, not 7 nights. The orchestrator saw a Fri 10 AM to Tue 2 PM trip billed "5 days" on the UI [TESTED-LIVE: walkthrough]. For this MIA trip the same logic is [INFERRED]; confirm in a browser.
  - Extra field "number_of_passengers" is required on this lot [TESTED-LIVE: snapshot]. It is unexplained.
  - "100+ Verified Parking Partners" has no definition of "verified" (footer.tsx:67) [CODE].
- Likely abandonment point: Checkout step 2 (Vehicle Info), when asked for passenger count and cruise-style data by a site that said "airport parking".
- Evidence: see tags above.
- Severity: Medium
- Type: Inventory-pricing limitation
- Proposed improvement: On lots flagged as cruise or farther than 5 mi, show a "Cruise parking, 6.3 mi from MIA, shuttle to port" strip and a per-lot "what 'verified' means here" line. Acceptance: any lot with `distanceFromAirport` over 5 mi shows an explicit port/airport label, and every extra field has a one-line reason.
- Needs browser repro?: yes. On iPad width, load the lot page for a 10 AM-4 PM, 7-night stay. Check the day count, the Due Now amount, and the passengers field wording at checkout.

### 6.5 "Will I be charged twice?" card-security worrier
- Profile: Desktop Firefox 1366x768. SEA. Wed 2026-12-02 7:00 AM to Sat 2026-12-12 9:00 PM (10 nights). Solo, Subaru. Was double-charged by another travel site once. Objection: "If the page hangs or I hit Back, do I pay twice?"
- Goal: Pay once with a card and be sure of the exact charge.
- Entry point: `https://www.triplypro.com/search?airport=SEA&checkin=2026-12-02&checkout=2026-12-12` (Fox Parking SeaTac, about $94 for 4 nights, no at-lot amount).
- Attempted journey:
  1. Gets to payment step. Ticks the terms box. Sees "Complete Booking - $X".
  2. Considers: what if 3-D Secure opens, or the network drops?
- Friction:
  - Positive (a confirmed non-issue): the charge is a Stripe manual-capture authorization. The card is authorized only and "Money moves only after ResLab confirms a reservation exists" (`stripe-payment-form.tsx:311-313`) [CODE]. The pending booking is persisted server-side BEFORE confirming the charge, and the form aborts if that fails (`checkout-form.tsx:960-968`) [CODE]. This is strong double-charge protection, but none of it is visible to the customer.
  - "Processing" and "post-auth" states exist to avoid retry-into-double-charge, and Back/Pay are locked while paying [CODE].
  - 3-D Secure: if `requires_action` is returned, the user sees "Additional authentication required. Please try again." (`stripe-payment-form.tsx:336-338`). That text invites a second click, which is the very behavior this user fears. It is a dead-end message, not an authentication prompt [CODE]. Normal Stripe 3DS happens inside `confirmPayment`, so this path is probably rare [INFERRED].
  - Copy: "Secured with 256-bit SSL encryption" (`stripe-payment-form.tsx:479`), "Secure payment, processed by Stripe" [CODE; TESTED-LIVE walkthrough]. The authorization-only behavior is never said.
  - Footer badges "SSL Secured" and "PCI DSS" are plain `div`s with no link or attestation (`footer.tsx:133-136`). Card entry is in Stripe's Payment Element, so the claim is plausible but self-asserted [CODE; INFERRED].
- Likely abandonment point: Pay button, if the user reads "Additional authentication required. Please try again." after a 3DS timeout. Otherwise the flow holds up.
- Evidence: see tags above.
- Severity: Medium
- Type: Copy-trust
- Proposed improvement: Under the Pay button add "You'll only be charged once. Your card is authorized now and charged after the lot confirms." Change the `requires_action` message to "Your bank needs to confirm this payment. Complete the bank prompt; do not pay again." Acceptance: a Stripe test card requiring 3DS shows the new text, and a test with a forced network drop leaves exactly one PaymentIntent.
- Needs browser repro?: yes. On desktop, use Stripe test mode on a local or staging environment (not production) with test card 4000 0027 6000 3184, then check the messages. Do not run in production.

### 6.6 "Free cancellation... tomorrow?" last-minute iPhone SE
- Profile: iPhone SE (375x667), Safari. IAH. Check-in tomorrow, Sat 2026-11-07 6:00 AM, return Tue 2026-11-10 8:00 PM (3 nights). Flight is booked. Risk-averse and read "Free Cancellation" in the hero. Objection: "I'll book and cancel if my plans change, right?"
- Goal: Book for tomorrow morning with a real cancellation fallback.
- Entry point: `https://www.triplypro.com/` then search IAH, or `/houston-iah/airport-parking`.
- Attempted journey:
  1. Reads hero badges "Free Cancellation" and "Instant Confirmation".
  2. Opens a lot slider (Hilton Garden Inn Houston/Bush, about $30 for 4 nights) and sees a green "Free Cancellation".
  3. Reaches checkout step 1.
- Friction:
  - The slider's "Free Cancellation" is hard-coded for every lot with no check on the check-in date (`product-detail-slider.tsx:310-312`) [CODE].
  - Checkout hides the free-cancellation badge when check-in is fewer than 2 days away (`checkout-form.tsx:101`, `order-summary.tsx:41`) [CODE]. The user therefore sees the promise on the search results and it disappears at checkout, with no explanation.
  - The terms checkbox still says "I can cancel for free up to 24 hours before check-in" (`terms-acceptance.ts`). For a booking made less than 24 hours before check-in, this is literally impossible [CODE].
  - Terms 5.3: within 24 h online cancel is blocked, handled "case-by-case", and "No-shows are not refunded" [CODE; TESTED-LIVE /terms].
  - Lot-page widget wording varies: Apex shows "Full refund if cancelled" with no 24h limit; JFK Parking Point shows "Free cancellation up to 24h before" because it has no policy (`booking-widget.tsx:163-167`) [TESTED-LIVE; CODE]. A user can read two different cancellation promises on two lots with the same cancel rules.
  - Whether the site blocks bookings inside 24 hours of check-in entirely was not verified.
- Likely abandonment point: Step 1 of checkout, when the green cancel badge is missing, or after booking, when Cancel is disabled and support takes 24-48 h.
- Evidence: see tags above.
- Severity: High
- Type: Defect
- Proposed improvement: Make "Free Cancellation" in the slider and widget conditional on the same lead-time gate as checkout; inside 24 h show "Not cancellable online - contact support". Acceptance: for a check-in less than 24 h out, no screen between search and payment shows an unconditional free-cancel promise, and the checkbox wording matches the lead time.
- Needs browser repro?: yes. On mobile, search IAH for tomorrow's check-in. Compare the slider, the lot widget, checkout step 1 and the checkbox text. Do not submit.

### 6.7 "Where are the reviews?" 21-night snowbird
- Profile: Windows laptop, Edge, 1280x720. PHX. Mon 2026-12-28 8:00 AM to Mon 2027-01-18 5:00 PM (21 nights). Retiree, long stay. Objection: "4.9 from whom? I can't find one review."
- Goal: Pick a trustworthy lot for three weeks from reviews and ratings.
- Entry point: `https://www.triplypro.com/phoenix-phx/airport-parking`
- Attempted journey:
  1. Sees "4.9 Rating" in the hero and "Join 5,000+ smart travelers".
  2. Opens lots (La Quinta Tempe about $21/4 nights, marked "limited"; Howard Johnson; Crowne Plaza).
  3. Looks for the reviews section.
- Friction:
  - "4.9 Rating" is a hard-coded label with no source or link (`hero.tsx:237`) [CODE]. "5,000+ smart travelers" is hard-coded newsletter copy (`newsletter.tsx:159`) [CODE]. About says "read real reviews" [CODE `about/page.tsx`].
  - The lot Reviews section renders nothing until the lot has at least one consented review, and the average only shows from 3 ratings (`lot-reviews.tsx:67`; `summary.ts` `MIN_REVIEWS_FOR_RATING = 3`) [CODE]. That design is honest, but the result is that the claim "4.9" sits next to lot pages with no reviews. The snapshot JSON carries no rating field on any of the 246 lots [TESTED-LIVE: snapshot].
  - When reviews do exist, each is labeled as from "a guest who booked this lot on Triply" ("Verified guest"), which is a good trust signal [CODE `lot-reviews.tsx:82`].
  - The search slider prints "({reviewCount || 0} ratings)" when a rating exists, and the sort "Top Rated" exists (orchestrator walkthrough) with no visible ratings behind it [CODE; TESTED-LIVE: walkthrough].
  - "limited" availability on La Quinta Tempe is a scarcity label whose source is not shown (not verified here) [INFERRED].
  - A 21-night stay hits a quote path I did not test; the 60-day booking window cap noted in project memory does not affect a stay starting within 60 days [INFERRED].
- Likely abandonment point: Lot page, scanning for reviews, when none exist and the "4.9" has no origin.
- Evidence: see tags above.
- Severity: Medium
- Type: Copy-trust
- Proposed improvement: Either link "4.9 Rating" to a source (Google/Trustpilot/internal average with N) or remove it until it is substantiated. Show "Be the first to review - guests are invited after their stay" on lots without reviews. Acceptance: every numeric trust claim on the home page links to a page that states source, N and date; "Top Rated" sort shows the rating it sorted by or is hidden when fewer than 3 lots have ratings.
- Needs browser repro?: yes. On desktop, check whether any lot in PHX/SEA/EWR shows ratings, and what "Top Rated" orders by when none do.

### 6.8 "Why do you need my phone?" privacy-minded Mac user
- Profile: MacBook Air 1440x900, Safari with tracker blocking. MSY. Fri 2026-12-11 12:00 PM to Mon 2026-12-14 3:30 PM (3 nights). Privacy-conscious, uses a throwaway email alias. Objection: "I won't hand over my number and plate to an unknown site, and I want to decline cookies."
- Goal: Book without giving more data than necessary, and decline tracking.
- Entry point: `https://www.triplypro.com/new-orleans-msy/airport-parking`
- Attempted journey:
  1. Meets the cookie banner.
  2. Opens a lot (DoubleTree New Orleans Airport, about $51 for 4 nights) and reaches checkout.
  3. Reads the required fields.
- Friction:
  - Cookie banner: "By continuing to browse, you consent to our use of cookies." with a single "Got it" button and no decline (`cookie-banner.tsx:29-35`) [CODE; TESTED-LIVE: walkthrough]. A "Cookie Settings" link exists in the footer and on the Privacy page [TESTED-LIVE: footer on lot page; CODE `privacy/page.tsx`], so opt-out exists but is hidden.
  - Phone is required, with the stated reason "For booking updates and shuttle coordination" (checkout step 1) [TESTED-LIVE: walkthrough]. `Phone number is required` is enforced (`checkout-form.tsx:376-377`) [CODE]. Privacy policy confirms booking details are shared with the lot [CODE `privacy/page.tsx`: "We share necessary booking details (name, contact info, vehicle details, reservation dates) with parking facilities"]. So the number goes to a third party the customer cannot yet identify.
  - Positive: "No account needed - book as a guest" and Stripe handles card data; "We do not sell your personal information" [CODE; TESTED-LIVE: walkthrough].
  - Email is used for guest cancellation: a different alias on return means a lost cancel path (help FAQ: "sign in with the same email") [TESTED-LIVE: walkthrough FAQ].
- Likely abandonment point: Checkout step 1, at the required phone field for a privacy-minded user, or on the banner if they want "Reject".
- Evidence: see tags above.
- Severity: Low (High for this persona)
- Type: Copy-trust
- Proposed improvement: Add "Manage" or "Decline non-essential" to the banner. Next to the phone field say who receives it ("shared only with <lot name> for arrival issues"). Acceptance: a first-visit user can decline analytics from the banner in one click, and no analytics script fires after Decline.
- Needs browser repro?: yes. On desktop, with a clean profile, click Got it versus Cookie Settings and watch network requests for GA/Clarity before and after.

### 6.9 "Is anything even available?" zero-inventory airport
- Profile: Desktop Chrome 1920x1080. SLC. Thu 2026-12-10 6:00 AM to Sun 2026-12-13 10:00 PM (3 nights). Ski trip. Google result for "Salt Lake City airport parking deals". Objection: "Does this site actually have lots, or is it a lead-gen shell?"
- Goal: Find parking at SLC, or learn quickly that none is available.
- Entry point: `https://www.triplypro.com/airport-parking` then SLC, or `/search?airport=SLC&checkin=2026-12-10&checkout=2026-12-13`.
- Attempted journey:
  1. Lands on the all-airports list.
  2. Picks SLC.
  3. Gets results.
- Friction:
  - The page markets "85+ US airports" (`airport-parking/page.tsx:10-19`), and lists all 85 equally. 15 return zero lots: ABE ABQ AZO DAL GEG IDA MEM ROA RSW SLC SNA YOW YUL YYC YYZ [TESTED-LIVE: snapshot]. Four of those are Canadian (YOW, YUL, YYC, YYZ), so "US airports" in the title is also wrong [CODE; TESTED-LIVE: snapshot].
  - A zero-lot airport ends at the generic "No parking lots found for your search criteria." (`search-results-list.tsx:108`) [CODE]. It has no alternatives, no waitlist/notify, and no nearby airport. The hub page at 0 lots drops the FAQ and guide and is noindexed (`[slug]/airport-parking/page.tsx:71,110-112`) [CODE], so most users reach it by the list, not by search.
  - "100+ Verified Parking Partners" and "Compare hundreds of parking options" sit on every page, including the empty one [CODE `footer.tsx:67`].
  - Inventory is a ResLab-sourced catalogue (70 airports with lots), so the "85+" claim may not be wrong in the strict sense but overstates what a user can book today [INFERRED].
- Likely abandonment point: Search results for SLC, immediately. The user concludes the site is a thin aggregator and does not return.
- Evidence: see tags above.
- Severity: Medium
- Type: Inventory-pricing limitation
- Proposed improvement: On the airport list, mark airports with no live lots ("No lots yet - notify me") or hide them; change the zero-result message to name the cause and offer a notify field. Acceptance: for each of the 15 zero-lot airports the list shows a "no lots yet" state, and the empty search page has a next step beyond "No parking lots found".
- Needs browser repro?: yes. On desktop, visit the list and the SLC and YYZ search pages. Check the empty state and whether a waitlist exists. The code has a waitlist-notify cron (`api/cron/waitlist-notify`) that may serve this, so check whether it is exposed on SLC.

### 6.10 "Guest booking, now I need to cancel" Apple Pay on Android-sized phone
- Profile: Samsung Galaxy S23 (360x780), Chrome with Google Pay. LGA. Fri 2026-12-11 11:00 AM to Sun 2026-12-13 7:00 PM (2 nights). Booked as a guest with a work email, then the trip is moved and the cancel is needed 3 days before check-in. Objection: "I never made an account; is the free cancellation real, and will I get all my money back?"
- Goal: Cancel for a full refund and get the card refunded.
- Entry point: `https://www.triplypro.com/reservations` (from the confirmation email link) and `/help`.
- Attempted journey:
  1. Opens My Reservations.
  2. Is asked to sign in with the email used.
  3. Reads Help and Terms for the refund.
- Friction:
  - Booking said "No account needed - book as a guest", yet cancelling needs sign-in to an account tied to that email. The checkout copy mentions "sign up later with this email" [TESTED-LIVE: walkthrough; CODE terms 5.1]. The Help FAQ for "can't cancel online" lists the same-email step and a 24h window as reasons [CODE `help/page.tsx`].
  - Refund covers only what was charged online: "everything you paid online - parking, taxes, and the Triply service fee", but not the at-lot part, which was never charged [CODE `help/page.tsx`; TESTED-LIVE /terms]. For an LGA pay-at-lot lot such as Carvia ($85.63 of $109.32 at the lot), the refund is only about $23.69 by arithmetic, with nothing owed at the lot if cancelled [TESTED-LIVE: snapshot; INFERRED for the refund figure].
  - Refund timing: "typically appear within 5-10 business days" (Terms 5.4) [CODE; TESTED-LIVE /terms].
  - Confirmation email sender: `Triply <bookings@triplypro.com>` (`lib/resend/client.ts:11`) [CODE]. Whether it lands in spam or on a work-domain filter is unknown. The contact reply says "check your spam folder too" [CODE].
  - If the guest email has a typo or an alias, there is no phone or chat fallback. Contact form only [TESTED-LIVE].
  - Park Guard protection: "partly non-refundable" appears in several places [CODE]. For a user who accepted a pre-selected plan, the non-refundable share is a surprise. Memory notes say pre-select was removed (Plan A), but I did not verify that live.
- Likely abandonment point: After booking, not before. The user hits the sign-in wall on Reservations, which is a trust loss and a likely support ticket or chargeback.
- Evidence: see tags above.
- Severity: Medium
- Type: UX gap
- Proposed improvement: Add a magic-link cancel in the confirmation email ("Cancel this booking"), valid until 24h before check-in, with no sign-in. Acceptance: a guest can cancel from the email link alone, the page shows the exact refund before confirming, and the at-lot amount is shown as "not charged, nothing owed".
- Needs browser repro?: yes. On mobile Chrome, open `/reservations` signed out, and read what it says to a guest. Verify the help copy, not the cancel action (no real booking allowed).

---

## Squad top findings
1. **Pay-at-lot split is hidden until late.** At 77-89% at-lot lots (21 of 246: EWR Apex, JFK Bolt, ORD Pride, MIA Premier Cruise, LGA Carvia), the lot page and card headline the full total and say "Payment will be collected on-site", never "pay today $X". Checkout is explicit, but only on step 3. [TESTED-LIVE: Apex page; CODE `lot-card.tsx:177-180`, `stripe-payment-form.tsx:450-460`]
2. **Cancellation promises conflict.** The slider shows an unconditional "Free Cancellation" and the lot widget says "Full refund if cancelled", while Terms 5.3 blocks online cancel inside 24h and checkout hides the badge when check-in is under 2 days. Same-day and next-day bookers are most exposed. [CODE `product-detail-slider.tsx:310-312`, `checkout-form.tsx:101`; TESTED-LIVE: Apex widget, /terms]
3. **Entity names do not match.** "Triply Inc." (footer), "Triply, Inc., New York, NY" (Terms/Privacy) and "IE Holdings, L.L.C., (TriplyPro)" (Terms 13), with no street address, phone or named lot operator. [TESTED-LIVE: /terms; CODE `footer.tsx:145`]
4. **Trust numbers are unsourced and the reviews behind them are missing.** "4.9 Rating", "5,000+ travelers" and "100+ Verified Parking Partners" are hard-coded strings. The lot Reviews section renders nothing below one review, and no snapshot lot carries a rating. [CODE `hero.tsx:237`, `newsletter.tsx:159`, `footer.tsx:67`, `lot-reviews.tsx:67`; TESTED-LIVE: snapshot]
5. **No answer for "the lot won't honor my booking" or "closed at 5 AM".** Help and Terms have no such entry. The time picker allows any slot regardless of shuttle hours. Support is email-only, 24-48h. Mitigations exist: an urgent flag on the contact form with a reservation number, a "Call Facility" button after booking, and lot phones shown pre-booking. [CODE `help/page.tsx`, `contact-page-client.tsx:91`, `whats-next.tsx:137`; TESTED-LIVE: /contact, Apex page, walkthrough]
6. **Double-charge protection is real but silent.** Stripe manual capture (authorize now, capture after ResLab confirms) and a persisted pending booking before charge are strong, but the customer is never told, and the `requires_action` message "Additional authentication required. Please try again." invites a retry. This is a confirmed non-issue in engineering, a copy gap for trust. [CODE `stripe-payment-form.tsx:311-338`, `checkout-form.tsx:960-968`]

---

## Squad 7

### Squad 7 — early-morning, late-night and long-trip travelers (SIMULATED reactions, evidence-grounded)

Method: coverage JSON parsed (246 lots / 70 airports; first parse silently dropped files with non-UTF-8 bytes, redone with utf-8), upstream/main code read, 2 live `/api/search?...&surface=featured` calls (ATL 42-day, HOU 21-day). No forms, no browser.

Shuttle-hours census of the 246 snapshot lots (regex on shuttleInfo summary+details) [TESTED-LIVE, snapshot]:
- 132 lots say 24/7. 22 say "no shuttle" at all (walk or own Uber/Lyft). 92 list limited or irregular hours. So 114 of 246 (46%) are not a 24/7 shuttle.
- Common windows: opens 4:00–6:30 AM, last run 10:00 PM–12:00 AM. Some have midday gaps (BWI Clarion 10 AM–5 PM none; SFO Best Western 10:15 AM–5 PM none; LAS Best Western 1:00–4:30 PM none; IAH Comfort Suites 11:30 AM–3 PM none).
- Code never compares picked check-in/check-out time to shuttle hours: `grep shuttle` over upstream/main `src/components/{search,lot,checkout}`, `src/app/api/{search,checkout}` returns only display strings (product-detail-slider.tsx:462-470, lot-overview.tsx:29-46) plus the lot-card badge, no comparison anywhere [CODE].
- The lot-card "No Shuttle" badge keys on an amenity key containing "no_shuttle"/"no shuttle" (lot-card.tsx:49-54). The snapshot amenities for the no-shuttle lots (PHX La Quinta/Howard Johnson, SFO x4, LAS Fairfield, LAX 9750) contain no such key, so the card most likely shows no shuttle warning [CODE + TESTED-LIVE snapshot; the rendered card needs a browser check].

---

### 7.1 4:30 AM drop-off for a 6:05 AM flight (ATL, cheap-lot hunter)
- Profile: Pixel 8, Chrome, 412px; ATL; check-in Mon 2026-12-07 4:00 AM, return Thu 2026-12-10 1:00 AM (red-eye home), 2.9 days; solo, sedan; urgency high (first flight out); objection "will someone actually be there at 4 AM".
- Goal: cheapest lot that works at 4 AM and again at 1 AM.
- Entry point: https://www.triplypro.com/search?airport=ATL&checkin=2026-12-07&checkout=2026-12-10
- Attempted journey: search shows Four Points (lowest total) and Routes; opens View Details; picks 4:00 AM and 1:00 AM from the 48-slot selects; Reserve Now; checkout.
- Friction:
  - Routes ATL shuttle 6:00 AM–11:30 PM, "11:30 PM–6:00 AM: No shuttle". Four Points 5:00 AM–12:00 AM, none 12–5 AM. Both are outside the hours at 4:00 AM and 1:00 AM. Orchestrator confirmed Routes accepts 4:00 AM / 1:00 AM with no warning. Only Sky Lot (24/7) is valid for both times. [TESTED-LIVE]
  - Search cards and header carry no times, so the hours conflict only exists inside the slider, where nothing checks it. [TESTED-LIVE][CODE slider 462-470 display only]
  - The "Lowest total" badge sits on Four Points, which fails this traveler's 4 AM need. [TESTED-LIVE]
  - Shuttle text is a long free-text paragraph inside the scrolling slider, mid-page. [TESTED-LIVE]
- Likely abandonment point: either leaves after calling the lot (support is email-only, 24–48h, so no) or books the wrong lot and is stranded at 4 AM; the cost shows up as a bad review/refund, not as a drop-off.
- Evidence: [TESTED-LIVE] Routes/Four Points hours + ATL snapshot; [CODE] no hours-vs-time check (see census); [INFERRED] stranded outcome.
- Severity: High
- Type: Defect (missing validation) / Copy-trust
- Proposed improvement: parse shuttle hours into `{open, close}` per lot (store alongside `shuttleInfo`); in the slider, when a chosen time falls in a "no shuttle" window, show an inline amber warning "No shuttle at 4:00 AM — runs 6:00 AM–11:30 PM. You'd need your own ride." with the 24/7 alternatives, and require a checkbox acknowledgment before Reserve. Acceptance: Routes + 4:00 AM shows the warning; Sky Lot + 4:00 AM shows none; lots with free-text that fails to parse show the raw text unchanged.
- Needs browser repro?: yes — mobile 412px: pick 4:00 AM on Routes and confirm no warning at checkout step 1–3 and on the confirmation page; also whether the card shows any shuttle-hours hint.

### 7.2 Red-eye lands 12:45 AM, parked at a hotel lot (DCA, iPhone)
- Profile: iPhone 14, Safari, 390px; DCA; depart Tue 2026-12-08 6:00 AM, back landing Fri 2026-12-11 12:45 AM (so the lot visit is ~1:30 AM Fri), 3 days; couple, SUV; objection "I can't leave my car across a river at 1 AM with no way back".
- Goal: park near DCA, get to the car after a late flight.
- Entry point: https://www.triplypro.com/search?airport=DCA&checkin=2026-12-08&checkout=2026-12-11
- Attempted journey: opens both lots; has to decide whether return date is Thu or Fri.
- Friction:
  - Both DCA lots stop early: Westin Crystal City 4:30 AM–10:30 PM ("10:30 PM–4:30 AM: No shuttle"), Sheraton Old Town 7:00 AM–10:30 PM (last shuttle 10:30). Neither can pick up at 1:30 AM or a 6 AM-flight 4 AM leave. [TESTED-LIVE snapshot]
  - Only 2 lots at DCA, so there is no good alternative to offer; zero 24/7 DCA lots. [TESTED-LIVE snapshot]
  - The return DATE the traveler must enter is the calendar day of pick-up (Fri), but the picker only shows dates and the traveler thinks "my trip ends Thursday". Header and results never show times, so a search for Thu gets priced at default 2:00 PM Thu; changing to Fri 1:30 AM in the slider changes the billed days. [TESTED-LIVE walkthrough: header no times] [CODE time.ts:200-258 default 10:00 AM / 2:00 PM]
  - Slider rejects return ≤ pickup silently as "not bookable" (use-live-price.ts:69-72) with no explanation. [CODE]
- Likely abandonment point: reads the shuttle text in the slider and leaves; or never reads it.
- Evidence: [TESTED-LIVE] shuttle strings; [CODE] use-live-price.ts:69-72; [INFERRED] date-vs-time confusion on a past-midnight return.
- Severity: High
- Type: UX gap + Inventory-pricing limitation
- Proposed improvement: add a "Landing after midnight? Pick the date you'll collect the car" helper under the return-time select when the chosen time is 12:00–4:30 AM. Show a "last shuttle" chip on the lot card ("Last shuttle 10:30 PM") from parsed hours. Acceptance: card shows the chip for every non-24/7 lot; selecting 1:00 AM return shows the helper line.
- Needs browser repro?: yes — iPhone 390px: does the select list scroll to 12:00–4:30 AM easily, and what does the not_bookable state say when return time is before pickup?

### 7.3 Six-week stay, NYC resident parking at LAX (device in Eastern time)
- Profile: iPhone 15 Pro Max, Safari; LAX; check-in Sat 2026-12-05 7:15 AM PT, return Sat 2027-01-16 9:00 PM PT, 42 days; 1 SUV; urgency low; objection "does $/day stay the same for 6 weeks, and is anything due later".
- Goal: find the lowest total for 42 days and trust it.
- Entry point: https://www.triplypro.com/search?airport=LAX&checkin=2026-12-05&checkout=2027-01-16
- Attempted journey: sorts Lowest Total, checks "$/day vs total", opens 9750 Airport Blvd (min 2 days, no shuttle) and 405 Airport Parking.
- Friction:
  - 8 LAX lots; the cheapest on the 4-night snapshot, 9750 Airport Blvd ($44.12), has "No shuttle. Guests will need to arrange their own transportation" and a 2-day minimum. [TESTED-LIVE snapshot]
  - Fox Parking is a daily lot (min 3 days, "12:00 AM–12:00 AM" shuttle). Hourly vs daily lots round differently for a 42-day stay (see 7.9 for measured 21 vs 22 days). [TESTED-LIVE snapshot]
  - One LAX lot (limited) has hoursBeforeReservation=24, so same-day/next-morning bookings are blocked for it only; unlikely here but invisible on the card. [TESTED-LIVE snapshot]
  - Timezone: check-in "today" filtering uses the AIRPORT timezone (time.ts:148-165, booking-widget.tsx:129), good. But the booking-window max (+100 days) and picker min are computed from the DEVICE's local calendar (booking-window.ts:32-34, toLocalISODate). An Eastern device late in the evening is already "tomorrow" relative to PT only for the min/max boundary day; low impact. [CODE][INFERRED impact]
  - ATL live check shows a 42-day search works and prices per-day (Sky Lot $11.55×42 = $485.10 incl 5% service fee). No max-stay cap in code (`grep maximum_booking/MAX_STAY` found nothing). [TESTED-LIVE ATL][CODE]
- Likely abandonment point: sticker shock/uncertainty at the 42-day total versus the "$/day" headline; or confusion over which lots have no shuttle.
- Evidence: see tags above.
- Severity: Low
- Type: Preference / Inventory-pricing limitation
- Proposed improvement: show total first, per-day second, plus "42 days" on the card (card already shows days elsewhere?). Acceptance: card text reads "$X total · 42 days · $Y/day".
- Needs browser repro?: yes — desktop/mobile: confirm the card shows the day count for a 42-day stay and that the Eastern-device clock does not disable Dec 5.

### 7.4 Spring trip beyond the picker cap, return date greyed out (SEA, Android)
- Profile: Galaxy S23, Chrome, 360px; SEA; check-in Wed 2027-02-10 (day 96 from today 2026-11-06), return Fri 2027-03-05 (day 119), 23 days; couple, SUV; urgency low; objection "why can't I pick my return".
- Goal: book parking for a 3-week trip while airfares are cheap.
- Entry point: https://www.triplypro.com/ (hero Depart/Return) then /search
- Attempted journey: taps Depart (Feb 10 enabled), taps Return, scrolls month; March days are greyed.
- Friction:
  - `maxAdvanceBookingDate()` = today+100 = Sun 2027-02-14, passed as `maxDate` to BOTH legs of the picker (date-range-field.tsx:35-36, hero.tsx:164, search-header.tsx:112/189, booking-widget.tsx:373, product-detail-slider.tsx:323). The picker disables `{after: maxDate}` for return too (date-picker.tsx:182-188). [CODE]
  - `validateSearchDates` also rejects a return after the cap ("Return dates are available up to Feb 14, 2027 for now.", booking-window.ts:94-97). [CODE]
  - But the ResLab wall is on CHECK-IN only (booking-window.ts:3-10 comment; `/api/lots/quote` checks only `checkin` against +101 days, quote/route.ts:115). So the Triply cap is stricter than the supplier's rule: any stay checking in after day (100 − N) cannot be searched. For a 23-day trip the last usable check-in is Jan 23, 2027 (day 78), not Feb 14. [CODE]
  - Picker footer says "Reservations open up to 100 days in advance." (date-picker.tsx:14-16) which reads as a check-in rule, not return. [CODE]
  - DST spring-forward (Sun 2027-03-14) cannot be reached via the picker until after Dec 5, 2026; no DST test is possible now. [CODE][INFERRED]
  - A waitlist exists for check-ins beyond day 100 (WaitlistPrompt.tsx:9-11, 182; MAX_WAITLIST_STAY_DAYS=60), so for check-in days 79–100 with a long stay the traveler is stuck: picker blocks return, waitlist prompt triggers only past day 100. [CODE]
- Likely abandonment point: tries Feb 14 as return, gets a 4-day trip, or leaves.
- Evidence: [CODE] all lines above; [INFERRED] who is stuck (sizing unknown).
- Severity: Medium (High for long trips booked at the window edge)
- Type: Defect (cap applied to wrong leg) / Inventory-pricing limitation
- Proposed improvement: apply `maxDate` only to the Depart leg; allow return up to check-in + 60 days (use `MAX_WAITLIST_STAY_DAYS` or a new `MAX_STAY_DAYS`); update `validateSearchDates` line 94-97 and the footer to "Check-in up to Feb 14, 2027". Acceptance: with check-in Feb 10, return Mar 5 is selectable and a search returns lots; check-in Feb 15 still triggers waitlist.
- Needs browser repro?: yes — mobile 360px: confirm March days are disabled in the Return calendar when Depart=Feb 10, and that waitlist is not offered.

### 7.5 Three-week snowbird at the cheapest PHX lot (no shuttle)
- Profile: iPad Air portrait 820px, Safari; PHX; check-in Thu 2026-12-17 9:00 AM, return Thu 2027-01-07 5:00 PM, 21 days; retired couple, SUV; objection "$/day matters more than anything".
- Goal: cheapest 21 days.
- Entry point: https://www.triplypro.com/search?airport=PHX&checkin=2026-12-17&checkout=2027-01-07
- Attempted journey: Lowest Total picks La Quinta Tempe ($20.95 on the snapshot 4-night total) or Howard Johnson ($26.25).
- Friction:
  - Both have "No shuttle. You must arrange your own transportation" yet amenity lists contain no shuttle key (La Quinta amenities empty; Howard Johnson no shuttle key), so the "No Shuttle" badge likely never renders (lot-card.tsx:49-54). The lowest-priced lots read as the best deal. [TESTED-LIVE snapshot][CODE; render unverified]
  - The warning lives only inside the slider text. [CODE slider 462-470]
  - 21-day stays amplify the "own transportation" cost: two rideshares at PHX plus the lot saves little vs a 24/7-shuttle lot (DoubleTree 4 AM–11 PM, Crowne Plaza 24/7 at $66 on snapshot). [INFERRED]
  - Crowne Plaza has 2-day min and a 7-foot clearance note; DoubleTree has pick-ups by phone call only ("please call (602)…"). [TESTED-LIVE snapshot]
- Likely abandonment point: books the cheapest, then discovers no shuttle at the airport (post-purchase regret, refund request).
- Evidence: as tagged.
- Severity: High
- Type: Copy-trust / UX gap
- Proposed improvement: derive a `shuttle: none | limited | 24-7` field and render a card badge ("No shuttle — rideshare/walk") for every `none` lot; sort "Lowest Total" ties unchanged but never show "Lowest total" on a no-shuttle lot without the badge. Acceptance: all 22 no-shuttle lots in the snapshot show the badge on the card and on mobile-map-card.
- Needs browser repro?: yes — desktop: check whether PHX La Quinta card shows any shuttle badge.

### 7.6 5:00 AM flight out of SFO, 2-night trip, every lot fails
- Profile: MacBook, Chrome, 1440px; SFO; check-in Tue 2026-12-01 2:30 AM, return Thu 2026-12-03 11:00 PM, 2.9 days; solo business traveler, sedan; objection "need a shuttle at 2:30 AM".
- Goal: park at SFO and ride to the terminal.
- Entry point: https://www.triplypro.com/search?airport=SFO&checkin=2026-12-01&checkout=2026-12-03
- Attempted journey: 5 lots; looks for hours.
- Friction:
  - 4 of 5 lots are no-shuttle (Hampton Inn, Courtyard, Home2Suites, DoubleTree North) and the fifth, Best Western Grosvenor, runs 5:00 AM–10:15 AM and 5:00–10:25 PM with no shuttle 10:15 AM–5:00 PM (daily lot, minimum 5 days). Nothing serves 2:30 AM or an 11 PM return. [TESTED-LIVE snapshot]
  - Best Western needs 5 days; a 2-night stay is blocked only after times are picked ("Minimum 5 days required", slider.tsx:158-164). The card still shows a price. [CODE][TESTED-LIVE snapshot]
  - Four lots are `limited` availability, so scarcity messaging pushes urgency on lots that fail the need. [TESTED-LIVE snapshot]
  - No hub or search-page message says "SFO lots mostly have no shuttle" (airport hub and /search treat all lots equally). [INFERRED]
- Likely abandonment point: cards look fine; the traveler discovers it after opening 3 sliders and leaves.
- Evidence: as tagged.
- Severity: Medium
- Type: Inventory-pricing limitation + UX gap
- Proposed improvement: add a filter chip "Shuttle at my time" on /search driven by the time fields (add times to the header, since the header has none); when 0 lots pass, show "No SFO lot has a shuttle at 2:30 AM; these have a shuttle after 5:00 AM" instead of a normal list. Acceptance: with times in the header, SFO at 2:30 AM shows the empty-state message.
- Needs browser repro?: yes — desktop: card price vs slider min-days gate for Best Western Grosvenor on a 2-night stay.

### 7.7 Short midweek trip at a daily-billed, 4-day-minimum lot (MSP, single lot)
- Profile: Surface Go 3, Edge, 912px; MSP; check-in Mon 2026-12-07 4:00 AM, return Wed 2026-12-09 11:00 PM, 2.8 days; solo, sedan; objection "price looked fine on search".
- Goal: book the only MSP lot.
- Entry point: https://www.triplypro.com/search?airport=MSP&checkin=2026-12-07&checkout=2026-12-09
- Attempted journey: sees one result (Hyatt Regency Bloomington, $47.70 on the 4-night snapshot); opens slider; picks times.
- Friction:
  - MSP returns one lot, daily billing, minimum 4 days. Daily lots bill calendar days +1 (client.ts:741-760), so Mon→Wed = 3 days < 4, so slider shows "Minimum 4 days required" and disables Reserve. [TESTED-LIVE snapshot][CODE client.ts:741-760, slider.tsx:158-164]
  - The traveler must change dates to a longer trip just to park for a shorter one, with no suggestion ("add 1 day: $X"). [INFERRED]
  - Shuttle 3:30 AM–1:30 AM works for 4:00 AM and 11:00 PM; only 1:30–3:30 AM has none. A confirmed good fit on hours. [TESTED-LIVE snapshot]
  - A 3-night Fri→Mon stay bills 4 calendar days and clears the minimum: passes. [CODE]
- Likely abandonment point: Reserve disabled message; leaves (one lot only).
- Evidence: as tagged.
- Severity: Medium
- Type: Inventory-pricing limitation / UX gap
- Proposed improvement: show "Min 4 days" on the card before opening the slider, and when below the minimum offer a one-tap "Extend to 4 days (+$X)" button. Acceptance: the card reads "4-day minimum" and the button recomputes the quote.
- Needs browser repro?: yes — desktop/mobile: does the card flag the minimum, and does Reserve show the reason?

### 7.8 Sunday-night return to Las Vegas, shuttle gap and no-shuttle cheapest
- Profile: iPhone SE 375px, Safari; LAS; check-in Fri 2026-12-11 3:00 PM, return Sun 2026-12-13 11:30 PM, 2 days; group of 4, minivan; objection "limited availability banner, decide now".
- Goal: cheap parking, trust return pickup at 11:30 PM.
- Entry point: https://www.triplypro.com/search?airport=LAS&checkin=2026-12-11&checkout=2026-12-13
- Attempted journey: three lots; Fairfield cheapest ($39.40 on snapshot).
- Friction:
  - Fairfield Inn is "NO SHUTTLE. You may park here but provide for your own transportation (uber/lyft)". Cheapest, shows "Lowest total", no card badge. [TESTED-LIVE snapshot][CODE lot-card.tsx:49-54]
  - Best Western runs 6:15 AM–1:00 PM, none 1:00–4:30 PM, 4:30–10:30 PM: a 3:00 PM drop-off and 11:30 PM pickup are both outside its hours. [TESTED-LIVE snapshot]
  - Only DoubleTree (24/7) works for both times, and is `limited` ("Limited" is a bookable state, per hubs). [TESTED-LIVE snapshot]
  - 375px: the slider holds 2 unlabeled selects (no accessible label per walkthrough) in a narrow column; a 48-option native select scroll to 11:30 PM is long. [TESTED-LIVE walkthrough]
- Likely abandonment point: at slider; or books Fairfield and is surprised.
- Evidence: as tagged.
- Severity: High (two of three lots fail the stated times)
- Type: Defect/UX gap (no hours check)
- Proposed improvement: same as 7.1 plus aria-labels on the time selects ("Check-in time", "Check-out time"). Acceptance: each select has an accessible name; hours warning appears for Best Western at 3:00 PM and 11:30 PM.
- Needs browser repro?: yes — iPhone SE 375px: select usability, label presence (axe), warning absent.

### 7.9 Three-week stay at Hobby, hourly vs daily rounding (HOU)
- Profile: Desktop Firefox 1280px; HOU; check-in Tue 2026-12-01 10:00 PM, return Tue 2026-12-22 1:00 AM, 20 days 3 hours; sedan; objection "why does a 20-day stay say 21 or 22 days".
- Goal: compare four Hobby lots on exact cost.
- Entry point: https://www.triplypro.com/search?airport=HOU&checkin=2026-12-01&checkout=2026-12-22
- Attempted journey: live search with 10:00 PM / 1:00 AM.
- Friction:
  - Measured (live, surface=featured): DoubleTree hourly 21 days, $94.50 sub, $107.03 total; Hobby Airport Parking hourly 21 days $118.81; Hampton Inn hourly 21 days $146.92; Houston Hobby Marriott South daily 22 days $114.35. [TESTED-LIVE]
  - Same stay, 1 billed day more at the daily lot. Daily = calendar days +1; hourly = ceil(hours/24) (client.ts:741-760). Check-in 10 PM and checkout 1 AM add an extra billed day on the hourly lots as well (20d3h→21). [CODE][TESTED-LIVE]
  - Moving the return time earlier by 3 hours (to 10:00 PM) would save one billed day on hourly lots (≈$4.7–6.5/day). Nothing on screen explains day counts. [CODE][INFERRED]
  - Per-day figure on a card does not equal total/days because of fees (e.g. DoubleTree $4.725/day × 21 = $99.23 vs total $107.03). [TESTED-LIVE]
  - All four HOU lots are 24/7 shuttle: confirmed non-issue for hours. [TESTED-LIVE snapshot]
- Likely abandonment point: none; low-stakes confusion. Might wonder why Marriott costs one more day.
- Evidence: as tagged.
- Severity: Low
- Type: Copy-trust / UX gap
- Proposed improvement: under the date/time pickers show "Billed: 21 days (24-hour blocks from check-in)" and for daily lots "22 calendar days". Acceptance: breakdown shows the rule per lot; a time change that crosses a 24h boundary updates the line.
- Needs browser repro?: yes — desktop: does the price breakdown label the day count and billing basis?

### 7.10 Zero-inventory airport, 5:00 AM flight (SLC, hub link)
- Profile: Desktop Edge 1920px; SLC; check-in Mon 2026-12-14 3:30 AM, return Fri 2026-12-18 11:00 PM, 4.8 days; solo, sedan; objection "marketed as 85+ airports".
- Goal: find early-morning parking at SLC.
- Entry point: https://www.triplypro.com/airport-parking (lists all 85 airports equally) then SLC
- Attempted journey: clicks SLC, searches, gets no results; tries a second date.
- Friction:
  - SLC is one of 15 airports returning 0 lots (ABE ABQ AZO DAL GEG IDA MEM ROA RSW SLC SNA YOW YUL YYC YYZ). The /airport-parking index shows no distinction. [TESTED-LIVE snapshot + walkthrough]
  - Search code treats an empty result as "no parking found"/waitlist copy; this squad did not exercise it live. [CODE search/page.tsx:85-140][INFERRED copy]
  - Early-morning travelers are the least likely to retry or call (email-only support, 24–48 h). [TESTED-LIVE walkthrough]
  - Dates outside the 100-day window return nothing too, so "no results" can mean wall, unsold airport, or no availability, with one panel. [CODE booking-window.ts, search/page.tsx]
- Likely abandonment point: the empty search page.
- Evidence: as tagged.
- Severity: Medium
- Type: Inventory-pricing limitation / UX gap
- Proposed improvement: on /airport-parking mark the 15 no-inventory airports ("Coming soon — notify me") and route them to the waitlist; on an empty /search say which cause applies. Acceptance: SLC shows a "no lots yet" state with a waitlist email form and distinct copy for beyond-window vs no-inventory.
- Needs browser repro?: yes — desktop: SLC hub/search empty state copy and whether a waitlist is offered.

---

## Squad top findings
1. No check of chosen check-in/return times against shuttle hours: 114 of 246 snapshot lots (46%) are not 24/7 (92 limited hours, 22 none); the cheapest/"Lowest total" lot is often the failing one (ATL Four Points/Routes, LAS Fairfield, PHX La Quinta). [CODE + TESTED-LIVE snapshot + orchestrator walkthrough]
2. Return date capped at today+100 though the ResLab wall is on check-in only; a 23-day trip is unsearchable after check-in day 78, 42-day after day 58, and the waitlist doesn't cover that gap. [CODE booking-window.ts:94-97, date-picker.tsx:182-188, lots/quote/route.ts:115]
3. "No Shuttle" card badge keys on an amenity key the snapshot lots do not carry; the 22 no-shuttle lots likely show no warning on cards. [CODE lot-card.tsx:49-54 + TESTED-LIVE snapshot; render needs browser check]
4. Minimum-stay gate only fires in the slider after times are picked (MSP 4-day, SFO Best Western 5-day, DTW/BOS/IAD 4–6 day lots); cards show prices for stays they can't sell. [CODE slider.tsx:158-164 + TESTED-LIVE snapshot]
5. Long-stay pricing works and scales linearly with no max-stay cap: ATL 42 days crossing the year boundary priced 42 days ($485.10 Sky Lot). Billing rounds up in 24-hour blocks, so 10 PM → 1 AM returns add a day, and daily lots add one more (HOU 21 vs 22 days), with no on-screen explanation. [TESTED-LIVE ATL + HOU][CODE client.ts:741-760]
6. Same-day and notice logic is sound and timezone-correct (airport/lot timezone, hoursBeforeReservation honored, past slots hidden): confirmed non-issue. DST spring-forward is unreachable within the 100-day picker until Dec 5, 2026. [CODE time.ts:148-165, pricing-window.ts:84-110]

---

## Squad 8

### Squad 8 — Flexibility / changed plans (simulated reactions, evidence-grounded)

Method: read upstream/main code (protection-plan, reservations, cancel button, eligibility, help/terms/contact, checkout trust copy, resend templates), the coverage snapshot JSON, 2 live GETs (`/contact`, one lot page). Search API not called. No forms touched.
Fetch note: lot page `/newark-ewr/airport-parking/courtyard-newark-liberty` returned a 25 KB shell; only site-wide meta ("Free cancellation, shuttle service, and upfront pricing") was visible, widget text not server-rendered, so lot-widget copy is [CODE] only.

### 8.1 Flight cancelled last night, booking same-day from the couch
- Profile: iPhone 15 (390px), Safari; EWR; check-in today 6:30 PM, return in 3 days 11 PM (airline rebooked him); solo, SUV; very urgent, will pay anything but wants to know he can undo it if the airline moves him again. Objection: "will I be stuck with this charge?"
- Goal: book a lot near EWR tonight and be sure what happens if plans change again.
- Entry point: `https://www.triplypro.com/search?airport=EWR&checkin=2026-11-06&checkout=2026-11-09`
- Attempted journey: search → opens "View Details" slider on Apex Airport Parking ($53.19 API, $44.01 due at lot) → sees green "Free Cancellation" → picks times → Reserve Now → checkout step 1 → looks for the same cancellation reassurance → step 3 terms checkbox → protection pick → pay.
- Friction:
  - Slider shows "Free Cancellation" unconditionally; checkout silently drops that line when check-in is <2 calendar days away, and puts nothing in its place. A same-day buyer is never told "this booking cannot be cancelled online".
  - Terms checkbox (all bookings) says "I can cancel for free up to 24 hours before check-in". For a booking made 3 hours before check-in that sentence is vacuous and reads as a promise.
  - Apex Airport Parking: $44.01 of $53.19 is "Due at Location" (83%), so checkout total charged now is ~$9; the customer may think "cheap, can't lose much" and miss that the real cost is at the lot.
  - Even if he wants out later: inside 24h means email-only support (24–48h business days).
  - Protection pick is mandatory (button says "Select a protection option above") — an extra decision at the most stressed moment, though the label is clear.
- Likely abandonment point: none forced (high intent); risk is post-purchase dispute/chargeback when he later cannot cancel after seeing "Free Cancellation" in the slider.
- Evidence: slider label unconditional [CODE product-detail-slider.tsx:311]; checkout gate `showFreeCancellation = leadDays >= 2` and no fallback copy [CODE checkout-form.tsx:101, customer-details-step.tsx:171, order-summary.tsx:273]; terms checkbox wording [CODE lib/checkout/terms-acceptance.ts:13-16]; online cancel blocked inside 24h [CODE cancel-reservation-button.tsx:226, terms 5.3]; same-day search is supported but may return `same_day_too_late` [CODE search/page.tsx:127]; Apex due-at-lot figures [TESTED-LIVE snapshot EWR]; support 24–48h [TESTED-LIVE /contact].
- Severity: High
- Type: Copy-trust
- Proposed improvement: when check-in is <24h (lot tz) away, replace the slider/hero "Free Cancellation" with "Free cancellation closes 24h before check-in — this booking can't be cancelled online" and show an amber line in checkout step 1 and above Pay. Acceptance: for a check-in <24h out, no green "Free Cancellation" appears anywhere on search, slider, checkout; an explicit non-cancellable line appears on step 1 and in the order summary.
- Needs browser repro?: yes — mobile 390px, search with today's date for a lot with a late shuttle; confirm slider label vs checkout step 1 vs order summary vs terms checkbox text. (Check same-day window rules by airport.)

### 8.2 Booked as guest, can't find the booking, wants to cancel (3 weeks out)
- Profile: MacBook, Chrome; JFK; check-in Dec 5 10 AM → Dec 12 6 PM (7 days), 3 weeks out; couple, sedan; moderate urgency (changed flights); booked on partner's email, partner's phone. Objection: "I just want to cancel, not create an account."
- Goal: cancel a guest booking and get the money back.
- Entry point: `https://www.triplypro.com/reservations` (from footer/nav "My Reservations")
- Attempted journey: /reservations → redirected to `/auth/login?redirect=/reservations` → no reservation-number lookup → opens confirmation email → "View Booking Details" CTA → confirmation page shows booking but no Cancel button → back to /reservations → sign up with the booking email → must confirm email → sign in → "We found 1 reservation under your email — Add to my account" → Cancel reservation → dialog with refund → confirm.
- Friction:
  - No guest lookup (number + email). `/reservations` hard-redirects unauthenticated users to login.
  - Confirmation page and confirmation email contain no cancel/manage link; email CTA is only "View Booking Details", footer only Help Center | Contact Us. The way to cancel lives only in the FAQ/terms copy.
  - Cancel needs: account creation + email verification + a manual "Add to my account" claim (by design, never auto-linked). Four detours for a one-click intent.
  - Booked on the partner's email: the account must be created with that exact email; mismatch makes the booking invisible with no explanation except FAQ ("I don't see a Cancel button…").
  - Works well: once linked, the dialog shows "Refund to your card", paid, Park Guard withheld and "5–10 business days" before confirming.
- Likely abandonment point: at "Create account / confirm email" — likely falls back to the support form instead.
- Evidence: redirect to login [CODE reservations/page.tsx:52-57]; claim prompt [CODE reservations/page.tsx:213-248]; email CTA + footer links only [CODE resend/templates/booking-confirmation.tsx:508, 537-541]; confirmation page guest view via emailed link or typed email [CODE confirmation/[id]/page.tsx:130-143, 399-455]; no cancel on confirmation components [CODE grep CancelReservationButton: only reservation-card.tsx]; sign-up requires email confirmation [CODE create-account-prompt.tsx:75-77]; refund preview before confirm [CODE cancel-reservation-button.tsx:290-330]; checkout copy "booking as a guest? sign up later with this email" [TESTED-LIVE walkthrough]; FAQ says same [TESTED-LIVE walkthrough].
- Severity: High
- Type: UX gap
- Proposed improvement: add "Cancel this booking" to the confirmation page and a "Manage booking" link in the email that deep-links to a guest cancel flow (email-verified magic link, no password). Acceptance: from the confirmation email, a guest reaches the refund dialog in ≤2 clicks with no account creation.
- Needs browser repro?: yes — desktop, signed-out: confirm /reservations has no lookup; open a confirmation link and confirm no cancel control; check the feature flag state (`ENABLE_SELF_SERVE_CANCEL`, not observable from outside).

### 8.3 Trip extended three days while already abroad
- Profile: Pixel 8 (412px), Chrome, on hotel wifi abroad; MCO (Omni Airport Parking, $36.40 API for 5 days); booked Nov 20→Nov 24, now wants to return Nov 27; family of 4, minivan; urgent (car at lot, return flight changed); Objection: "How much extra, and who do I even call?"
- Goal: extend parking by 3 days at the lot without being gouged or having the car towed.
- Entry point: `https://www.triplypro.com/help` (from the confirmation email "Help Center")
- Attempted journey: Help → "Can I modify my reservation?" ("no edit option") → "What if I need to extend my parking?" ("contact the facility directly… charged at the daily rate") → confirmation page for the lot phone → calls internationally or emails support.
- Friction:
  - No extend option in-product; "cancel + rebook" is meaningless once check-in has passed.
  - Overstay rate is never shown pre-purchase for most lots: of 246 lots a keyword scan found overstay/extension language in at most ~4 (JFK PARK AC "Extensions and overstays are paid on site"; JFK DoubleTree "additional balance … at checkout based on the posted rates"; JAX Airlynk and LGA Hearthstone matched "extend", text not read). MCO Omni: nothing.
  - FAQ copy is hedged: "Some facilities also charge on site for… staying past your booked time; those charges are listed in the lot's details" — for most lots no such listing exists.
  - Support is email-only 24–48h business days; the fast channel is the lot phone, which is present for all 246 lots and shown on the confirmation page (good) but an international call is the customer's cost.
  - Arrive-earlier/return-later FAQ: "may be charged for the additional time" — no figure.
- Likely abandonment point: not an abandonment; risk is an angry on-site dispute or negative review (rate unknown until paying at the exit).
- Evidence: FAQ extend/modify/charge copy [CODE help/page.tsx:50, 71-73, 96, 128-130] and [TESTED-LIVE walkthrough for "no edit option yet"]; lot overstay language count and quotes [TESTED-LIVE snapshot JSON JFK]; lot phone on 246/246 lots and tel link [TESTED-LIVE snapshot; CODE whats-next.tsx:137]; email shows only the shuttle phone [CODE booking-confirmation.tsx:215, 317]; support 24–48h [TESTED-LIVE /contact].
- Severity: Medium
- Type: UX gap / Inventory-pricing limitation
- Proposed improvement: add a per-lot "If you stay longer" line on the slider/lot page/confirmation (ResLab or lot-supplied daily overstay rate, or an explicit "rate not listed — call lot"), plus the lot phone in the confirmation email. Acceptance: every lot detail shows overstay terms or an explicit "ask the lot"; the confirmation email contains the lot phone number.
- Needs browser repro?: no for the data scan; yes (mobile) to confirm where overstay text surfaces on the slider/lot page for JFK PARK AC vs MCO Omni.

### 8.4 Entered the wrong return date, weekend, inside 24h
- Profile: Samsung Galaxy S23 (360px), Chrome; FLL (Fairfield Inn & Suites, $46.99 API); booked Fri night for check-in Sat 6:00 AM, entered return Tue instead of Mon (also covers "returning a day early"); solo, compact car; urgency high, it is Friday 11 PM. Objection: "Will I pay for a day I don't use?"
- Goal: fix the return date (or get the unused day back).
- Entry point: `https://www.triplypro.com/confirmation/<id>?email=…` (from the confirmation email)
- Attempted journey: confirmation page → looks for Edit → none → Help "Can I modify my reservation?" ("closer to check-in… email support") → /contact → subject dropdown → types message → waits until Monday.
- Friction:
  - No edit; cancel+rebook only works >24h out, which is not his case: Cancel card says "Online cancellation is available up to 24 hours before check-in" → "Contact support for help".
  - Live contact form topics: General Inquiry, Booking Help, Cancellation Request, Payment Issue, Feedback, Partnership, Other. There is no "Change My Reservation" / "Problem at the Lot" topic (the code shows those exist only when the support inbox flag is on, so the flag looks off in production). No reservation-number field, no phone number, "We typically respond within 24-48 hours during business days".
  - Nothing says whether an unused day is refundable. Terms/Help: no partial-refund, early-return or pro-rata language; "no-shows aren't refunded" is the only adjacent rule.
  - Weekend: a Friday-night message plausibly sits until Mon/Tue, after he has already parked.
- Likely abandonment point: the contact form (sends nothing useful; just a mailto) — then the customer goes to the lot at 6 AM and negotiates.
- Evidence: cancel dialog block inside 24h [CODE cancel-reservation-button.tsx:226-241]; contact form topics + 24–48h + support@ only, no phone [TESTED-LIVE /contact]; "Change My Reservation" tip gated on `supportInboxEnabled` [CODE contact-page-client.tsx:50-52, 77-92]; no early-return/prorata copy [CODE grep help/terms: none]; "no edit option" [TESTED-LIVE walkthrough].
- Severity: High
- Type: UX gap
- Proposed improvement: (a) add a "Change my reservation" topic and reservation-number field to the live contact form; (b) add one FAQ + terms sentence: "Returning early? The unused days aren't refunded" (or the actual rule); (c) show lot phone on the cancel "inside 24h" card. Acceptance: contact form lists a change topic and requires/accepts a reservation number; FAQ states early-return policy; the inside-24h card shows the lot's phone.
- Needs browser repro?: yes — mobile 360px, confirm contact topics list and whether the confirmation page has any edit/contact affordance.

### 8.5 Booked EWR, meant JFK — cancel and rebook, 3 weeks out
- Profile: iPad Air (820px), Safari; EWR (Courtyard Newark Liberty, $76.83 API) booked in error, needs JFK (The Parking Point JFK, $57.71 API); check-in Dec 4 9 AM → Dec 10 8 PM; couple, 1 car; low urgency, high irritation; chose Park Guard Plan A ($12.99). Objection: "What do I lose by fixing my mistake?"
- Goal: undo the wrong-airport booking and rebook at JFK with minimal loss.
- Entry point: `https://www.triplypro.com/reservations` (logged in, booked while signed in)
- Attempted journey: My Reservations → Cancel reservation → dialog → refund preview → confirm → new search for JFK → full checkout again.
- Friction:
  - No "change airport/lot" — full re-entry of name/phone/vehicle (checkout does not prefill vehicle from the cancelled booking per what was readable; unverified).
  - Park Guard $6.00 of Plan A is non-refundable (wholesale kept); disclosed in the dialog, but at the point of purchase the protection card itself does not mention refundability.
  - Refunded to the card in "5–10 business days" while the rebook charges the card immediately: customer is out both amounts for up to two weeks (~$90 at EWR+JFK totals; larger at expensive lots).
  - Rebook price may differ (rates move) — nothing guards or flags that.
- Likely abandonment point: none; this is the best-served flexibility path.
- Evidence: cancel flow, refund breakdown, PG withheld line, 5–10 days [CODE cancel-reservation-button.tsx:290-335]; PG non-refundable amounts $6/$4/$2 [CODE parkguard/plans.ts:72-100, 282-287]; protection card has no refund wording [CODE protection-plan.tsx:67-153]; EWR/JFK totals [TESTED-LIVE snapshot]; "no edit option yet… cancel and book again" [TESTED-LIVE walkthrough]; flow flag-gated by `ENABLE_SELF_SERVE_CANCEL` [CODE user/bookings/route.ts:150] (production state [INFERRED] on, since live FAQ advertises it).
- Severity: Low (confirmed working; minor money-float friction)
- Type: Preference / Copy-trust (non-refundable PG not stated on the protection card)
- Proposed improvement: add "Partly non-refundable if you cancel ($6 of $12.99)" under each plan price on the card; prefill vehicle/contact from the cancelled booking's data via a "Rebook" link in the cancel confirmation. Acceptance: protection card shows the non-refundable amount per tier; cancel-success state shows a "Rebook" CTA that preloads dates.
- Needs browser repro?: yes (needs a real booking, so owner-only): check whether the cancel-success panel offers a rebook link and prefill; I could not test.

### 8.6 Typed the wrong license plate; lot gate is plate-reading
- Profile: iPhone 13 mini (375px), Safari; DEN (Canopy Denver Airport Parking, $57.58 API); check-in Sun 5:40 AM; solo, truck; discovered the typo on the QR screen on the way to the lot. Objection: "The gate reads the plate. What now?"
- Goal: correct the plate before arriving, or park without a failed gate.
- Entry point: confirmation page / email
- Attempted journey: confirmation page → "Vehicle" details shown but not editable → Help "modify" FAQ → cancel (inside 24h? blocked) → email.
- Friction:
  - The lot's own arrival text: "If you entered your License plate correctly, the gate should read it and open the gate automatically." Wrong plate = gate fails, at 5:40 AM.
  - Two extra fields (License Plate #, Plate State) marked `perCar` and the lot is the only DEN lot requiring them; the vehicle step also has its own plate field (aliases hidden so plate is typed once). One typo, no edit anywhere.
  - No confirm-your-plate step, no echo on the payment step.
  - Support 24–48h business days; he is already driving.
- Likely abandonment point: at the lot gate (post-purchase failure), not in-funnel.
- Evidence: Canopy extraFields + gate/plate sentence [TESTED-LIVE snapshot DEN]; plate hidden-alias logic and plate state list [CODE vehicle-details-step.tsx:24, 34-52, 77-81]; no edit control on card/confirmation [CODE reservation-card.tsx; confirmation components]; no edit option [TESTED-LIVE walkthrough].
- Severity: High (post-purchase failure, only affects plate-reading lots; LAX Travelodge, IAD both lots also require plate)
- Type: UX gap
- Proposed improvement: on the payment step show "Plate: ABC123 (CO)" with Edit link, and add a confirmation-page "Fix my plate" request that emails the lot via support. Acceptance: plate and state appear in the order summary before Pay; confirmation page offers a one-click "my plate is wrong" that opens a pre-filled support message with the reservation number.
- Needs browser repro?: yes — mobile 375px: step 2 plate field, auto-uppercase/format validation, whether the summary shows the plate.

### 8.7 Needs a second car for the same trip (IAD)
- Profile: Dell laptop, Edge; IAD (Hyatt Regency Dulles, $47.70 API, requires License Plate #); check-in Dec 18 7 AM → Dec 22 9 PM; two adults driving separately, 2 cars; moderate urgency; Objection: "Do I pay two service fees, and are they linked?"
- Goal: park 2 vehicles at the same lot with one booking if possible.
- Entry point: `https://www.triplypro.com/dulles-iad/airport-parking/hyatt-regency-dulles-airport` (blog link)
- Attempted journey: lot page → looks for a "number of vehicles" field → none → Reserve → checkout → vehicle step asks for one make/model/colour/plate → completes; then starts the whole checkout again for car 2.
- Friction:
  - No quantity/vehicle-count control; one booking = one vehicle. Second car = second full checkout (name/email/phone/card/protection choice/terms).
  - Each booking carries its own service fee (the UI showed a per-booking fee of $5.95 on a similar lot in the walkthrough) and optional protection ($12.99 each), so a $95.40 API total becomes ~$107+ before protection.
  - Two confirmations, two QR codes, two refund/cancel actions; nothing links them for the lot attendant.
  - The `perCar` flag exists in lot data but is only a per-field attribute; no UI for multiple cars was found.
- Likely abandonment point: at the vehicle step when no second-car option appears; some will phone the lot.
- Evidence: IAD lots + plate field [TESTED-LIVE snapshot IAD]; `perCar` only in lot types/search mapping [CODE types/lot.ts:130, reslab/search.ts:226]; no vehicle-count in checkout [CODE grep: no match for second/multiple vehicle]; fee per booking [TESTED-LIVE walkthrough ATL $5.95] and [INFERRED] it repeats per booking.
- Severity: Medium
- Type: UX gap
- Proposed improvement: add "Booking for 2 cars? Make a second booking for the same lot" CTA on the confirmation page that prefills lot/dates/contact. Acceptance: confirmation page has a "Add another car" button that opens checkout for the same lot/dates with contact fields prefilled; no card re-entry beyond Stripe.
- Needs browser repro?: yes — desktop, check lot page and vehicle step for any vehicle-count control and what the second checkout prefills.

### 8.8 Blizzard forecast, 28 hours before check-in (weather disruption)
- Profile: iPhone SE (375px), Safari; BOS (Park N Boston Logan, $110.20 API; Broadway Motor Service $62.74 has no shuttle); booked 3 weeks ago, check-in Sat 8 AM, now Fri 4 AM (28h) and airline cancels; family of 3, SUV. Objection: "The lot page said full refund."
- Goal: cancel before the window closes at 8 AM Friday.
- Entry point: `https://www.triplypro.com/reservations` (from the confirmation email, he created an account at checkout)
- Attempted journey: My Reservations → card shows "Cancel reservation" (28h) → dialog → refund preview → confirm. If he wakes at 9 AM (23h) the same card turns into "Online cancellation is available up to 24 hours before check-in".
- Friction:
  - Lot widget shows "Full refund if cancelled" when the lot's cancellationPolicies says 100% (244 of 246 lots), with no 24h condition, while Triply's own rule is 24h. Terms 5.4 says "Some parking facilities may have different cancellation policies, which will be displayed at the time of booking", but the per-lot policy is only that one-line widget text.
  - Gate is computed in the lot's timezone; the customer sees only "24 hours" with no cutoff timestamp ("closes Fri 8:00 AM ET").
  - Inside the window: email-only support, case-by-case refunds, "no-shows aren't refunded" — the exact weather case is not addressed in terms (no weather/force-majeure language).
  - Works well: the cutoff is server-side airport-local, so a customer cannot wrongly self-cancel; dialog shows exact refund first.
- Likely abandonment point: none online; at the 24h cliff, the customer is pushed to an email form on a storm night.
- Evidence: widget text from `cancellationPolicies[0].percentage === 100` [CODE lot/booking-widget.tsx:162-167, 504]; 244/246 lots are `[{"numberOfDays":0,"percentage":100}]`, 1 `[]` (STL Parking Spot), 1 missing (JFK Parking Point) [TESTED-LIVE snapshot, all airports]; terms 5.1/5.3/5.4 wording [CODE terms/page.tsx:83-120]; server-side airport-local gate [CODE lib/cancellation/eligibility.ts]; no weather clause [CODE grep terms/help: none]; cancel card copy [CODE cancel-reservation-button.tsx:226-241, 270-275].
- Severity: Medium
- Type: Copy-trust
- Proposed improvement: (a) lot widget text to "Free cancellation until <timestamp in lot tz>" computed from the selected check-in; (b) show the exact cutoff on the reservation card ("Cancel online until Fri 8:00 AM ET"); (c) add a one-line weather/airline-cancellation note in Help. Acceptance: no lot page says "Full refund" without the cutoff; every upcoming reservation card shows an absolute cutoff time.
- Needs browser repro?: yes — mobile 375px, open a BOS lot page and the slider: confirm the exact string next to Reserve Now and whether it names 24h.

### 8.9 Price-sensitive buyer weighs Park Guard on a $36 booking (MCO)
- Profile: iPhone 14 (390px), Chrome; MCO (Gold Park Orlando, $35.63 API for 5 days); 5-day trip Nov 20–24 (flexible, plans may change); couple, rental-car-free; moderate urgency. Objection: "Plan A is 36% of my parking. What does it actually cover, and can I get it back?"
- Goal: decide whether the protection is worth it and understand refundability if the trip changes.
- Entry point: checkout step 3 (Payment) from `https://www.triplypro.com/search?airport=MCO&checkin=2026-11-20&checkout=2026-11-24`
- Attempted journey: step 3 → four cards (Plan A $12.99 "Recommended", Plan B $7.99, Plan C $4.95, "No protection") → reads blurbs → clicks "full terms" → /terms#parking-protection → Park Guard external terms.
- Friction:
  - Card copy is only "Covers up to $1,000 of theft and damages while parked at the lot." No deductible, exclusions, claim steps or deadlines. Help says claims must be filed within 72 hours of leaving the lot, with a police report for theft — none of that is on the card.
  - Refundability is absent from the card; "partly non-refundable" is in the order-summary badge and step-1 trust line, which are hidden when check-in is <2 days away. Amounts ($6.00/$4.00/$2.00 kept on cancel) appear only in Help/terms/cancel dialog.
  - Plan A "Recommended" with an expensive price vs a $35.63 parking base; "per trip" lets users believe it scales with days.
  - The decision is forced (Pay Now disabled until chosen); "No protection" copy "I agree to park at my own risk" is stark but honest. Compliance wording ("insurance/coverage" avoided) makes it vaguer than a shopper expects.
  - Terms §13: "or, in certain instances, by failing to opt out" is stale wording now that nothing is pre-selected.
  - Works well: nothing pre-selected (as of 2026-11-02), explicit disabled-button reason "Select a protection option above".
- Likely abandonment point: step 3 hesitation; may pick "No protection" or leave to compare. Cannot tell conversion effect without data.
- Evidence: card copy/prices/"Recommended"/no refund wording [CODE protection-plan.tsx:40-62, 126-150]; tier prices & PG kept amounts [CODE parkguard/plans.ts:72-100, 282-287]; badge/trust line gated on showFreeCancellation [CODE order-summary.tsx:273-281, customer-details-step.tsx:171-190]; 72h claim rule [CODE help/page.tsx:190-193]; terms "failing to opt out" [CODE terms/page.tsx:176-183]; Pay button states [CODE stripe-payment-form.tsx:495-525]; MCO total [TESTED-LIVE snapshot MCO]. Plan A share of parking is [INFERRED] arithmetic ($12.99/$35.63).
- Severity: Medium
- Type: Copy-trust
- Proposed improvement: under each plan add one line "Cancel before check-in: $6.00 of $12.99 non-refundable" and "Claims within 72 hours; see what's covered" (link to a 5-line summary with exclusions); show the plan price as % of booking only if internal data supports it. Acceptance: card shows refundability and claim deadline in the viewport without opening Terms; the same disclosure appears for same-day bookings.
- Needs browser repro?: yes — mobile 390px, step 3: confirm card text, whether the non-refundable line shows when check-in <2 days, and the "full terms" link target.

### 8.10 Airline reroutes him to a zero-inventory airport (RSW)
- Profile: Android tablet (800px), Chrome; RSW (Fort Myers; 0 lots in the snapshot); booked FLL parking, now rebooked to RSW by the airline; check-in Nov 28 6 AM → Dec 2; solo, sedan. Objection: "Search says nothing is available — is the site broken?"
- Goal: find parking at the new airport and cancel the old booking.
- Entry point: `https://www.triplypro.com/search?airport=RSW&checkin=2026-11-28&checkout=2026-12-02`
- Attempted journey: types RSW (it is marketed in "85+ airports") → results → "No parking lots found for your search criteria." → tries a hub page → back to FLL booking → cancel.
- Friction:
  - RSW is one of 15 airports marketed but returning 0 lots (ABE ABQ AZO DAL GEG IDA MEM ROA RSW SLC SNA YOW YUL YYC YYZ).
  - The empty state is one grey line: no nearby-airport suggestion (e.g. FLL/TPA), no waitlist link, no explanation whether it is inventory vs date.
  - Hub trust badge says "Free Cancellation" on every hub regardless of inventory.
  - He now owes a cancel+rebook elsewhere; if the FLL booking is inside 24h he is stuck with email.
- Likely abandonment point: the empty search result (leaves the site).
- Evidence: 15 zero-inventory airports [TESTED-LIVE snapshot; brief]; empty-state copy [CODE search-results-list.tsx:107-109]; hub badge [CODE airport/hero-section.tsx:30-35]; /airport-parking lists all 85 equally [TESTED-LIVE walkthrough]; no nearby-airport code found in search components [CODE grep: no match].
- Severity: Medium
- Type: Inventory-pricing limitation / UX gap
- Proposed improvement: when `total===0 && !degraded`, show "We don't have lots at RSW yet", nearby airports with inventory, and an email-me button. Acceptance: empty result for a zero-inventory airport lists ≥1 nearby covered airport link and a waitlist capture; the /airport-parking list marks zero-inventory airports.
- Needs browser repro?: yes — desktop and tablet, `/search?airport=RSW…`; confirm the empty state has no alternatives and see if a waitlist block renders on the RSW hub.

## Squad top findings
1. **"Free Cancellation" is shown unconditionally pre-purchase** (slider, hub hero, site meta, lot widget "Full refund if cancelled") while checkout hides it for check-in <2 days and the terms checkbox still says "free up to 24h"; no non-cancellable notice for same-day/next-day buyers. [CODE product-detail-slider.tsx:311; checkout-form.tsx:101; terms-acceptance.ts:13] High
2. **Guest cancellation is a 4-step detour** (signup, email confirm, claim, cancel); the confirmation email/page have no cancel or manage link, and `/reservations` has no guest lookup. [CODE reservations/page.tsx:52; booking-confirmation.tsx:508-541] High
3. **Inside 24h, support is email-only 24–48h business days**; the live contact form lacks "Change My Reservation"/"Problem at the Lot" topics and a reservation-number field (inbox flag appears off), and terms/Help say nothing about early return or weather. [TESTED-LIVE /contact; CODE contact-page-client.tsx:50-92] High
4. **No edit path for plate/dates/airport/second car**; worst for plate-reading gates (DEN Canopy "if you entered your License plate correctly") and for anyone inside 24h. [TESTED-LIVE snapshot DEN; TESTED-LIVE walkthrough "no edit option"] High
5. **Park Guard card omits refundability, claim deadline (72h) and exclusions**; "partly non-refundable" disclosures disappear for check-in <2 days; Plan A $12.99 is ~36% of a $35.63 MCO booking. [CODE protection-plan.tsx; order-summary.tsx:273; help/page.tsx:190] Medium
6. **Confirmation email says "Late cancellations may incur fees"** while terms say no online cancel inside 24h, case-by-case refunds, no-shows not refunded; overstay rates are stated for only ~2–4 of 246 lots. [CODE booking-confirmation.tsx:537; terms 5.3; TESTED-LIVE snapshot JFK] Medium

Confirmed non-issues: cancel dialog shows server-computed refund and PG withheld before confirming [CODE]; 24h gate is server-side in lot timezone [CODE]; guests can open their booking from the emailed link or by typing the booking email [CODE]; lot phone present on 246/246 lots and linked on the confirmation page [TESTED-LIVE + CODE]; nothing is pre-selected on protection and the disabled Pay button says why [CODE].

---

## Squad 9

### Squad 9 — Accessibility and usability requirements

Method: read upstream/main JSX (search header, lot-card, results list, product-detail-slider, date-picker, airport-combobox, checkout steps, stripe form, cookie banner, globals.css), computed WCAG contrast from hex values, mined the 70 coverage JSONs for accessibility data. No live fetch, no browser, no API call (read-only). Simulated reactions, not real customer behaviour.

Contrast table (WCAG 2.x, computed): white on brand-orange #f87356 = 2.77 (fails 4.5 and even 3.0); white on hover orange-600 = 3.56; white on amber-500 "Limited" tag = 2.15 at 10px; amber-700 on white (Pay at Location) = 5.02 OK; amber-800 on amber-50 = 6.84 OK; gray-400 on white = 2.54, on gray-50 = 2.43 (placeholders, review attribution, "N Results"); green-600 "Taxes & fees included" on white = 3.30 at 11px (fails); red-500 error text on white = 3.76 at 12px (fails); yellow-400 star on yellow-50 = 1.48 (decorative, rating number beside it is fine); gray-500 on white = 4.83 OK.

Accessibility data in the snapshot: 246 lots; 85 carry the `wheelchair_access` amenity; 55 descriptions mention ADA/wheelchair/handicap/accessible; only 5 shuttle texts mention accessibility; 90 lots say "no shuttle". Wheelchair-lift shuttle info exists only as free text in shuttleInfo.details (EWR Courtyard Elizabeth: "shuttle wheelchair accessible if requested in advance"; JFK A1: "ADA/aisle access is available"; BNA Comfort Suites: shuttle must be booked 1 h ahead by phone).

---

### 9.1 VoiceOver iPhone user booking a time-sensitive trip
- Profile: iPhone 14 (390x844), Safari + VoiceOver; EWR; Fri 2026-12-18 4:30 AM -> Mon 2026-12-21 11:30 PM (3 nights); 1 sedan; blind traveler, flies for work, needs to book tonight; objection: "I can't tell what the controls are".
- Goal: choose the cheapest lot with a shuttle and complete the search -> detail step.
- Entry point: https://www.triplypro.com/search?airport=EWR&checkin=2026-12-18&checkout=2026-12-21
- Attempted journey: swipe through results; open "View Details" on a card; swipe to the check-in/check-out time controls; choose times; hit Reserve Now.
- Friction:
  - Time `<select>`s in the slider have no accessible name: the visual "Check-in" `<label>` has no `htmlFor` and doesn't wrap the control, so VoiceOver reads "Select, pop-up button" for both, no way to tell check-in from check-out.
  - The slider is not `role="dialog"`/`aria-modal`; background results stay in the swipe order, so VO swipes past the panel into the page behind it.
  - No focus move on open, no Escape handler, close "X" button has no accessible name (icon only); photo arrows have no names either ("button, button").
  - Sort select on results has no label (bare select with "Recommended" value).
  - Disabled Reserve Now explains itself only via `title`, which VoiceOver does not announce; the on-screen message "Please select check-in and check-out times" is not tied to the button.
  - Text-xs (12px) selects trigger iOS auto-zoom on focus (<16px).
- Likely abandonment point: the time selects (can't identify them) or Reserve Now stays dimmed with no spoken reason.
- Evidence: [CODE] product-detail-slider.tsx:329-335 (label w/o htmlFor), :348-352 (select w/o aria-label), :219-235 (no role/aria-modal/Escape/focus handling; close button no aria-label), :534-537 (title only); [CODE] search-results-list.tsx:61-65 (select, no label; confirmed in baseline snapshot markup); [CODE] grep of slider found no `Escape`, `role=`, `aria-modal`; [TESTED-LIVE] orchestrator confirmed time selects have no accessible label; [INFERRED] VO swipe leakage (depends on browser behaviour without aria-modal).
- Severity: Blocker (for screen-reader users, the booking cannot be completed unambiguously)
- Type: Defect
- Proposed improvement: give both selects `aria-label="Check-in time"`/"Check-out time" (or `htmlFor`/`id`), make the panel `role="dialog" aria-modal="true" aria-label={lot.name}`, move focus into it on open and restore on close, Escape closes, label close/photo buttons, and add `aria-describedby` from Reserve Now to the "select times" message. Acceptance: axe-core reports zero "select-name"/"button-name" violations on the slider; VO reads "Check-in time, Select, pop-up button"; focus is trapped in the slider and Escape returns focus to the originating View Details button.
- Needs browser repro?: yes — iOS Safari + VoiceOver (or Chrome DevTools accessibility tree + axe) on /search?airport=EWR..., open View Details, inspect select names and tab/swipe order behind the panel.

### 9.2 NVDA + Firefox keyboard-only user on desktop checkout
- Profile: Windows 11, 1440x900, Firefox + NVDA, keyboard only; ATL; Fri 2026-11-20 5:00 AM -> Tue 2026-11-24 11:30 PM (4 nights); 1 car; blind, uses Tab/arrow keys; objection: "form errors aren't read to me".
- Goal: fill Your Details and Vehicle Info steps, see and fix validation errors.
- Entry point: https://www.triplypro.com/checkout?lot=reslab-366&checkin=2026-11-20&checkinTime=5%3A00+AM&checkout=2026-11-24&checkoutTime=11%3A30+PM
- Attempted journey: Tab through First/Last/Email/Phone, submit with Email blank and Phone malformed, try to find errors; continue to Vehicle step.
- Friction:
  - Customer-detail labels ("First Name *", "Email Address *"…) are plain `<label>` with no `htmlFor` and aren't wrapping the input: NVDA falls back to the placeholder ("John", "john@example.com") as the field name — wrong for first/last name pair ("John" vs "Doe").
  - Error `<p>` has no `id`, input has no `aria-invalid`/`aria-describedby`, error container has no `role="alert"`/live region: a blank-field error appears visually in red but is silent. Native `required` does give a browser tooltip but only for the first invalid field.
  - No `autocomplete` attributes (given-name, family-name, email, tel) on the customer step: no browser/password-manager autofill assist, which also hurts tremor and cognitive-load users.
  - Stepper "Your Details -> Vehicle Info -> Payment" has no `<ol>`, `aria-current="step"` or step count: NVDA user doesn't know which step they are on.
  - Vehicle "Color" `<select>` and State select: same label-association pattern as the details step (labels without `htmlFor`).
  - Confirmed non-issue: lot extra-fields (ResLab dynamic inputs) DO use `htmlFor`, `aria-invalid`, `aria-describedby` (vehicle-details-step.tsx:273-311); the Protection Plan error area uses `role="alert" aria-live="polite"`.
- Likely abandonment point: step 1/2 after submit fails silently; the user keeps hitting Continue.
- Evidence: [CODE] customer-details-step.tsx:51-72, :106-127 (label/input/error markup; no aria-*, no autoComplete); [CODE] vehicle-details-step.tsx:157-183, :219-248 vs :273-311; [CODE] checkout-steps.tsx (no aria/ol/li/role matches); [CODE] protection-plan.tsx:172 (role=alert present there only); [TESTED-LIVE] orchestrator saw the 3-step stepper and required fields.
- Severity: High
- Type: Defect
- Proposed improvement: `htmlFor`/`id` pairs on every checkout field, `aria-invalid` + `aria-describedby` to an error `<p id>` with `role="alert"`, an error summary that takes focus on failed submit, `autoComplete` tokens, and `<ol aria-label="Checkout progress">` with `aria-current="step"`. Acceptance: NVDA reads "First name, edit, required" and announces "Email is required" on submit; axe "label" and "aria-valid-attr-value" pass on all three steps.
- Needs browser repro?: yes — desktop Firefox+NVDA, or Chrome accessibility tree: inspect computed names for step-1 inputs; submit empty form and watch live-region output.

### 9.3 Keyboard-only desktop user: date picker, combobox, slider
- Profile: MacBook 1280x800, Chrome, no mouse (motor impairment, uses switch-style Tab/Enter); DEN; Mon 2026-12-07 8:00 AM -> Sun 2026-12-13 9:00 PM (6 nights); SUV; objection: "I can't get out of things".
- Goal: change the dates on the search page, then open a lot's detail and close it.
- Entry point: https://www.triplypro.com/search?airport=DEN&checkin=2026-11-20&checkout=2026-11-24
- Attempted journey: Tab to airport box, check-in trigger, open calendar, arrow to a new date, Escape; Tab to Update; Tab to a lot's View Details; Tab inside the open slider; try Escape.
- Friction:
  - The slider does not close on Escape (no key handler) and does not trap or restore focus: Tab walks into the dimmed results behind a full-screen backdrop, focus is lost visually under the overlay, and the user has to Tab back to the X button which is the first element in the panel DOM only if focus started there.
  - Airport combobox input has no `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, and the dropdown is portaled: arrow-key highlight is visual only, a screen reader hears nothing; its clear "X" button has no name. Keyboard handling itself (ArrowUp/Down/Enter/Escape) works.
  - Confirmed non-issue: date triggers are real `<button>`s with `<label htmlFor>` ("Parking check-in"/"Parking check-out"); calendar is Radix Popover + react-day-picker (arrow-key day navigation, Escape closes, focus returns to trigger by library default); lot cards use a real `<button>View Details</button>`, not a clickable div; View full details is a Link.
  - Hover-only card highlight (`onMouseEnter`) has no keyboard equivalent, so Tab focus doesn't sync with the map marker.
- Likely abandonment point: stuck behind the slider overlay.
- Evidence: [CODE] product-detail-slider.tsx:219-235 (backdrop onClick only; no keydown); [CODE] airport-combobox.tsx:116-130 (keyboard handler), :220-240 (input without ARIA), :37-42 (button w/o name); [CODE] date-picker.tsx:157-205 (Radix Popover + DayPicker); [CODE] lot-card.tsx:113-122 (hover handlers only), :239-253 (real button); [INFERRED] focus-leak behaviour of non-modal overlay.
- Severity: High (slider), Medium (combobox)
- Type: Defect
- Proposed improvement: use Radix Dialog (already in dependency tree with Popover) for the slider, or add `role="dialog"`, Escape, focus trap and focus restore; give the combobox the ARIA 1.2 combobox pattern. Acceptance: keyboard-only user opens and closes the slider and returns to the same View Details button; Tab never reaches elements behind the backdrop.
- Needs browser repro?: yes — desktop Chrome: press Tab repeatedly after opening View Details, press Escape, check `document.activeElement` and whether the panel closes.

### 9.4 Low vision at 200–400% zoom, small phone width
- Profile: Android Pixel 7 (412 px) or desktop browser at 400% (equivalent 320 CSS px), Chrome; ORD; Fri 2026-12-04 6:00 AM -> Sun 2026-12-06 10:00 PM (2 nights); sedan; legally low vision, uses zoom plus high-contrast sensitivity; objection: "grey on grey and orange on white are unreadable".
- Goal: read price, "Pay at Location", "Limited", and shuttle details; use results.
- Entry point: https://www.triplypro.com/search?airport=ORD&checkin=2026-12-04&checkout=2026-12-06
- Attempted journey: zoom to 400%, scan the first card, then open details, find price and fees.
- Friction:
  - White button text on brand orange #f87356 = 2.77:1 (View Details, Reserve Now, Update, Pay Now); fails 4.5 for 14px bold and fails 3.0 for UI components; hover orange-600 = 3.56 (still <4.5).
  - "Limited" tag white on amber-500 at 10px uppercase = 2.15:1.
  - Placeholders and metadata gray-400: "Depart date" (2.43 on gray-50), "(212 ratings)", "N Results" (2.43–2.54).
  - "Taxes & fees included" green-600 11px = 3.30; field errors red-500 12px = 3.76; the 10px "Pay at Location" (5.02 passes but 10px is below any legible minimum under zoom).
  - Several text sizes are 10–11px (`text-[10px]`, `text-[11px]`), and selects in the slider are `text-xs w-28` (112px): the time text will clip at large text sizes.
  - Confirmed non-issue: viewport allows scaling (`maximumScale: 5`, no `user-scalable=no`), so pinch/browser zoom works; cards stack (`@lg:flex-row` container query) so no horizontal scroll expected at 320 px for the list.
- Likely abandonment point: can't read the white-on-orange CTA and amber tag; may bounce rather than abandon mid-flow.
- Evidence: [CODE] globals.css:24 (`--color-brand-orange: #f87356`), lot-card.tsx:137 (amber-500 tag), :178 (text-[10px] amber-700), :253 (btn colors), product-detail-slider.tsx:391-395 (w-28 text-xs select), layout.tsx:85-90 (viewport); [INFERRED] contrast ratios computed by script from Tailwind default hex (WCAG formula), not measured in a browser.
- Severity: High (brand-wide CTA contrast) / Medium (small type)
- Type: Defect
- Proposed improvement: darken the CTA fill to >=4.5:1 with white (e.g. #c2410c orange-700 = 5.18 with white) or switch to dark text; amber tag text to amber-950 on amber-100; raise min text to 12px/16px for selects; placeholder to gray-500. Acceptance: Lighthouse/axe color-contrast passes on /search and /checkout; at 400% zoom no horizontal scroll and the slider time selects show full text.
- Needs browser repro?: yes — desktop Chrome at 400% and mobile 320px: axe color-contrast scan on /search and the open slider; confirm select text isn't clipped.

### 9.5 Wheelchair user needing an ADA lot and lift shuttle (EWR)
- Profile: iPhone 15 (393 px) Safari; EWR; Thu 2026-12-17 5:30 AM -> Mon 2026-12-28 10:00 PM (11 nights); accessible van with ramp or folding power chair; family trip, books 5 weeks out; objection: "will the shuttle take my chair?"
- Goal: find a lot that is ADA accessible AND has a wheelchair-accessible shuttle (or a drop-off with no shuttle).
- Entry point: https://www.triplypro.com/search?airport=EWR&checkin=2026-12-17&checkout=2026-12-28
- Attempted journey: scan cards for an accessible badge; look for a filter; open details of candidate lots; read shuttle text.
- Friction:
  - No accessibility filter: the results page offers only a sort select (Recommended/Lowest/Highest Total/Top Rated/Closest/Most booked). The `wheelchair_access` amenity exists in data (85 of 246 lots) but cannot be filtered.
  - On the card, `wheelchair_access` (display name "Wheelchair Access") misses the "Accessible" rule in `getAmenityConfig` (it matches "handicap"/"accessible"/"ada", not "wheelchair"), so it falls to the generic green check chip, and only the first 4 amenities show, with the rest hidden behind "+N more". In the snapshot it's usually the last amenity, so on lots with 5+ amenities it can be hidden.
  - Shuttle accessibility is free text only. EWR Courtyard Elizabeth: shuttle "wheelchair accessible if requested in advance" (buried in details). Embassy Suites Newark shuttle details say pick-ups are at Lot P4, reachable via AirTrain, with no accessibility statement. Red Carpet Inn is "fully ADA accessible" but "No Shuttle", rideshare only.
  - A "Free Shuttle" green chip appears on cards from the word "shuttle" regardless of whether it lifts a chair; "No Shuttle" lots are visible only in text.
  - "Advance request" requirement (shuttle must be arranged ahead) has no field/notes box at checkout, no accessibility-needs input.
- Likely abandonment point: after opening 3-4 detail sliders and reading prose; calls instead, but support is email-only, 24-48 h on business days, so she goes to a rival or the airport lot.
- Evidence: [TESTED-LIVE] snapshot: EWR 8 lots; reslab-323 amenities `['247_front_desk','restaurant','wheelchair_access']` and shuttle details quote above; reslab-184 "fully ADA accessible… No Shuttle"; reslab-277 no accessibility text; walkthrough: sort select only, support by email only; [CODE] lot-card.tsx:81-84 (accessible rule), :188-210 (slice(0,4) + "+N more"), search/page.tsx and search-results-list.tsx:61-73 (sort only, no filter); [CODE] src/data/airport-content/ewr.ts:36 (blog copy mentions wheelchair shuttle on request — nowhere in the search UI).
- Severity: High
- Type: UX gap
- Proposed improvement: add an "Accessible" filter chip on search (wheelchair_access amenity) and a card badge with wheelchair icon + text; parse/curate a "Wheelchair-accessible shuttle: yes / on request / no" field per lot (from shuttleInfo + ops confirmation) and show it above the fold in the slider; add an optional "accessibility needs" note passed to the lot. Acceptance: at EWR, toggling the filter shows exactly the lots whose amenities include wheelchair_access; the badge text "Wheelchair access" is visible on the card regardless of amenity position.
- Needs browser repro?: yes — mobile Safari on EWR results: check how reslab-323 renders its amenity chips; try to find any filter control.

### 9.6 Older traveler with hand tremor, large tap targets (JFK, Pay at Location)
- Profile: iPad mini / iPhone SE 375 px, Safari, 68 years old, essential tremor, uses a stylus/knuckle; JFK; Sat 2026-12-12 9:00 AM -> Sun 2026-12-27 6:00 PM (15 nights); 1 sedan; objection: "I keep tapping the wrong thing, and what is 'Pay at Location'?"
- Goal: pick A1 JFK Park (valet, 24/7 shuttle every 10 min, due at location) and book without mistakes.
- Entry point: https://www.triplypro.com/search?airport=JFK&checkin=2026-12-12&checkout=2026-12-27
- Attempted journey: tap sort select, tap View Details, scroll the slider, tap time selects, accept the cookie banner, tap Reserve Now.
- Friction:
  - Tap targets under 44 px (WCAG 2.2 AA minimum is 24 px; AAA/Apple HIG 44): View Details 117x36, sort select 125x34, cookie "Got it" 60x32 (Button size sm = h-8), slider time select `py-1 text-xs` (approx 26 px high), photo arrows ~30 px (p-1.5 + 18px icon), slider close X 36 px, the combobox clear X ~16 px. Mis-taps beside adjacent controls (the sort select sits next to the "N Results" count; photo arrows inside the image).
  - Cookie banner is `fixed bottom-0` full-width with only "Got it" (no decline), covering the bottom of the viewport and, on a 375x667 screen, overlaying the sticky Reserve Now footer until dismissed.
  - "Pay at Location" is a 10px amber one-liner with no explanation on the card; the slider explains "Payment will be collected on-site at check-in" but not how much is due then. A tremor user will not tolerate a surprise payment.
  - 48 half-hour options in a native `<select>`: wheel picker is steady on iOS but the select is the smallest control on the sheet.
- Likely abandonment point: the time select (mis-tap, then "Select" remains, Reserve Now stays disabled) or Pay at Location confusion at the card.
- Evidence: [TESTED-LIVE] orchestrator measured on 375 px: View Details 117x36, sort select 125x34, "Got it" 60x32, a 28x28 icon button; [CODE] cookie-banner.tsx:19-37, button.tsx:26 (sm = h-8), lot-card.tsx:178, slider :229-233 close and :252-266 arrows; [TESTED-LIVE] snapshot: reslab JFK A1 `dueAtLocation=True`, shuttle 24/7 every 10 min; [INFERRED] ~26 px select height from `py-1` + 12 px text.
- Severity: Medium
- Type: UX gap
- Proposed improvement: min 44x44 CSS px hit area on View Details, sort, slider close/arrows, cookie accept (use `min-h-11`), spacing >=8px between adjacent targets; make the cookie banner non-covering (inline above footer or a compact bar) with Accept/Decline; show "Pay now $X, at the lot $Y" on the card. Acceptance: all interactive controls measure >=44x44 at 375 px; zero overlap between the banner and Reserve Now on a 375x667 viewport.
- Needs browser repro?: yes — mobile 375x667: measure bounding boxes and check whether the cookie banner covers the slider's Reserve Now footer.

### 9.7 Cognitive-load / plain-language user on the home page to checkout
- Profile: Android mid-range 360x800, Chrome; MIA; Fri 2027-01-08 2:15 PM -> Mon 2027-01-11 6:30 PM (3 nights); one rental-sized SUV; first-time online parking buyer with an attention disorder; objection: "too many steps and unclear words".
- Goal: understand what is the cost, what happens at arrival, and complete Your Details quickly.
- Entry point: https://www.triplypro.com/ then the MIA search.
- Attempted journey: home hero (Where to / Depart / Return, no times) -> search (no times) -> results -> View Details (times asked now) -> Reserve -> 3-step checkout.
- Friction:
  - Time entry appears late: the hero and results header have no times, and the slider then demands both selects ("Select", 48 options) with no default. The user filled dates twice and must now think of times a third place; no indication that times matter for the shuttle hours.
  - Jargon: "Pay at Location", "Park Guard protection plans", "Taxes & fees included" and "Limited" mean nothing to a first-timer; "Limited" is not defined (a flag meaning bookable). 34 of 246 lots carry it.
  - Mixed trust copy: stepper + trust block + SSL/PCI badges + a 4-bullet block on cancellation; and "There's no edit option yet" in FAQ, with cancel needing the same email.
  - The "N days" billing: a Fri 2:15 PM -> Mon 6:30 PM stay is charged 4 days (calendar days inclusive), which the user can't predict and the page doesn't explain.
  - Confirmed non-issue: checkout is only 3 steps and forms use a plain single-column layout with visible labels and placeholders; the protection plan question has a radio with clear text; "No account needed — book as a guest" is up front.
- Likely abandonment point: the slider's time selects, and later the Protection plan choice (Pay stays disabled until the customer chooses).
- Evidence: [TESTED-LIVE] walkthrough: hero has no time fields; slider asks times with default "Select"; FAQ "There's no edit option yet"; "5 days" billing for Fri 10 AM -> Tue 2 PM; [TESTED-LIVE] snapshot: MIA 8 lots, 34 `limited` lots overall; [CODE] stripe-payment-form.tsx:181, :495 (Pay disabled until protectionAnswered), lot-card.tsx:137; [INFERRED] reading level/jargon assessment.
- Severity: Medium
- Type: Copy-trust
- Proposed improvement: add sensible default times (e.g., 10:00 AM / 5:00 PM) or collect time in the hero; add one-line tooltips or plain text ("Pay $X now, $Y at the lot"; "Limited = few spaces left"); show "billed as N days" on the card. Acceptance: a first-time user can complete search -> slider -> Reserve with no more than one time-entry step and no undefined jargon on the card (copy review with 5 non-experts).
- Needs browser repro?: no — copy and structure are already observed; a browser pass is optional for the Android layout.

### 9.8 Color-blind traveler (deuteranopia) and error/status signalling
- Profile: iPhone 13 (390 px) Safari, deuteranopia; LAX; Wed 2026-12-23 7:00 AM -> Sat 2026-12-26 11:00 PM (3 nights); 1 SUV; objection: "I can't see what is an error and which plan is picked".
- Goal: finish Your Details, pick a Protection plan, pay.
- Entry point: https://www.triplypro.com/checkout?lot=reslab-…&checkin=2026-12-23&checkinTime=7%3A00+AM&checkout=2026-12-26&checkoutTime=11%3A00+PM (lot from LAX search)
- Attempted journey: leave email blank and Continue; read error; choose a protection plan (emerald vs gray radio colours); read Payment Error if card declined.
- Friction:
  - Field errors rely on a red border plus small red text; text is present (not colour only), but at red-500 12px = 3.76:1 it's thin, and no icon.
  - Protection plan options use emerald-600 vs gray-600 radio colours and a "-top-2.5 left-3 bg-emerald-600 text-[10px]" badge: selection state is a native radio (visible), so selection is fine, but the badge white on emerald-600 at 10px ≈ 3.8.
  - Search card: "Lowest total" (green-700 on green-50), "Most booked" (orange-700 on orange-50 = 4.88) badges differ mainly by colour but also have icon and text: OK. The "No Shuttle" red X vs "Free Shuttle" green bus differ by icon and text: OK.
  - Payment error panel (red box) has the title "Payment Error" and an icon, so not colour-only; but it has no `role="alert"`, so also invisible to a screen reader.
  - Confirmed non-issue: colour is never the only cue in the audited components (text + icon accompany status colours).
- Likely abandonment point: none specific; low risk.
- Evidence: [CODE] customer-details-step.tsx:65, :71-72; protection-plan.tsx:126, :132-138; lot-card.tsx:67-100 (icons + labels), stripe-payment-form.tsx:464-474 (icon + label, no role); [INFERRED] contrast figures computed by script.
- Severity: Low
- Type: Preference
- Proposed improvement: add an alert icon to field errors and raise error text to red-700 (>=4.5:1); `role="alert"` on payment error. Acceptance: error text >=4.5:1; failed payment announced by a screen reader within 1 s.
- Needs browser repro?: no — static review is sufficient; optionally run a Chrome DevTools colour-vision emulation pass on /checkout.

### 9.9 Spanish-speaking limited-English customer, SFO
- Profile: Android Galaxy A14 (360 px), Chrome set to Spanish (es-MX), Google Translate auto-prompt; SFO; Sun 2026-12-20 5:30 AM -> Sat 2027-01-02 9:00 PM (13 nights); 1 compact car; limited English; objection: "I don't understand 'Pay at Location' or the cancellation rules and can't ask anyone".
- Goal: understand shuttle schedule, price and cancellation; book.
- Entry point: https://www.triplypro.com/search?airport=SFO&checkin=2026-12-20&checkout=2027-01-02
- Attempted journey: page loads in English with `<html lang="en">`; Chrome offers translation; user translates; opens slider; reads shuttle text; looks for Spanish contact.
- Friction:
  - No localization: `<html lang="en">`, no i18n library or hreflang (grep of src found none); support is email-only English, 24-48 h on business days, no phone/chat; the user cannot ask about the cancellation policy (account sign-in needed for guests to cancel).
  - Browser translation of dynamic UI: time `<option>` text like "5:00 AM" and shuttle strings translate unevenly; "Pay at Location"/"Limited" are translated literally and mislead ("Limitado" reads as "restricted").
  - Shuttle hours text is lot-supplied English prose (SFO Best Western: "5:00 AM - 10:15 AM: Shuttle runs every 45 minutes…"); 2 of the 3 wheelchair SFO lots show "No shuttle".
  - Sign-in-with-same-email rule to cancel as a guest is subtle even in English.
- Likely abandonment point: the cancellation/Pay-at-Location decision; no one to ask.
- Evidence: [CODE] layout.tsx:98 (`<html lang="en">`); [CODE] git grep for next-intl/i18n/hreflang found no hits; [TESTED-LIVE] walkthrough: support by email only 24-48 h, FAQ guest-cancel via same email; [TESTED-LIVE] snapshot: SFO lots (Best Western Grosvenor shuttle text; Hampton Inn and Home2Suites "No shuttle"); [INFERRED] machine-translation behaviour.
- Severity: Medium
- Type: Inventory-pricing limitation (language coverage), Copy-trust
- Proposed improvement: Spanish for the highest-intent surfaces first (hero, search chrome, checkout trust copy, cancellation text), with `lang` per page and structured, translatable shuttle hours; add a visible Spanish-capable contact path. Acceptance: the booking path (home -> search -> slider -> checkout) has 100% translated UI strings in es; `<html lang>` follows the chosen language.
- Needs browser repro?: no — absence is established from code/search; a Chrome auto-translate pass is optional.

### 9.10 Zero-inventory airport (YYZ) for an assistive-tech user
- Profile: Windows desktop 1366x768, Chrome + Windows Magnifier 300% + screen reader (JAWS), Canadian traveler; YYZ (Toronto Pearson, zero lots); Fri 2026-12-11 6:00 AM -> Fri 2026-12-18 11:30 PM (7 nights); 1 SUV; objection: "I found YYZ in the list, but nothing happened".
- Goal: park at YYZ.
- Entry point: https://www.triplypro.com/airport-parking (lists all 85 airports equally) -> YYZ.
- Attempted journey: pick YYZ from the list or search combobox; read the empty results page.
- Friction:
  - YYZ is one of 15 airports that return 0 lots (ABE ABQ AZO DAL GEG IDA MEM ROA RSW SLC SNA YOW YUL YYC YYZ) yet the airport index treats all 85 equally and does not flag them.
  - Empty state (results list / `role="status"` partial banner) should announce "No lots" to AT; `role="status"` exists on the partial-failure banner (search-results-list.tsx:87) but I did not verify a no-results announcement. The results count `<span>` is not a live region, so an updated count after Update is silent to screen readers.
  - Zero-lot page gives no accessibility-relevant alternatives (e.g., "nearest airport with parking"); a magnified user loses context (the map region and header are far apart at 300%).
- Likely abandonment point: immediately on empty results.
- Evidence: [TESTED-LIVE] snapshot: 15 airports with 0 lots incl. YYZ; walkthrough: /airport-parking lists all 85 with no indicator; [CODE] search-results-list.tsx:50-58 (count span, no aria-live), :87 (role=status only in partial banner); [INFERRED] AT announcement of empty state (not checked in browser).
- Severity: Medium
- Type: Inventory-pricing limitation
- Proposed improvement: mark no-inventory airports as "Coming soon"/remove from marketed count, and make the results count and empty state an `aria-live="polite"` region ("0 lots found for YYZ; try nearby airports"). Acceptance: a screen reader announces the result count after every search; the airport index visually and programmatically distinguishes airports with inventory.
- Needs browser repro?: yes — desktop Chrome + NVDA: load /search?airport=YYZ&checkin=…&checkout=… and check whether anything is announced.

---

## Squad top findings
1. Slider is a modal in appearance only: no `role="dialog"`/`aria-modal`, no Escape, no focus move/trap/restore, close and photo buttons unnamed, time `<select>`s unlabeled (label lacks `htmlFor`). Blocks screen-reader and keyboard users at the exact step that must be completed (times). [CODE product-detail-slider.tsx:219-235, :329-352] [TESTED-LIVE orchestrator]
2. Checkout fields lack label association and error semantics on the details and vehicle steps (no `htmlFor`, no `aria-invalid`/`aria-describedby`, no `role="alert"`, no `autocomplete`); stepper has no `aria-current`; payment error not announced. The ResLab dynamic extra-fields are the one coded correctly. [CODE customer-details-step.tsx:51-127, vehicle-details-step.tsx:157-248, checkout-steps.tsx, stripe-payment-form.tsx:464]
3. Brand CTA contrast fails: white on #f87356 = 2.77:1 on every primary button (View Details, Reserve Now, Update, Pay), hover 3.56; "Limited" tag white on amber-500 = 2.15:1 at 10px; gray-400 placeholders 2.4–2.5. [CODE globals.css:24, lot-card.tsx:137] [INFERRED computed ratios]
4. Wheelchair users cannot filter or reliably see accessibility: 85 of 246 lots have `wheelchair_access` but search has only a sort select; the card falls to a generic check chip within 4-chip cap; shuttle lift info exists only in free text for ~5 lots. [TESTED-LIVE snapshot data] [CODE lot-card.tsx:81-84, :188-210]
5. Tap targets and cookie banner: View Details 117x36, sort 125x34, "Got it" 60x32, slider time select ~26 px; banner is fixed over the bottom of the viewport with no decline. [TESTED-LIVE orchestrator measurements] [CODE cookie-banner.tsx:19-37, button.tsx:26]
6. Confirmed non-issues: lot cards use real `<button>`; date triggers are labeled buttons with a Radix/react-day-picker calendar (keyboard nav, Escape); viewport allows zoom (`maximumScale: 5`); airport combobox has keyboard handling; status is never colour-only; no Spanish/i18n at all (`<html lang="en">`, email-only support). [CODE lot-card.tsx:239, date-picker.tsx:157-205, layout.tsx:85-98]

---

## Squad 10

### Squad 10 — Visitors from search, blog posts, airport pages (simulated; evidence-grounded)

Method notes. Fetches used: 10 public pages (homewood-suites lot, SLC hub, ATL hub, YYZ BF post, DAL promo post, ATL-vs-comparison, /park-stay, /blog/airport/YYZ + CMS GET API for ~10 post bodies). 0 search-API calls. Snapshot = Nov 20→24, 10:00→14:00 (5 billed days). Code = upstream/main.
CMS census (GET /api/posts, 4,699 posts): YYZ 59, YYC 38, YUL 35, YOW 4 = 136 articles for zero-inventory airports, plus ~13 Dallas Love Field (DAL) articles tagged DFW. Zero posts exist for the other zero-inventory airports.
Confirmed non-issues: PHX article "off-site from about $4/day" matches live (La Quinta Tempe $20.95/5d = $4.19). ATL/BWI/PHX/HPN/SFO/POE-article lot links all point at slugs that exist (only `homewood-suites` is absent from the snapshot, but the page itself renders, 200). Comparison page (`/atlanta-atl/spothero-vs-...`) and `/park-stay` return 404 for the public — by design (comparison `status !== "live"` -> notFound; park-stay is access-gated, `park-stay/page.tsx:23`).

---

### 10.1 Black-Friday Toronto flyer (zero-inventory airport, blog landing)
- Profile: iPhone 14, 390x844, Safari. YYZ. Fri 2026-11-27 10:00 AM -> Sun 2026-11-29 9:00 PM (3 days). One adult, sedan. Googled "pearson airport parking black friday". Wants cheapest off-site lot with free cancellation. Objection: wants a real price before giving anything.
- Goal: Find a C$6-ish/day lot and book.
- Entry point: https://www.triplypro.com/blog/pearson-airport-parking-black-friday
- Attempted journey: land on article -> read excerpt "Compare all 13 YYZ lots" -> scroll past featured image -> widget "Book YYZ airport parking — pick your dates" (YYZ preselected) -> pick dates -> Search Parking -> /search?airport=YYZ&checkin=..&checkout=.. -> results.
- Friction:
  - Article states "All 13 off-site lots listed on Triply include free cancellation", "verified based on Triply's live November 2026 search data", rates "from C$6.25/day". Triply returns 0 YYZ lots (considered 0). [TESTED-LIVE: snapshot YYZ "0 lots (considered 0)"; page text of the post]
  - Widget preselects YYZ because every airport is `enabled: true`, including YYZ (`getSellableAirportCode` only checks `enabled`). [CODE: src/config/airports.ts:1076-1079; src/components/blog/ArticleBookingPrompt.tsx:19-28] [TESTED-LIVE: live HTML "Book YYZ airport parking — pick your dates"]
  - Search ends in "No parking lots found for your search criteria." — no reason, no alternative, no notify option. [CODE: src/components/search/search-results-list.tsx:106-108]
  - Same article has a mid-article CTA "Ready to Book Your YYZ Airport Parking?" -> /search?airport=YYZ (same dead end). [CODE: ArticleCta.tsx:41,46]
  - /blog/airport/YYZ also sells "Find Parking at YYZ" and lists 59 guides. [TESTED-LIVE]
  - Mobile: widget sits below a 256px featured image (`h-64`) plus a py-12 header with 3-4 line H1 and excerpt, so it is likely below the first screen; date fields render as "Loading…" skeletons first (compact variant is `ssr:false`). [CODE: blog/[slug]/page.tsx:191,242; search-widget.tsx:21-24] [TESTED-LIVE: "Depart Loading… Return Loading…" in served HTML] [INFERRED: below fold at 390x844]
- Likely abandonment point: the empty search result (after ~6 taps: dates x2, search, wait).
- Evidence: see tags above.
- Severity: Blocker (136 articles x every visit is a guaranteed non-booking; plus unsupported claims about inventory and cancellation)
- Type: Defect (blog gate) + Copy-trust
- Proposed improvement: (a) derive "sellable" from live inventory (airports with >=1 lot in a cached coverage map), not `enabled`; for non-sellable airports hide the widget and show "We don't sell YYZ yet — here are lots near BUF/…" or a notify-me field. (b) CMS lint: any article for a zero-inventory airport cannot contain "on Triply" price/lot claims. Acceptance: for the 15 zero-lot airports, no blog page renders a booking widget/CTA that links to an empty search; the YYZ BF post contains no "13 lots on Triply".
- Needs browser repro?: yes — mobile 390x844: measure widget y-position, confirm search for YYZ returns the empty text; desktop same.

### 10.2 "Salt Lake City airport parking" Google click (zero-inventory hub, Android)
- Profile: Pixel 7, 412x915, Chrome. SLC. Sat 2026-12-12 6:00 AM -> Wed 2026-12-16 11:30 PM (4 nights, ~5 days). Family of 3, minivan. Early flight, wants a shuttle running before 6 AM. Objection: "is this real?"
- Goal: See prices, book a lot with early shuttle.
- Entry point: https://www.triplypro.com/salt-lake-city-slc/airport-parking
- Attempted journey: land on hub -> sees hero + widget -> scrolls -> sees banner -> clicks "Other Airport Parking" tile.
- Friction:
  - Hub shows no lots, only: "No Online Availability for the Next Week — Parking near Salt Lake City International Airport is booked or unavailable for the next week. Use the search above to check your dates." That is false/misleading for SLC: the API returns 0 lots structurally (considered 1) at every date, not a one-week sell-out. [TESTED-LIVE: page text; snapshot SLC 0 lots] [CODE: src/lib/airport-page/content.ts:185-203 — "Coming Soon" copy only when locationsConsidered===0]
  - Page still title-tags "Cheap SLC Parking Rates", robots `index, follow` (noindex only when `locationsConsidered` is 0, here 1), so Google keeps sending SLC searchers here. [TESTED-LIVE: `<title>`, robots meta] [CODE: airport-parking/page.tsx:73-79]
  - Hero still promises "Free Cancellation · Trusted Lots · Instant Confirmation", date picker + "Search Parking" that will return nothing. [TESTED-LIVE]
  - "Other Airport Parking" is region-based with no inventory check: for a Utah (West) airport it lists ABQ, BUR, DEN, FAT, GEG, IDA — ABQ, GEG, IDA also return 0 lots. [TESTED-LIVE: page text; snapshot] [CODE: src/components/airport/other-airports.tsx:36-48]
  - Only DEN/BUR/FAT in that list are real alternatives (DEN is ~500 mi away).
- Likely abandonment point: on landing (no price, no lot) or after clicking ABQ/GEG/IDA (second dead end).
- Evidence: [TESTED-LIVE] + [CODE] as tagged.
- Severity: Blocker for this visitor; affects 15 hubs.
- Type: Inventory-pricing limitation + UX gap + Copy-trust
- Proposed improvement: for airports with 0 lots across two consecutive coverage checks, replace banner with "We don't have SLC lots yet. Get an email when we do" (email field) + 3 nearest airports that DO have inventory; filter Other Airports by inventory; drop "Instant Confirmation/Trusted Lots" hero chips and "Cheap … Rates" title for these. Acceptance: no tile on any hub links to an airport with 0 lots; empty hub copy never says "next week" when `locationsConsidered` has been empty for >7 days.
- Needs browser repro?: yes — mobile: confirm banner position vs fold; click each Other-Airports tile and note which are empty.

### 10.3 Love Field regular reading a "promo code" post (airport mismatch, desktop)
- Profile: MacBook Air 1440x900, Chrome. Dallas Love Field (DAL). Fri 2026-12-04 7:00 AM -> Sun 2026-12-06 8:00 PM (2 nights). Solo, small SUV. Googled "dallas love field airport parking promo code". Wants a $3-10 discount and the $6.95/day lot.
- Goal: Use a promo code on a cheap off-airport lot near Love Field.
- Entry point: https://www.triplypro.com/blog/dallas-love-field-airport-parking-promo-code
- Attempted journey: read excerpt "Compare off-airport lots from $5/day" -> email capture "Looking for a DFW parking promo code?" (does not submit) -> widget "Book DFW airport parking" (DFW preselected) -> dates -> search -> results.
- Friction:
  - Article is about Love Field (DAL) but tagged `airportCode: DFW`; every module says DFW: email box "Looking for a DFW parking promo code?", widget "Book DFW airport parking", mid CTA "Ready to Book Your DFW…". DAL returns 0 lots; DFW (a different airport, ~15 mi away) returns 2. [TESTED-LIVE: post page text, CMS `airportCode: DFW`; snapshot DAL 0 / DFW 2]
  - Article says "Off-airport lots near Dallas Love Field start at $6.95/day through platforms like Triply" and "see all verified lots side by side with promo codes pre-applied". Triply sells no DAL lot. [TESTED-LIVE: post body]
  - Results the reader gets: Clarion Inn & Suites North (1.8 mi from DFW, 'limited', $22.5 for 4 nights) and Westin DFW — not near Love Field; nothing signals the airport swap, the user may book a lot 15 miles from their airport. [TESTED-LIVE: snapshot DFW]
  - ~13 articles share this pattern (Love Field articles tagged DFW). [TESTED-LIVE: CMS list]
  - The 10% email capture is a real offer, but "doesn't apply at the airport's own garages" is the only caveat. [TESTED-LIVE]
- Likely abandonment point: results page (names DFW hotels, not Love Field) — or worse, a wrong-airport booking (support/cancel cost).
- Evidence: [TESTED-LIVE] tagged above; wrong-airport booking risk [INFERRED].
- Severity: High (wrong-airport booking risk + false inventory claim)
- Type: Defect (CMS tagging/gating) + Copy-trust
- Proposed improvement: add DAL as an explicit non-sellable airport code; widget must say "We don't sell Love Field. Closest we sell: DFW (~16 mi)" with a confirm tap before search; email capture and CTA headings use the article's own airport. Acceptance: no DAL article renders "DFW" in widget/CTA/email-capture copy without the "not Love Field" notice.
- Needs browser repro?: yes — desktop: confirm widget/capture strings, run DFW search and read the lot names/distances.

### 10.4 Atlanta cost-per-day researcher (desktop, price-consistency)
- Profile: Windows laptop 1366x768, Edge. ATL. Fri 2026-11-20 10:00 AM -> Tue 2026-11-24 2:00 PM (Thanksgiving week). 2 adults, sedan. Searched "atlanta airport parking cost". Objection: "your page said $10/day, why $12?"
- Goal: Book the cheapest lot shown in the article.
- Entry point: https://www.triplypro.com/blog/atlanta-airport-parking-cost
- Attempted journey: read "Quick answer: … from $10.01 to $20.69 a day across 4 lots (prices checked 6 Nov 2026)" -> click mid-article "Find Parking Now" (/search?airport=ATL) -> lands on search with no dates chosen -> read cards -> compare.
- Friction:
  - Same lot, three prices: article Four Points $10.01/day; ATL hub "from $9.67/day" (sample 7-day trip); live search card $12.29/day ($61.43 total for 5 days). API grandTotal is 55.48 ($11.10/day). [TESTED-LIVE: article text, hub text, walkthrough; snapshot]
  - Article lists 4 lots (incl. PreFlight $18.52/day, hub $13.14/day) but the Nov 20-24 search returns 3: PreFlight is absent. A reader who wanted PreFlight (24/7 shuttle to both terminals) cannot find it, with no "unavailable for your dates" explanation. [TESTED-LIVE: snapshot ATL 3 lots, considered 11; article/hub list PreFlight] [INFERRED: cause = date-specific availability]
  - CTA link carries no dates: `/search?airport=ATL`. Search silently defaults to today -> today+7 (UTC date) and runs, so the first thing shown is a trip the reader did not choose. [CODE: ArticleCta.tsx:20-22; search/page.tsx:43-50] [INFERRED: user mistakes defaults for their dates]
  - Even with dates picked, cards carry no times; the times must be re-chosen inside the "View Details" slider. [TESTED-LIVE: walkthrough]
  - Hub says "Guide updated November 5, 2026"; article updated 6 Nov — freshness is fine. [TESTED-LIVE]
- Likely abandonment point: search results, when per-day ($12.29) is above the article's ($10.01) — 'bait' perception — or after PreFlight is missing.
- Evidence: [TESTED-LIVE]/[CODE] as tagged.
- Severity: Medium
- Type: Copy-trust + UX gap
- Proposed improvement: label article/hub prices as "sample 7-day trip, before $5.95 service fee" or compute them with the same formula as the card; add checkin/checkout from the widget into CTA links when known; on search, show a banner "Not available for your dates: PreFlight …" when a hub-listed lot is missing. Acceptance: for a given lot, article, hub and search card per-day figures differ by <$0.25 for the same dates, or each carries a label naming the basis.
- Needs browser repro?: yes — desktop: click the mid-article CTA with a clean URL, record default dates shown; compare the Four Points card to the article.

### 10.5 Cruise-goer on a phone (Port Everglades, lot-page link validity)
- Profile: Samsung S23, 360x780, Chrome. Port Everglades (POE). Sat 2026-12-19 8:00 AM -> Sat 2026-12-26 4:30 PM (7 nights, ~8 days). 2 adults, 1 SUV. Booked a cruise, needs parking + ride to the ship. Objection: "does the shuttle go to the port?"
- Goal: Cheapest lot with a cruise shuttle.
- Entry point: https://www.triplypro.com/blog/port-everglades-parking-cost
- Attempted journey: read excerpt "11 lots… $7.10 to $24.46 a day" -> table -> clicks "Homewood Suites" (the $7.10 headline lot) -> lot page -> sees dates default -> tries to pick times.
- Friction:
  - Article is honest that cruise shuttle is rare: only Park By The Ports Cruise Parking includes a port shuttle ($24.46/day, $171.20 for a week). [TESTED-LIVE: post text] Confirmed good.
  - Headline "from $7.10/day" is Homewood Suites, which says on its own page "cruise shuttle service is not available" (and its shuttle goes to the airport only). [TESTED-LIVE: lot page + post]
  - "11 lots" in article vs 10 lots returned for Nov 20-24; `homewood-suites` is absent from that snapshot but its lot page is live with $6.99/day, $55.93 for 8 days, "Full refund if cancelled", "Reserve Now", default dates Nov 7-14 (tomorrow+8). [TESTED-LIVE: snapshot POE 10 lots; lot page text]
  - Lot page: check-in/out `<select>`s default "Select" with message "Please select check-in and check-out times"; 48 half-hour options each; for a cruise (boarding 11-1) the shuttle hours "4:00 AM – 1:00 AM, every hour" are shown far above, no warning vs chosen time. [TESTED-LIVE: lot page text] [CODE: src/components/lot/booking-widget.tsx:190-205 — Reserve disabled until times set]
  - Cruise cost scale: week total $171.20 vs $49.68 for a lot that does not reach the port; user must read a long table to see this. [TESTED-LIVE: post text]
- Likely abandonment point: after opening a lot page and learning there is no port shuttle (backtrack to article) — or before, on the ~30-option time selects on a 360px screen.
- Evidence: [TESTED-LIVE] + [CODE].
- Severity: Medium
- Type: UX gap (cruise intent unsupported in search) + Inventory-pricing limitation
- Proposed improvement: add a "Goes to cruise port" filter/badge on POE search cards (data already in lot descriptions); article table rows should show a badge and sort cruise-shuttle lots first. Acceptance: on /search?airport=POE a "Cruise shuttle" toggle leaves only lots whose shuttle description includes the port; article headline price quotes the cheapest lot WITH a port shuttle.
- Needs browser repro?: yes — mobile 360x780: open /fort-lauderdale-poe/airport-parking/homewood-suites, set the dates in the article's sample week, confirm what "Reserve Now" does for Nov 20-24 (unavailable?).

### 10.6 Westchester commuter with a pay-at-lot lot (HPN, one-lot airport)
- Profile: iPhone SE 375x667, Safari. White Plains (HPN). Mon 2026-12-07 6:00 AM -> Fri 2026-12-11 9:00 PM (4 nights). Solo business traveler, company card. Searched "how much is parking at hpn airport". Objection: money due at the lot; "is the garage cheaper?"
- Goal: pick the cheapest honest option.
- Entry point: https://www.triplypro.com/blog/hpn-airport-parking
- Attempted journey: article quick answer -> "Purchase Park 2 Fly Westchester … about $23/day" -> widget -> dates -> /search?airport=HPN -> one card -> View Details -> price breakdown.
- Friction:
  - Article is candid that the airport's own Long-Term lot is cheaper: $146.16 vs $162.99 for a week. [TESTED-LIVE: post text] Confirmed trust positive, but it hands the reader a reason not to book.
  - Single bookable lot. Snapshot total $111.71 of which $91.71 is due at the lot, i.e. only ~$20 charged online. [TESTED-LIVE: snapshot HPN dueAtLot True $91.71] The article says "$28.59 paid online, $134.40 at the lot" for its week. [TESTED-LIVE]
  - 2-day minimum; search card shows "Taxes & fees included" for the whole $111.71 even though most is paid at the lot (needs check). [TESTED-LIVE: walkthrough card copy] [CODE: price-breakdown.tsx:29-32 shows dueAtLocation line in the slider]
  - Checkout summary/trust copy says "Secure payment, processed by Stripe" — a business traveler paying $20 online + $91 offline will wonder what the receipt shows. [TESTED-LIVE: walkthrough] [INFERRED]
  - Mobile: widget below image/header (see 10.1). [INFERRED]
- Likely abandonment point: at the card — reader compares the $23/day lot with the airport's $20.88/day lot the article just described and leaves.
- Evidence: tagged.
- Severity: Low-Medium
- Type: Inventory-pricing limitation + Copy-trust
- Proposed improvement: on cards with `dueAtLocation`, show "Pay now $20.00 · Pay at lot $91.71" under the total; keep the article honesty. Acceptance: any card whose `dueAtLocation > 0` shows both amounts without opening the slider.
- Needs browser repro?: yes — mobile: check how the card/slider/checkout summary label the online vs at-lot split.

### 10.7 BWI economy-rates searcher (duplicate lots, article vs card price)
- Profile: Pixel 8 412x915, Chrome (Google AI answer referral). BWI. Sat 2026-11-21 9:00 AM -> Sun 2026-11-29 8:00 PM (8 nights). 2 adults, minivan. Searched "bwi airport parking rates economy". Objection: wants BWI economy rate; fears hidden fees.
- Goal: Book the cheapest BWI lot.
- Entry point: https://www.triplypro.com/blog/bwi-airport-parking-rates-economy
- Attempted journey: read "$6.16–$8.35/day" -> widget -> dates -> results -> sort Lowest Total.
- Friction:
  - Article's $6.16/day = Doubletree Baltimore API total $30.79 / 5 days, i.e. excludes the $5.95 Triply service fee that the card adds. Card would read ~(30.79+5.95)/5 = ~$7.35/day. [TESTED-LIVE: snapshot DoubleTree $30.79; walkthrough "UI total = API + $5.95"] [INFERRED: card value; compare POE article, which DOES include the fee: $49.68 = 7 x 6.25 + 5.95] — articles are inconsistent in whether fee is included.
  - Clarion Hotel BWI North appears twice in the same results (ResLab ids 370 and 371, same slug `clarion-hotel-bwi-north`, same price, one lot page). [TESTED-LIVE: cov/BWI.json] [INFERRED: duplicate cards in UI]
  - Article title "Rates Economy 2026: Full Guide" with excerpt "Compare 2026 rates, shuttle times, and savings tips." — the excerpt carries no price, no "bookable on Triply". [TESTED-LIVE: CMS]
  - 4 sibling BWI articles share near-identical titles (rates-economy / garage-rates / daily-rate / daily-parking-cost) — cannibalization; reader may click all four. [TESTED-LIVE: CMS list]
  - Widget placement/skeleton as 10.1. [INFERRED]
- Likely abandonment point: cards (a $7.35 card for a "$6.16" article lot) or the duplicate card (looks like an error).
- Evidence: tagged.
- Severity: Medium
- Type: Defect (duplicate lot) + Copy-trust
- Proposed improvement: dedupe results by lot slug (keep cheapest, merge availability); articles quote prices on the card formula or label "before service fee". Acceptance: no two cards share a slug; article and card per-day figures agree to within $0.25 on the same dates.
- Needs browser repro?: yes — desktop and mobile: run BWI search, confirm two Clarion cards and what each opens.

### 10.8 PHX Thanksgiving traveler (confirmed-good price match, long hub article)
- Profile: iPad Air 820x1180, Safari. PHX. Wed 2026-11-25 5:00 AM -> Sun 2026-11-29 10:00 PM (4 nights). Couple, sedan. Came from a ChatGPT answer citing the PHX guide. Objection: "which lot is closest to Terminal 3?"
- Goal: Cheap lot near terminal with a pre-dawn shuttle.
- Entry point: https://www.triplypro.com/blog/phx-airport-parking
- Attempted journey: land on 25k-character hub article -> use TOC -> Terminal 3 section -> "Search PHX parking" -> dates -> results (5 lots) -> pick Howard Johnson.
- Friction:
  - Price claim holds: article "off-site lots from about $4/day"; live cheapest La Quinta Inn & Suites Tempe University $20.95 / 5 days = $4.19 ('limited'). [TESTED-LIVE: post text; snapshot PHX] Confirmed non-issue.
  - The article has no deep links to individual lot pages (lot-link count 0), only `/phoenix-phx/airport-parking` and `/search?airport=PHX`; the reader must discover lots on the search page, and the named cheapest lot is 3.9 mi away with 'limited' availability. [TESTED-LIVE: link extraction; snapshot]
  - Article ~25k chars: mid-article CTA sits at ~30% (`getMidArticleInsertIndex`), end CTA is a one-line link. [CODE: blog/[slug]/page.tsx:137,274-285]
  - Thanksgiving window: "limited" badge on the cheapest lot but no hint of scarcity on the article. [INFERRED]
  - PHX Terminal 3 construction link in the article points off-site (skyharbor.com). [TESTED-LIVE: link list]
- Likely abandonment point: none structural; a fraction leave via 8 outbound airport links.
- Evidence: tagged.
- Severity: Low
- Type: UX gap (minor) — otherwise Confirmed non-issue for pricing
- Proposed improvement: in hub articles, link the 3 cheapest bookable lots with live "from $X" chips (same source as the hub). Acceptance: each hub article for an airport with inventory contains >=3 working lot-page links whose prices match the hub list.
- Needs browser repro?: yes — tablet 820x1180: scroll position of widget and mid CTA; confirm click path to a lot card in <=4 taps.

### 10.9 Three-week Newark holiday parker (EWR, long trip, stale article, competitor exits)
- Profile: iPhone 15 Pro Max 430x932, Chrome. EWR. Sat 2026-12-19 5:30 AM -> Sun 2027-01-10 11:00 PM (22 nights, 23 days). Family of 4, large SUV (3 rows). Searched "cheapest parking at EWR". Objection: wants a lot that accepts a large SUV, no surprise at the lot.
- Goal: Cheapest 3-week lot that fits an SUV.
- Entry point: https://www.triplypro.com/blog/newark-airport-parking
- Attempted journey: title promises "from $6/day" -> widget -> dates (window 100 days; Jan 10 is within window) -> results -> sort by price -> look for SUV/oversize.
- Friction:
  - Title "from $6/day"; snapshot cheapest EWR is Red Carpet Inn $27.38/5 days = ~$5.48/day (+ fee in UI) with `limited` availability and a 1-day minimum; the next cheapest, Apex, is $53.19/5 days ($10.6) with money due at the lot. [TESTED-LIVE: snapshot EWR]
  - 5 of 11 EWR lots have money due at the lot (Apex, Motel 6, Maas, EWR Airport Parking, plus Apex pricing) — the card says "Taxes & fees included" while part is paid on site. [TESTED-LIVE: snapshot dueAtLot True x4] [INFERRED: card wording]
  - Article last content update 2026-07-28 (published 2026-04-05); price claims (e.g. "$21/day on-site pre-booked") are 3+ months old, header shows "Updated July 2026". [TESTED-LIVE: CMS fields; post page header logic] [CODE: blog/[slug]/page.tsx:219-228]
  - Article links out to competitors/coupon sites (parksleepfly.com, onairparking.com, greenpromocode.com, simplycodes.com, ewr.parksleephotels.com) in the body; mid-booking exits. [TESTED-LIVE: link list from CMS]
  - Long-stay unknowns: no vehicle-size filter on search (large SUV); size must be read lot by lot. [INFERRED from search-header fields in walkthrough; lot page has vehicle-size modal (src/components/lot/vehicle-size-modal)]
  - Date picker: check-in must be <=100 days out (OK), but a 22-night stay is far longer than the 60-day waitlist cap, so no issue; the min-stay check disables Reserve with a message when below min. [CODE: booking-window.ts:11,25; booking-widget.tsx:190-205]
- Likely abandonment point: results page (no SUV/oversize filter; "limited" badge on the cheapest lot; at-lot payments).
- Evidence: tagged.
- Severity: Medium
- Type: UX gap (no vehicle filter) + Copy-trust (stale 'from $6')
- Proposed improvement: add a "Fits SUV / oversized" filter (from lot extra fields) on search; make the article's "from $X/day" live or re-date it. Acceptance: at /search?airport=EWR the user can filter to lots that accept oversized vehicles in one tap; article price chips refresh from the same cached source as the hub (<=24h old).
- Needs browser repro?: yes — mobile: run the 22-night EWR search, confirm no hidden date errors, check what filters exist, and read the card's 'due at lot' wording.

### 10.10 San Francisco "promo code" reader, short trip, min-stay trap (SFO)
- Profile: Galaxy A54 360x800, Chrome. SFO. Thu 2026-12-17 11:00 AM -> Sat 2026-12-19 7:00 PM (2 nights, 3 days). Solo, hatchback. Googled "sfo long term parking promo code". Objection: the title says 2025; "is this still valid?"
- Goal: Apply a promo code and get $9/day.
- Entry point: https://www.triplypro.com/blog/sfo-long-term-parking-promo-code-2025
- Attempted journey: sees "2025" in title/H2 -> scrolls -> mid CTA -> /search?airport=SFO (no dates) -> picks dates -> looks at the $9/day lot.
- Friction:
  - URL slug, H2 and excerpt say 2025 while the page is dated Apr 2026 (updated Oct 2026): "Find the best SFO long-term parking promo codes for 2025", H2 "Best SFO Long-Term Parking Promo Code for 2025?". Stale year in a visible heading, 2026-11-06. [TESTED-LIVE: CMS title/excerpt; post text]
  - The site's email capture is the only real code ("10% off first booking") but this is a non-"promo" post? The `isPromoPost(slug)` logic decides if the capture goes to the top; verify it triggers for this slug. [CODE: blog/[slug]/page.tsx:134,232-236] [INFERRED]
  - Cheapest lot: Hampton Inn $45.87/5 days (~$9.17/day) — fits "$9/day". But Best Western Grosvenor (the only SFO lot with a shuttle) has `minDays=5` and 'limited'; for a 3-day trip it is not bookable, shown in results without a stay filter. [TESTED-LIVE: snapshot SFO; post text "only one with a shuttle … 5-day minimum"]
  - For a 3-day trip the sibling article quotes "Triply's hotel lots run about $31 to $72 for 3 days, with no shuttle" — honest, but the user now sees "no shuttle" for every bookable lot except the 5-day-minimum one. [TESTED-LIVE: post text]
  - Booking-widget disables Reserve below min days and shows a reason (works), but the search card does not filter or label min-stay. [CODE: booking-widget.tsx:190-205] [INFERRED: card has no min-stay label]
- Likely abandonment point: reading "no shuttle" after clicking a lot; or on arrival noticing "2025".
- Evidence: tagged.
- Severity: Medium
- Type: Copy-trust (stale year) + UX gap (min-stay)
- Proposed improvement: rewrite "2025" -> "2026" in title/H2/excerpt (keep the slug with a 301 only if needed); add "5-night minimum" tag on cards whose `minimumBookingDays` exceeds the searched stay and push them to the bottom. Acceptance: no published article has a prior year in H1/H2/meta title; cards below min stay show a visible label before the slider.
- Needs browser repro?: yes — mobile: search a 3-day SFO trip and confirm how the Best Western card reads (and whether Reserve is disabled with a reason).

---

## Squad top findings
1. Blog/CTA gate is `enabled`-only, so ~136 YYZ/YYC/YUL/YOW articles (plus ~13 Love Field posts tagged DFW) show a preselected booking widget that ends in "No parking lots found…", and some articles claim "13 lots on Triply, free cancellation". [CODE: airports.ts:1076, ArticleBookingPrompt.tsx:19; TESTED-LIVE: YYZ post, CMS counts, snapshot YYZ 0]
2. Zero-inventory hubs (SLC etc.) say "booked or unavailable for the next week", stay `index, follow`, and cross-link to other empty airports (ABQ, GEG, IDA). [TESTED-LIVE: SLC page; CODE: content.ts:185-203, other-airports.tsx:36-48]
3. Same lot shows different prices across article / hub / search (Four Points ATL $10.01 / $9.67 / $12.29), and articles disagree on whether the $5.95 service fee is included (BWI excludes, POE includes). [TESTED-LIVE + INFERRED]
4. Article lot lists can name lots that the search for the traveler's dates omits (PreFlight ATL; Homewood Suites POE is the article's headline "$7.10" lot and has no cruise shuttle) with no "unavailable for your dates" explanation. [TESTED-LIVE]
5. Mid-article CTAs link to `/search?airport=XXX` with no dates, so search silently runs today -> +7 days; the widget is likely below the first mobile screen and its date fields load as "Loading…" skeletons. [CODE: ArticleCta.tsx:20-22, search/page.tsx:43-50, search-widget.tsx:21-24; INFERRED: fold]
6. BWI results carry the same lot twice (ResLab 370 and 371, one slug); min-stay and pay-at-lot details (SFO 5-night minimum, HPN $91.71 at lot) are visible only after opening a lot. [TESTED-LIVE: cov/BWI.json, snapshot; CODE: booking-widget.tsx:190-205]

---

# Appendix B — Depth-stage browser reproductions



Nothing was booked, typed into a form or paid for. Checkout pages were only opened, never filled in.

| # | Journey | Viewport | Result |
|---|---|---|---|
| D1 | JFK search for Nov 20–24, Bolt Parking (minimumBookingDays=6), times 10:00 AM / 2:00 PM | 375×812 mobile | The card shows $152.28 with no min-stay flag. In the slider, Reserve Now is `disabled=true` and no reason is visible; the reason sits only in the `title` attribute. Tapping does nothing. CONFIRMED. |
| D2 | ATL Routes (shuttle 6:00 AM–11:30 PM), check-in 4:00 AM and return 1:00 AM | 375×812 | Reserve Now is enabled, with no warning anywhere above the shuttle text. CONFIRMED. |
| D3 | EWR search for Nov 7–9 (next day), on the search card | 375×812 | Red Carpet Inn ("No Shuttle. Uber and Lyft…") gets the "LIMITED" and "Lowest total" badges and is #1. The card has no shuttle warning. CONFIRMED. |
| D4 | Same lot, opened in the slider | 375×812 | The header says "Free Cancellation" for a check-in tomorrow. CONFIRMED. |
| D5 | Same lot, opened at checkout (9:00 AM Nov 7 → 6:00 PM Nov 9) | 375×812 | The "Free cancellation up to 24 hours" block present on the 2-week-out checkout is gone, with no replacement notice. The phone helper still says "For booking updates and shuttle coordination" on a no-shuttle lot. The service fee of $5.95 is 27% of the $22.37 total. On mobile, the price summary renders below the form. CONFIRMED. |
| D6 | EWR hub page, served HTML | n/a | Red Carpet Inn shows a "Shuttle" tag and "Best Price", and the rates table says Shuttle "Yes". The hub reads "from $5.20/day", while the search card says $7.46/day. CONFIRMED. |
| D7 | JFK search, cards | 375×812 | 6 of 10 cards show a "Pay at Location" chip with no amount. The PARK AC slider shows "Payment will be collected on-site at check-in" and "Due at location $61.23" against a total of $84.12; the amount charged now is never stated. The overview says "0.5 miles" while the card says "2.5 mi". CONFIRMED. |
| D8 | SLC search and SLC hub | 375×812 plus HTML | Search shows "0 Results / No parking lots found for your search criteria." with no alternative. The hub says "No Online Availability for the Next Week… booked or unavailable… Use the search above to check your dates" and lists ABQ, GEG and IDA, which are also empty. CONFIRMED. |
| D9 | Slider accessibility | desktop | 0 elements with role=dialog, aria-modal or dialog. Focus stays on BODY after opening. Both time selects have no id, no aria-label and 0 labels, and are 26px tall. 4 visible buttons have no name. Reserve Now is rgb(255,255,255) on rgb(248,115,86), a ratio of 2.77:1. CONFIRMED. |
| D10 | Mobile search with the slider open, then browser Back | 375×812 | Back leaves /search entirely, because the slider adds no history entry. CONFIRMED by observation. |
| D11 | Mobile tap targets on /search | 375×812 | View Details 117×36, sort select 125×34, "Got it" 60×32, one icon button 28×28. No horizontal overflow. CONFIRMED. |
| D12 | Cookie banner | both | "By continuing to browse, you consent" with a single "Got it" button and no decline. CONFIRMED. |
| D13 | ATL desktop pricing | desktop | UI $63.70 = $11.55 × 5 days + $5.95 service fee + $0 tax, for Fri 10 AM → Tue 2 PM (4 nights billed as 5 days). CONFIRMED. |

Not reproduced, because the pane was hidden and scripts timed out: the lot-page min-stay banner, the reversed-date URL, the date-picker "Invalid Date" path, and the banner overlapping the sticky footer.

# Appendix C — Adversarial review



Reviewer method: every Medium+ claim re-checked against `upstream/main` (e11996bc, 2026-11-06 15:44 ET) with `git show`, and every count re-run on `cov/*.json` (246 lots, 70 airports with inventory) with `python -I`. Depth-repro rows D1–D13 are treated as tested facts. Nothing was fetched live, nothing was submitted.

Ranking basis: severity × how many journeys it touches × evidence strength. How many squads mentioned a finding was NOT used as evidence. The brief asked every squad to include a zero-inventory scenario, so ten mentions of F6 reflect the brief, not ten independent discoveries.

## Reviewer re-counts (snapshot, 246 lots)

| Metric | Count | Note |
|---|---|---|
| `minimumBookingDays` ≥ 2 | **53 lots / 36 airports** (2:23, 3:13, 4:9, 5:6, 6:2) | JFK Bolt and MCI Travelodge (min 6) can't be booked even on the 5-day snapshot trip |
| Shuttle summary = none or suspended | **25** | e.g. EWR Red Carpet, BOS Broadway, ORD Super 8, LAS Fairfield, 4× SFO, MCI Travelodge, ORF Econo Lodge |
| Shuttle summary not 24/7 (none + windows/hourly) | **~123** by my regex (squad 7: 114) | so **46–50%** of lots, depending on parse |
| `lowest_total` badge on a no-shuttle lot | **14 airports** | BNA BOS BUR EWR LAS LAX MSY ORD ORF PHL PHX RIC SAV SFO (BUR and FAT are walkable) |
| `dueAtLocation` true | **21** (all with amount > 0) | matches dossier |
| Amenity names containing "shuttle" | **0** | 10 distinct amenities in the corpus |
| Card chip "24/7 Access" (from ResLab "24/7 Front Desk") | **189 lots; 87 of them lack a 24/7 shuttle** | new finding by the reviewer, see R1 |
| Non-empty `specialConditions` | **70** | never shown in the search slider |
| `source: direct` | **1** (JFK The Parking Point) | the only lot that gets the oversize flow |
| `cancellationPolicies` = [{0 days, 100%}] | 244; 1 missing, 1 empty | |

## Consolidated findings

Severity is after review. Classes: D = Defect, UX = UX gap, CT = Copy/trust, INV = Inventory/pricing limitation.

| ID | Title | Class | Verdict | Evidence (upstream/main; repro; counts) | Raised by | Sev |
|---|---|---|---|---|---|---|
| F1 | Min-stay lots are listed and priced on cards. In the slider, Reserve Now is disabled and the reason sits only in the `title` attribute, which touch users can't see | D | **VERIFIED**. The lot page shows a red banner; the slider and cards show nothing | `product-detail-slider.tsx:158-168,537`; `booking-widget.tsx:354-361` (lot page only); no `minimumBookingDays` in lot-card or search page; **D1 CONFIRMED**; 53 lots / 36 airports | 1.3, 2.4, 5.1, 5.2, 7.7, 10.10 | **High** |
| F2 | Chosen check-in and return times are never checked against shuttle hours or lot closures, and no warning appears | UX (a Defect where the lot says it is "closed outside shuttle hours") | **VERIFIED** | no comparison anywhere in `src/components/{search,lot,checkout}` or `src/app/api/{search,checkout}`; all 48 slots always offered (`product-detail-slider.tsx:38-47,361`); **D2 CONFIRMED**; ~114–123 of 246 lots are not 24/7 | 1.2, 1.6, 2.5, 3.4–3.6, 4.3, 6.3, 7.1–7.8 | **High** |
| F3 | Shuttle status is missing or false. The card's "No Shuttle" chip can never fire; hub cards tag every lot "Shuttle" and the rates table says "Yes"; "Lowest total" lands on no-shuttle lots | D | **VERIFIED** | `lot-card.tsx:49-54` keys on amenities and 0 of 246 amenities contain "shuttle"; `lot-grid.tsx:58-63` and `rates-table.tsx:60` test only that `shuttleInfo` exists; **D3, D6 CONFIRMED**; 25 lots without a shuttle; badge on a no-shuttle lot at 14 airports | 1.2, 1.3, 2.5, 3 (top 1), 4 (top 3), 7 (top 3) | **High** |
| F4 | "Free Cancellation" is shown without conditions before purchase. At checkout the 24h line disappears for check-ins under 2 days away and nothing replaces it | CT | **PARTLY**. The core claim holds, but the step-3 terms checkbox does state the 24h rule accurately, so "silent" overstates it | slider `:310-312`; hub hero `hero-section.tsx:34`; lot widget `booking-widget.tsx:165` "Full refund if cancelled"; `checkout-form.tsx:101` (`leadDays >= 2`); mitigation `terms-acceptance.ts:13-16`; email `booking-confirmation.tsx:537` "Late cancellations may incur fees"; **D4, D5 CONFIRMED** | 1.8, 6.6 (top 2), 8.1, 8 (top 1) | **High** |
| F5 | Pay at Location: the card chip shows no amount, and the slider and lot page show "Due at location" but never the amount charged now. Checkout does state Due Now and Due at Location, but on mobile that summary sits below the form | CT | **PARTLY**. Squad 6's "only on step 3" is wrong, because the order summary shows the split on every step | `lot-card.tsx:177-182`; `order-summary.tsx:250-265`; `stripe-payment-form.tsx:449-460`; **D7, D5 CONFIRMED**; 21 lots, 63–89% due at the lot | 2.3, 6.1, 6.4, 9.6, 10.6 | **Medium** |
| F6 | Zero-inventory airports are dead ends: a bare empty state; "Other Airport Parking" links to other empty airports; /airport-parking lists all 85; the blog widget preselects empty airports | UX + INV | **VERIFIED** | `search-results-list.tsx:106-109`; `other-airports.tsx:32-47` (no inventory filter); `ArticleBookingPrompt.tsx:19` → `config/airports.ts:1076-1079` gates on `enabled`, and all 85 are enabled; **D8 CONFIRMED**; 15 of 85 airports; ~136 YYZ/YYC/YUL/YOW posts (squad 10 CMS count, not re-run) | every squad (the brief required it) | **High** for blog and SEO entry; the inventory itself is not a UI issue |
| F7 | Slider accessibility: no dialog role, no focus move or trap, no Escape, unlabeled time selects, unnamed buttons, CTA contrast 2.77:1; browser Back leaves /search | D (WCAG) | **VERIFIED** | `product-detail-slider.tsx:219-235` (plain `div`, unnamed close button), `:329,348` (label without `htmlFor`); no `pushState` in search; **D9, D10 CONFIRMED** | 9.1–9.4 (top 1, top 3), 1.1 | **High** for AT users; Medium overall |
| F8 | Checkout fields: labels not associated with inputs, no `autoComplete` or `inputMode`, no `aria-invalid` | D (a11y) + UX | **VERIFIED** | `customer-details-step.tsx:51,78,106,133` (no `htmlFor`); 0 `autoComplete` in `src/components/checkout` | 1.5, 9.2 | **Medium** |
| F9 | Small controls: 12px time and sort selects (iOS zooms on focus), tap targets 26–36px | UX | **VERIFIED** (zoom on iOS INFERRED) | slider `:354` `py-1 text-xs`; **D11 CONFIRMED** | 1.1, 1.7, 9.6 | **Medium-Low** |
| F10 | Mobile checkout shows the price summary below the form, so the total isn't visible until scrolling | UX | **VERIFIED** | `checkout-form.tsx` `grid-cols-1 lg:grid-cols-3`; **D5 CONFIRMED** | 1.5 | **Medium** |
| F11 | Hidden default pricing times (10 AM → 2 PM): search has no time fields, so card prices assume default times; ResLab bills 24h blocks, so a Fri→Tue trip is "5 days"; the price shifts once real times are picked | UX | **VERIFIED** | `utils/time.ts:120-121`; **D13 CONFIRMED**; squad 2 live A/B (EWR $33.33 vs $27.85) not re-run | 2.1 (top 1), 7.9 (top 5), 1.6 | **Medium** |
| F12 | Hub "from $X/day" uses pre-tax, pre-fee `minPrice`, while the card shows the all-in price per day. The JFK/LGA calculator claims are also optimistic | CT | **VERIFIED** | `rates-table.tsx:64` (`minPrice`); **D6 CONFIRMED** ($5.20 vs $7.46 EWR); calculator `comparison.tsx:20-23` not re-read | 2.7, 2.8 (top 5), 10.4 (top 3) | **Medium** |
| F13 | Return date capped at today+100, although the ResLab wall applies to check-in only | D (self-imposed) | **PARTLY**. The cap is verified; whether ResLab accepts a return past day 100 is asserted, not proven. Squad 7's line refs were wrong | `booking-window.ts:87-91` (not 94-97) vs the comment at `:4-7` | 7.3, 7.4 (top 2) | **Medium** (long stays only) |
| F14 | Oversize vehicles: ResLab checkout always books one spot of the single parking type built from min-price `rates[0]`; lot rules (`specialConditions`) never appear in the slider; the oversize flow exists only for direct lots | INV + UX | **PARTLY**. The code claim is verified; the impact depends on whether ResLab exposes "Large Vehicle" types for those lots, and the snapshot carries no `parkingTypes` | `checkout/lot/route.ts:113-123,140`; `reslab/get-lot.ts:80-95`; `specialConditions` rendered only in `lot-overview.tsx:55` and `whats-next.tsx:98`; 70 lots have it; 1 direct lot | 3.1, 3.5–3.7 (top 3, top 4) | **Medium** |
| F15 | Confirmation page and email hard-code "Scan your QR code at the entrance gate" and "Follow signs for check-in parking", while most lots need a front-desk check-in. The email QR is rendered by a third party | CT | **VERIFIED** | `whats-next.tsx:29-46`; `booking-confirmation.tsx:281,529`; QR from `api.qrserver.com` with the confirmation number (`:219`); 134 of 246 front-desk lots (squad 4 count, not re-run) | 4.2, 4.3, 4.6 (top 2) | **Medium** |
| F16 | Guest cancel or manage: /reservations sends guests straight to login; no guest lookup; no manage or cancel link in the email | UX | **VERIFIED** (squad 8: a guest can still open a booking from the emailed link, so this is a detour, not a block) | `reservations/page.tsx:55-56,69,97`; `booking-confirmation.tsx:535-541` | 1.10, 6.10, 8.2 (top 2) | **Medium** |
| F17 | Inside 24h: no online cancel, no edit at all, support by email only with 24–48h replies | UX / policy | **VERIFIED** | `help/page.tsx:49-61,103,216`; /contact (squads 6, 8 live) | 5.10, 8.3–8.8 (top 3, top 4), 1.10 | **Medium** (High for same-day bookers) |
| F18 | Lot data defects pass straight through: TPA "241 Car Services" is a cruise-port valet lot in airport results; Grand Hyatt TPA's return number is a 502 (Louisville) area code; BWI Clarion appears twice; POE hotels run airport shuttles only; a distance mismatch | INV | **VERIFIED** (TPA phone: PARTLY, the `phone` field 1-877-886-1583 is complete and only the details text is truncated to "…886-158") | `cov/TPA.json` reslab-230 (1236 Channelside Dr, "shuttle is only to the port"), reslab-455 "502-579-0053"; `cov/BWI.json` reslab-370 and 371 share a slug and the $41.74 price, with different shuttle windows; POE: 3 of 10 lots mention port or cruise, Fairfield "no cruise" carries `lowest_total`; **D7** 0.5 vs 2.5 mi | 4.9 (top 1), 10.7 (top 6), 3.2 (top 2) | **Medium** (needs a data-quality filter or ops fix) |
| F19 | Templated hub copy says "shuttles every 5–15 minutes" on every hub, cruise port included; Help says 10–15 | CT | **VERIFIED** (squad 4 misquoted Help as 5–15) | `airport-page/content.ts:68,119`; `help/page.tsx:125` | 3.2, 4.1 (top 5) | **Low-Medium** |
| F20 | Date picker: the first click clears the return date in parent state; the collapsed mobile bar then formats "" as "Invalid Date"; Update then prices a defaulted range | D | **PARTLY**. The code path is verified; the render was NOT reproduced (D-stage pane timed out) | `components/ui/date-picker.tsx:99-105`; `search-header.tsx:37-40,81`; `search/page.tsx:93-105` | 1.4 | **Medium** (pending repro) |
| F21 | Trust copy: "4.9 Rating", "5,000+" and "100+ partners" are hard-coded; the footer says "Triply Inc." while the Terms name "IE Holdings, L.L.C." (in the Park Guard clause); no reviews data | CT | **PARTLY**. The strings are verified; IE Holdings is likely the legitimate Park Guard contracting party | `hero.tsx:237`; `newsletter.tsx:159`; `footer.tsx:67,145`; `terms/page.tsx:178` | 6.2, 6.7 (top 3, top 4) | **Low-Medium** |
| F22 | Park Guard card omits refundability and the claim window; Plan A is a large share of a small booking | CT | **PARTLY** (not re-read in full); not pre-selected (confirmed non-issue) | `protection-plan.tsx`; `order-summary.tsx:273` | 2.9, 8.9 (top 5) | **Low-Medium** |
| F23 | Sort change re-runs the live search with a full spinner, although sorting is also done client-side | UX | **VERIFIED** | `search/page.tsx:165-170` and `:173-197` | 1.7 | **Low-Medium** |
| F24 | Mobile map card omits the pay-at-lot, limited and min-days signals | UX | **VERIFIED** (by squad 1's read; consistent with the lot-card grep) | `mobile-map-card.tsx:24,40-125` | 1.7 | **Low** |
| F25 | Blog CTAs link to `/search?airport=X` with no dates, so search silently runs today → +7, and "today" is computed in UTC | UX | **VERIFIED** (the UTC part is a reviewer addition) | `ArticleCta.tsx` `ctaHref`; `search/page.tsx:43-51` (`toISOString`) | 10.x (top 5) | **Low-Medium** |
| F26 | No receipt or invoice for expense claims | UX | **VERIFIED** | `confirmation/[id]/page.tsx:604-609` (only "save or print") | 5.3 (top 2) | **Low-Medium** |
| F27 | Google and Outlook calendar links are all-day events, and Google drops the return day (exclusive end); times sit only in the description | D | **VERIFIED** | `add-to-calendar.tsx:59-88` (`.ics` path is correct, `:42-51`) | 5.6 | **Low** |
| F28 | Reservations: an in-progress trip appears under "Past" | D | **VERIFIED** | `reservations/page.tsx:144-152` (`isPast(check_in)`) | 5.5 | **Low** |
| F29 | Cookie banner: "by continuing to browse you consent", one "Got it" button, no decline | CT / compliance | **VERIFIED** | `cookie-banner.tsx:29-35`; **D12 CONFIRMED** | 9.4, 9.6 | **Low-Medium** (a legal call, not UX) |
| F30 | Phone helper says "For booking updates and shuttle coordination" on no-shuttle lots; confirmation's fallback reads "Board the complimentary shuttle…" | CT | **VERIFIED** | **D5**; `whats-next.tsx:50-53` | 6.8, D5 | **Low** (fold into F3) |
| F31 | Late-night returns: the time list ends at 11:30 PM; 24h-block day rounding is never explained | UX | **VERIFIED** | slider `:38-47`; `utils/time.ts:118` | 1.6, 7.2, 7.9 | **Low-Medium** |
| F32 | Long unbroken shuttle and arrival text blobs (111 lots over 600 chars) | UX | VERIFIED (squad 4 count, not re-run) | slider `:468-471` renders summary plus details in one `<p>` | 3, 4 | **Low** |
| F33 | No accessibility filter; ADA and lift info exists only as free text | UX + INV | VERIFIED | 85 lots carry `wheelchair_access`; the chip falls to the generic default (`lot-card.tsx` has no match for "wheelchair") | 9.5 | **Low** |
| F34 | "Valet" chip on lots that read as self-park | INV | VERIFIED (44 lots carry the ResLab `valet` amenity) | `lot-card.tsx:69-70` | 4.1 (top 4) | **Low** |
| R1 | **Reviewer-found:** the card chip "24/7 Access" comes from ResLab's "24/7 Front Desk" amenity, because the keyword match on "24" fires. Shown on 189 lots, 87 of which have no 24/7 shuttle. It worsens F3 | D | **VERIFIED** | `lot-card.tsx:87-88` matches on `displayName` (`:190`) "24/7 Front Desk" → key contains "24" | none | **Medium** |

## Refuted or downgraded

- **Squad 9 "90 lots say no shuttle"** is refuted. The 90 counts every mention of a no-shuttle *window* ("11 PM–4 AM: No shuttle"). Lots with no shuttle at all, or a suspended one, number **25**.
- **Squad 7 "114 of 246 not 24/7"** stands roughly; my regex gives ~123. Cite as "46–50%".
- **Squad 2 "Lowest total on no-shuttle lots at 13 airports"** is corrected to **14**. BUR and FAT are walkable, so ~12 are materially misleading.
- **Squad 4 "Help says every 5–15 minutes"** is corrected. Help says 10–15 (`help:125`); the 5–15 figure is the hub template (`content.ts:68,119`).
- **Squad 4 "truncated phone"**: the lot's `phone` field is complete; only the ResLab details text is cut ("1-877-886-158"). Still a customer-visible error in the slider and confirmation text.
- **Squad 7 booking-window line refs**: the actual lines are 87-91. "ResLab accepts a return past day 100" is unproven, so F13 is downgraded to PARTLY.
- **Squad 8 "terms checkbox still says free up to 24h" (framed as a conflict)**: the checkbox wording is accurate and is the one place a same-day buyer *is* told the rule. F4 stays, but the problem is "no explicit non-cancellable warning", not "silent".
- **Squad 6 "checkout explicit only on step 3" (pay-at-lot)**: the order summary shows Due Now and Due at Location on every step (`order-summary.tsx:250-265`). The real gap is the pre-checkout surfaces plus the mobile layout.
- **Squad 6 entity mismatch**: "IE Holdings" sits in the Park Guard protection clause (`terms:178`), which is plausibly correct, so it drops to Low. The footer versus Terms "Triply, Inc." difference is cosmetic.
- **Squad 1 "Invalid Date"**: code-verified but not reproduced, so it stays Medium only until repro.
- **Squad 3 "parkingTypes[0] means oversize rates can't be chosen"**: the code is true. Customer impact is unquantified, because search JSON has no `parkingTypes` and nobody showed that ResLab offers a Large Vehicle type for those lots. Downgraded to PARTLY / Medium.
- **Squad 1.1 "check-out before check-in on a same-day stay"**: the price and Reserve gate catches it, so Low and dropped as a separate finding.

## Contradictions resolved

1. **Does the lot page show the min-stay reason?** Yes, as a red banner (`booking-widget.tsx:354-361`). The search slider doesn't (D1). Most mobile traffic goes through the slider, so F1 stands.
2. **Is checkout explicit about pay-now versus pay-at-lot?** Yes. The order summary shows "Due Now" and "Due at Location", and step 3 adds an amber notice. Card, slider and lot page never state the pay-now amount (D7), and on mobile the summary sits below the form (D5).
3. **Do search cards show shuttle status?** No. The "No Shuttle" chip is dead code (0 amenities contain "shuttle"). Hubs, by contrast, show a *false* "Shuttle"/"Yes" for any lot that has `shuttleInfo`. Squads 1, 3 and 7 agree; this resolves squad 7's "needs browser check": the code makes the result deterministic.
4. **Is free cancellation hidden or stated at checkout?** The 24h trust block is hidden under 2 days (`checkout-form:101`), and the step-3 terms checkbox states the 24h rule. So it is stated, but weakly and late.
5. **Guest cancel: blocked or possible?** Possible: open the booking from the email link, or sign up with the same email, then cancel when more than 24h out. /reservations itself has no guest lookup. It is a detour, not a block.
6. **Shuttle-hours counts (squads 4, 7, 9)** are reconciled in the re-count table above.

## Not UI: inventory, data or commercial decisions

- 15 of 85 marketed airports have zero lots. Showing them is a product choice (see F6); the inventory gap itself is ResLab supply.
- Minimum-stay rules (53 lots) and shuttle hours (~120 lots not 24/7) are lot policy. Only *surfacing* them is UI (F1, F2).
- 21 lots are pay-at-location, with 63–89% due at the lot.
- The $5.95 service-fee floor (`service-fee.ts:28,35-38`) is 27% of a $22.37 stay (D5). It is charged on the full parking base, including the part paid at the lot (`checkout/lot/route.ts:126-129`). This is a commercial decision.
- ResLab's 24h-block billing (a Fri 10 AM → Tue 2 PM trip = 5 days) and the 100-day check-in wall.
- ResLab data errors: TPA 241 cruise lot, the 502 number, the BWI duplicate, POE hotels marketed for cruises, distance mismatches, "Valet" tags, long text blobs, 4-passenger caps and cash-only notes in free text.
- No ratings or reviews data on any of the 246 lots.
- Oversize, Large Vehicle and second-car handling depend on what ResLab exposes (F14).

## Dropped as preference (parked)

- Spanish or other languages (no `lang`/i18n). Park it until there's evidence of demand.
- A saved vehicle and "book again" for repeat business travelers (squad 5): nice to have.
- An express Apple Pay button at the top of checkout. Stripe PaymentElement already offers wallets on step 3, so this is taste.
- Drive time instead of miles on cards (squad 1.4).
- Apple and .ics calendar buttons duplicating each other.
- Live chat or a phone line. This is a policy choice, captured under F17 as "email only, 24–48h", not as a separate UI finding.

## Priority order after review

1. F1 min-stay hidden (D1)
2. F3 + R1 shuttle status missing or false (D3, D6)
3. F2 no shuttle-hours check (D2)
4. F4 cancellation promise (D4, D5)
5. F6 zero-inventory dead ends and blog preselect
6. F7 slider a11y (D9, D10)
7. F5 pay-now amount (D7)
8. F11 hidden default times (D13)
9. F12 hub pre-fee prices
10. F15 hard-coded QR and gate copy
11. F16/F17 cancel and change paths
12. F10 mobile checkout price
13. F8 form semantics
14. F18 data-quality filter
15. F13, F14, F20 (each needs one more proof)

Low items follow.

# Appendix D — Live coverage snapshot (Nov 20–24, fetched 2026-11-06)



### ABE — 0 lots (considered 1, degraded=False)
### ABQ — 0 lots (considered 1, degraded=False)
### ALB — 2 lots (considered 2, degraded=False)
- Baymont Albany Airport | /albany-alb/airport-parking/baymont-albany-airport | 4-night total $39.27 (sub 34.75, fees 1.74, tax 2.78) | 0.8 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'fitness_center', 'free_internet_wifi', 'breakfast_included'] | shuttle: 4:00 AM - 11:00 PM: Shuttle runs on demand.  11:00 PM - 4:00 AM: No shuttle. | photos=3 | reviews=None
- Hampton Inn Albany Wolf Road | /albany-alb/airport-parking/hampton-inn-albany-wolf-road | 4-night total $52.15 (sub 44.75, fees 4.12, tax 3.28) | 1.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'breakfast_included'] | shuttle: 4AM - 10:30PM, every hourPick-ups are on demand | photos=3 | reviews=None
### ATL — 3 lots (considered 11, degraded=False)
- Sky Lot Atlanta Airport Parking | /atlanta-atl/airport-parking/sky-lot-atlanta-airport-parking | 4-night total $57.75 (sub 55, fees 2.75, tax 0) | 3.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['247_front_desk'] | shuttle: 24/7, every 15 minutes | photos=3 | reviews=None
- Four Points by Sheraton Atlanta Airport | /atlanta-atl/airport-parking/four-points-by-sheraton-atlanta-airport | 4-night total $55.48 (sub 34.75, fees 20.73, tax 0) | 2 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['restaurant'] | shuttle: 5:00 AM - 12:00 AM: Shuttle runs every 30 minutes.  12:00 AM - 5:00 AM: No shuttle. | photos=3 | reviews=None
- Routes Atlanta Airport Parking | /atlanta-atl/airport-parking/routes-atlanta-airport-parking | 4-night total $103.45 (sub 99.95, fees 3.5, tax 0) | 2.2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=[] | shuttle: 6:00 AM - 11:30 PM: Shuttle runs on demand.  11:30 PM - 6:00 AM: No shuttle. | photos=3 | reviews=None
### AUS — 1 lots (considered 1, degraded=False)
- Comfort Suites Austin Airport | /austin-aus/airport-parking/comfort-suites-austin-airport | 4-night total $55.68 (sub 44.75, fees 7.24, tax 3.69) | 2.1 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'fitness_center', 'free_internet_wifi', 'breakfast_included'] | shuttle: 24/7 complimentary Lyft | photos=3 | reviews=None
### AZO — 0 lots (considered 1, degraded=False)
### BDL — 3 lots (considered 3, degraded=False)
- Motel 6 Windsor Locks | /hartford-bdl/airport-parking/motel-6-windsor-locks | 4-night total $33.13 (sub 29.75, fees 1.49, tax 1.89) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=[] | shuttle: 24/7 every 30-45 minutes | photos=3 | reviews=None
- Econo Lodge Inn & Suites | /hartford-bdl/airport-parking/econo-lodge-inn-suites | 4-night total $34.55 (sub 27.45, fees 5.36, tax 1.74) | 1.2 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'valet'] | shuttle: 8 AM - 3:45 AM every 30 minutes and on call 3:45 AM - 8 AM on demand | photos=3 | reviews=None
- Days Inn Windsor Locks Bradley | /hartford-bdl/airport-parking/days-inn-windsor-locks-bradley | 4-night total $49.26 (sub 39.75, fees 6.99, tax 2.52) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'breakfast_included'] | shuttle: 3:25 AM - 9:25 AM: Shuttle runs every 30 minutes.  9:25 AM - 3:25 AM: Shuttle runs on dema | photos=3 | reviews=None
### BHM — 2 lots (considered 2, degraded=False)
- Ramada by Wyndham Birmingham Airport | /birmingham-bhm/airport-parking/ramada-by-wyndham-birmingham-airport | 4-night total $34.22 (sub 29.75, fees 1.49, tax 2.98) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['security', '247_front_desk', 'restaurant', 'free_internet_wifi'] | shuttle: 4:30 AM - 11:00 PM: Shuttle runs on demand.  11:00 PM - 4:30 AM: No shuttle. | photos=3 | reviews=None
- National Birmingham Airport Parking | /birmingham-bhm/airport-parking/national-birmingham-airport-parking | 4-night total $44.1 (sub 35, fees 5.25, tax 3.85) | 1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security'] | shuttle: 24/7, on demand | photos=3 | reviews=None
### BNA — 7 lots (considered 11, degraded=False)
- Southwestern Airport Parking | /nashville-bna/airport-parking/southwestern-airport-parking | 4-night total $28.4 (sub 24.75, fees 1.24, tax 2.41) | 2.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate_number', 'vehicle_make'] | badges=['lowest_total'] | amen=[] | shuttle: No Shuttle. Uber and Lyft are a convenient option for affordable transportation to and fro | photos=3 | reviews=None
- Cambria Hotel Nashville Airport | /nashville-bna/airport-parking/cambria-hotel-nashville-airport | 4-night total $53.98 (sub 44.75, fees 5.74, tax 3.49) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate'] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 4 AM - Midnight On Demand | photos=3 | reviews=None
- Best Western Plus Nashville Airport | /nashville-bna/airport-parking/best-western-plus-nashville-airport | 4-night total $56.25 (sub 50, fees 6.25, tax 0) | 1.6 mi | avail=limited | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', 'restaurant', 'wheelchair_access'] | shuttle: 4:00 AM - 11:00 PM: Shuttle runs every 1 hour.  11:00 PM - 4:00 AM: No shuttle. | photos=3 | reviews=None
- Holiday Inn Express Nashville Airport | /nashville-bna/airport-parking/holiday-inn-express-nashville-airport | 4-night total $56.84 (sub 49.75, fees 2.49, tax 4.6) | 1.4 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'wheelchair_access'] | shuttle: 24/7 on Demand | photos=3 | reviews=None
- Comfort Suites Nashville Airport | /nashville-bna/airport-parking/comfort-suites-nashville-airport | 4-night total $57.22 (sub 49.75, fees 7.47, tax 0) | 1.7 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'free_internet_wifi'] | shuttle: 4:20 AM - 12:00 AM: Shuttle runs every 20 minutes.  12:00 AM - 4:20 AM: No shuttle. | photos=3 | reviews=None
- Fly Away Airport Parking Nashville | /nashville-bna/airport-parking/fly-away-airport-parking-nashville | 4-night total $57.24 (sub 49.75, fees 7.49, tax 0) | 1.7 mi | avail=available | dueAtLot=False $0 | minDays=4 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=[] | shuttle: 24/7 Shuttle, every 10 minutes | photos=3 | reviews=None
- Avid Hotel Nashville Airport | /nashville-bna/airport-parking/avid-hotel-nashville-airport | 4-night total $59.72 (sub 49.75, fees 5.99, tax 3.98) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate'] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access', 'fitness_center', 'free_internet_wifi', 'breakfast_included'] | shuttle: 4 AM - Midnight On Demand | photos=3 | reviews=None
### BOS — 4 lots (considered 5, degraded=False)
- Broadway Motor Service | /boston-bos/airport-parking/broadway-motor-service | 4-night total $62.74 (sub 59.75, fees 2.99, tax 0) | 2.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk'] | shuttle: No shuttle, guests must arrange their own airport transportation | photos=3 | reviews=None
- Se-lect Airport Valet Parking - Boston Logan | /boston-bos/airport-parking/se-lect-airport-valet-parking-boston-logan | 4-night total $95.7 (sub 79.75, fees 15.95, tax 0) | 2.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'security', '247_front_desk', 'restaurant'] | shuttle: 24/7, every 20 minutes | photos=3 | reviews=None
- Ramada by Wyndham Boston | /boston-bos/airport-parking/ramada-by-wyndham-boston | 4-night total $104.74 (sub 99.75, fees 4.99, tax 0) | 5.2 mi | avail=available | dueAtLot=False $0 | minDays=5 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 6:00 AM - 10:00 PM: Shuttle runs on demand.  10:00 PM - 6:00 AM: No shuttle. | photos=3 | reviews=None
- Park N Boston Logan Airport Parking | /boston-bos/airport-parking/park-n-boston-logan-airport-parking | 4-night total $110.2 (sub 104.95, fees 5.25, tax 0) | 2.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security'] | shuttle: 24/7, every 30 minutes | photos=3 | reviews=None
### BUF — 6 lots (considered 7, degraded=False)
- Sleep Inn & Suites Buffalo Airport | /buffalo-buf/airport-parking/sleep-inn-suites-buffalo-airport | 4-night total $39.32 (sub 37.45, fees 1.87, tax 0) | 0.8 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['security', '247_front_desk', 'wheelchair_access'] | shuttle: 24/7, on demand | photos=3 | reviews=None
- Salvatores Grand Hotel | /buffalo-buf/airport-parking/salvatores-grand-hotel | 4-night total $38.92 (sub 34.75, fees 1.74, tax 2.43) | 2.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['security', '247_front_desk', 'restaurant'] | shuttle: 7:00 AM - 10:00 PM: Shuttle runs on demand.  10:00 PM - 7:00 AM: No shuttle. | photos=3 | reviews=None
- Buffalo Airport Hotel | /buffalo-buf/airport-parking/buffalo-airport-hotel | 4-night total $41.86 (sub 33.8, fees 5.69, tax 2.37) | 0.9 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'fitness_center'] | shuttle: 24/7, on demand | photos=3 | reviews=None
- Quality Inn Buffalo Airport | /buffalo-buf/airport-parking/quality-inn-buffalo-airport | 4-night total $43.51 (sub 37.5, fees 1.88, tax 4.13) | 0.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate', 'stateprovince', 'number_of_passengers', 'makemodel_of_car'] | badges=None | amen=['247_front_desk', 'restaurant', 'free_internet_wifi'] | shuttle: 4AM - 12PM, every 30 minutes, except at 7AM, 3PM, and 11PM | photos=3 | reviews=None
- M Hotel Buffalo Airport | /buffalo-buf/airport-parking/m-hotel-buffalo-airport | 4-night total $45.45 (sub 39.95, fees 2, tax 3.5) | 2.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7, every 30 minutes | photos=3 | reviews=None
- Hampton Inn & Suites | /buffalo-buf/airport-parking/hampton-inn-suites | 4-night total $47.74 (sub 39.75, fees 7.99, tax 0) | 0.9 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: No shuttle, guests must arrange their own airport transportation | photos=3 | reviews=None
### BUR — 1 lots (considered 1, degraded=False)
- Southwest Parking Burbank | /burbank-bur/airport-parking/southwest-parking-burbank | 4-night total $100 (sub 90, fees 1, tax 9) | 0.4 mi | avail=available | dueAtLot=True $81 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'wheelchair_access', 'security'] | shuttle: NO shuttle, but it's an easy walk to the airport | photos=3 | reviews=None
### BWI — 6 lots (considered 8, degraded=False)
- Doubletree Baltimore | /baltimore-bwi/airport-parking/doubletree-baltimore | 4-night total $30.79 (sub 29.75, fees 1.04, tax 0) | 2.2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked', 'lowest_total'] | amen=['247_front_desk', 'restaurant'] | shuttle: 5:00 AM - 12:00 AM: Shuttle runs every 15 minutes.  12:00 AM - 5:00 AM: Shuttle runs every | photos=3 | reviews=None
- The Westin | /baltimore-bwi/airport-parking/the-westin | 4-night total $36.49 (sub 34.75, fees 1.74, tax 0) | 2.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7, every 30 minutesPick-ups are on demand | photos=3 | reviews=None
- Sheraton Hotel | /baltimore-bwi/airport-parking/sheraton-hotel | 4-night total $37.81 (sub 31.25, fees 6.56, tax 0) | 2.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7, every 30 minutesPick-ups on demand | photos=3 | reviews=None
- Country Inn & Suites | /baltimore-bwi/airport-parking/country-inn-suites | 4-night total $41.7 (sub 34.95, fees 6.75, tax 0) | 1.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 4:30 AM - 12:00 PM: Shuttle runs every 30 minutes.  12:00 PM - 4:00 PM: No shuttle.  4:00  | photos=3 | reviews=None
- Clarion Hotel BWI North | /baltimore-bwi/airport-parking/clarion-hotel-bwi-north | 4-night total $41.74 (sub 39.75, fees 1.99, tax 0) | 3 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'breakfast_included', 'room_service'] | shuttle: 10:00 AM - 2:00 PM: Shuttle runs on demand.  2:00 PM - 10:00 AM: No shuttle. | photos=3 | reviews=None
- Clarion Hotel BWI North | /baltimore-bwi/airport-parking/clarion-hotel-bwi-north | 4-night total $41.74 (sub 39.75, fees 1.99, tax 0) | 3 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'breakfast_included', 'room_service'] | shuttle: 4:00 AM - 10:00 AM: Shuttle runs every 30 minutes.  10:00 AM - 5:00 PM: No shuttle.  5:00  | photos=3 | reviews=None
### CHS — 1 lots (considered 1, degraded=False)
- Embassy Suites Charleston Airport | /charleston-chs/airport-parking/embassy-suites-charleston-airport | 4-night total $31.24 (sub 29.75, fees 1.49, tax 0) | 2.5 mi | avail=available | dueAtLot=False $0 | minDays=4 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 5:30 AM - 10:00 PM: Shuttle runs every 30 minutes.  10:00 PM - 5:30 AM: No shuttle. | photos=3 | reviews=None
### CLE — 4 lots (considered 5, degraded=False)
- 2 Birds Shuttle and Detail | /cleveland-cle/airport-parking/2-birds-shuttle-and-detail | 4-night total $32.03 (sub 28.75, fees 1.44, tax 1.84) | 3 mi | avail=available | dueAtLot=False $0 | minDays=4 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['security'] | shuttle: 4 AM - 1 AM every 30 minutes, airport pickups on demand | photos=3 | reviews=None
- Crowne Plaza Airport Hotel | /cleveland-cle/airport-parking/crowne-plaza-airport-hotel | 4-night total $55.96 (sub 44.75, fees 7.23, tax 3.98) | 3.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 4:00 AM - 12:00 AM: Shuttle runs every 30 minutes.  12:00 AM - 4:00 AM: No shuttle. | photos=3 | reviews=None
- Airport Express Parking | /cleveland-cle/airport-parking/airport-express-parking | 4-night total $72.3 (sub 60, fees 7.5, tax 4.8) | 1.4 mi | avail=available | dueAtLot=False $0 | minDays=5 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['returning_flight', 'returning_flight_arrival_time', 'license_plate', 'car_makemodel'] | badges=None | amen=['security', '247_front_desk', 'wheelchair_access'] | shuttle: Shuttles to Airport start at 4am and no earlier (TSA at the airport opens at 4:15)Shuttles | photos=3 | reviews=None
- CLE Park | /cleveland-cle/airport-parking/cle-park | 4-night total $72.9 (sub 60, fees 8.1, tax 4.8) | 1.6 mi | avail=available | dueAtLot=False $0 | minDays=5 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['returning_flight', 'returning_flight_arrival_time', 'vehicle_makemodel', 'license_plate'] | badges=None | amen=['247_front_desk'] | shuttle: Shuttle for Check-in starts 4 AM. Shuttle for Check-out is 24/7. | photos=3 | reviews=None
### CLT — 2 lots (considered 2, degraded=False)
- Radisson Hotel Charlotte Airport | /charlotte-clt/airport-parking/radisson-hotel-charlotte-airport | 4-night total $40.65 (sub 34.75, fees 3.74, tax 2.16) | 3.9 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked', 'lowest_total'] | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7, every hour; Pick-up on demand | photos=3 | reviews=None
- Sheraton Charlotte Airport Hotel | /charlotte-clt/airport-parking/sheraton-charlotte-airport-hotel | 4-night total $60.81 (sub 49.75, fees 7.24, tax 3.82) | 2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7, every 30 minutes | photos=3 | reviews=None
### CVG — 5 lots (considered 6, degraded=False)
- Holiday Inn Cincinnati Airport | /cincinnati-cvg/airport-parking/holiday-inn-cincinnati-airport | 4-night total $27.48 (sub 24.75, fees 1.24, tax 1.49) | 2.2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7 every 30 minutes | photos=3 | reviews=None
- Quality Inn & Suites | /cincinnati-cvg/airport-parking/quality-inn-suites | 4-night total $27.94 (sub 23.75, fees 4.19, tax 0) | 2.1 mi | avail=available | dueAtLot=False $0 | minDays=4 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'wheelchair_access', 'fitness_center', 'free_internet_wifi', 'breakfast_included'] | shuttle: 5:00 AM - 12:00 AM: Shuttle runs every 30 minutes.  12:00 AM - 5:00 AM: No shuttle. | photos=3 | reviews=None
- Hyatt Place Cincinnati Airport | /cincinnati-cvg/airport-parking/hyatt-place-cincinnati-airport | 4-night total $30.99 (sub 24.75, fees 6.24, tax 0) | 3.1 mi | avail=limited | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['restaurant'] | shuttle: 24/7 every 30 minutes | photos=3 | reviews=None
- Holiday Inn Express & Suites | /cincinnati-cvg/airport-parking/holiday-inn-express-suites | 4-night total $31.97 (sub 24.75, fees 7.22, tax 0) | 2.8 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 6:30 AM - 11:00 PM: Shuttle runs every 30 minutes.  11:00 PM - 6:30 AM: No shuttle. | photos=3 | reviews=None
- Hilton Cincinnati Airport | /cincinnati-cvg/airport-parking/hilton-cincinnati-airport | 4-night total $36.01 (sub 29.75, fees 4.47, tax 1.79) | 3.1 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24 hours every 30 minutes on the hour at top and bottom of hour. Pickups are on demand. | photos=3 | reviews=None
### DAL — 0 lots (considered 0, degraded=False)
### DCA — 2 lots (considered 2, degraded=False)
- Westin Crystal City | /washington-dca/airport-parking/westin-crystal-city | 4-night total $56.23 (sub 53.55, fees 2.68, tax 0) | 0.8 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['covered_garage', 'security', '247_front_desk', 'restaurant'] | shuttle: 4:30 AM - 10:30 PM: Shuttle runs every 30 minutes.  10:30 PM - 4:30 AM: No shuttle. | photos=3 | reviews=None
- Sheraton Suites Old Town Alexandria | /washington-dca/airport-parking/sheraton-suites-old-town-alexandria | 4-night total $44.63 (sub 42.5, fees 2.13, tax 0) | 2.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['security', '247_front_desk', 'restaurant', 'wheelchair_access', 'free_internet_wifi'] | shuttle: 7:00 AM to 10:30 PM (last Shuttle at 10:30) Every Hour on top of the hourPick ups on deman | photos=3 | reviews=None
### DEN — 11 lots (considered 13, degraded=False)
- Park2Jet Denver | /denver-den/airport-parking/park2jet-denver | 4-night total $47.52 (sub 44.95, fees 2.57, tax 0) | 5.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['covered_garage', 'security', '247_front_desk', 'wheelchair_access'] | shuttle: 24/7 From the Parking Lot to the Airport:* Shuttle runs Every 10 - 15 minutes 24/7/365 day | photos=3 | reviews=None
- Embassy Suites Denver Airport | /denver-den/airport-parking/embassy-suites-denver-airport | 4-night total $28.47 (sub 24.75, fees 3.72, tax 0) | 5.8 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7 every 30 mins, call 24hrs ahead to reserve shuttle spot. | photos=3 | reviews=None
- Hyatt Place Denver Airport | /denver-den/airport-parking/hyatt-place-denver-airport | 4-night total $30.99 (sub 24.75, fees 6.24, tax 0) | 8.8 mi | avail=limited | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['restaurant'] | shuttle: 4:00 AM - 12:00 AM: Shuttle runs on demand.  12:00 AM - 4:00 AM: No shuttle. | photos=3 | reviews=None
- Residence Inn Denver Airport at Gateway Park | /denver-den/airport-parking/residence-inn-denver-airport-at-gateway-park | 4-night total $36.8 (sub 35.05, fees 1.75, tax 0) | 8.7 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 4:00 AM - 12:00 AM: Shuttle runs every 30 minutes.  12:00 AM - 4:00 AM: No shuttle. | photos=3 | reviews=None
- Hyatt Place Peña Station - Denver Airport | /denver-den/airport-parking/hyatt-place-pe-a-station-denver-airport | 4-night total $38.82 (sub 36.97, fees 1.85, tax 0) | 6.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 4:00 AM - 12:00 PM: Shuttle runs every 30 minutes.  12:00 PM - 5:00 PM: Shuttle runs every | photos=3 | reviews=None
- Aloft Denver Airport at Gateway Park | /denver-den/airport-parking/aloft-denver-airport-at-gateway-park | 4-night total $39.11 (sub 37.25, fees 1.86, tax 0) | 8.7 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 3:45 AM - 12:00 AM: Shuttle runs every 30 minutes.  12:00 AM - 3:45 AM: No shuttle. | photos=3 | reviews=None
- Spark by Hilton Denver Airport | /denver-den/airport-parking/spark-by-hilton-denver-airport | 4-night total $39.22 (sub 37.35, fees 1.87, tax 0) | 5.6 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['restaurant'] | shuttle: 3:30 AM - 1:30 AM: Shuttle runs every 20 minutes.  1:30 AM - 3:30 AM: No shuttle. | photos=3 | reviews=None
- Holiday Inn Express Denver Airport | /denver-den/airport-parking/holiday-inn-express-denver-airport | 4-night total $41.91 (sub 39.91, fees 2, tax 0) | 5.6 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk'] | shuttle: 3:30 AM - 1:30 AM: Shuttle runs every 30 minutes.  1:30 AM - 3:30 AM: No shuttle. | photos=3 | reviews=None
- DoubleTree Denver Airport | /denver-den/airport-parking/doubletree-denver-airport | 4-night total $41.93 (sub 39.93, fees 2, tax 0) | 5.7 mi | avail=available | dueAtLot=False $0 | minDays=3 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['restaurant'] | shuttle: 3:30 AM - 1:30 AM: Shuttle runs every 30 minutes.  1:30 AM - 3:30 AM: No shuttle. | photos=3 | reviews=None
- Hyatt House Denver Airport | /denver-den/airport-parking/hyatt-house-denver-airport | 4-night total $45.08 (sub 42.93, fees 2.15, tax 0) | 5.5 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['restaurant'] | shuttle: 3:30 AM - 12:00 PM: Shuttle runs every 30 minutes.  12:00 PM - 5:00 PM: Shuttle runs every | photos=3 | reviews=None
- Canopy Denver Airport Parking | /denver-den/airport-parking/canopy-denver-airport-parking | 4-night total $57.58 (sub 44.75, fees 12.83, tax 0) | 5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate', 'plate_state_eg_co'] | badges=None | amen=['247_front_desk', 'covered_garage', 'wheelchair_access', 'security'] | shuttle: 24/7 every 15 minutes | photos=3 | reviews=None
### DFW — 2 lots (considered 9, degraded=False)
- Clarion Inn & Suites North | /dallas-dfw/airport-parking/clarion-inn-suites-north | 4-night total $22.5 (sub 22.5, fees 0, tax 0) | 1.8 mi | avail=limited | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['restaurant'] | shuttle: 24/7 every 40 minutes | photos=3 | reviews=None
- The Westin Dallas-Fort Worth | /dallas-dfw/airport-parking/the-westin-dallas-fort-worth | 4-night total $44.57 (sub 42.45, fees 2.12, tax 0) | 2.2 mi | avail=available | dueAtLot=False $0 | minDays=3 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7 every hour on the hourPick-ups are on demand. | photos=3 | reviews=None
### DSM — 1 lots (considered 2, degraded=False)
- Clarion Inn Des Moines Airport | /des-moines-dsm/airport-parking/clarion-inn-des-moines-airport | 4-night total $44.32 (sub 37.45, fees 6.87, tax 0) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'breakfast_included', 'room_service'] | shuttle: 24/7 on Demand | photos=3 | reviews=None
### DTW — 5 lots (considered 5, degraded=False)
- Valet Connections | /detroit-dtw/airport-parking/valet-connections | 4-night total $61 (sub 55, fees 6, tax 0) | 3 mi | avail=available | dueAtLot=True $49 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['valet', 'security', '247_front_desk'] | shuttle: 24 hours to the airport every 10-15 minutes and pick ups are on demand. | photos=3 | reviews=None
- Detroit Metro Airport Marriott | /detroit-dtw/airport-parking/detroit-metro-airport-marriott | 4-night total $59.4 (sub 45, fees 2.25, tax 12.15) | 2.2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7 on demand, every 30 minutes | photos=3 | reviews=None
- Wyndham Garden Romulus | /detroit-dtw/airport-parking/wyndham-garden-romulus | 4-night total $60.46 (sub 48.75, fees 8.43, tax 3.28) | 1.8 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7, every hour | photos=3 | reviews=None
- Hampton Inn Detroit/Belleville | /detroit-dtw/airport-parking/hampton-inn-detroit-belleville | 4-night total $60.75 (sub 59.75, fees 1, tax 0) | 7.1 mi | avail=available | dueAtLot=True $47.8 | minDays=3 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'wheelchair_access', 'fitness_center', 'free_internet_wifi', 'breakfast_included', 'room_service'] | shuttle: 24 hours on the hour pick ups on call | photos=3 | reviews=None
- Radisson Hotel Detroit Metro Airport | /detroit-dtw/airport-parking/radisson-hotel-detroit-metro-airport | 4-night total $65.16 (sub 54.75, fees 2.74, tax 7.67) | 2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'restaurant', 'free_internet_wifi', 'breakfast_included', 'room_service'] | shuttle: Shuttle runs 24/7, every 30 minutes | photos=3 | reviews=None
### ELP — 1 lots (considered 1, degraded=False)
- Courtyard El Paso Airport | /el-paso-elp/airport-parking/courtyard-el-paso-airport | 4-night total $19.76 (sub 17.45, fees 0.87, tax 1.44) | 2.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'breakfast_included', 'room_service'] | shuttle: Mon-Thu5:30 AM - 11:00 PM: Shuttle runs on demand.  11:00 PM - 5:30 AM: No shuttle.  Fri-S | photos=3 | reviews=None
### EWR — 11 lots (considered 26, degraded=False)
- Red Carpet Inn | /new-york-ewr/airport-parking/red-carpet-inn | 4-night total $27.38 (sub 24.75, fees 1.24, tax 1.39) | 3.8 mi | avail=limited | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['wheelchair_access'] | shuttle: No Shuttle. Uber and Lyft are readily available, affordable, and will bring you directly t | photos=3 | reviews=None
- Apex Airport Parking | /new-york-ewr/airport-parking/apex-airport-parking | 4-night total $53.19 (sub 44.75, fees 1.57, tax 6.87) | 1.3 mi | avail=available | dueAtLot=True $44.01 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'wheelchair_access'] | shuttle: 24/7 every 10 minutes | photos=2 | reviews=None
- Motel 6 Newark Airport | /new-york-ewr/airport-parking/motel-6-newark-airport | 4-night total $56.51 (sub 39.75, fees 11.99, tax 4.77) | 1.3 mi | avail=available | dueAtLot=True $46.57 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 24 hours every 15 minutes. Pick ups are on demand. | photos=3 | reviews=None
- Maas Parking Newark | /new-york-ewr/airport-parking/maas-parking-newark | 4-night total $61.44 (sub 49.75, fees 2.49, tax 9.2) | 1.3 mi | avail=available | dueAtLot=True $49 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk'] | shuttle: 24/7 every 15 minutes | photos=2 | reviews=None
- ARB Parking Newark | /new-york-ewr/airport-parking/arb-parking-newark | 4-night total $66.8 (sub 54.75, fees 1.92, tax 10.13) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'wheelchair_access', 'valet'] | shuttle: 24/7 every 15 minutes | photos=3 | reviews=None
- Courtyard Newark Liberty | /new-york-ewr/airport-parking/courtyard-newark-liberty | 4-night total $76.83 (sub 52.45, fees 16.62, tax 7.76) | 1.4 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: Shuttle runs 24/7 every 30 minutes | photos=3 | reviews=None
- Renaissance Newark Airport Hotel | /new-york-ewr/airport-parking/renaissance-newark-airport-hotel | 4-night total $77.76 (sub 52.45, fees 21.84, tax 3.47) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 4:00 AM - 12:00 AM: Shuttle runs every 15 minutes.  12:00 AM - 4:00 AM: Shuttle runs every | photos=3 | reviews=None
- Embassy Suites Hilton Newark Airport | /new-york-ewr/airport-parking/embassy-suites-hilton-newark-airport | 4-night total $83.99 (sub 52.45, fees 21.84, tax 9.7) | 1.9 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'restaurant'] | shuttle: Every 30 minutes to and from the airport | photos=3 | reviews=None
- Courtyard by Marriott Newark Elizabeth | /new-york-ewr/airport-parking/courtyard-by-marriott-newark-elizabeth | 4-night total $84.77 (sub 52.45, fees 22.62, tax 9.7) | 1.9 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7 every 30 min | photos=3 | reviews=None
- EWR Airport Parking | /new-york-ewr/airport-parking/ewr-airport-parking | 4-night total $99.69 (sub 74.75, fees 13.73, tax 11.21) | 1.3 mi | avail=available | dueAtLot=True $81 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', 'valet'] | shuttle: 24/7 on demand | photos=2 | reviews=None
- Snap Parking | /new-york-ewr/airport-parking/snap-parking | 4-night total $126.19 (sub 89.75, fees 17.44, tax 19) | 2.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'wheelchair_access', 'security', 'valet', 'covered_garage'] | shuttle: Shuttle runs 24 hours on demand to and from the airport | photos=3 | reviews=None
### FAT — 2 lots (considered 2, degraded=False)
- Best Western | /fresno-fat/airport-parking/best-western | 4-night total $68 (sub 60, fees 8, tax 0) | 0.8 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['security', '247_front_desk', 'restaurant'] | shuttle: 24 hours every 30 minutes.pick-ups on demand | photos=3 | reviews=None
- Wyndham Garden | /fresno-fat/airport-parking/wyndham-garden | 4-night total $68.8 (sub 65, fees 0, tax 3.8) | 0.5 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['restaurant'] | shuttle: No shuttle, very easy walk to the airport from the parking area. | photos=3 | reviews=None
### FLL — 10 lots (considered 18, degraded=False)
- Springhill Suites | /fort-lauderdale-fll/airport-parking/springhill-suites | 4-night total $48.87 (sub 44.75, fees 4.12, tax 0) | 1.9 mi | avail=available | dueAtLot=False $0 | minDays=3 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['security', '247_front_desk', 'restaurant', 'wheelchair_access', 'free_internet_wifi'] | shuttle: Sun-Thu4:30 AM - 11:30 PM: Shuttle runs every 1 hour.  11:30 PM - 4:30 AM: No shuttle.  Fr | photos=3 | reviews=None
- Fairfield Inn & Suites | /fort-lauderdale-fll/airport-parking/fairfield-inn-suites | 4-night total $46.99 (sub 44.75, fees 2.24, tax 0) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['restaurant'] | shuttle: 24 hours every hour on the hour; Pickups are on demand. | photos=3 | reviews=None
- Home2 Suites by Hilton Ft. Lauderdale Airport | /fort-lauderdale-fll/airport-parking/home2-suites-by-hilton-ft-lauderdale-airport | 4-night total $50.12 (sub 44.75, fees 2.24, tax 3.13) | 1.9 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 5:00 AM - 10:30 PM: Shuttle runs every 1 hour. Pickups from Airport on demand 10:30 PM - 5 | photos=3 | reviews=None
- The Harrison Hotel Downtown Hollywood | /fort-lauderdale-fll/airport-parking/the-harrison-hotel-downtown-hollywood | 4-night total $56 (sub 50, fees 2.5, tax 3.5) | 4.4 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['covered_garage', '247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'room_service'] | shuttle: 5:30 AM - 9:30 PM: Shuttle runs on demand.  9:30 PM - 5:30 AM: No shuttle. | photos=3 | reviews=None
- Residence Inn Fort Lauderdale Airport | /fort-lauderdale-fll/airport-parking/residence-inn-fort-lauderdale-airport | 4-night total $58.19 (sub 48.39, fees 6.41, tax 3.39) | 1.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['restaurant'] | shuttle: 5:00 AM - 11:00 PM: Shuttle runs every 1 hour. Top of the hour 11:00 PM - 5:00 AM: No shut | photos=3 | reviews=None
- Aloft by Marriott Fort Lauderdale Airport | /fort-lauderdale-fll/airport-parking/aloft-by-marriott-fort-lauderdale-airport | 4-night total $59.82 (sub 48.95, fees 7.44, tax 3.43) | 1.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'covered_garage', '247_front_desk', 'restaurant'] | shuttle: 24/7 every hour on the hour | photos=3 | reviews=None
- Courtyard Fort Lauderdale Airport | /fort-lauderdale-fll/airport-parking/courtyard-fort-lauderdale-airport | 4-night total $61.24 (sub 59.75, fees 1.49, tax 0) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'restaurant', 'wheelchair_access', 'free_internet_wifi'] | shuttle: 5:00 AM - midnight every 30 minutes pick ups are on demand within shuttle hours | photos=3 | reviews=None
- Marriott Fort Lauderdale Airport | /fort-lauderdale-fll/airport-parking/marriott-fort-lauderdale-airport | 4-night total $66.92 (sub 59.75, fees 2.99, tax 4.18) | 1.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'covered_garage', 'security', '247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7 Shuttle every hour - Top of the hourPick-ups from airport On-Demand | photos=3 | reviews=None
- Park By The Ports AIRPORT Parking | /fort-lauderdale-fll/airport-parking/park-by-the-ports-airport-parking | 4-night total $115.9 (sub 99.95, fees 10, tax 5.95) | 1.6 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'wheelchair_access'] | shuttle: 24/7 on Demand | photos=3 | reviews=None
- Park By The Ports Cruise Parking | /fort-lauderdale-fll/airport-parking/park-by-the-ports-cruise-parking | 4-night total $117.3 (sub 99.95, fees 10, tax 7.35) | 1.6 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security'] | shuttle: 7 AM to 2 PM | photos=3 | reviews=None
### GEG — 0 lots (considered 1, degraded=False)
### GSO — 1 lots (considered 1, degraded=False)
- Embassy Suites Greensboro Airport | /greensboro-gso/airport-parking/embassy-suites-greensboro-airport | 4-night total $28.99 (sub 24.75, fees 4.24, tax 0) | 1.8 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['restaurant'] | shuttle: Shuttle runs 24/7 on demand | photos=3 | reviews=None
### HOU — 4 lots (considered 4, degraded=False)
- DoubleTree Houston Hobby Airport | /houston-hou/airport-parking/doubletree-houston-hobby-airport | 4-night total $25.49 (sub 22.5, fees 1.13, tax 1.86) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7 every 15 minutes | photos=3 | reviews=None
- Houston Hobby Marriott South | /houston-hou/airport-parking/houston-hobby-marriott-south | 4-night total $25.99 (sub 24.75, fees 1.24, tax 0) | 1.6 mi | avail=available | dueAtLot=False $0 | minDays=1 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['restaurant'] | shuttle: 24/7 every 30 minutes at the top of the hour | photos=3 | reviews=None
- Hobby Airport Parking | /houston-hou/airport-parking/hobby-airport-parking | 4-night total $29.11 (sub 24.75, fees 2.24, tax 2.12) | 1.4 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'security'] | shuttle: 24/7, every 15 minutes | photos=3 | reviews=None
- Hampton Inn Houston Hobby Airport | /houston-hou/airport-parking/hampton-inn-houston-hobby-airport | 4-night total $39.11 (sub 29.75, fees 6.49, tax 2.87) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'breakfast_included'] | shuttle: 24/7 complimentary Lyft | photos=3 | reviews=None
### HPN — 1 lots (considered 1, degraded=False)
- Purchase Park 2 Fly Westchester | /white-plains-hpn/airport-parking/purchase-park-2-fly-westchester | 4-night total $111.71 (sub 95, fees 8.75, tax 7.96) | 1.2 mi | avail=available | dueAtLot=True $91.71 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['valet', 'security', '247_front_desk', 'wheelchair_access'] | shuttle: 5:00 AM- Midnight on demand to and from the airport | photos=3 | reviews=None
### IAD — 2 lots (considered 2, degraded=False)
- Hyatt Regency Dulles Airport | /washington-iad/airport-parking/hyatt-regency-dulles-airport | 4-night total $47.7 (sub 39.75, fees 7.95, tax 0) | 1.9 mi | avail=available | dueAtLot=False $0 | minDays=4 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate'] | badges=['most_booked', 'lowest_total'] | amen=['security', '247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'room_service'] | shuttle: 6:00 AM - 11:00 PM: Shuttle runs every 30 minutes.  11:00 PM - 6:00 AM: Shuttle runs on de | photos=3 | reviews=None
- DoubleTree Washington Dulles Airport | /washington-iad/airport-parking/doubletree-washington-dulles-airport | 4-night total $72.74 (sub 59.75, fees 12.99, tax 0) | 2.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate', 'car_makemodel'] | badges=None | amen=['security', '247_front_desk', 'restaurant'] | shuttle: 4:00 AM - 12:00 AM: Shuttle runs every 30 minutes. Terminal pick-ups on demand 12:00 AM -  | photos=3 | reviews=None
### IAH — 2 lots (considered 3, degraded=False)
- Hilton Garden Inn Houston/Bush | /houston-iah/airport-parking/hilton-garden-inn-houston-bush | 4-night total $30.11 (sub 27.25, fees 0.68, tax 2.18) | 3.4 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked', 'lowest_total'] | amen=['restaurant'] | shuttle: Shuttle runs from 4:30 AM to 10 PM every 30 minutes within shuttle hours. | photos=3 | reviews=None
- Comfort Suites Houston Bush Airport | /houston-iah/airport-parking/comfort-suites-houston-bush-airport | 4-night total $39.37 (sub 34.75, fees 1.74, tax 2.88) | 3.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'breakfast_included'] | shuttle: 5:00 AM - 11:30 AM: Shuttle runs every 30 minutes.  11:30 AM - 3:00 PM: No shuttle.  3:00  | photos=3 | reviews=None
### IDA — 0 lots (considered 1, degraded=False)
### IND — 1 lots (considered 1, degraded=False)
- Wyndham Indianapolis Airport | /indianapolis-ind/airport-parking/wyndham-indianapolis-airport | 4-night total $33.47 (sub 29.75, fees 1.49, tax 2.23) | 2.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'breakfast_included', 'room_service'] | shuttle: Shuttle runs 24/7 on demand | photos=3 | reviews=None
### JAX — 2 lots (considered 5, degraded=False)
- Airlynk Parking | /jacksonville-jax/airport-parking/airlynk-parking | 4-night total $43.65 (sub 34.75, fees 6.22, tax 2.68) | 1.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk'] | shuttle: 6 AM - 10 PM, On DemandOutside shuttle hours available if notified in advance | photos=3 | reviews=None
- Wyndham Jacksonville Hotel & Conference Center - Formerly Crowne Plaza | /jacksonville-jax/airport-parking/wyndham-jacksonville-hotel-conference-center-formerly-crowne-plaza | 4-night total $51.56 (sub 46.45, fees 2.32, tax 2.79) | 2.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 4:00 AM - 2:00 AM: Shuttle runs every 15 minutes. Pick-ups on demand 2:00 AM - 4:00 AM: No | photos=3 | reviews=None
### JFK — 10 lots (considered 17, degraded=False)
- PARK AC JFK Airport Parking | /new-york-jfk/airport-parking/park-ac-jfk-airport-parking | 4-night total $78.17 (sub 67.75, fees 3.39, tax 7.03) | 2.5 mi | avail=available | dueAtLot=True $61.23 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=[] | shuttle: 24/7 Shuttle every 10 minutes | photos=3 | reviews=None
- The Parking Point JFK | /new-york-jfk/airport-parking/the-parking-point-jfk | 4-night total $57.71 (sub 49.75, fees 0, tax 7.96) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=null | extraFields=[] | badges=['lowest_total'] | amen=[] | shuttle: Shuttle to the terminal (about 10 min) | photos=4 | reviews=None
- ARB Parking | /new-york-jfk/airport-parking/arb-parking | 4-night total $91.21 (sub 79.75, fees 2.79, tax 8.67) | 2.5 mi | avail=available | dueAtLot=True $74.86 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'free_internet_wifi', 'security', 'valet'] | shuttle: 24/7 every 15 minutesPick-ups on demand | photos=3 | reviews=None
- Purchase Park 2 Fly | /new-york-jfk/airport-parking/purchase-park-2-fly | 4-night total $114.48 (sub 84.95, fees 20.36, tax 9.17) | 1.9 mi | avail=available | dueAtLot=True $96.49 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'valet'] | shuttle: 24/7, On Demand | photos=3 | reviews=None
- A1 JFK Park | /new-york-jfk/airport-parking/a1-jfk-park | 4-night total $120.86 (sub 104.75, fees 5.24, tax 10.87) | 1.7 mi | avail=available | dueAtLot=True $94.67 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'covered_garage', '247_front_desk'] | shuttle: 24/7 every 10 minutes | photos=3 | reviews=None
- DoubleTree by Hilton | /new-york-jfk/airport-parking/doubletree-by-hilton | 4-night total $124.11 (sub 109.95, fees 2.75, tax 11.41) | 2.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'security', '247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7 every 30 minutes | photos=3 | reviews=None
- Bolt Parking | /new-york-jfk/airport-parking/bolt-parking | 4-night total $144.28 (sub 113.7, fees 19.69, tax 10.89) | 2.3 mi | avail=available | dueAtLot=True $115.85 | minDays=6 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'valet', 'security'] | shuttle: 24/7 every 30 minutes. | photos=3 | reviews=None
- Hampton Inn John F. Kennedy Airport | /new-york-jfk/airport-parking/hampton-inn-john-f-kennedy-airport | 4-night total $164.22 (sub 125, fees 26.25, tax 12.97) | 2 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'restaurant'] | shuttle: 24/7 every 30 minutes | photos=3 | reviews=None
- Safe Park JFK | /new-york-jfk/airport-parking/safe-park-jfk | 4-night total $176.09 (sub 149.75, fees 10.49, tax 15.85) | 1.8 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk'] | shuttle: 24/7, every 45 minutes | photos=3 | reviews=None
- TWA Hotel | /new-york-jfk/airport-parking/twa-hotel | 4-night total $211.85 (sub 174.95, fees 18.75, tax 18.15) | 0.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'valet', 'restaurant'] | shuttle: Airtrain directly to airport | photos=3 | reviews=None
### LAS — 3 lots (considered 4, degraded=False)
- DoubleTree by Hilton Las Vegas Airport | /las-vegas-las/airport-parking/doubletree-by-hilton-las-vegas-airport | 4-night total $52.45 (sub 49.95, fees 2.5, tax 0) | 1.8 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7 every 30 minutes; Pickups on demand | photos=3 | reviews=None
- Fairfield Inn Las Vegas Convention Center | /las-vegas-las/airport-parking/fairfield-inn-las-vegas-convention-center | 4-night total $39.4 (sub 34.75, fees 1.74, tax 2.91) | 2.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'fitness_center', 'free_internet_wifi', 'breakfast_included'] | shuttle: NO SHUTTLE | photos=3 | reviews=None
- Best Western | /las-vegas-las/airport-parking/best-western | 4-night total $62.74 (sub 59.75, fees 2.99, tax 0) | 1.1 mi | avail=limited | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'free_internet_wifi', 'breakfast_included'] | shuttle: 6:15 AM - 1:00 PM: Shuttle runs every 30 minutes.  1:00 PM - 4:30 PM: No shuttle.  4:30 PM | photos=3 | reviews=None
### LAX — 8 lots (considered 12, degraded=False)
- South Bay Airport Parking - 105 | /los-angeles-lax/airport-parking/south-bay-airport-parking-105 | 4-night total $48.74 (sub 44.75, fees 3.99, tax 0) | 1.2 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['247_front_desk', 'valet', 'covered_garage', 'wheelchair_access'] | shuttle: 24/7, Every 20-30 Minutes | photos=3 | reviews=None
- 9750 AIRPORT BLVD (LAX) Formerly Four Points by Sheraton | /los-angeles-lax/airport-parking/9750-airport-blvd-lax-formerly-four-points-by-sheraton | 4-night total $44.12 (sub 39.75, fees 0.99, tax 3.38) | 1.4 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['valet', '247_front_desk'] | shuttle: No shuttle. Guests will need to arrange their own transportation. | photos=3 | reviews=None
- 405 Airport Parking | /los-angeles-lax/airport-parking/405-airport-parking | 4-night total $56.74 (sub 47, fees 4.92, tax 4.82) | 2.2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'covered_garage'] | shuttle: Shuttle runs, 24/7 on demand | photos=3 | reviews=None
- Simply Park | /los-angeles-lax/airport-parking/simply-park | 4-night total $57.22 (sub 49.75, fees 2.49, tax 4.98) | 2.2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'covered_garage', 'security'] | shuttle: 24/7, Every 30 minutes | photos=3 | reviews=None
- Travelodge by Wyndham LAX South | /los-angeles-lax/airport-parking/travelodge-by-wyndham-lax-south | 4-night total $64.27 (sub 34.75, fees 26.74, tax 2.78) | 1.2 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate'] | badges=None | amen=['247_front_desk', 'restaurant', 'free_internet_wifi'] | shuttle: 5:00 AM - 12:30 AM: Shuttle runs every 30 minutes.  12:30 AM - 5:00 AM: No shuttle. | photos=3 | reviews=None
- Fox Parking | /los-angeles-lax/airport-parking/fox-parking | 4-night total $73.12 (sub 60, fees 7.12, tax 6) | 2.1 mi | avail=available | dueAtLot=False $0 | minDays=3 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['wheelchair_access', 'security', 'valet', 'covered_garage'] | shuttle: 12:00 AM - 12:00 AM: Shuttle runs every 20 minutes. | photos=3 | reviews=None
- Sonesta Los Angeles Airport | /los-angeles-lax/airport-parking/sonesta-los-angeles-airport | 4-night total $123.44 (sub 87.5, fees 27.19, tax 8.75) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'security', '247_front_desk', 'restaurant', 'wheelchair_access', 'fitness_center'] | shuttle: 24/7 every 25-30 minutes to and from the airport | photos=3 | reviews=None
- Sheraton Gateway Los Angeles Hotel | /los-angeles-lax/airport-parking/sheraton-gateway-los-angeles-hotel | 4-night total $161.71 (sub 116.7, fees 30.84, tax 14.17) | 1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'room_service'] | shuttle: 24/7 every 25 minutes | photos=3 | reviews=None
### LGA — 8 lots (considered 19, degraded=False)
- Carvia Parking | /new-york-lga/airport-parking/carvia-parking | 4-night total $109.32 (sub 94.75, fees 4.74, tax 9.83) | 0.6 mi | avail=available | dueAtLot=True $85.63 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['247_front_desk', 'valet', 'security'] | shuttle: 24/7 every 15min | photos=3 | reviews=None
- Queens Crossing - LAZ Parking | /new-york-lga/airport-parking/queens-crossing-laz-parking | 4-night total $65.38 (sub 49.75, fees 11.24, tax 4.39) | 2.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['valet', 'security', 'covered_garage'] | shuttle: 6:30 AM - 10:30 PM: Shuttle runs every 1 hour.  10:30 PM - 6:30 AM: No shuttle. | photos=3 | reviews=None
- Hyatt Place Flushing - LAZ Parking | /new-york-lga/airport-parking/hyatt-place-flushing-laz-parking | 4-night total $65.8 (sub 54.75, fees 5.37, tax 5.68) | 2.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'covered_garage', 'security', 'restaurant'] | shuttle: 7 AM - 10 PM on top of hour to and from the airport | photos=3 | reviews=None
- Hearthstone Garage | /new-york-lga/airport-parking/hearthstone-garage | 4-night total $86.25 (sub 74.75, fees 3.74, tax 7.76) | 2.8 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'valet', 'covered_garage'] | shuttle: No Shuttle. Please arrange alternative transportation (Uber/Lyft) | photos=3 | reviews=None
- Park For U LaGuardia | /new-york-lga/airport-parking/park-for-u-laguardia | 4-night total $91.98 (sub 74.95, fees 8.74, tax 8.29) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['car_makemodel', 'license_plate', 'return_flight_number'] | badges=None | amen=['247_front_desk', 'valet'] | shuttle: 24/7 Valet Service - Will drop you off at your Terminal in your own vehicle | photos=3 | reviews=None
- Parking Place | /new-york-lga/airport-parking/parking-place | 4-night total $101.24 (sub 87.75, fees 4.39, tax 9.1) | 0.7 mi | avail=available | dueAtLot=True $79.3 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'valet'] | shuttle: 24/7 every 15 min | photos=3 | reviews=None
- Purchase Park 2 Fly LaGuardia Airport | /new-york-lga/airport-parking/purchase-park-2-fly-laguardia-airport | 4-night total $108.4 (sub 79.95, fees 20.16, tax 8.29) | 0.6 mi | avail=available | dueAtLot=True $91.41 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=[] | shuttle: 24/7 On Demand | photos=2 | reviews=None
- New York LaGuardia Marriott Airport Hotel | /new-york-lga/airport-parking/new-york-laguardia-marriott-airport-hotel | 4-night total $121.27 (sub 102.25, fees 8.1, tax 10.92) | 0.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7 every 15 minutes | photos=3 | reviews=None
### LIT — 1 lots (considered 1, degraded=False)
- Wyndham Grand Executive Center | /little-rock-lit/airport-parking/wyndham-grand-executive-center | 4-night total $55.67 (sub 49.75, fees 2.49, tax 3.43) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant'] | shuttle: 4:30 AM - 12:00 AM: Shuttle runs every 1 hour. Pick-ups on demand 12:00 AM - 4:30 AM: No s | photos=3 | reviews=None
### MCI — 6 lots (considered 8, degraded=False)
- Quality Inn Kansas City Airport | /kansas-city-mci/airport-parking/quality-inn-kansas-city-airport | 4-night total $20.74 (sub 19.75, fees 0.99, tax 0) | 3.1 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['security', '247_front_desk', 'wheelchair_access'] | shuttle: 24/7 every 30 minutes | photos=3 | reviews=None
- Travelodge | /kansas-city-mci/airport-parking/travelodge | 4-night total $25.21 (sub 20.94, fees 3.05, tax 1.22) | 5 mi | avail=available | dueAtLot=False $0 | minDays=6 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['wheelchair_access'] | shuttle: Shuttle suspended | photos=3 | reviews=None
- Hilton Kansas City Airport | /kansas-city-mci/airport-parking/hilton-kansas-city-airport | 4-night total $36.75 (sub 35, fees 1.75, tax 0) | 1.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7 every hour, On the hour | photos=3 | reviews=None
- Super 8 Kansas City Airport | /kansas-city-mci/airport-parking/super-8-kansas-city-airport | 4-night total $37.6 (sub 29.75, fees 3.24, tax 4.61) | 1.9 mi | avail=limited | dueAtLot=True $32.4 | minDays=4 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'wheelchair_access'] | shuttle: 24/7 on demand | photos=3 | reviews=None
- Kansas City Airport Marriott | /kansas-city-mci/airport-parking/kansas-city-airport-marriott | 4-night total $41.74 (sub 39.75, fees 1.99, tax 0) | 0.9 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7 every 15 minutes | photos=3 | reviews=None
- Days Inn Kansas City Airport | /kansas-city-mci/airport-parking/days-inn-kansas-city-airport | 4-night total $55.72 (sub 39.75, fees 15.97, tax 0) | 1.7 mi | avail=available | dueAtLot=False $0 | minDays=5 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 4:00 AM - 7:30 AM: Shuttle runs every 30 minutes.  7:30 AM - 11:00 PM: Shuttle runs on dem | photos=3 | reviews=None
### MCO — 4 lots (considered 8, degraded=False)
- Gold Park Orlando Airport | /orlando-mco/airport-parking/gold-park-orlando-airport | 4-night total $35.63 (sub 24.75, fees 8.71, tax 2.17) | 2.9 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'valet'] | shuttle: 24/7 Shuttle, every 15 minutes | photos=3 | reviews=None
- Omni Airport Parking | /orlando-mco/airport-parking/omni-airport-parking | 4-night total $36.4 (sub 29.95, fees 4.5, tax 1.95) | 2.9 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=[] | shuttle: 24/7 every 20 minutes | photos=3 | reviews=None
- Holiday Inn Orlando Airport | /orlando-mco/airport-parking/holiday-inn-orlando-airport | 4-night total $58.69 (sub 48.15, fees 7.41, tax 3.13) | 2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['restaurant'] | shuttle: 24/7 every 30 minutes | photos=3 | reviews=None
- Best Rate Airport Parking | /orlando-mco/airport-parking/best-rate-airport-parking | 4-night total $187.38 (sub 175, fees 1, tax 11.38) | 2.9 mi | avail=available | dueAtLot=True $151.38 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'security', 'wheelchair_access'] | shuttle: 4:00 AM - 10:00 PM: Shuttle runs every 30 minutes.  10:00 PM - 4:00 AM: No shuttle. | photos=3 | reviews=None
### MDW — 2 lots (considered 2, degraded=False)
- Midway HotSpot Airport Parking | /chicago-mdw/airport-parking/midway-hotspot-airport-parking | 4-night total $81.99 (sub 59.85, fees 2.99, tax 19.15) | 1.5 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'security'] | shuttle: 24/7, on demand | photos=3 | reviews=None
- Hampton Inn Chicago Midway Airport | /chicago-mdw/airport-parking/hampton-inn-chicago-midway-airport | 4-night total $89.11 (sub 69.75, fees 10.99, tax 8.37) | 1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7, every 30 minutes | photos=3 | reviews=None
### MEM — 0 lots (considered 1, degraded=False)
### MIA — 8 lots (considered 14, degraded=False)
- Holiday Inn Miami Airport | /miami-mia/airport-parking/holiday-inn-miami-airport | 4-night total $55.23 (sub 45.75, fees 6.28, tax 3.2) | 1.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['security', '247_front_desk', 'restaurant'] | shuttle: 24/7 On demand | photos=3 | reviews=None
- Courtyard by Marriott Miami Airport West/Doral | /miami-mia/airport-parking/courtyard-by-marriott-miami-airport-west-doral | 4-night total $43.91 (sub 34.75, fees 6.73, tax 2.43) | 2.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant'] | shuttle: 5:00 AM - 11:00 PM: Shuttle runs every 1 hour.  11:00 PM - 5:00 AM: No shuttle. | photos=3 | reviews=None
- Bayfront Garage Miami | /miami-mia/airport-parking/bayfront-garage-miami | 4-night total $44.8 (sub 40, fees 2, tax 2.8) | 6.2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'covered_garage', 'wheelchair_access'] | shuttle: No shuttle | photos=3 | reviews=None
- La Quinta Inn & Suites Miami Airport East | /miami-mia/airport-parking/la-quinta-inn-suites-miami-airport-east | 4-night total $49.89 (sub 41.25, fees 6.05, tax 2.59) | 1.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 5:00 AM - 10:00 PM: Shuttle runs every 1 hour.  10:00 PM - 5:00 AM: No shuttle. | photos=3 | reviews=None
- EVEN Hotel Miami | /miami-mia/airport-parking/even-hotel-miami | 4-night total $58.66 (sub 39.95, fees 15, tax 3.71) | 2.2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7, On Demand | photos=3 | reviews=None
- Hilton Miami Airport Blue Lagoon | /miami-mia/airport-parking/hilton-miami-airport-blue-lagoon | 4-night total $69.12 (sub 44.75, fees 21.24, tax 3.13) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 4:00 AM - 1:00 AM: Shuttle runs every 30 minutes.  1:00 AM - 4:00 AM: No shuttle. | photos=3 | reviews=None
- WePark in Miami Cruise Parking | /miami-mia/airport-parking/wepark-in-miami-cruise-parking | 4-night total $86.9 (sub 59.95, fees 22.75, tax 4.2) | 6.2 mi | avail=available | dueAtLot=False $0 | minDays=3 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['number_of_guests_traveling', 'name_of_ship', 'license_plate'] | badges=None | amen=['security'] | shuttle: To Cruise Terminal: 11 AM - 2:30 PM, every 30 minutesFrom Cruise Terminal: 7 AM - 2:30 PM, | photos=1 | reviews=None
- Premier Cruise Parking | /miami-mia/airport-parking/premier-cruise-parking | 4-night total $92.64 (sub 74.95, fees 13.49, tax 4.2) | 6.3 mi | avail=available | dueAtLot=True $76.65 | minDays=3 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['number_of_passengers'] | badges=None | amen=['wheelchair_access', 'security', 'covered_garage'] | shuttle: Disembarkation: 7:30 AM to 10:45 AM, every 30 minutesEmbarkation: 11 AM to 3:15 PM, every  | photos=2 | reviews=None
### MKE — 4 lots (considered 4, degraded=False)
- Royle Hotel | /milwaukee-mke/airport-parking/royle-hotel | 4-night total $35.52 (sub 29.75, fees 3.28, tax 2.49) | 0.8 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant', 'wheelchair_access', 'free_internet_wifi'] | shuttle: 4:00 AM - 8:00 AM: Shuttle runs every 30 minutes.  8:00 AM - 1:00 AM: Shuttle runs on dema | photos=3 | reviews=None
- Best Western Plus | /milwaukee-mke/airport-parking/best-western-plus | 4-night total $38.4 (sub 34.75, fees 1.74, tax 1.91) | 0.8 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access', 'fitness_center', 'free_internet_wifi', 'breakfast_included'] | shuttle: 4 AM till 12 AM, on demand | photos=3 | reviews=None
- Crowne Plaza Milwaukee Airport | /milwaukee-mke/airport-parking/crowne-plaza-milwaukee-airport | 4-night total $43.49 (sub 34.75, fees 8.74, tax 0) | 2.2 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 4:00 AM - 11:00 PM: Shuttle runs on demand.  11:00 PM - 4:00 AM: No shuttle. | photos=3 | reviews=None
- ExecPark Valet Parking & Shuttle | /milwaukee-mke/airport-parking/execpark-valet-parking-shuttle | 4-night total $73.82 (sub 62.5, fees 7.19, tax 4.13) | 0.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'valet', 'security', 'wheelchair_access'] | shuttle: 24/7 on demand pick up from airport. | photos=3 | reviews=None
### MLB — 1 lots (considered 1, degraded=False)
- Hilton Melbourne, FL | /melbourne-mlb/airport-parking/hilton-melbourne-fl | 4-night total $29.03 (sub 26.25, fees 1.31, tax 1.47) | 1.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate_number'] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7 on demand | photos=3 | reviews=None
### MSP — 1 lots (considered 1, degraded=False)
- Hyatt Regency Bloomington | /minneapolis-msp/airport-parking/hyatt-regency-bloomington | 4-night total $47.7 (sub 39.75, fees 7.95, tax 0) | 1.9 mi | avail=available | dueAtLot=False $0 | minDays=4 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate', 'car_makemodel'] | badges=['most_booked', 'lowest_total'] | amen=['247_front_desk', 'restaurant'] | shuttle: 3:30 AM - 1:30 AM: Shuttle runs every 30 minutes. Pick ups on demand 1:30 AM - 3:30 AM: No | photos=3 | reviews=None
### MSY — 3 lots (considered 5, degraded=False)
- DoubleTree New Orleans Airport | /new-orleans-msy/airport-parking/doubletree-new-orleans-airport | 4-night total $50.76 (sub 45, fees 2.25, tax 3.51) | 1.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: No shuttle. You must arrange their own rideshare transportation (such as Uber or Lyft) to  | photos=3 | reviews=None
- Hilton New Orleans Airport | /new-orleans-msy/airport-parking/hilton-new-orleans-airport | 4-night total $52.36 (sub 44.75, fees 7.61, tax 0) | 0.8 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7 Shuttle Service, every 15 mins | photos=3 | reviews=None
- Comfort Inn New Orleans Airport South | /new-orleans-msy/airport-parking/comfort-inn-new-orleans-airport-south | 4-night total $59.23 (sub 34.75, fees 21.74, tax 2.74) | 2 mi | avail=available | dueAtLot=False $0 | minDays=4 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 6:00 AM - 11:00 AM: Shuttle runs on demand.  11:00 AM - 5:00 PM: No shuttle.  5:00 PM - 11 | photos=3 | reviews=None
### OAK — 3 lots (considered 4, degraded=False)
- Express Park Fly | /oakland-oak/airport-parking/express-park-fly | 4-night total $49.44 (sub 34.75, fees 6.74, tax 7.95) | 1.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['covered_garage', 'security', '247_front_desk'] | shuttle: 24/7, On demand | photos=3 | reviews=None
- Spring Park Airport Parking | /oakland-oak/airport-parking/spring-park-airport-parking | 4-night total $50.44 (sub 34.75, fees 8.74, tax 6.95) | 1.4 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk'] | shuttle: 24/7 On demand | photos=3 | reviews=None
- Airpark Oakland Parking | /oakland-oak/airport-parking/airpark-oakland-parking | 4-night total $77.6 (sub 60, fees 6.5, tax 11.1) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'wheelchair_access', 'valet', 'security'] | shuttle: 24/7 every 10 minutes | photos=3 | reviews=None
### OKC — 2 lots (considered 2, degraded=False)
- DoubleTree | /oklahoma-city-okc/airport-parking/doubletree | 4-night total $20.74 (sub 19.75, fees 0.99, tax 0) | 3.6 mi | avail=available | dueAtLot=False $0 | minDays=3 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['security', 'restaurant', 'wheelchair_access'] | shuttle: 6AM - 10PM hourly to the airport call to arrange for a pick-up | photos=3 | reviews=None
- Wyndham Garden | /oklahoma-city-okc/airport-parking/wyndham-garden | 4-night total $33.75 (sub 23.75, fees 10, tax 0) | 3.5 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: Shuttle service is currently suspended; however, the airport is just a short and convenien | photos=3 | reviews=None
### ORD — 6 lots (considered 11, degraded=False)
- Super 8 Chicago O'Hare Airport | /chicago-ord/airport-parking/super-8-chicago-o-hare-airport | 4-night total $55.23 (sub 49.75, fees 2.49, tax 2.99) | 2.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked', 'lowest_total'] | amen=['free_internet_wifi', '247_front_desk', 'fitness_center'] | shuttle: No shuttle, guests must arrange their own airport transportation | photos=3 | reviews=None
- Crowne Plaza | /chicago-ord/airport-parking/crowne-plaza | 4-night total $66.32 (sub 54.75, fees 7.74, tax 3.83) | 2.2 mi | avail=limited | dueAtLot=False $0 | minDays=3 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 5AM - 9:30PM, every 30 minutes | photos=3 | reviews=None
- Routes Airport Parking | /chicago-ord/airport-parking/routes-airport-parking | 4-night total $78.3 (sub 59.75, fees 18.55, tax 0) | 2.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'security'] | shuttle: 24/7, on demand | photos=2 | reviews=None
- Hyatt Place Chicago/O'Hare | /chicago-ord/airport-parking/hyatt-place-chicago-o-hare | 4-night total $88.68 (sub 64.75, fees 20.04, tax 3.89) | 2.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 5:00 AM - 10:30 PM: Shuttle runs every 40 minutes.  10:30 PM - 5:00 AM: No shuttle. | photos=3 | reviews=None
- Pride Airport Parking | /chicago-ord/airport-parking/pride-airport-parking | 4-night total $95.88 (sub 69.75, fees 8.69, tax 17.44) | 2 mi | avail=available | dueAtLot=True $83.68 | minDays=3 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', 'valet', '247_front_desk'] | shuttle: 24/7, on demand | photos=1 | reviews=None
- Marriott Suites O'Hare | /chicago-ord/airport-parking/marriott-suites-o-hare | 4-night total $111.3 (sub 106, fees 5.3, tax 6.36) | 2.6 mi | avail=available | dueAtLot=False $0 | minDays=3 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['restaurant', 'wheelchair_access'] | shuttle: 5 AM - 10 PM, every 30 minutes | photos=3 | reviews=None
### ORF — 1 lots (considered 2, degraded=False)
- Econo Lodge Norfolk Airport | /norfolk-orf/airport-parking/econo-lodge-norfolk-airport | 4-night total $42 (sub 35, fees 7, tax 0) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['restaurant'] | shuttle: Shuttle temporarily suspended. You may arrange for your own Uber/Lyft | photos=3 | reviews=None
### PBI — 1 lots (considered 1, degraded=False)
- West Palm Beach Marriott | /west-palm-beach-pbi/airport-parking/west-palm-beach-marriott | 4-night total $38.44 (sub 34.75, fees 1.74, tax 1.95) | 2.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant'] | shuttle: 6:00 AM - 12:00 AM, every 30 minutes | photos=3 | reviews=None
### PDX — 3 lots (considered 3, degraded=False)
- Holiday Inn | /portland-pdx/airport-parking/holiday-inn | 4-night total $47.7 (sub 39.75, fees 7.95, tax 0) | 1.9 mi | avail=available | dueAtLot=False $0 | minDays=4 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked', 'lowest_total'] | amen=['247_front_desk', 'restaurant', 'wheelchair_access', 'free_internet_wifi'] | shuttle: 24/7 on demand | photos=3 | reviews=None
- Radisson Portland Airport | /portland-pdx/airport-parking/radisson-portland-airport | 4-night total $66.48 (sub 59.98, fees 6.5, tax 0) | 1.6 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7 every 30 minutes; Airport pick-ups on demand | photos=3 | reviews=None
- AirPark Portland | /portland-pdx/airport-parking/airpark-portland | 4-night total $75.59 (sub 73.75, fees 1.84, tax 0) | 1.4 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['wheelchair_access', '247_front_desk', 'valet', 'security'] | shuttle: 24 hours on demand to and from airport | photos=3 | reviews=None
### PHL — 6 lots (considered 8, degraded=False)
- ARB Parking Philadelphia | /philadelphia-phl/airport-parking/arb-parking-philadelphia | 4-night total $45.51 (sub 37.25, fees 1.3, tax 6.96) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['security', '247_front_desk', 'wheelchair_access'] | shuttle: 24/7 every 10 minutes | photos=3 | reviews=None
- Motel 6 | /philadelphia-phl/airport-parking/motel-6 | 4-night total $36.06 (sub 30, fees 1.5, tax 4.56) | 2 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant'] | shuttle: No shuttle, but airport is a few minutes away by Uber/Lyft?Taxi | photos=3 | reviews=None
- Regal Philly Parking | /philadelphia-phl/airport-parking/regal-philly-parking | 4-night total $36.6 (sub 29.75, fees 1.49, tax 5.36) | 2.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=[] | shuttle: Shuttle runs 24/7 every 10-15 minutes | photos=3 | reviews=None
- Red Carpet Inn Philadelphia Airport | /philadelphia-phl/airport-parking/red-carpet-inn-philadelphia-airport | 4-night total $37.2 (sub 30, fees 1.5, tax 5.7) | 2 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: No shuttle; minutes from the airport via quick rideshare/taxi. | photos=3 | reviews=None
- MS Parking Philly | /philadelphia-phl/airport-parking/ms-parking-philly | 4-night total $44.31 (sub 34.75, fees 1.74, tax 7.82) | 2.2 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'wheelchair_access', 'valet', 'free_internet_wifi'] | shuttle: 24/7 every 10-15 mins to and from your terminal | photos=3 | reviews=None
- PHL Park & Ride - Holiday Inn Philadelphia Airport | /philadelphia-phl/airport-parking/phl-park-ride-holiday-inn-philadelphia-airport | 4-night total $54.41 (sub 44.75, fees 6.62, tax 3.04) | 4.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'free_internet_wifi', 'restaurant', 'fitness_center'] | shuttle: 24/7 Shuttle every 30 minutespick ups on demand | photos=3 | reviews=None
### PHX — 5 lots (considered 8, degraded=False)
- La Quinta Inn & Suites Tempe University | /phoenix-phx/airport-parking/la-quinta-inn-suites-tempe-university | 4-night total $20.95 (sub 19.95, fees 1, tax 0) | 3.9 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=[] | shuttle: No shuttle. You must arrange your own transportation to and from the airport. | photos=3 | reviews=None
- Howard Johnson | /phoenix-phx/airport-parking/howard-johnson | 4-night total $26.25 (sub 25, fees 1.25, tax 0) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access', 'free_internet_wifi'] | shuttle: no shuttle | photos=3 | reviews=None
- DoubleTree Suites by Hilton Phoenix | /phoenix-phx/airport-parking/doubletree-suites-by-hilton-phoenix | 4-night total $48.02 (sub 44.5, fees 2.23, tax 1.29) | 1.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 4:00 AM - 11:00 PM: Shuttle runs every 30 minutes. pick ups on demand, please call (602) 2 | photos=3 | reviews=None
- Holiday Inn & Suites Phoenix Airport North | /phoenix-phx/airport-parking/holiday-inn-suites-phoenix-airport-north | 4-night total $48.24 (sub 44.95, fees 2.25, tax 1.04) | 2.3 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['wheelchair_access'] | shuttle: Shuttle runs from 4AM to 12AM every 30 minutes and pick ups on demand. | photos=3 | reviews=None
- Crowne Plaza | /phoenix-phx/airport-parking/crowne-plaza | 4-night total $66 (sub 60, fees 6, tax 0) | 1.4 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate'] | badges=None | amen=['covered_garage', 'security', '247_front_desk', 'restaurant'] | shuttle: 24/7, every 30 minutes on top of hour; Pick-ups are on demand | photos=3 | reviews=None
### PIT — 2 lots (considered 3, degraded=False)
- Globe Airport Parking | /pittsburgh-pit/airport-parking/globe-airport-parking | 4-night total $40.62 (sub 34.75, fees 5.87, tax 0) | 1.2 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['valet', 'security', '247_front_desk', 'wheelchair_access'] | shuttle: 24/7, Globe operates 3 Shuttlespickups are on demand. | photos=3 | reviews=None
- Charlie Brown's Airport Parking | /pittsburgh-pit/airport-parking/charlie-brown-s-airport-parking | 4-night total $61.85 (sub 49.75, fees 7.24, tax 4.86) | 2.6 mi | avail=available | dueAtLot=False $0 | minDays=1 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'security', '247_front_desk', 'wheelchair_access'] | shuttle: 24 hours on demand | photos=3 | reviews=None
### POE — 10 lots (considered 18, degraded=False)
- Springhill Suites | /fort-lauderdale-poe/airport-parking/springhill-suites | 4-night total $48.87 (sub 44.75, fees 4.12, tax 0) | 4.3 mi | avail=available | dueAtLot=False $0 | minDays=3 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['security', '247_front_desk', 'restaurant', 'wheelchair_access', 'free_internet_wifi'] | shuttle: Sun-Thu4:30 AM - 11:30 PM: Shuttle runs every 1 hour.  11:30 PM - 4:30 AM: No shuttle.  Fr | photos=3 | reviews=None
- Fairfield Inn & Suites | /fort-lauderdale-poe/airport-parking/fairfield-inn-suites | 4-night total $46.99 (sub 44.75, fees 2.24, tax 0) | 4 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['restaurant'] | shuttle: 24 hours every hour on the hour; Pickups are on demand. | photos=3 | reviews=None
- Home2 Suites by Hilton Ft. Lauderdale Airport | /fort-lauderdale-poe/airport-parking/home2-suites-by-hilton-ft-lauderdale-airport | 4-night total $50.12 (sub 44.75, fees 2.24, tax 3.13) | 4.4 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 5:00 AM - 10:30 PM: Shuttle runs every 1 hour. Pickups from Airport on demand 10:30 PM - 5 | photos=3 | reviews=None
- The Harrison Hotel Downtown Hollywood | /fort-lauderdale-poe/airport-parking/the-harrison-hotel-downtown-hollywood | 4-night total $56 (sub 50, fees 2.5, tax 3.5) | 6.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['covered_garage', '247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'room_service'] | shuttle: 5:30 AM - 9:30 PM: Shuttle runs on demand.  9:30 PM - 5:30 AM: No shuttle. | photos=3 | reviews=None
- Residence Inn Fort Lauderdale Airport | /fort-lauderdale-poe/airport-parking/residence-inn-fort-lauderdale-airport | 4-night total $58.19 (sub 48.39, fees 6.41, tax 3.39) | 4.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['restaurant'] | shuttle: 5:00 AM - 11:00 PM: Shuttle runs every 1 hour. Top of the hour 11:00 PM - 5:00 AM: No shut | photos=3 | reviews=None
- Aloft by Marriott Fort Lauderdale Airport | /fort-lauderdale-poe/airport-parking/aloft-by-marriott-fort-lauderdale-airport | 4-night total $59.82 (sub 48.95, fees 7.44, tax 3.43) | 1.5 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'covered_garage', '247_front_desk', 'restaurant'] | shuttle: 24/7 every hour on the hour | photos=3 | reviews=None
- Courtyard Fort Lauderdale Airport | /fort-lauderdale-poe/airport-parking/courtyard-fort-lauderdale-airport | 4-night total $61.24 (sub 59.75, fees 1.49, tax 0) | 4 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'restaurant', 'wheelchair_access', 'free_internet_wifi'] | shuttle: 5:00 AM - midnight every 30 minutes pick ups are on demand within shuttle hours | photos=3 | reviews=None
- Marriott Fort Lauderdale Airport | /fort-lauderdale-poe/airport-parking/marriott-fort-lauderdale-airport | 4-night total $66.92 (sub 59.75, fees 2.99, tax 4.18) | 3.9 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'covered_garage', 'security', '247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 24/7 Shuttle every hour - Top of the hourPick-ups from airport On-Demand | photos=3 | reviews=None
- Park By The Ports AIRPORT Parking | /fort-lauderdale-poe/airport-parking/park-by-the-ports-airport-parking | 4-night total $115.9 (sub 99.95, fees 10, tax 5.95) | 3 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'wheelchair_access'] | shuttle: 24/7 on Demand | photos=3 | reviews=None
- Park By The Ports Cruise Parking | /fort-lauderdale-poe/airport-parking/park-by-the-ports-cruise-parking | 4-night total $117.3 (sub 99.95, fees 10, tax 7.35) | 3 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security'] | shuttle: 7 AM to 2 PM | photos=3 | reviews=None
### PVD — 1 lots (considered 1, degraded=False)
- DoubleTree by Hilton Providence Airport | /providence-pvd/airport-parking/doubletree-by-hilton-providence-airport | 4-night total $91.28 (sub 74.75, fees 10.8, tax 5.73) | 0.6 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi'] | shuttle: 24/7 on demand | photos=3 | reviews=None
### RDU — 3 lots (considered 7, degraded=False)
- Embassy Suites by Hilton Research Triangle | /raleigh-rdu/airport-parking/embassy-suites-by-hilton-research-triangle | 4-night total $44.51 (sub 37.45, fees 4.87, tax 2.19) | 3.2 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate_number', 'number_of_passengers'] | badges=['lowest_total'] | amen=['security', 'restaurant'] | shuttle: 4:00 AM - 12:00 AM: Shuttle runs every 30 minutes.  12:00 AM - 4:00 AM: No shuttle. | photos=3 | reviews=None
- Sheraton Imperial Raleigh-Durham Airport | /raleigh-rdu/airport-parking/sheraton-imperial-raleigh-durham-airport | 4-night total $61.48 (sub 54.65, fees 2.73, tax 4.1) | 2.9 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7 every hour; Pickups on demand | photos=3 | reviews=None
- Quality Inn & Suites | /raleigh-rdu/airport-parking/quality-inn-suites | 4-night total $65.97 (sub 49.75, fees 12.49, tax 3.73) | 2.1 mi | avail=available | dueAtLot=False $0 | minDays=3 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['wheelchair_access'] | shuttle: 4 AM - MIDNIGHT; no shuttle outside of these hours. Shuttle runs every 30 minutes to and f | photos=3 | reviews=None
### RIC — 3 lots (considered 3, degraded=False)
- Best Western Plus Richmond Airport | /richmond-ric/airport-parking/best-western-plus-richmond-airport | 4-night total $25.99 (sub 24.75, fees 1.24, tax 0) | 1.5 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['restaurant', 'wheelchair_access', 'free_internet_wifi'] | shuttle: No Shuttle | photos=3 | reviews=None
- DoubleTree by Hilton Richmond Airport | /richmond-ric/airport-parking/doubletree-by-hilton-richmond-airport | 4-night total $52.24 (sub 49.75, fees 2.49, tax 0) | 1.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', 'restaurant', 'wheelchair_access'] | shuttle: 5:00 AM - 12:00 AM every 30 minutes to airportOn demand from airport within shuttle hours | photos=3 | reviews=None
- Sheraton Richmond Airport | /richmond-ric/airport-parking/sheraton-richmond-airport | 4-night total $52.45 (sub 49.95, fees 2.5, tax 0) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 4:00 AM - 1:00 AM: Shuttle runs every 30 minutes.  1:00 AM - 4:00 AM: No shuttle. | photos=3 | reviews=None
### RNO — 2 lots (considered 2, degraded=False)
- Best Western Plus Sparks-Reno | /reno-rno/airport-parking/best-western-plus-sparks-reno | 4-night total $52.24 (sub 49.75, fees 2.49, tax 0) | 2.7 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant', 'wheelchair_access', 'fitness_center', 'free_internet_wifi', 'breakfast_included'] | shuttle: 24/7 on demand | photos=3 | reviews=None
- SureStay Plus | /reno-rno/airport-parking/surestay-plus | 4-night total $88.99 (sub 84.75, fees 4.24, tax 0) | 0.8 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'restaurant', 'fitness_center'] | shuttle: 24/7 on demand to and from the airport | photos=3 | reviews=None
### ROA — 0 lots (considered 1, degraded=False)
### ROC — 1 lots (considered 2, degraded=False)
- Motel 6 Rochester Airport | /rochester-roc/airport-parking/motel-6-rochester-airport | 4-night total $18.32 (sub 17.45, fees 0.87, tax 0) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk'] | shuttle: Shuttle runs 24/7 on demand to and from the airport | photos=3 | reviews=None
### RSW — 0 lots (considered 0, degraded=False)
### SAN — 4 lots (considered 5, degraded=False)
- Fox Parking | /san-diego-san/airport-parking/fox-parking | 4-night total $103.19 (sub 87.5, fees 10.88, tax 4.81) | 0.8 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked', 'lowest_total'] | amen=['valet', 'security'] | shuttle: 4:00 AM - 12:30 AM: Shuttle runs on demand.  12:30 AM - 4:00 AM: No shuttle. | photos=3 | reviews=None
- San Diego's Park Shuttle and Fly - LOT A | /san-diego-san/airport-parking/san-diego-s-park-shuttle-and-fly-lot-a | 4-night total $112.12 (sub 104.75, fees 7.37, tax 0) | 0.9 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'security'] | shuttle: 24 hours on demand to and from the airport. | photos=3 | reviews=None
- San Diego's Park Shuttle and Fly - LOT B | /san-diego-san/airport-parking/san-diego-s-park-shuttle-and-fly-lot-b | 4-night total $112.12 (sub 104.75, fees 7.37, tax 0) | 0.9 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=[] | shuttle: 24/7 on demand to and from the airport | photos=1 | reviews=None
- Aladdin Port Parking | /san-diego-san/airport-parking/aladdin-port-parking | 4-night total $120.49 (sub 114.75, fees 5.74, tax 0) | 1.2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'wheelchair_access', 'valet', 'covered_garage', 'security'] | shuttle: 24 hours every 15-25 minutes; on demand | photos=3 | reviews=None
### SAT — 1 lots (considered 2, degraded=False)
- Homewood Suites | /san-antonio-sat/airport-parking/homewood-suites | 4-night total $33.22 (sub 29.75, fees 1.49, tax 1.98) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=2 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant'] | shuttle: 4:00 AM - 12:00 AM: Shuttle runs on demand.  12:00 AM - 4:00 AM: No shuttle. | photos=3 | reviews=None
### SAV — 1 lots (considered 2, degraded=False)
- Candlewood Suites | /savannah-sav/airport-parking/candlewood-suites | 4-night total $41.74 (sub 39.75, fees 1.99, tax 0) | 2.3 mi | avail=available | dueAtLot=False $0 | minDays=None daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk'] | shuttle: No Shuttle. Uber/Lyft is an affordable option for transportation. | photos=3 | reviews=None
### SDF — 3 lots (considered 4, degraded=False)
- Hampton Inn | /louisville-sdf/airport-parking/hampton-inn | 4-night total $41.74 (sub 39.75, fees 1.99, tax 0) | 1.2 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7 on demand | photos=3 | reviews=None
- SpringHill Suites | /louisville-sdf/airport-parking/springhill-suites | 4-night total $41.74 (sub 39.75, fees 1.99, tax 0) | 1.2 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['restaurant'] | shuttle: 24/7 on demand | photos=3 | reviews=None
- Residence Inn | /louisville-sdf/airport-parking/residence-inn | 4-night total $41.74 (sub 39.75, fees 1.99, tax 0) | 1.2 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=[] | shuttle: 24 hours on demand to and from the airport. | photos=3 | reviews=None
### SEA — 4 lots (considered 8, degraded=False)
- Fox Parking SeaTac | /seattle-sea/airport-parking/fox-parking-seatac | 4-night total $94.01 (sub 67.5, fees 18.37, tax 8.14) | 2.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['247_front_desk', 'valet'] | shuttle: 24/7, with pickups every 15–20 minutes | photos=3 | reviews=None
- Motel 6 | /seattle-sea/airport-parking/motel-6 | 4-night total $46.99 (sub 44.75, fees 2.24, tax 0) | 2 mi | avail=limited | dueAtLot=False $0 | minDays=1 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['security', '247_front_desk', 'wheelchair_access'] | shuttle: 7am to 10pm once an hour top of the hour | photos=3 | reviews=None
- Evods Parking at Spark by Hilton SEA-TAC Airport | /seattle-sea/airport-parking/evods-parking-at-spark-by-hilton-sea-tac-airport | 4-night total $80.79 (sub 69.95, fees 3.5, tax 7.34) | 1 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['valet', 'covered_garage', 'security', '247_front_desk', 'restaurant'] | shuttle: 24/7 every 30 minutes, on the hour and half hour. | photos=3 | reviews=None
- Seattle Airport Marriott | /seattle-sea/airport-parking/seattle-airport-marriott | 4-night total $105.01 (sub 87.25, fees 8.6, tax 9.16) | 0.9 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7 Shuttle every 15 minutes | photos=3 | reviews=None
### SFO — 5 lots (considered 6, degraded=False)
- Best Western Grosvenor Hotel | /san-francisco-sfo/airport-parking/best-western-grosvenor-hotel | 4-night total $46.99 (sub 44.75, fees 2.24, tax 0) | 2.1 mi | avail=limited | dueAtLot=False $0 | minDays=5 daily | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 5:00 AM - 10:15 AM: Shuttle runs every 45 minutes.  10:15 AM - 5:00 PM: No shuttle.  5:00  | photos=3 | reviews=None
- Hampton Inn | /san-francisco-sfo/airport-parking/hampton-inn | 4-night total $45.87 (sub 44.75, fees 1.12, tax 0) | 2.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'wheelchair_access'] | shuttle: No shuttle | photos=3 | reviews=None
- Courtyard San Francisco Airport | /san-francisco-sfo/airport-parking/courtyard-san-francisco-airport | 4-night total $57.38 (sub 49.95, fees 2.5, tax 4.93) | 2.3 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: No shuttle. Please arrange for your own Uber/Lyft when you park | photos=3 | reviews=None
- Home2Suites by Hilton | /san-francisco-sfo/airport-parking/home2suites-by-hilton | 4-night total $58.49 (sub 49.75, fees 8.74, tax 0) | 2.7 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: No shuttle | photos=3 | reviews=None
- DoubleTree San Francisco Airport North Bayfront | /san-francisco-sfo/airport-parking/doubletree-san-francisco-airport-north-bayfront | 4-night total $94.14 (sub 81.95, fees 4.1, tax 8.09) | 3.6 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'restaurant'] | shuttle: No Shuttle. Guests must arrange their own transportation (Uber/Lyft) to and from the airpo | photos=3 | reviews=None
### SJC — 3 lots (considered 4, degraded=False)
- Joy Park Fly | /san-jose-sjc/airport-parking/joy-park-fly | 4-night total $43.79 (sub 34.95, fees 5.87, tax 2.97) | 1.2 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'valet', 'security'] | shuttle: Shuttles run 24 hours a day, departing every 10 to 15 minutes. Return pickups are availabl | photos=3 | reviews=None
- Holiday Inn San Jose Airport | /san-jose-sjc/airport-parking/holiday-inn-san-jose-airport | 4-night total $44.1 (sub 34.75, fees 5.87, tax 3.48) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7, on demand | photos=3 | reviews=None
- Spring Park San Jose Airport Parking | /san-jose-sjc/airport-parking/spring-park-san-jose-airport-parking | 4-night total $49.44 (sub 34.75, fees 7.74, tax 6.95) | 0.8 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['covered_garage', '247_front_desk'] | shuttle: 24/7 on demand | photos=3 | reviews=None
### SLC — 0 lots (considered 2, degraded=False)
### SNA — 0 lots (considered 1, degraded=False)
### STL — 6 lots (considered 6, degraded=False)
- Quality Inn | /st-louis-stl/airport-parking/quality-inn | 4-night total $32.5 (sub 32.5, fees 0, tax 0) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=1 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['valet', 'restaurant'] | shuttle: 4:30 AM - 11 PM every 30 minuteson demand from the airport. | photos=3 | reviews=None
- Renaissance St. Louis Airport | /st-louis-stl/airport-parking/renaissance-st-louis-airport | 4-night total $33.86 (sub 32.25, fees 1.61, tax 0) | 1.7 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant', 'fitness_center', 'room_service'] | shuttle: 4:00 AM - 12:00 AM: Shuttle runs every 30 minutes.  12:00 AM - 4:00 AM: Shuttle runs on de | photos=3 | reviews=None
- Crowne Plaza Airport | /st-louis-stl/airport-parking/crowne-plaza-airport | 4-night total $52.45 (sub 49.95, fees 2.5, tax 0) | 1.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['security', '247_front_desk', 'restaurant'] | shuttle: 24/7 every 30 minutes | photos=3 | reviews=None
- Marriott St. Louis Airport | /st-louis-stl/airport-parking/marriott-st-louis-airport | 4-night total $62.74 (sub 59.75, fees 2.99, tax 0) | 0.8 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7 Every 20 minutes | photos=3 | reviews=None
- The Parking Spot 3 | /st-louis-stl/airport-parking/the-parking-spot-3 | 4-night total $72.07 (sub 68.75, fees 1.72, tax 1.6) | 0.9 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[] | extraFields=[] | badges=None | amen=['covered_garage', '247_front_desk'] | shuttle: 24/7, runs continuously | photos=3 | reviews=None
- Hilton St. Louis Airport | /st-louis-stl/airport-parking/hilton-st-louis-airport | 4-night total $78.7 (sub 74.95, fees 3.75, tax 0) | 1.1 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['247_front_desk', 'restaurant'] | shuttle: 24/7 Every 30 Minutes | photos=3 | reviews=None
### SYR — 1 lots (considered 2, degraded=False)
- Candlewood Suites Syracuse Airport | /syracuse-syr/airport-parking/candlewood-suites-syracuse-airport | 4-night total $38.71 (sub 34.75, fees 1.74, tax 2.22) | 1.9 mi | avail=limited | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 4:00 AM - 12:00 AM: Shuttle runs on demand.  12:00 AM - 4:00 AM: No shuttle. | photos=3 | reviews=None
### TPA — 3 lots (considered 4, degraded=False)
- Grand Hyatt Tampa Bay | /tampa-tpa/airport-parking/grand-hyatt-tampa-bay | 4-night total $48.79 (sub 39.75, fees 5.98, tax 3.06) | 1.3 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked'] | amen=['247_front_desk', 'restaurant', 'wheelchair_access'] | shuttle: 5:00 AM - 11:00 PM: Shuttle runs on demand.  11:00 PM - 5:00 AM: No shuttle. | photos=3 | reviews=None
- Quality Inn & Suites Tampa/Ybor City | /tampa-tpa/airport-parking/quality-inn-suites-tampa-ybor-city | 4-night total $41.82 (sub 37.5, fees 1.88, tax 2.44) | 7.9 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['lowest_total'] | amen=['security', '247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi', 'breakfast_included'] | shuttle: 10:00 AM - 2:00 PM: Shuttle runs on demand.  2:00 PM - 10:00 AM: No shuttle. | photos=3 | reviews=None
- 241 Car Services - Secure Parking | /tampa-tpa/airport-parking/241-car-services-secure-parking | 4-night total $47.32 (sub 44.95, fees 2.37, tax 0) | 5.5 mi | avail=available | dueAtLot=False $0 | minDays=2 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=None | amen=['wheelchair_access', 'security'] | shuttle: 7:00 AM - 3:00 PM on demand | photos=2 | reviews=None
### TUS — 1 lots (considered 1, degraded=False)
- Four Points by Sheraton Tucson Airport | /tucson-tus/airport-parking/four-points-by-sheraton-tucson-airport | 4-night total $23.62 (sub 19.75, fees 3.36, tax 0.51) | 0.6 mi | avail=available | dueAtLot=False $0 | minDays=None hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=['license_plate'] | badges=['lowest_total'] | amen=['covered_garage', '247_front_desk', 'restaurant', 'fitness_center', 'free_internet_wifi'] | shuttle: 4:00 AM - 11:00 PM: Shuttle runs on demand.  11:00 PM - 4:00 AM: No shuttle. | photos=3 | reviews=None
### TYS — 1 lots (considered 1, degraded=False)
- USA PARKING Knoxville Airport | /knoxville-tys/airport-parking/usa-parking-knoxville-airport | 4-night total $42.46 (sub 39.75, fees 0, tax 2.71) | 1.3 mi | avail=available | dueAtLot=True $30.54 | minDays=5 hourly | cancel=[{"numberOfDays": 0, "percentage": 100}] | extraFields=[] | badges=['most_booked', 'lowest_total'] | amen=['security', '247_front_desk'] | shuttle: Shuttle runs 4 AM to 11 PM | photos=1 | reviews=None
### YOW — 0 lots (considered 0, degraded=False)
### YUL — 0 lots (considered 0, degraded=False)
### YYC — 0 lots (considered 0, degraded=False)
### YYZ — 0 lots (considered 0, degraded=False)