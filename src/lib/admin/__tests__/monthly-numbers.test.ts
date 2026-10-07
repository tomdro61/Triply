import { describe, it, expect } from "vitest";
import {
  bookingsByMonth,
  emailKey,
  lastNDays,
  lastNMonths,
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

  it("prefers cashTotal (after Stripe fees) and divides by confirmed", () => {
    const n = netTakeFrom(slice(10, 200, 176.7));
    expect(n).toMatchObject({ net: 176.7, basis: "cash", reason: null });
    expect(n.perBooking).toBeCloseTo(17.67, 10);
  });
  it("falls back to pre-Stripe total, flagged", () => {
    expect(netTakeFrom(slice(4, 100, null))).toMatchObject({ net: 100, perBooking: 25, basis: "pre-stripe" });
  });
  it("carries the reconciler's reason when there is no total", () => {
    expect(netTakeFrom(slice(4, null, null, "missing ResLab data for 1 of 4 confirmed bookings"))).toEqual({
      net: null,
      perBooking: null,
      basis: null,
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
