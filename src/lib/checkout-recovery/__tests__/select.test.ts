import { describe, it, expect } from "vitest";
import {
  literalWallClock,
  selectRecoveryCandidates,
  storedTripKey,
  tripFingerprintOf,
  type PaymentIntentLike,
} from "../select";

const NOW = Date.UTC(2026, 9, 7, 15, 0, 0); // 2026-10-07 15:00Z
const sec = (msAgo: number) => Math.floor((NOW - msAgo) / 1000);
const MIN = 60_000;

const trip = {
  lotId: "reslab-10",
  locationId: "10",
  checkin: "2026-10-20",
  checkout: "2026-10-22",
  checkinTime: "10:00 AM",
  checkoutTime: "6:00 PM",
};
const other = { ...trip, checkin: "2026-11-02", checkout: "2026-11-05" };

function pi(
  id: string,
  ageMin: number,
  metadata: Record<string, string>,
  status: PaymentIntentLike["status"] = "requires_payment_method"
): PaymentIntentLike {
  return { id, status, created: sec(ageMin * MIN), amount: 5000, livemode: true, metadata };
}

describe("selectRecoveryCandidates — the trip decides, not the email", () => {
  it("an abandoned PaymentIntent for a trip that reached payment on ANY other PaymentIntent is never a candidate", () => {
    const statuses: PaymentIntentLike["status"][] = [
      "succeeded",
      "requires_capture",
      "processing",
      "requires_action",
      "requires_confirmation",
      "canceled",
    ];
    for (const status of statuses) {
      const r = selectRecoveryCandidates(
        [
          pi("pi_left", 60, { ...trip, customerEmail: "a@example.com" }),
          // Different address, created EARLIER — order and email must not matter.
          pi("pi_other", 90, { ...trip, customerEmail: "b@example.com" }, status),
        ],
        NOW
      );
      expect(r.candidates, status).toEqual([]);
      expect(r.skipped.tripAttempted, status).toBe(1);
    }
  });

  it("two abandoned PaymentIntents for the same trip do not suppress each other", () => {
    const r = selectRecoveryCandidates(
      [
        pi("pi_1", 60, { ...trip, customerEmail: "a@example.com" }),
        pi("pi_2", 70, { ...trip, customerEmail: "b@example.com" }),
      ],
      NOW
    );
    expect(r.candidates.map((c) => c.email).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("a different trip by the same address, paid EARLIER, does not block; paid LATER does", () => {
    const earlier = selectRecoveryCandidates(
      [
        pi("pi_paid", 120, { ...other, customerEmail: "a@example.com" }, "succeeded"),
        pi("pi_left", 60, { ...trip, customerEmail: "a@example.com" }),
      ],
      NOW
    );
    expect(earlier.candidates.map((c) => c.paymentIntentId)).toEqual(["pi_left"]);

    const later = selectRecoveryCandidates(
      [
        pi("pi_left", 60, { ...trip, customerEmail: "a@example.com" }),
        pi("pi_paid", 50, { ...other, customerEmail: "A@Example.com" }, "requires_capture"),
      ],
      NOW
    );
    expect(later.candidates).toEqual([]);
    expect(later.skipped.paidSince).toBe(1);
  });

  it("a non-abandoned PaymentIntent with unreadable metadata cannot vouch for any trip", () => {
    const r = selectRecoveryCandidates(
      [
        pi("pi_left", 60, { ...trip, customerEmail: "a@example.com" }),
        pi("pi_junk", 50, { lotId: "reslab-10" }, "succeeded"),
      ],
      NOW
    );
    expect(r.candidates).toHaveLength(1);
  });

  it("carries the literal wall-clock strings the database stores, built by string formatting", () => {
    const [c] = selectRecoveryCandidates([pi("pi_left", 60, { ...trip, customerEmail: "a@example.com" })], NOW)
      .candidates;
    expect(c.fromDate).toBe("2026-10-20 10:00:00");
    expect(c.toDate).toBe("2026-10-22 18:00:00");
    expect(c.storedTrip).toBe("10|2026-10-20 10:00:00|2026-10-22 18:00:00");
    expect(c.trip).toBe(tripFingerprintOf(trip));
  });
});

describe("storedTripKey / literalWallClock", () => {
  it("matches a TIMESTAMP column rendered with a T to the TEXT column with a space", () => {
    const fromBookings = storedTripKey("10", "2026-10-20T10:00:00", "2026-10-22T18:00:00");
    const fromPending = storedTripKey(10, "2026-10-20 10:00:00", "2026-10-22 18:00:00");
    expect(fromBookings).toBe(fromPending);
    expect(fromBookings).toBe("10|2026-10-20 10:00:00|2026-10-22 18:00:00");
  });

  it("ignores fractional seconds and refuses anything shorter than a full wall clock", () => {
    expect(storedTripKey(10, "2026-10-20T10:00:00.000", "2026-10-22T18:00:00")).toBe(
      "10|2026-10-20 10:00:00|2026-10-22 18:00:00"
    );
    expect(storedTripKey(10, "2026-10-20", "2026-10-22 18:00:00")).toBeNull();
    expect(storedTripKey(10, null, "2026-10-22 18:00:00")).toBeNull();
  });

  it("12-hour edge cases: noon and midnight", () => {
    expect(literalWallClock("2026-10-20", "12:00 PM")).toBe("2026-10-20 12:00:00");
    expect(literalWallClock("2026-10-20", "12:30 AM")).toBe("2026-10-20 00:30:00");
    expect(literalWallClock("2026-10-20", "6:00 PM")).toBe("2026-10-20 18:00:00");
  });
});
