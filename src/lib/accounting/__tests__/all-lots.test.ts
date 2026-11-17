import { describe, it, expect } from "vitest";
import { combinedTotal, directCsv, dollarsToCents } from "../all-lots";
import { csvEscape } from "@/lib/utils/csv";
import type { DirectBookingDetail } from "../types";

describe("dollarsToCents", () => {
  it.each([[12.34, 1234], [0.29, 29], [-1.81, -181], [0, 0], [1151.115, 115112], [-0.125, -13]])("%d → %i", (d, c) => expect(dollarsToCents(d)).toBe(c));
});

describe("combinedTotal", () => {
  const sum = (cents: number, known: number, of: number) => ({ cents, known, of });
  it("adds the two sides in cents", () => expect(combinedTotal(10000, sum(1029, 2, 2))).toEqual({ cents: 11029, missing: 0 }));
  it("a direct loss lowers the total", () => expect(combinedTotal(10000, sum(-181, 1, 1))).toEqual({ cents: 9819, missing: 0 }));
  it("no direct bookings: the ResLab figure alone", () => expect(combinedTotal(10000, sum(0, 0, 0))).toEqual({ cents: 10000, missing: 0 }));
  it("says how many direct bookings are not in it", () => expect(combinedTotal(10000, sum(1210, 1, 3))).toEqual({ cents: 11210, missing: 2 }));
  it("no total when the ResLab side is unknown", () => expect(combinedTotal(null, sum(1210, 1, 1))).toBeNull());
  it("no total when the direct figures were not worked out", () => expect(combinedTotal(10000, null)).toBeNull());
  it("no total when no direct booking of several has a figure (never the ResLab figure alone)", () => expect(combinedTotal(10000, sum(0, 0, 2))).toBeNull());
});

describe("directCsv", () => {
  const b = (o: Partial<DirectBookingDetail> = {}): DirectBookingDetail => ({
    reservationNumber: "TRP-AAAA1111", status: "refunded", checkIn: "2026-11-21 08:00:00", checkOut: "2026-11-30 21:30:00", lotName: "Lot, JFK",
    state: "ok", reason: null, receivedCents: 10983, refundedCents: 10983, owedToLotCents: 0, owedSource: "rule", stripeFeeCents: 349, grossCents: 0, netCents: -349, ...o,
  });
  it("writes a loss as a plain negative number and quotes text with a comma", () => {
    const [, line] = directCsv([b()], csvEscape).split("\n");
    expect(line).toBe('TRP-AAAA1111,refunded,2026-11-21 08:00:00,2026-11-30 21:30:00,"Lot, JFK",ok,,109.83,109.83,0.00,rule,3.49,0.00,-3.49');
  });
  it("unknown is an empty cell, never 0", () => {
    const [, line] = directCsv([b({ state: "not_read", reason: "payment not read from Stripe", receivedCents: null, refundedCents: null, owedToLotCents: null, owedSource: null, stripeFeeCents: null, grossCents: null, netCents: null })], csvEscape).split("\n");
    expect(line.endsWith(",not_read,payment not read from Stripe,,,,,,,")).toBe(true);
  });
  it("a reason that starts like a formula is neutralised", () => {
    const [, line] = directCsv([b({ reason: "=HYPERLINK(1)" })], csvEscape).split("\n");
    expect(line).toContain("'=HYPERLINK(1)");
  });
  it("header and one line per booking", () => {
    const lines = directCsv([b(), b({ reservationNumber: "TRP-BBBB2222" })], csvEscape).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0].split(",")).toHaveLength(14);
  });
});
