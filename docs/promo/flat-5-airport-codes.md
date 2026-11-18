# Triply's own airport codes: flat $5 off (for Tom, updated 6 Nov 2026)

**Change from the first version:** the codes are now **$5 off**, not 10%. Vin decided this on 6 Nov after the board review. 10% off a $77 stay is $7.70, about half our ~$14.79 net take, and it grows on long stays. A flat $5 is predictable.

**Why the codes exist:** 212 promo posts send code-seekers to SpotHero, Way, Groupon and others. None of the 32 codes our posts quote works at our checkout. From now on, every promo post leads with OUR code.

**Rules:**
- $5 off the parking subtotal. The service fee is untouched.
- The discount never exceeds the subtotal or the amount due now. Due-at-lot stays the same.
- Minimum subtotal of $25, so a 1-day $10 stay doesn't get 50% off. This is Claude's suggestion; Vin or Tom can change it.
- One code per airport (`DFW5`, `LAX5`, …), so `bookings.promo_code` tells us which airport's posts drove the booking.
- PR #48 (one use per customer + `current_uses` counting) merges first.

## Needs a small checkout change (Tom's area)

Today `promo_codes` only has `discount_percent` (NOT NULL, 1–100), and `/api/checkout/lot` + `/api/promo/validate` only apply a percent. A flat code needs:

1. A migration: `discount_amount DECIMAL(10,2) NULL`, `min_subtotal DECIMAL(10,2) NULL`, make `discount_percent` nullable, and add a CHECK that exactly one of the two is set.
2. `src/app/api/checkout/lot/route.ts` (both paths, ~L340 and ~L571): discount = `min(discount_amount, sub_total, dueNow)` when `discount_amount` is set and `sub_total >= min_subtotal`. Keep the percent path as is for old codes.
3. `src/app/api/promo/validate/route.ts`: return `discountAmount` (and `minSubtotal`) alongside `discountPercent`.
4. The checkout UI line that shows the promo ("10% off") shows "$5 off" for a flat code.
5. `bookings.discount_amount` already stores dollars (migration 016), so the admin dashboard needs no change.

## SQL once that ships

```sql
-- 1. check nothing collides
SELECT code, active FROM promo_codes
WHERE code IN ('DFW5','LAX5','CLT5','EWR5','IAH5','TPA5','LGA5','SAN5','JFK5','IAD5',
               'BOS5','LAS5','SFO5','AUS5','MSP5','MCO5','ATL5','DEN5','DCA5','ORD5',
               'PHL5','BWI5','SEA5');

-- 2. add the 23 airport codes (ranked by promo-post clicks, 90 days)
INSERT INTO promo_codes (code, discount_amount, min_subtotal, active, expires_at, max_uses, current_uses)
SELECT c, 5.00, 25.00, true, '2027-01-31T23:59:59Z', 500, 0
FROM unnest(ARRAY['DFW5','LAX5','CLT5','EWR5','IAH5','TPA5','LGA5','SAN5','JFK5','IAD5',
                  'BOS5','LAS5','SFO5','AUS5','MSP5','MCO5','ATL5','DEN5','DCA5','ORD5',
                  'PHL5','BWI5','SEA5']) AS c;
```

**Verify:** `POST https://www.triplypro.com/api/promo/validate` with `{"code":"DFW5"}` returns `valid: true, discountAmount: 5`. Then tell Claude: Claude adds the codes to the engine's `approved-promo-codes.json`, rewrites the 20 promo previews from "10%" to "$5 off", re-runs the checks and applies them on Vin's OK.
