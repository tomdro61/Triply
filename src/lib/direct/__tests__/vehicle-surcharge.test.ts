/**
 * Oversized-vehicle surcharge (plan notes/2026-10-09-direct-lots-vehicle-surcharge-plan.md):
 * the pure money function, the PaymentIntent-metadata codec (R5), the
 * metadata-only estimate the pending route uses, the strict store parse (R14),
 * the adapter, and the Preview-only checkout flag (R11).
 */
import { describe, it, expect } from "vitest";
import { getAirportByCode } from "@/config/airports";
import { computeVehicleSurcharge, computeDirectQuote, directDays } from "../pricing";
import {
  decodeSurchargeRates,
  decodeTaxRatePercent,
  encodeSurchargeRates,
  isEncodableTaxRatePercent,
  DIRECT_SURCHARGES_KEY,
  DIRECT_TAX_RATE_KEY,
} from "../vehicle-surcharge-metadata";
import { directVehicleEstimate } from "../vehicle-estimate";
import { directLotFromRow } from "../store";
import { directLotToUnified } from "../adapter";
import { isDirectCheckoutOpen } from "../flag";
import { directLotRow } from "./fixtures";

const LOT1 = [
  { code: "small_suv", dailyRateCents: 500 },
  { code: "midsize_suv", dailyRateCents: 700 },
  { code: "large_suv_truck", dailyRateCents: 1000 },
];

describe("computeVehicleSurcharge", () => {
  it("plan §2 worked example: 5 days, Large SUV / truck, 16 % → $50.00 + $8.00 = $58.00 at the lot", () => {
    expect(computeVehicleSurcharge({ days: 5, dailyRateCents: 1000, taxRatePercent: 16 })).toEqual({
      surchargeCents: 5000,
      surchargeTaxCents: 800,
      atLotCents: 5800,
    });
  });

  it("…while the online charge for the same stay is $63.66 (parking + tax + fee — no surcharge in it)", () => {
    const q = computeDirectQuote({ rateCents: 995, days: 5, taxRatePercent: 16 });
    expect(q.chargeCents).toBe(6366);
    expect(q.dueAtLocationCents).toBe(0);
  });

  it("'No oversized vehicle' (rate 0) is zero everywhere", () => {
    expect(computeVehicleSurcharge({ days: 3, dailyRateCents: 0, taxRatePercent: 16 })).toEqual({
      surchargeCents: 0,
      surchargeTaxCents: 0,
      atLotCents: 0,
    });
  });

  it("bills on the SAME days as the parking: 7 AM → 7 PM four days later is 5 billed days, not 4", () => {
    const d = directDays("2026-10-10 07:00:00", "2026-10-14 19:00:00");
    expect(d).toMatchObject({ ok: true, days: 5 });
    if (!d.ok) return;
    expect(computeVehicleSurcharge({ days: d.days, dailyRateCents: 500, taxRatePercent: 16 }).surchargeCents).toBe(2500);
  });

  it("rounds the tax to the cent like the parking tax (500 × 10.375 % = 51.875 → 52)", () => {
    expect(computeVehicleSurcharge({ days: 1, dailyRateCents: 500, taxRatePercent: 10.375 }).surchargeTaxCents).toBe(52);
  });

  it("refuses malformed input instead of guessing", () => {
    expect(() => computeVehicleSurcharge({ days: 0, dailyRateCents: 500, taxRatePercent: 16 })).toThrow();
    expect(() => computeVehicleSurcharge({ days: 2, dailyRateCents: 4.5, taxRatePercent: 16 })).toThrow();
    expect(() => computeVehicleSurcharge({ days: 2, dailyRateCents: 500, taxRatePercent: 101 })).toThrow();
  });
});

describe("surcharge metadata codec (R5)", () => {
  it("round-trips lot 1's rates inside Stripe's 500-char value limit", () => {
    const s = encodeSurchargeRates(LOT1);
    expect(s).toBe("small_suv:500,midsize_suv:700,large_suv_truck:1000");
    expect(decodeSurchargeRates(s)).toEqual(LOT1);
    const six = Array.from({ length: 6 }, (_, i) => ({ code: `${"x".repeat(30)}${i}`, dailyRateCents: 100000 }));
    expect(encodeSurchargeRates(six).length).toBeLessThanOrEqual(500);
  });

  it("'none' means the lot offers none — never '' (Stripe deletes a key sent empty); missing or '' is null (refuse)", () => {
    expect(encodeSurchargeRates([])).toBe("none");
    expect(decodeSurchargeRates("none")).toEqual([]);
    expect(decodeSurchargeRates(undefined)).toBeNull();
    expect(decodeSurchargeRates("")).toBeNull();
  });

  it("every encoded value is non-empty, so it survives Stripe's empty-value-unsets-the-key rule", () => {
    for (const rates of [[], LOT1, [LOT1[0]]]) expect(encodeSurchargeRates(rates)).not.toBe("");
  });

  it.each([
    ["small_suv", "no rate"],
    ["small_suv:0", "zero rate"],
    ["small_suv:0500", "leading zero"],
    ["small_suv:5.00", "dollars"],
    ["Small:500", "uppercase code"],
    ["none:500", "reserved code"],
    ["a:1,a:2", "duplicate code"],
    ["a:1,", "trailing comma"],
    ["a:1,b:1,c:1,d:1,e:1,f:1,g:1", "seven rows"],
  ])("rejects %s (%s)", (value) => {
    expect(decodeSurchargeRates(value)).toBeNull();
  });

  it("the encoder refuses what the decoder would refuse", () => {
    expect(() => encodeSurchargeRates([{ code: "none", dailyRateCents: 500 }])).toThrow();
    expect(() => encodeSurchargeRates([{ code: "a", dailyRateCents: 0 }])).toThrow();
  });

  it("tax rate: plain decimals only", () => {
    expect(decodeTaxRatePercent("16")).toBe(16);
    expect(decodeTaxRatePercent("10.375")).toBe(10.375);
    expect(decodeTaxRatePercent("0")).toBe(0);
    for (const bad of [undefined, "", "16%", "-1", "101", "1e1", " 16", "18.3755"]) expect(decodeTaxRatePercent(bad)).toBeNull();
  });
});

describe("directVehicleEstimate — from PaymentIntent metadata only", () => {
  const meta = {
    [DIRECT_SURCHARGES_KEY]: "small_suv:500,midsize_suv:700,large_suv_truck:1000",
    [DIRECT_TAX_RATE_KEY]: "16",
    directDays: "5",
  };

  it("computes the large-SUV estimate from the stamped terms", () => {
    expect(directVehicleEstimate("large_suv_truck", meta)).toEqual({
      ok: true,
      vehicleSize: "large_suv_truck",
      surchargeCents: 5000,
      surchargeTaxCents: 800,
    });
  });

  it("'none' is 0 / 0", () => {
    expect(directVehicleEstimate("none", meta)).toMatchObject({ ok: true, surchargeCents: 0, surchargeTaxCents: 0 });
  });

  it("a code this payment was not priced with is refused (the customer re-chooses)", () => {
    expect(directVehicleEstimate("bus", meta)).toEqual({ ok: false, reason: "unknown_size" });
  });

  it("missing or malformed terms are an integrity error — even for 'none'", () => {
    for (const drop of [DIRECT_SURCHARGES_KEY, DIRECT_TAX_RATE_KEY, "directDays"]) {
      const m: Record<string, string | undefined> = { ...meta, [drop]: undefined };
      expect(directVehicleEstimate("none", m)).toMatchObject({ ok: false, reason: "metadata" });
    }
    expect(directVehicleEstimate("none", { ...meta, directDays: "0" })).toMatchObject({ ok: false, reason: "metadata" });
  });
});

describe("store: vehicle_surcharges parse strictly (R14)", () => {
  it("lot 1's live rows become cents (9.95-style floats are rounded, not refused)", () => {
    const out = directLotFromRow(directLotRow({ vehicle_surcharges: [{ code: "small_suv", label: "Small SUV", dailyRate: 9.95 }] }));
    expect(out.lot?.vehicleSurcharges).toEqual([{ code: "small_suv", label: "Small SUV", dailyRateCents: 995 }]);
  });

  it("numeric strings (node-postgres) parse too", () => {
    const out = directLotFromRow(directLotRow({ vehicle_surcharges: [{ code: "a", label: "A", dailyRate: "7.00" }] }));
    expect(out.lot?.vehicleSurcharges[0].dailyRateCents).toBe(700);
  });

  it.each([
    ["duplicate code", [{ code: "a", label: "A", dailyRate: 1 }, { code: "a", label: "B", dailyRate: 2 }]],
    ["reserved 'none'", [{ code: "none", label: "None", dailyRate: 1 }]],
    ["zero rate", [{ code: "a", label: "A", dailyRate: 0 }]],
    ["blank label", [{ code: "a", label: "   ", dailyRate: 1 }]],
    ["bad code", [{ code: "Large-SUV", label: "A", dailyRate: 1 }]],
    ["extra key", [{ code: "a", label: "A", dailyRate: 1, id: "x" }]],
    ["seven rows", Array.from({ length: 7 }, (_, i) => ({ code: `c${i}`, label: "A", dailyRate: 1 }))],
    ["missing column", undefined],
  ])("a %s makes the lot UNREADABLE, never 'no surcharges'", (_name, rows) => {
    const out = directLotFromRow(directLotRow({ vehicle_surcharges: rows }));
    expect(out.lot).toBeNull();
    expect(out).toMatchObject({ kind: "invalid" });
  });

  it("an empty list is a lot with no surcharges", () => {
    expect(directLotFromRow(directLotRow({ vehicle_surcharges: [] })).lot?.vehicleSurcharges).toEqual([]);
  });
});

describe("adapter", () => {
  it("carries the surcharges (public data) and still no partner fields", () => {
    const out = directLotFromRow(directLotRow());
    if (!out.lot) throw new Error(out.reason);
    const u = directLotToUnified(out.lot, getAirportByCode("JFK")!, { fromDate: "2026-10-10 10:00:00", toDate: "2026-10-14 14:00:00" });
    expect(u.vehicleSurcharges).toEqual([
      { code: "small_suv", label: "Small SUV", dailyRateCents: 500 },
      { code: "midsize_suv", label: "Midsize SUV / minivan", dailyRateCents: 700 },
      { code: "large_suv_truck", label: "Large SUV / truck", dailyRateCents: 1000 },
    ]);
    // Paid at the lot — never folded into the booking's own price split.
    expect(u.dueAtLocation).toBe(false);
    expect(u.dueAtLocationAmount).toBe(0);
    expect(JSON.stringify(u)).not.toMatch(/notificationEmails|partnerShare/);
  });
});

describe("isDirectCheckoutOpen (R11) — an allowlist", () => {
  const env = (o: Record<string, string>) => ({ NODE_ENV: "production", ...o }) as NodeJS.ProcessEnv;
  it("is closed by default", () => {
    expect(isDirectCheckoutOpen(env({ VERCEL_ENV: "preview" }))).toBe(false);
  });
  it("opens on preview / staging / local development with DIRECT_CHECKOUT_PREVIEW=true", () => {
    expect(isDirectCheckoutOpen(env({ DIRECT_CHECKOUT_PREVIEW: "true", VERCEL_ENV: "preview" }))).toBe(true);
    expect(isDirectCheckoutOpen(env({ DIRECT_CHECKOUT_PREVIEW: "true", NEXT_PUBLIC_APP_ENV: "staging", VERCEL_ENV: "preview" }))).toBe(true);
    expect(isDirectCheckoutOpen(env({ DIRECT_CHECKOUT_PREVIEW: "true", NODE_ENV: "development" }))).toBe(true);
    expect(isDirectCheckoutOpen(env({ DIRECT_CHECKOUT_PREVIEW: " TRUE ", VERCEL_ENV: "preview" }))).toBe(true);
  });
  it("IGNORES the flag in production, by either signal", () => {
    expect(isDirectCheckoutOpen(env({ DIRECT_CHECKOUT_PREVIEW: "true", VERCEL_ENV: "production" }))).toBe(false);
    expect(isDirectCheckoutOpen(env({ DIRECT_CHECKOUT_PREVIEW: "true", NEXT_PUBLIC_APP_ENV: "production" }))).toBe(false);
    // A mislabelled app env never overrides Vercel's own production signal.
    expect(isDirectCheckoutOpen(env({ DIRECT_CHECKOUT_PREVIEW: "true", VERCEL_ENV: "production", NEXT_PUBLIC_APP_ENV: "staging" }))).toBe(false);
  });
  it("an UNKNOWN environment is closed (self-hosted next start, a typo)", () => {
    expect(isDirectCheckoutOpen(env({ DIRECT_CHECKOUT_PREVIEW: "true" }))).toBe(false);
    expect(isDirectCheckoutOpen(env({ DIRECT_CHECKOUT_PREVIEW: "true", NEXT_PUBLIC_APP_ENV: "prod" }))).toBe(false);
  });
  it("only 'true' opens it", () => {
    for (const v of ["1", "yes", "on", ""]) expect(isDirectCheckoutOpen(env({ DIRECT_CHECKOUT_PREVIEW: v, VERCEL_ENV: "preview" }))).toBe(false);
  });
});

describe("tax rate round trip (store refuses what metadata cannot carry)", () => {
  it.each([0, 8.875, 10.375, 16, 18.375, 30])("%s round-trips", (r) => {
    expect(isEncodableTaxRatePercent(r)).toBe(true);
    expect(decodeTaxRatePercent(String(r))).toBe(r);
  });
  it("a 4-decimal CMS rate makes the lot UNREADABLE (the bookings column keeps 3) — before any PaymentIntent", () => {
    expect(isEncodableTaxRatePercent(18.3755)).toBe(false);
    expect(isEncodableTaxRatePercent(8.87512)).toBe(false);
    const out = directLotFromRow(directLotRow({ tax_rate_percent: 18.3755 }));
    expect(out).toMatchObject({ lot: null, kind: "invalid" });
  });
});
