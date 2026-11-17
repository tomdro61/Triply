import { describe, expect, it } from "vitest";
import {
  FX_KEYS,
  cadCentsToUsdCents,
  currentCadRate,
  fxStampMetadata,
  isUsableRate,
  rateFromColumn,
  rateToColumn,
  readFxStamp,
  toUsd,
  type FxRate,
  type ReslabMoneyParts,
} from "../cad-usd";

const RATE: FxRate = { id: "t1", micros: 725_000 };
const parts = (p: Partial<ReslabMoneyParts> = {}): ReslabMoneyParts => ({
  subtotal: 107.55,
  feesTotal: 5.38,
  taxTotal: 12.88,
  longTermDiscount: 0,
  grandTotal: 125.81,
  dueAtLocation: 0,
  ...p,
});

describe("isUsableRate", () => {
  it("accepts a sane rate", () => expect(isUsableRate(RATE)).toBe(true));
  it.each([
    ["inverted (USD→CAD)", { id: "x", micros: 1_380_000 }],
    ["exactly 1", { id: "x", micros: 1_000_000 }],
    ["exactly 0.5", { id: "x", micros: 500_000 }],
    ["zero", { id: "x", micros: 0 }],
    ["fractional micros", { id: "x", micros: 725_000.5 }],
    ["NaN", { id: "x", micros: NaN }],
    ["no id", { id: "", micros: 725_000 }],
    ["null", null],
  ])("refuses %s", (_n, rate) => expect(isUsableRate(rate)).toBe(false));
});

describe("currentCadRate", () => {
  const setting = { id: "r1", micros: 725_000, validUntil: "2026-12-31" };
  it("returns the rate on its last valid day", () => {
    expect(currentCadRate(new Date("2026-12-31T23:59:59Z"), setting)).toEqual({ id: "r1", micros: 725_000 });
  });
  it("returns null the day after", () => {
    expect(currentCadRate(new Date("2027-01-01T00:00:00Z"), setting)).toBeNull();
  });
  it("returns null for an insane rate or a malformed date", () => {
    expect(currentCadRate(new Date("2026-06-01T00:00:00Z"), { ...setting, micros: 1_400_000 })).toBeNull();
    expect(currentCadRate(new Date("2026-06-01T00:00:00Z"), { ...setting, validUntil: "soon" })).toBeNull();
  });
  it("is not set yet: Canadian lots stay hidden", () => {
    expect(currentCadRate(new Date("2026-11-17T12:00:00Z"))).toBeNull();
  });
});

describe("cadCentsToUsdCents", () => {
  it("rounds half up", () => {
    expect(cadCentsToUsdCents(2, { id: "x", micros: 750_000 })).toBe(2); // 1.5 → 2
    expect(cadCentsToUsdCents(1, { id: "x", micros: 750_000 })).toBe(1); // 0.75 → 1
    expect(cadCentsToUsdCents(1, { id: "x", micros: 510_000 })).toBe(1); // 0.51 → 1
    expect(cadCentsToUsdCents(10_000, RATE)).toBe(7_250);
    expect(cadCentsToUsdCents(0, RATE)).toBe(0);
  });
  it.each([[-1], [1.5], [NaN], [Number.MAX_SAFE_INTEGER]])("refuses %s", (c) => {
    expect(cadCentsToUsdCents(c, RATE)).toBeNull();
  });
  it("refuses a bad rate", () => expect(cadCentsToUsdCents(100, { id: "x", micros: 1_380_000 })).toBeNull());
});

describe("toUsd", () => {
  it("converts each part and derives the total from them", () => {
    const r = toUsd(parts(), RATE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 10755 → 7797.375 → 7797; 538 → 390.05 → 390; 1288 → 933.8 → 934
    expect(r.usdCents).toEqual({ subtotal: 7797, feesTotal: 390, taxTotal: 934, longTermDiscount: 0, grandTotal: 9121, dueAtLocation: 0 });
    expect(r.usd.grandTotal).toBe(91.21);
    expect(r.cadGrandTotalCents).toBe(12581);
  });

  it("the derived total, not the converted CAD total, is what holds the sum (they can differ by a cent)", () => {
    // 12581 × 0.725 = 9121.225 → 9121 here; the property test below covers the cases that differ.
    const r = toUsd(parts(), RATE);
    if (!r.ok) throw new Error("unusable");
    const c = r.usdCents;
    expect(c.subtotal + c.feesTotal - c.longTermDiscount + c.taxTotal).toBe(c.grandTotal);
  });

  it("handles a long-stay discount and a pay-at-lot share", () => {
    const r = toUsd(parts({ subtotal: 200, feesTotal: 10, taxTotal: 26, longTermDiscount: 20, grandTotal: 216, dueAtLocation: 50 }), RATE);
    expect(r.ok && r.usdCents).toEqual({ subtotal: 14500, feesTotal: 725, taxTotal: 1885, longTermDiscount: 1450, grandTotal: 15660, dueAtLocation: 3625 });
  });

  it("refuses parts that do not add up to the total, by one cent either way", () => {
    expect(toUsd(parts({ grandTotal: 125.82 }), RATE)).toEqual({ ok: false, reason: "parts_do_not_add_up" });
    expect(toUsd(parts({ grandTotal: 125.8 }), RATE)).toEqual({ ok: false, reason: "parts_do_not_add_up" });
  });

  it("refuses a pay-at-lot amount above the total instead of capping it", () => {
    expect(toUsd(parts({ dueAtLocation: 125.82 }), RATE)).toEqual({ ok: false, reason: "due_above_total" });
    expect(toUsd(parts({ dueAtLocation: 125.81 }), RATE).ok).toBe(true);
  });

  it.each([
    ["negative", { taxTotal: -1 }],
    ["NaN", { subtotal: NaN }],
    ["three decimals", { feesTotal: 5.381 }],
    ["a string", { grandTotal: "125.81" as unknown as number }],
    ["missing", { dueAtLocation: undefined as unknown as number }],
  ])("refuses a %s amount", (_n, bad) => {
    expect(toUsd(parts(bad), RATE)).toEqual({ ok: false, reason: "bad_amount" });
  });

  it("refuses a bad rate and never throws on junk", () => {
    expect(toUsd(parts(), { id: "x", micros: 1_380_000 })).toEqual({ ok: false, reason: "bad_rate" });
    expect(toUsd(null as unknown as ReslabMoneyParts, RATE)).toEqual({ ok: false, reason: "bad_amount" });
    expect(toUsd(undefined as unknown as ReslabMoneyParts, null as unknown as FxRate)).toEqual({ ok: false, reason: "bad_rate" });
  });

  it("property: for any CAD price that adds up, the USD parts add up exactly, nothing is negative, due ≤ total", () => {
    let seed = 20261117;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let usable = 0;
    for (let i = 0; i < 20_000; i++) {
      const sub = rnd(300_000);
      const fees = rnd(20_000);
      const tax = rnd(50_000);
      const ltd = rnd(4) === 0 ? rnd(sub + 1) : 0;
      const grand = sub + fees - ltd + tax;
      const due = rnd(3) === 0 ? rnd(grand + 1) : 0;
      const rate = { id: "p", micros: 500_001 + rnd(499_998) };
      const r = toUsd(
        { subtotal: sub / 100, feesTotal: fees / 100, taxTotal: tax / 100, longTermDiscount: ltd / 100, grandTotal: grand / 100, dueAtLocation: due / 100 },
        rate
      );
      if (!r.ok) {
        // Only the rounding edge may refuse a price that added up in CAD.
        expect(r.reason).toBe("due_above_total");
        continue;
      }
      usable++;
      const c = r.usdCents;
      expect(c.subtotal + c.feesTotal - c.longTermDiscount + c.taxTotal).toBe(c.grandTotal);
      for (const v of Object.values(c)) expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
      expect(c.dueAtLocation).toBeLessThanOrEqual(c.grandTotal);
      // The derived total is within 2 cents of converting the CAD total directly (four rounded parts).
      const direct = cadCentsToUsdCents(grand, rate) ?? -99;
      expect(Math.abs(c.grandTotal - direct)).toBeLessThanOrEqual(2);
      // Dollars are the cents, exactly.
      expect(Math.round(r.usd.grandTotal * 100)).toBe(c.grandTotal);
    }
    expect(usable).toBeGreaterThan(19_000);
  });
});

describe("the PaymentIntent stamp", () => {
  it("round-trips a CAD rate and a US lot", () => {
    expect(readFxStamp(fxStampMetadata(RATE))).toEqual({ kind: "cad", rate: RATE });
    expect(readFxStamp(fxStampMetadata(null))).toEqual({ kind: "usd" });
    expect(fxStampMetadata(null)).toEqual({ reslabCurrency: "USD" });
  });
  it("no stamp at all is 'absent' (a PaymentIntent from before the stamp)", () => {
    expect(readFxStamp({ lotId: "reslab-1" })).toEqual({ kind: "absent" });
    expect(readFxStamp(null)).toEqual({ kind: "absent" });
  });
  it.each([
    ["a third currency", { [FX_KEYS.currency]: "EUR" }],
    ["CAD with no rate", { [FX_KEYS.currency]: "CAD", [FX_KEYS.rateId]: "r" }],
    ["CAD with no rate id", { [FX_KEYS.currency]: "CAD", [FX_KEYS.rateMicros]: "725000" }],
    ["CAD with an inverted rate", { [FX_KEYS.currency]: "CAD", [FX_KEYS.rateId]: "r", [FX_KEYS.rateMicros]: "1380000" }],
    ["CAD with a decimal rate", { [FX_KEYS.currency]: "CAD", [FX_KEYS.rateId]: "r", [FX_KEYS.rateMicros]: "0.7250" }],
    ["USD carrying a rate", { [FX_KEYS.currency]: "USD", [FX_KEYS.rateId]: "r", [FX_KEYS.rateMicros]: "725000" }],
    ["a rate with no currency", { [FX_KEYS.rateId]: "r", [FX_KEYS.rateMicros]: "725000" }],
    ["lower-case currency", { [FX_KEYS.currency]: "cad", [FX_KEYS.rateId]: "r", [FX_KEYS.rateMicros]: "725000" }],
  ])("%s is 'invalid', never guessed", (_n, md) => {
    expect(readFxStamp(md)).toEqual({ kind: "invalid" });
  });
});

describe("the bookings.fx_rate column", () => {
  it("round-trips exactly, as a string or as the number the driver may return", () => {
    expect(rateToColumn(RATE)).toBe("0.725000");
    expect(rateFromColumn("0.725000")).toEqual({ id: "booking", micros: 725_000 });
    expect(rateFromColumn(0.725)).toEqual({ id: "booking", micros: 725_000 });
    expect(rateFromColumn("0.7251")).toEqual({ id: "booking", micros: 725_100 });
    const odd = { id: "x", micros: 712_345 };
    expect(rateFromColumn(rateToColumn(odd))?.micros).toBe(712_345);
  });
  it.each([[null], [undefined], [""], ["1.000000"], ["1.38"], ["0.7250001"], ["abc"], [1], ["0.4"]])("refuses %s", (v) => {
    expect(rateFromColumn(v)).toBeNull();
  });
});
