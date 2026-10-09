import { describe, it, expect } from "vitest";
import {
  checkoutWallClock,
  daysBetween,
  earliestLocalWallClock,
  linkableAirportCode,
  localWallClockAt,
  selectReviewSends,
  type ReviewBookingRow,
  type ReviewLedgerRow,
} from "../select";

// 2026-10-09 23:00 UTC = 19:00 in New York, 16:00 in Los Angeles.
const NOW = Date.UTC(2026, 9, 9, 23, 0);
const HOUR = 3_600_000;

let seq = 0;
function booking(o: Partial<ReviewBookingRow> = {}): ReviewBookingRow {
  seq++;
  return {
    id: o.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    status: "confirmed",
    cancelState: null,
    checkOut: "2026-10-09T10:00:00",
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

const sent = (bookingId: string, kind: "initial" | "reminder", sentAt: string): ReviewLedgerRow => ({
  bookingId,
  kind,
  status: "sent",
  sentAt,
});

function run(bookings: ReviewBookingRow[], ledger: ReviewLedgerRow[] = [], reviewed: string[] = []) {
  return selectReviewSends(bookings, ledger, new Set(reviewed), NOW, { testLocationIds: new Set([194]) });
}

describe("helpers", () => {
  it("checkoutWallClock reads both PostgREST and literal formats, as strings", () => {
    expect(checkoutWallClock("2026-10-09T10:00:00")).toBe("2026-10-09 10:00");
    expect(checkoutWallClock("2026-10-09 22:30:00")).toBe("2026-10-09 22:30");
    expect(checkoutWallClock("garbage")).toBeNull();
    expect(checkoutWallClock(null)).toBeNull();
  });

  it("daysBetween is calendar days", () => {
    expect(daysBetween("2026-10-09", "2026-10-09")).toBe(0);
    expect(daysBetween("2026-10-06", "2026-10-09")).toBe(3);
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(daysBetween("2026-11-01", "2026-11-02")).toBe(1); // across a DST change
  });

  it("projects only 'now' into the lot zone, falling back to the airport, then the earliest zone", () => {
    expect(localWallClockAt(NOW, "America/New_York", null)).toBe("2026-10-09 19:00");
    expect(localWallClockAt(NOW, null, "LAX")).toBe("2026-10-09 16:00");
    expect(localWallClockAt(NOW, "Not/AZone", "RESLAB")).toBe(earliestLocalWallClock(NOW));
    expect(earliestLocalWallClock(NOW) <= "2026-10-09 16:00").toBe(true);
  });

  it("linkableAirportCode drops the RESLAB placeholder and unknown codes", () => {
    expect(linkableAirportCode("JFK")).toBe("JFK");
    expect(linkableAirportCode("RESLAB")).toBeNull();
    expect(linkableAirportCode(null)).toBeNull();
  });
});

describe("initial email", () => {
  it("goes to a confirmed booking whose check-out passed today at the lot", () => {
    const b = booking();
    const r = run([b]);
    expect(r.initial).toEqual([
      {
        bookingId: b.id,
        kind: "initial",
        email: b.email,
        firstName: "Sam",
        lotName: "Jet Parking JFK",
        airportCode: "JFK",
        checkoutDate: "2026-10-09",
      },
    ]);
    expect(r.reminder).toEqual([]);
  });

  it("also goes to a 'completed' booking", () => {
    expect(run([booking({ status: "completed" })]).initial).toHaveLength(1);
  });

  it("waits while the check-out is still ahead at the lot (literal wall clock vs local now)", () => {
    const r = run([
      booking({ checkOut: "2026-10-09T20:00:00" }), // NY is at 19:00
      booking({ checkOut: "2026-10-09T17:00:00", locationTimezone: "America/Los_Angeles", airportCode: "LAX" }), // LA is at 16:00
    ]);
    expect(r.initial).toEqual([]);
    expect(r.skipped.notCheckedOut).toBe(2);
  });

  it("uses the airport's zone when the booking has none", () => {
    const r = run([booking({ locationTimezone: null, airportCode: "LAX", checkOut: "2026-10-09T15:30:00" })]);
    expect(r.initial).toHaveLength(1);
  });

  it("with no zone at all, waits for the earliest US clock — never emails before check-out", () => {
    const r = run([booking({ locationTimezone: null, airportCode: "RESLAB", checkOut: "2026-10-09T18:00:00" })]);
    expect(r.initial).toEqual([]);
    expect(r.skipped.notCheckedOut).toBe(1);
  });

  it("never links the RESLAB placeholder airport", () => {
    const r = run([booking({ airportCode: "RESLAB" })]);
    expect(r.initial[0].airportCode).toBeNull();
  });

  it("covers today, yesterday and the day before; older trips are never emailed", () => {
    const r = run([
      booking({ checkOut: "2026-10-08T22:00:00" }),
      booking({ checkOut: "2026-10-07T09:00:00" }),
      booking({ checkOut: "2026-10-06T09:00:00" }),
    ]);
    expect(r.initial.map((c) => c.checkoutDate)).toEqual(["2026-10-07", "2026-10-08"]);
    expect(r.skipped.tooOldForInitial).toBe(1);
  });

  it.each([
    ["cancelled", "notReviewable"],
    ["refunded", "notReviewable"],
    ["payment_failed", "notReviewable"],
    ["disputed", "notReviewable"],
  ] as const)("skips a %s booking", (status, bucket) => {
    const r = run([booking({ status })]);
    expect(r.initial).toEqual([]);
    expect(r.skipped[bucket]).toBe(1);
  });

  it("skips a booking mid-cancellation, test-mode rows, test lots and missing emails", () => {
    const r = run([
      booking({ cancelState: "claimed" }),
      booking({ livemode: false }),
      booking({ reslabLocationId: 194 }),
      booking({ email: null }),
      booking({ email: "not-an-email" }),
      booking({ checkOut: "nonsense" }),
    ]);
    expect(r.initial).toEqual([]);
    expect(r.skipped).toMatchObject({ cancelling: 1, testMode: 1, testLot: 1, noEmail: 2, invalidCheckout: 1 });
  });

  it("treats a pre-034 row (livemode NULL) as live", () => {
    expect(run([booking({ livemode: null })]).initial).toHaveLength(1);
  });

  it("includes direct-lot bookings", () => {
    expect(run([booking({ reslabLocationId: null, directLotId: "42" })]).initial).toHaveLength(1);
  });

  it("is idempotent against the ledger: claimed = in flight, failed = never, retry = again", () => {
    const [a, b, c] = [booking(), booking(), booking()];
    const r = run(
      [a, b, c],
      [
        { bookingId: a.id, kind: "initial", status: "claimed", sentAt: null },
        { bookingId: b.id, kind: "initial", status: "failed", sentAt: null },
        { bookingId: c.id, kind: "initial", status: "retry", sentAt: null },
      ]
    );
    expect(r.initial.map((x) => x.bookingId)).toEqual([c.id]);
    expect(r.skipped).toMatchObject({ inFlight: 1, failed: 1 });
  });

  it("does not email a booking that already has a review", () => {
    const b = booking();
    const r = run([b], [], [b.id]);
    expect(r.initial).toEqual([]);
    expect(r.skipped.reviewed).toBe(1);
  });

  it("sends one email per address per run (oldest trip first)", () => {
    const r = run([
      booking({ email: "Same@Example.com", checkOut: "2026-10-09T08:00:00" }),
      booking({ email: "same@example.com", checkOut: "2026-10-08T08:00:00" }),
    ]);
    expect(r.initial).toHaveLength(1);
    expect(r.initial[0].checkoutDate).toBe("2026-10-08");
    expect(r.initial[0].email).toBe("same@example.com");
    expect(r.skipped.sameAddress).toBe(1);
  });
});

describe("reminder", () => {
  const threeDaysAgo = "2026-10-06T10:00:00";
  const sentLongAgo = new Date(NOW - 72 * HOUR).toISOString();

  it("goes once, 3 days after check-out, when the initial was sent ≥48h ago and there is no review", () => {
    const b = booking({ checkOut: threeDaysAgo });
    const r = run([b], [sent(b.id, "initial", sentLongAgo)]);
    expect(r.reminder.map((c) => [c.bookingId, c.kind])).toEqual([[b.id, "reminder"]]);
    expect(r.initial).toEqual([]);
  });

  it("never goes after a review", () => {
    const b = booking({ checkOut: threeDaysAgo });
    const r = run([b], [sent(b.id, "initial", sentLongAgo)], [b.id]);
    expect(r.reminder).toEqual([]);
    expect(r.skipped.reviewed).toBe(1);
  });

  it("never goes twice", () => {
    const b = booking({ checkOut: threeDaysAgo });
    const r = run([b], [sent(b.id, "initial", sentLongAgo), sent(b.id, "reminder", sentLongAgo)]);
    expect(r.reminder).toEqual([]);
    expect(r.skipped.alreadyReminded).toBe(1);
  });

  it("is retried when the reminder send was parked", () => {
    const b = booking({ checkOut: threeDaysAgo });
    const r = run(
      [b],
      [sent(b.id, "initial", sentLongAgo), { bookingId: b.id, kind: "reminder", status: "retry", sentAt: null }]
    );
    expect(r.reminder).toHaveLength(1);
  });

  it("is not due before day 3, nor within 48h of the initial", () => {
    const early = booking({ checkOut: "2026-10-07T10:00:00" });
    const lateInitial = booking({ checkOut: threeDaysAgo });
    const r = run(
      [early, lateInitial],
      [sent(early.id, "initial", sentLongAgo), sent(lateInitial.id, "initial", new Date(NOW - 24 * HOUR).toISOString())]
    );
    expect(r.reminder).toEqual([]);
    expect(r.skipped.reminderNotDue).toBe(2);
  });

  it("is dropped, not sent late, past day 5", () => {
    const b = booking({ checkOut: "2026-10-03T10:00:00" });
    const r = run([b], [sent(b.id, "initial", new Date(NOW - 6 * 24 * HOUR).toISOString())]);
    expect(r.reminder).toEqual([]);
    expect(r.skipped.tooOldForReminder).toBe(1);
  });

  it("never follows a permanently failed initial", () => {
    const b = booking({ checkOut: threeDaysAgo });
    const r = run([b], [{ bookingId: b.id, kind: "initial", status: "failed", sentAt: null }]);
    expect(r.reminder).toEqual([]);
    expect(r.skipped.failed).toBe(1);
  });

  it("is never sent for a booking that never got the initial", () => {
    const b = booking({ checkOut: threeDaysAgo });
    const r = run([b]);
    expect(r.reminder).toEqual([]);
    expect(r.initial).toEqual([]);
    expect(r.skipped.tooOldForInitial).toBe(1);
  });

  it("skips a booking cancelled after the initial went out", () => {
    const b = booking({ checkOut: threeDaysAgo, status: "refunded" });
    const r = run([b], [sent(b.id, "initial", sentLongAgo)]);
    expect(r.reminder).toEqual([]);
  });
});
