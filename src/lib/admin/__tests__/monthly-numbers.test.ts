import { describe, it, expect } from "vitest";
import {
  bookingsByMonth,
  emailKey,
  lastNDays,
  lastNMonths,
  literalMonthKey,
  bookingMonthKey,
  paidAfterWindow,
  lotsSeverity,
  monthKeyOf,
  netTakeFrom,
  accountingSliceSchema,
  type NumbersBookingRow,
} from "../monthly-numbers";
import { lotsPerAirport } from "../airport-lots";
import type { ReslabLocation } from "@/lib/reslab/client";

describe("lastNMonths", () => {
  it("returns 6 UTC months oldest first, current one partial", () => {
    const m = lastNMonths(new Date("2026-09-28T12:00:00Z"), 6);
    expect(m.map((x) => x.key)).toEqual([
      "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09",
    ]);
    expect(m[5]).toMatchObject({ from: "2026-09-01", to: "2026-09-30", label: "Sep 2026", partial: true });
    expect(m.filter((x) => x.partial)).toHaveLength(1);
  });

  it("crosses a year boundary and gets February right", () => {
    const m = lastNMonths(new Date("2028-02-10T00:00:00Z"), 3);
    expect(m.map((x) => [x.key, x.to])).toEqual([
      ["2027-12", "2027-12-31"],
      ["2028-01", "2028-01-31"],
      ["2028-02", "2028-02-29"], // leap year
    ]);
  });
});

describe("lastNDays", () => {
  it("ends today (UTC) and spans a month boundary", () => {
    expect(lastNDays(new Date("2026-10-02T23:59:00Z"), 3)).toEqual([
      "2026-09-30", "2026-10-01", "2026-10-02",
    ]);
  });
});

describe("monthKeyOf / emailKey", () => {
  it("buckets by UTC month", () => {
    expect(monthKeyOf("2026-08-31T23:30:00-04:00")).toBe("2026-09");
    expect(monthKeyOf("not a date")).toBeNull();
  });
  it("lowercases and trims; blank is no key", () => {
    expect(emailKey("  Jo@Example.COM ")).toBe("jo@example.com");
    expect(emailKey("")).toBeNull();
    expect(emailKey(null)).toBeNull();
  });
});

describe("bookingsByMonth", () => {
  const months = lastNMonths(new Date("2026-09-15T00:00:00Z"), 2); // Aug, Sep
  const row = (created_at: string, email: string | null, status = "confirmed"): NumbersBookingRow => ({
    created_at,
    email,
    status,
  });

  it("counts confirmed and refunded per month; ignores cancelled/other", () => {
    const out = bookingsByMonth(
      [
        row("2026-08-02T10:00:00Z", "a@x.com"),
        row("2026-08-03T10:00:00Z", "b@x.com", "refunded"),
        row("2026-08-04T10:00:00Z", "c@x.com", "cancelled"),
        row("2026-09-01T10:00:00Z", "d@x.com"),
      ],
      months
    );
    expect(out[0]).toMatchObject({ key: "2026-08", confirmed: 1, refunded: 1, paid: 2 });
    expect(out[1]).toMatchObject({ key: "2026-09", confirmed: 1, refunded: 0, paid: 1 });
  });

  it("matches repeats case-insensitively, using history before the window", () => {
    const out = bookingsByMonth(
      [
        row("2026-03-01T00:00:00Z", "Jo@X.com"), // outside the window, but seeds history
        row("2026-08-10T00:00:00Z", "jo@x.com"), // repeat (case differs)
        row("2026-08-11T00:00:00Z", "new@x.com"), // first time
        row("2026-08-20T00:00:00Z", "NEW@x.com "), // repeat within the same month
      ],
      months
    );
    expect(out[0]).toMatchObject({ paid: 3, repeat: 2 });
    expect(out[0].repeatRate).toBeCloseTo(2 / 3);
  });

  it("orders by time regardless of input order; cancelled bookings don't seed history", () => {
    const out = bookingsByMonth(
      [
        row("2026-09-05T00:00:00Z", "z@x.com"),
        row("2026-08-01T00:00:00Z", "z@x.com"),
        row("2026-07-01T00:00:00Z", "q@x.com", "cancelled"),
        row("2026-08-02T00:00:00Z", "q@x.com"),
      ],
      months
    );
    expect(out[0]).toMatchObject({ paid: 2, repeat: 0 });
    expect(out[1]).toMatchObject({ paid: 1, repeat: 1, repeatRate: 1 });
  });

  it("a refunded booking does NOT seed history (cancel-and-rebook is not a returning customer — same rule as the digest); no email is never a repeat", () => {
    const out = bookingsByMonth(
      [
        row("2026-08-01T00:00:00Z", "r@x.com", "refunded"),
        row("2026-08-02T00:00:00Z", "r@x.com"), // first CONFIRMED booking → not a repeat
        row("2026-08-03T00:00:00Z", "r@x.com", "refunded"), // repeat: a confirmed booking preceded it
        row("2026-08-04T00:00:00Z", null),
        row("2026-08-05T00:00:00Z", null),
      ],
      months
    );
    expect(out[0]).toMatchObject({ paid: 5, repeat: 1 });
  });

  it("files bookings under the trip month on the checkout axis using the LITERAL string, never Date math", () => {
    const rows: NumbersBookingRow[] = [
      // Booked in July, trip ends 31 Aug 23:30 airport-local — must stay in August
      // on every machine clock (a Date parse in UTC-anything would move it).
      { created_at: "2026-07-20T10:00:00Z", status: "confirmed", email: "a@x.com", check_in: "2026-08-28 10:00:00", check_out: "2026-08-31 23:30:00" },
      // Booked in August, trip ends in September → September on the checkout axis
      { created_at: "2026-08-25T10:00:00Z", status: "confirmed", email: "b@x.com", check_in: "2026-08-30 10:00:00", check_out: "2026-09-02 14:00:00" },
      // Legacy row with no check_out: unfilable on this axis, still counted on created
      { created_at: "2026-09-10T10:00:00Z", status: "confirmed", email: "c@x.com", check_in: null, check_out: null },
    ];
    const byCheckout = bookingsByMonth(rows, months, "checkout");
    expect(byCheckout[0]).toMatchObject({ key: "2026-08", confirmed: 1 });
    expect(byCheckout[1]).toMatchObject({ key: "2026-09", confirmed: 1 });
    const byCreated = bookingsByMonth(rows, months, "created");
    expect(byCreated[0]).toMatchObject({ key: "2026-08", confirmed: 1 }); // b
    expect(byCreated[1]).toMatchObject({ key: "2026-09", confirmed: 1 }); // c
    const byCheckin = bookingsByMonth(rows, months, "checkin");
    expect(byCheckin[0]).toMatchObject({ key: "2026-08", confirmed: 2 }); // a and b start in August
  });

  it("buckets trip months from the literal string even on a UTC+14 clock (Date math would move a 00:30 Sep 1 check-out into August)", () => {
    // Pins the "never Date math" rule where it would actually bite: on a UTC
    // runner a Date parse of the literal still lands in the right month, so
    // the test above cannot catch a regression to monthKeyOf(). Node re-reads
    // TZ at runtime; at UTC+14 a local "2026-09-01 00:30" is Aug 31 10:30 UTC,
    // so UTC-getter bucketing says August while the literal says September.
    const saved = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14
    try {
      // Sanity: under this clock, Date-based bucketing of the same literal is the WRONG month.
      expect(monthKeyOf("2026-09-01 00:30:00")).toBe("2026-08");
      expect(bookingMonthKey({ created_at: "2026-07-01T00:00:00Z", status: "confirmed", email: null, check_out: "2026-09-01 00:30:00" }, "checkout")).toBe("2026-09");
      expect(bookingMonthKey({ created_at: "2026-07-01T00:00:00Z", status: "confirmed", email: null, check_in: "2026-09-01T00:30:00" }, "checkin")).toBe("2026-09");
    } finally {
      if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved;
    }
  });

  it("counts paid bookings whose trip month is after the window (booked trips we would otherwise hide)", () => {
    const rows: NumbersBookingRow[] = [
      { created_at: "2026-09-10T10:00:00Z", status: "confirmed", email: "a@x.com", check_in: "2026-10-05 10:00:00", check_out: "2026-10-08 10:00:00" },
      { created_at: "2026-09-11T10:00:00Z", status: "confirmed", email: "b@x.com", check_in: "2026-09-29 10:00:00", check_out: "2026-10-02 10:00:00" },
      { created_at: "2026-09-12T10:00:00Z", status: "cancelled", email: "c@x.com", check_in: "2026-11-01 10:00:00", check_out: "2026-11-03 10:00:00" },
    ];
    expect(paidAfterWindow(rows, months, "checkout")).toBe(2); // a and b end in October, after the Aug–Sep window
    expect(paidAfterWindow(rows, months, "checkin")).toBe(1); // only a starts after September
    expect(paidAfterWindow(rows, months, "created")).toBe(0);
  });

  it("on a trip axis, repeat is still decided in booking order while the row is filed by its trip month", () => {
    const rows: NumbersBookingRow[] = [
      { created_at: "2026-08-01T10:00:00Z", status: "confirmed", email: "r@x.com", check_in: "2026-09-28 10:00:00", check_out: "2026-09-30 10:00:00" },
      { created_at: "2026-08-10T10:00:00Z", status: "confirmed", email: "r@x.com", check_in: "2026-08-14 10:00:00", check_out: "2026-08-15 10:00:00" },
    ];
    const out = bookingsByMonth(rows, months, "checkout");
    // B (booked Aug 10, after A) is the repeat and is filed in August by its trip; A is filed in September.
    expect(out[0]).toMatchObject({ key: "2026-08", paid: 1, repeat: 1 });
    expect(out[1]).toMatchObject({ key: "2026-09", paid: 1, repeat: 0 });
  });

  it("literalMonthKey reads the prefix only and rejects anything that is not a date", () => {
    expect(literalMonthKey("2026-10-31 23:00:00")).toBe("2026-10");
    expect(literalMonthKey("2026-10-01")).toBe("2026-10");
    expect(literalMonthKey("")).toBeNull();
    expect(literalMonthKey(null)).toBeNull();
    expect(literalMonthKey("Oct 31 2026")).toBeNull();
  });

  it("returns null repeat rate for a month with no paid bookings", () => {
    const out = bookingsByMonth([], months);
    expect(out.map((b) => b.repeatRate)).toEqual([null, null]);
  });
});

describe("netTakeFrom", () => {
  const slice = (confirmed: number, total: number | null, cashTotal: number | null, reason: string | null = null) =>
    accountingSliceSchema.parse({
      counts: { confirmed, refunded: 2 },
      triplyNet: { total, cashTotal, totalReason: reason, serviceFee: 1 },
    });

  it("carries BOTH of accounting's figures under its names: gross (headline) and cash (after Stripe); per booking = gross ÷ confirmed", () => {
    // 2026-10-07: the page led with the after-Stripe figure while
    // /admin/accounting's headline tile is the gross one — the two pages
    // disagreed on October by exactly the Stripe fees. Never again.
    const n = netTakeFrom(slice(10, 200, 176.7));
    expect(n).toMatchObject({ gross: 200, cash: 176.7, reason: null });
    expect(n.perBooking).toBeCloseTo(20, 10);
  });
  it("keeps gross when Stripe fee data is incomplete (cash null), never substitutes one for the other", () => {
    expect(netTakeFrom(slice(4, 100, null))).toMatchObject({ gross: 100, cash: null, perBooking: 25, reason: null });
  });
  it("carries the reconciler's reason when there is no total", () => {
    expect(netTakeFrom(slice(4, null, null, "missing ResLab data for 1 of 4 confirmed bookings"))).toEqual({
      gross: null,
      cash: null,
      perBooking: null,
      reason: "missing ResLab data for 1 of 4 confirmed bookings",
    });
  });
  it("no per-booking figure for a month with zero confirmed", () => {
    expect(netTakeFrom(slice(0, 12, 11)).perBooking).toBeNull();
  });
  it("rejects a response missing the fields it reads", () => {
    expect(accountingSliceSchema.safeParse({ counts: {} }).success).toBe(false);
  });
});

describe("lotsPerAirport", () => {
  const loc = (id: number, lat: number, lng: number): ReslabLocation =>
    ({ id, latitude: String(lat), longitude: String(lng) }) as ReslabLocation;
  const airports = [
    { code: "JFK", city: "New York", latitude: 40.6413, longitude: -73.7781 },
    { code: "SLC", city: "Salt Lake City", latitude: 40.7899, longitude: -111.9791 },
    { code: "MSP", city: "Minneapolis", latitude: 44.8848, longitude: -93.2223 },
  ];

  it("counts lots within 15 km, drops blocked ids, sorts fewest first", () => {
    const locations = [
      loc(1, 40.66, -73.8), // JFK ~3 km
      loc(2, 40.65, -73.79), // JFK
      loc(416, 40.65, -73.78), // JFK, blocked
      loc(3, 44.88, -93.2), // MSP
      loc(4, 41.2, -73.8), // ~60 km from JFK: out of radius
    ];
    const out = lotsPerAirport(locations as readonly ReslabLocation[], airports, new Set([416]));
    expect(out).toEqual([
      { code: "SLC", city: "Salt Lake City", lots: 0 },
      { code: "MSP", city: "Minneapolis", lots: 1 },
      { code: "JFK", city: "New York", lots: 2 },
    ]);
  });

  it("severity: 0 none, 1 thin, 2+ ok", () => {
    expect([0, 1, 2, 30].map(lotsSeverity)).toEqual(["none", "thin", "ok", "ok"]);
  });
});
