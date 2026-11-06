# Disputes (chargebacks) — how they're handled

## What happens automatically

When a customer disputes a charge, Stripe sends `charge.dispute.created` to `/api/webhooks/stripe`, and the webhook:

1. Writes a row to the `disputes` table (migration 045) with the amount, reason, deadline, booking, and the booking's status before the dispute.
2. Builds evidence and saves it on the dispute as a **draft**. It is **never submitted**, because Stripe allows only one submission per dispute. The draft states only what the records show:
   - the name and email typed at checkout (or, if there is no checkout record, the linked account, labelled as such);
   - the amount charged and anything refunded, read from Stripe, never from the booking total (that leaves out the service fee and Park Guard and includes what was paid at the lot);
   - the cancellation and refund policy, only for bookings made after the current Terms §5 went live on 2026-08-12;
   - that checkout keeps Pay disabled until the terms checkbox is ticked, and the exact wording shown for this payment (the checkout sends the version it rendered; it is stamped on the PaymentIntent as `termsVersion`, see `src/lib/checkout/terms-acceptance.ts`; older or unknown versions quote nothing), plus the CVC / postal / 3D Secure checks that passed;
   - a "Triply's booking record shows no cancellation" rebuttal only when the booking was confirmed or completed, no cancellation was started or recorded, and Stripe shows nothing refunded. A cancel made by the lot or in ResLab never reaches our record, so the checklist says to confirm in ResLab first.
   If Stripe can't be read, the draft states no amount, no terms, no checks and no rebuttal. It reads the dispute live first (one call: dispute, charge and PaymentIntent): if the dispute no longer takes evidence, or someone has already typed evidence in Stripe, no draft is saved over it.
3. Emails `PAYMENT_ALERT_EMAILS` with the deadline in Eastern time, a reason-specific checklist of what to add by hand, and a link to the dispute. The email is marked sent only after Resend accepts it; if a send fails or the function dies mid-send, Stripe's redelivery sends it (worst case: a duplicate email, never a missing one).
4. Sets the booking to `disputed`, but only if its status hasn't changed since step 1 (a refund that landed meanwhile keeps `refunded`).

On `charge.dispute.updated` / `charge.dispute.closed` the row's status and deadline stay current. On close it records the outcome (won / lost) and emails it once.

On `radar.early_fraud_warning.created` (the card network's warning that a dispute is likely) it records the warning (`fraud_warnings`, migration 046) and emails the alert list. Nothing is refunded automatically. If the car was not parked, **cancel the booking with a full refund from Admin → Bookings** — that also cancels it at ResLab and Park Guard. A refund in Stripe alone leaves the reservation live at the lot (and ResLab still bills it).

`/admin/disputes` lists every open dispute (deadline in Eastern time, hours left under 2 days) and recent closed ones, with draft state and outcome, plus fraud warnings. It opens on the deployment's own Stripe mode (staging = test); test rows carry a TEST tag. **Mark submitted** records who submitted the evidence in Stripe. It sends nothing to Stripe.

Code: `src/lib/disputes/` (evidence + per-reason playbook, handler, fraud warnings) and `src/lib/resend/send-dispute-alert.ts`.

## What a person does (each dispute)

1. Open the dispute from the alert email.
2. Read the issuer's note and check the draft text against the booking.
3. Add the items on the email's checklist, such as the lot's check-in proof or the customer's emails.
4. If the dispute can't be won (the lot turned them away, it really is a duplicate, a refund was owed), **accept it or refund**. Don't fight it.
5. Submit before the deadline, then press **Mark submitted** on `/admin/disputes`.

## Per-reason plan

| Stripe reason | Fight with | Concede when |
|---|---|---|
| `fraudulent` | Booking in cardholder's name and email, the lot's entry log | Lot has no record and the customer never contacted us |
| `product_not_received` | Lot's check-in/scan record | Lot turned them away |
| `product_unacceptable` | Listing as booked, our replies to the customer | Listing was wrong |
| `credit_not_processed` | Cancel time vs the 24-hour rule, refund already issued | Cancelled in time and not refunded |
| `subscription_canceled` | No cancellation on record | Cancelled in time |
| `duplicate` | Two separate confirmation numbers | Two charges for one reservation |

## One-time setup

- Apply `supabase/migrations/045_disputes.sql` (applied 2026-11-06), then `046_dispute_tracking.sql`, **before** deploying #150 and before enabling the fraud-warning event (the admin page reads 046's columns).
- In Stripe → Developers → Webhooks, on both the live triplypro.com endpoint and the test-mode staging endpoint, make sure `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed` and `radar.early_fraud_warning.created` are all enabled.
- Changing the checkout checkbox wording? Add a new version in `terms-acceptance.ts`; never edit an old one.
