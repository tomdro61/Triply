# Disputes (chargebacks) — how they're handled

## What happens automatically

When a customer disputes a charge, Stripe sends `charge.dispute.created` to `/api/webhooks/stripe`, and the webhook:

1. Sets the booking to `disputed`. This is unchanged.
2. Writes a row to the `disputes` table (migration 045) with the amount, reason, deadline and booking.
3. Builds evidence from the booking record (customer, lot, dates, confirmation, cancellation and refund policy) and saves it on the dispute as a **draft**. It is **never submitted**, because Stripe allows only one submission per dispute.
4. Emails `PAYMENT_ALERT_EMAILS` with the deadline, a reason-specific checklist of what to add by hand, and a link to the dispute.

On `charge.dispute.updated` / `charge.dispute.closed` the row's status and deadline stay current. On close it records the outcome (won / lost) and emails it once.

Code: `src/lib/disputes/` (evidence + per-reason playbook, handler) and `src/lib/resend/send-dispute-alert.ts`.

## What a person does (each dispute)

1. Open the dispute from the alert email.
2. Read the issuer's note and check the draft text against the booking.
3. Add the items on the email's checklist, such as the lot's check-in proof or the customer's emails.
4. If the dispute can't be won (the lot turned them away, it really is a duplicate, a refund was owed), **accept it or refund**. Don't fight it.
5. Submit before the deadline.

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

- Apply `supabase/migrations/045_disputes.sql` in the Supabase SQL editor.
- In Stripe → Developers → Webhooks → the triplypro.com endpoint, make sure `charge.dispute.created`, `charge.dispute.updated` and `charge.dispute.closed` are all enabled.
