import { describe, it, expect } from "vitest";
import { triage, tripPhase, normalizeReservationNumber, canSelfCancel, type MatchedBooking } from "../triage";

// 2026-11-10 12:00 in New York (EST, UTC-5) = 17:00Z.
const NOW = Date.UTC(2026, 10, 10, 17, 0, 0);

function booking(checkIn: string, checkOut: string, over: Partial<MatchedBooking> = {}): MatchedBooking {
  return {
    id: "b1",
    reservationNumber: "TRP1234",
    status: "confirmed",
    checkIn,
    checkOut,
    timezone: "America/New_York",
    locationName: "Runway Park",
    locationAddress: "1 Airport Rd",
    airportCode: "EWR",
    ...over,
  };
}

const FUTURE = booking("2026-11-20 08:00:00", "2026-11-25 18:00:00"); // 10 days out
const SOON = booking("2026-11-11 06:00:00", "2026-11-14 18:00:00"); // in 18h
const ACTIVE = booking("2026-11-08 06:00:00", "2026-11-10 20:00:00"); // on the trip now
const PAST = booking("2026-11-01 06:00:00", "2026-11-05 18:00:00");

describe("normalizeReservationNumber", () => {
  it("upper-cases and strips spaces and #", () => {
    expect(normalizeReservationNumber(" #trp 12-34 ")).toBe("TRP12-34");
  });
  it("is null for nothing usable", () => {
    expect(normalizeReservationNumber("")).toBeNull();
    expect(normalizeReservationNumber(undefined)).toBeNull();
    expect(normalizeReservationNumber("ab")).toBeNull();
    expect(normalizeReservationNumber("TRP_1%")).toBeNull(); // never a LIKE wildcard
  });
});

describe("tripPhase — airport-local wall clock, never UTC-parsed", () => {
  it("places each booking", () => {
    expect(tripPhase(FUTURE, NOW)).toBe("future");
    expect(tripPhase(SOON, NOW)).toBe("within_24h");
    expect(tripPhase(ACTIVE, NOW)).toBe("active");
    expect(tripPhase(PAST, NOW)).toBe("past");
  });
  it("counts the 6 h after check-out as still on the trip (return shuttle)", () => {
    expect(tripPhase(booking("2026-11-08 06:00:00", "2026-11-10 07:00:00"), NOW)).toBe("active"); // out 5h ago
    expect(tripPhase(booking("2026-11-08 06:00:00", "2026-11-10 05:00:00"), NOW)).toBe("past"); // out 7h ago
  });
  it("window edges: exactly 24h before check-in, at check-in, at check-out + 6h", () => {
    // check-in 2026-11-11 12:00 NY = NOW + 24h exactly
    expect(tripPhase(booking("2026-11-11 12:00:00", "2026-11-12 12:00:00"), NOW)).toBe("within_24h");
    expect(tripPhase(booking("2026-11-10 12:00:00", "2026-11-12 12:00:00"), NOW)).toBe("active");
    expect(tripPhase(booking("2026-11-08 06:00:00", "2026-11-10 06:00:00"), NOW)).toBe("active"); // out + 6h == now
  });
  it("uses the lot's offset across the DST change (EDT check-in, EST now)", () => {
    // 2026-11-01 01:30 is the repeated hour; check-out 2026-11-02 10:00 EST is long before NOW.
    expect(tripPhase(booking("2026-11-01 01:30:00", "2026-11-02 10:00:00"), NOW)).toBe("past");
    // Pacific lot: 2026-11-11 09:30 PT = 17:30Z = NOW + 24h30m → still "future".
    expect(tripPhase(booking("2026-11-11 09:30:00", "2026-11-12 09:00:00", { timezone: "America/Los_Angeles" }), NOW)).toBe("future");
  });
  it("fractional seconds fail closed to unknown (pinned)", () => {
    expect(tripPhase(booking("2026-11-11 06:00:00.123", "2026-11-14 18:00:00"), NOW)).toBe("unknown");
  });
  it("is unknown without a timezone or with a bad timestamp", () => {
    expect(tripPhase({ ...FUTURE, timezone: null }, NOW)).toBe("unknown");
    expect(tripPhase({ ...FUTURE, checkIn: "2026-11-20T08:00:00Z" }, NOW)).toBe("unknown");
  });
});

describe("triage — priority", () => {
  const base = { message: "Hi there", selfCancelEnabled: true, now: NOW };

  it("a question about a future trip is normal", () => {
    const r = triage({ ...base, subject: "Booking Help", booking: FUTURE });
    expect(r.priority).toBe("normal");
    expect(r.reasons).toEqual([]);
  });

  it("anything from a customer on the trip, or checking in within 24h, is urgent", () => {
    expect(triage({ ...base, subject: "General Inquiry", booking: ACTIVE }).priority).toBe("urgent");
    expect(triage({ ...base, subject: "Booking Help", booking: SOON }).reasons).toContain("check-in within 24h");
  });

  it("cancelled, refunded, completed or NULL-status bookings are not 'on the trip'", () => {
    for (const status of ["cancelled", "refunded", "completed", null]) {
      expect(triage({ ...base, subject: "Booking Help", booking: { ...SOON, status } }).priority, String(status)).toBe("normal");
    }
  });

  it("Problem at the Lot is urgent even with no booking", () => {
    const r = triage({ ...base, subject: "Problem at the Lot", booking: null });
    expect(r.priority).toBe("urgent");
    expect(r.replyKind).toBe("at_lot");
  });

  it("strong words are urgent whatever the dates", () => {
    for (const msg of ["my car was towed", "I was charged twice!", "There's damage to my bumper", "double-charged", "I'm stranded at the airport"]) {
      expect(triage({ ...base, message: msg, subject: "General Inquiry", booking: PAST }).priority, msg).toBe("urgent");
    }
  });

  it("at-lot words raise to high without dates", () => {
    const r = triage({ ...base, message: "the shuttle never came", subject: "Other", booking: null });
    expect(r.priority).toBe("high");
    expect(r.reasons).toEqual(["shuttle"]);
  });

  it("does not fire on look-alike words", () => {
    expect(triage({ ...base, message: "Is there a towel? Damn good service", subject: "Feedback", booking: null }).priority).toBe("normal");
  });

  it("payment issues are high", () => {
    expect(triage({ ...base, subject: "Payment Issue", booking: FUTURE }).priority).toBe("high");
  });

  it("a partner inquiry is never escalated by keywords", () => {
    const r = triage({ ...base, message: "We run a shuttle and handle damage claims", subject: "Partnership Inquiry", booking: null });
    expect(r.priority).toBe("normal");
    expect(r.replyKind).toBe("partner");
  });
});

describe("triage — which instant reply", () => {
  const base = { message: "please cancel", now: NOW };

  it("cancellable + self-serve on → send them to cancel it themselves", () => {
    expect(triage({ ...base, subject: "Cancellation Request", booking: FUTURE, selfCancelEnabled: true }).replyKind).toBe("self_cancel");
  });

  it("self-serve off → the team handles it, as high", () => {
    const r = triage({ ...base, subject: "Cancellation Request", booking: FUTURE, selfCancelEnabled: false });
    expect(r.replyKind).toBe("cancel_support");
    expect(r.priority).toBe("high");
  });

  it("inside 24h → team handles it (and it's urgent: they're about to park)", () => {
    const r = triage({ ...base, subject: "Cancellation Request", booking: SOON, selfCancelEnabled: true });
    expect(r.replyKind).toBe("cancel_support");
    expect(r.priority).toBe("urgent");
  });

  it("refunded counts as already cancelled", () => {
    expect(
      triage({ ...base, subject: "Cancellation Request", booking: { ...FUTURE, status: "refunded" }, selfCancelEnabled: true }).replyKind
    ).toBe("already_cancelled");
  });

  it("already cancelled → say so", () => {
    expect(
      triage({ ...base, subject: "Cancellation Request", booking: { ...FUTURE, status: "cancelled" }, selfCancelEnabled: true }).replyKind
    ).toBe("already_cancelled");
  });

  it("no booking → cancel_support, normal", () => {
    const r = triage({ ...base, subject: "Cancellation Request", booking: null, selfCancelEnabled: true });
    expect(r.replyKind).toBe("cancel_support");
    expect(r.priority).toBe("normal");
  });

  it("booking help with a booking → details; on the trip → lot facts", () => {
    expect(triage({ ...base, subject: "Booking Help", booking: FUTURE, selfCancelEnabled: true }).replyKind).toBe("booking_details");
    expect(triage({ ...base, subject: "Booking Help", booking: ACTIVE, selfCancelEnabled: true }).replyKind).toBe("at_lot");
    expect(triage({ ...base, subject: "Booking Help", booking: null, selfCancelEnabled: true }).replyKind).toBe("generic");
  });

  it("change and payment keep their own replies even on the trip", () => {
    expect(triage({ ...base, subject: "Change My Reservation", booking: ACTIVE, selfCancelEnabled: true }).replyKind).toBe("change");
    expect(triage({ ...base, subject: "Payment Issue", booking: ACTIVE, selfCancelEnabled: true }).replyKind).toBe("payment");
  });
});

describe("canSelfCancel", () => {
  it("needs the flag, a confirmed booking and the 24h gate", () => {
    expect(canSelfCancel(FUTURE, true, NOW)).toBe(true);
    expect(canSelfCancel(FUTURE, false, NOW)).toBe(false);
    expect(canSelfCancel(SOON, true, NOW)).toBe(false);
    expect(canSelfCancel({ ...FUTURE, status: "cancelled" }, true, NOW)).toBe(false);
    expect(canSelfCancel(null, true, NOW)).toBe(false);
  });
});
