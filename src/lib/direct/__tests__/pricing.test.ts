import { describe, it, expect } from "vitest";
import { directDays, computeDirectQuote, wallClockMinutes } from "../pricing";
import { calculateServiceFee } from "@/lib/utils/service-fee";

describe("directDays — 24-hour periods from drop-off to pickup", () => {
  it.each([
    // The real RTL856901 case: the 7 AM → 7 PM change added a billed day.
    ["2026-10-02 11:30:00", "2026-10-05 07:00:00", 3],
    ["2026-10-02 11:30:00", "2026-10-05 19:00:00", 4],
    ["2026-10-02 11:30:00", "2026-10-05 11:30:00", 3], // exactly 72 h
    ["2026-10-02 11:30:00", "2026-10-05 11:31:00", 4], // one minute over
    ["2026-10-02 11:30:00", "2026-10-02 13:00:00", 1], // same day → 1 day minimum
    ["2026-10-02 23:00:00", "2026-10-03 01:00:00", 1], // crosses midnight, 2 h → 1 day
    ["2026-12-31 10:00", "2027-01-01 10:00", 1], // year boundary, HH:MM form
    ["2028-02-28 10:00:00", "2028-03-01 10:00:00", 2], // leap day counts
    // Wall-clock rule across the US fall-back night (Nov 1 2026): exactly 24 h on
    // the clock = 1 day, even though 25 real hours elapsed. Unverified vs ResLab.
    ["2026-11-01 00:30:00", "2026-11-02 00:30:00", 1],
  ])("%s → %s = %i day(s)", (a, b, days) => {
    const r = directDays(a, b);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.days).toBe(days);
  });

  it("reversed or zero-length ranges are errors, never 0 or 1 day", () => {
    expect(directDays("2026-10-05 07:00:00", "2026-10-02 11:30:00")).toEqual({ ok: false, reason: "checkout_not_after_checkin" });
    expect(directDays("2026-10-02 11:30:00", "2026-10-02 11:30:00")).toEqual({ ok: false, reason: "checkout_not_after_checkin" });
  });

  it("malformed or impossible datetimes are rejected", () => {
    expect(directDays("2026-10-02T11:30:00Z", "2026-10-05 07:00:00").ok).toBe(false);
    expect(directDays("2026-02-30 10:00:00", "2026-03-02 10:00:00").ok).toBe(false);
    expect(directDays("not a date", "2026-10-05 07:00:00").ok).toBe(false);
    expect(wallClockMinutes("2026-10-02 24:00:00")).toBeNull();
    expect(wallClockMinutes("2026-10-02 10:00:99")).toBeNull();
    expect(wallClockMinutes("2026-02-29 10:00:00")).toBeNull(); // not a leap year
    expect(wallClockMinutes("2028-02-29 10:00:00")).not.toBeNull();
  });
});

describe("computeDirectQuote — integer cents, ResLab column semantics", () => {
  it("4 days at $15.95 with 18.375 % tax", () => {
    const q = computeDirectQuote({ rateCents: 1595, days: 4, taxRatePercent: 18.375 });
    expect(q.subtotalCents).toBe(6380);
    expect(q.taxTotalCents).toBe(Math.round(6380 * 0.18375)); // 1172
    expect(q.grandTotalCents).toBe(6380 + 1172); // excludes the service fee
    expect(q.feesTotalCents).toBe(0);
    expect(q.dueAtLocationCents).toBe(0);
    expect(q.discountCents).toBe(0);
    // Same helper as every other quote: max($5.95, 6 %) of the parking base.
    expect(q.serviceFeeCents).toBe(Math.round(calculateServiceFee(63.8) * 100));
    expect(q.chargeCents).toBe(q.grandTotalCents + q.serviceFeeCents);
  });

  it("the service fee floor applies to a cheap stay", () => {
    const q = computeDirectQuote({ rateCents: 1000, days: 1, taxRatePercent: 0 });
    expect(q.serviceFeeCents).toBe(595);
    expect(q.chargeCents).toBe(1000 + 595);
  });

  it("a promo discount is a percentage of the parking subtotal and comes off the charge, not the stored grand_total", () => {
    const q = computeDirectQuote({ rateCents: 2000, days: 5, taxRatePercent: 10, discountPercent: 10 });
    expect(q.subtotalCents).toBe(10000);
    expect(q.taxTotalCents).toBe(1000);
    expect(q.grandTotalCents).toBe(11000);
    expect(q.discountCents).toBe(1000);
    expect(q.chargeCents).toBe(11000 - 1000 + q.serviceFeeCents);
  });

  it("a 100 % promo leaves tax + service fee on the charge", () => {
    const q = computeDirectQuote({ rateCents: 2000, days: 2, taxRatePercent: 10, discountPercent: 100 });
    expect(q.discountCents).toBe(4000);
    expect(q.chargeCents).toBe(400 + q.serviceFeeCents);
  });

  it("rounding never produces fractional cents", () => {
    const q = computeDirectQuote({ rateCents: 1999, days: 3, taxRatePercent: 8.875, discountPercent: 15 });
    for (const v of Object.values(q)) expect(Number.isInteger(v)).toBe(true);
  });

  it("refuses nonsense inputs instead of quoting $0", () => {
    expect(() => computeDirectQuote({ rateCents: 0, days: 1, taxRatePercent: 0 })).toThrow();
    expect(() => computeDirectQuote({ rateCents: 1000, days: 0, taxRatePercent: 0 })).toThrow();
    expect(() => computeDirectQuote({ rateCents: 10.5, days: 1, taxRatePercent: 0 })).toThrow();
    expect(() => computeDirectQuote({ rateCents: 1000, days: 1, taxRatePercent: 101 })).toThrow();
    expect(() => computeDirectQuote({ rateCents: 1000, days: 1, taxRatePercent: 0, discountPercent: -1 })).toThrow();
  });
});
