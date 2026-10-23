import { describe, it, expect } from "vitest";
import {
  BACKFILL_MAX_DAYS_AFTER,
  BACKFILL_MIN_DAYS_AFTER,
  selectBackfillSends,
  summarizeBackfill,
} from "../backfill";
import type { ReviewBookingRow, ReviewLedgerRow } from "../select";

// 2026-10-09 23:00 UTC = 19:00 in New York.
const NOW = Date.UTC(2026, 9, 9, 23, 0);
const CAMPAIGN = "2026-10-09";

let seq = 0;
function booking(o: Partial<ReviewBookingRow> = {}): ReviewBookingRow {
  seq++;
  return {
    id: o.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    status: "completed",
    cancelState: null,
    checkOut: "2026-07-15T10:00:00",
    locationName: "Jet Parking JFK",
    airportCode: "JFK",
    reslabLocationId: 10,
    directLotId: null,
    locationTimezone: "America/New_York",
    livemode: true,
    email: `traveller${seq}@example.com`,
    firstName: "Sam",
    ...o,
  };
}

function run(
  bookings: ReviewBookingRow[],
  ledger: ReviewLedgerRow[] = [],
  reviewed: string[] = [],
  suppressed: string[] = []
) {
  return selectBackfillSends(bookings, ledger, new Set(reviewed), NOW, {
    live: true,
    testLocationIds: new Set([194]),
    suppressed: new Set(suppressed),
    campaignDate: CAMPAIGN,
  });
}

describe("selectBackfillSends", () => {
  it("asks a past customer once, as kind 'backfill', with the campaign date on the link", () => {
    const b = booking({ email: "  Sam@Example.com " });
    const { candidates } = run([b]);
    expect(candidates).toEqual([
      {
        bookingId: b.id,
        kind: "backfill",
        email: "sam@example.com",
        firstName: "Sam",
        lotName: "Jet Parking JFK",
        airportCode: "JFK",
        checkoutDate: "2026-07-15",
        linkFromDate: CAMPAIGN,
      },
    ]);
  });

  it("asks one address about its most recent trip only", () => {
    const older = booking({ email: "a@example.com", checkOut: "2026-03-01T10:00:00", locationName: "Old Lot" });
    const newer = booking({ email: "A@example.com", checkOut: "2026-08-20T10:00:00", locationName: "New Lot" });
    const { candidates, skipped } = run([older, newer]);
    expect(candidates.map((c) => c.bookingId)).toEqual([newer.id]);
    expect(skipped.olderTripSameAddress).toBe(1);
  });

  it("never asks an address that already had any review email or left a review", () => {
    const got = booking({ email: "got@example.com", checkOut: "2026-10-07T10:00:00" }); // regular email last week
    const old = booking({ email: "got@example.com", checkOut: "2026-05-01T10:00:00" });
    const unconfirmed = booking({ email: "maybe@example.com" });
    const reviewer = booking({ email: "rev@example.com" });
    const { candidates, skipped } = run(
      [got, old, unconfirmed, reviewer],
      [
        { bookingId: got.id, kind: "initial", status: "sent", sentAt: "2026-10-07T23:00:00Z" },
        { bookingId: unconfirmed.id, kind: "backfill", status: "unconfirmed", sentAt: null },
      ],
      [reviewer.id]
    );
    expect(candidates).toEqual([]);
    expect(skipped.alreadyAsked).toBe(3);
  });

  it("leaves trips still inside the daily email's windows to the daily cron", () => {
    const recent = booking({ checkOut: "2026-10-05T10:00:00" }); // 4 days ago
    const edge = booking({ checkOut: "2026-10-03T10:00:00" }); // 6 days ago
    const { candidates, skipped } = run([recent, edge]);
    expect(BACKFILL_MIN_DAYS_AFTER).toBe(6);
    expect(candidates.map((c) => c.bookingId)).toEqual([edge.id]);
    expect(skipped.tooRecent).toBe(1);
  });

  it("skips trips older than a year", () => {
    const { candidates, skipped } = run([booking({ checkOut: "2025-10-08T10:00:00" })]);
    expect(BACKFILL_MAX_DAYS_AFTER).toBe(365);
    expect(candidates).toEqual([]);
    expect(skipped.tooOld).toBe(1);
  });

  it("applies the daily email's skips", () => {
    const { candidates, skipped } = run(
      [
        booking({ status: "cancelled" }),
        booking({ status: "refunded" }),
        booking({ cancelState: "requested" }),
        booking({ livemode: false }),
        booking({ reslabLocationId: 194 }),
        booking({ email: "not-an-email" }),
        booking({ email: "out@example.com" }),
        booking({ checkOut: "garbage" }),
      ],
      [],
      [],
      ["out@example.com"]
    );
    expect(candidates).toEqual([]);
    expect(skipped).toMatchObject({
      notReviewable: 2,
      cancelling: 1,
      otherMode: 1,
      testLot: 1,
      noEmail: 1,
      optedOut: 1,
      invalidCheckout: 1,
    });
  });

  it("orders the freshest trips first and summarizes without addresses", () => {
    const a = booking({ checkOut: "2026-04-10T10:00:00", airportCode: "EWR", locationName: "Lot A" });
    const b = booking({ checkOut: "2026-09-10T10:00:00" });
    const c = booking({ checkOut: "2026-09-12T10:00:00" });
    const { candidates } = run([a, b, c]);
    expect(candidates.map((x) => x.bookingId)).toEqual([c.id, b.id, a.id]);
    const s = summarizeBackfill(candidates);
    expect(s).toEqual({
      total: 3,
      byAirport: { JFK: 2, EWR: 1 },
      byCheckoutMonth: { "2026-09": 2, "2026-04": 1 },
      byLot: [
        { lot: "Jet Parking JFK", count: 2 },
        { lot: "Lot A", count: 1 },
      ],
    });
    expect(JSON.stringify(s)).not.toContain("@");
  });
});
