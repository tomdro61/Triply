/**
 * quoteDirectCheckout — the one place a direct-lot checkout is validated and
 * priced (GET and POST /api/checkout/lot both use it). Lead time is judged in
 * the AIRPORT's wall clock; booking times are never converted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("../store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../store")>()),
  fetchDirectLot: lookup,
}));

import { quoteDirectCheckout } from "../checkout-quote";
import { directLotFromRow, type DirectLot } from "../store";
import { directLotRow } from "./fixtures";

const lot = (over: Record<string, unknown> = {}): DirectLot => {
  const out = directLotFromRow(directLotRow({ tax_rate_percent: 16, ...over }));
  if (!out.lot) throw new Error(out.reason);
  return out.lot;
};
const quote = (fromDate: string, toDate: string, discountPercent = 0) =>
  quoteDirectCheckout({ payloadId: 1, fromDate, toDate, discountPercent, endpoint: "test" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 2026-10-09 12:00 in New York (EDT, UTC-4).
  vi.setSystemTime(new Date("2026-10-09T16:00:00Z"));
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging"); // the fixture lot is staging_only
  lookup.mockResolvedValue({ status: "found", lot: lot() });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("quoteDirectCheckout", () => {
  it("prices 5 billed days at $9.95 + 16 % + the $5.95 minimum fee = $63.66", async () => {
    const r = await quote("2026-10-10 10:00:00", "2026-10-15 10:00:00");
    expect(r).toMatchObject({ ok: true, days: 5, quote: { subtotalCents: 4975, taxTotalCents: 796, serviceFeeCents: 595, chargeCents: 6366 } });
  });

  it("applies a promo to the subtotal, like the ResLab branch", async () => {
    const r = await quote("2026-10-10 10:00:00", "2026-10-15 10:00:00", 10);
    expect(r).toMatchObject({ ok: true, quote: { discountCents: 498, chargeCents: 6366 - 498 } });
  });

  it("refuses inside the lot's 2-hour notice period, judged in the airport's clock", async () => {
    // Now is 12:00 at JFK: 13:30 is inside 2 h; 14:00 is not.
    expect(await quote("2026-10-09 13:30:00", "2026-10-11 13:30:00")).toMatchObject({ ok: false, status: 400, code: "inside_notice_period" });
    expect(await quote("2026-10-09 14:00:00", "2026-10-11 14:00:00")).toMatchObject({ ok: true });
  });

  it("refuses a past drop-off even with no notice period configured", async () => {
    lookup.mockResolvedValue({ status: "found", lot: lot({ min_lead_hours: 0 }) });
    expect(await quote("2026-10-09 11:00:00", "2026-10-11 11:00:00")).toMatchObject({ ok: false, code: "inside_notice_period" });
  });

  it("across midnight: absolute minutes, never mod 24 (23:00 at JFK, 2 h notice)", async () => {
    vi.setSystemTime(new Date("2026-10-10T03:00:00Z")); // 23:00 Oct 9 EDT
    expect(await quote("2026-10-10 00:30:00", "2026-10-12 00:30:00")).toMatchObject({ ok: false, code: "inside_notice_period" });
    expect(await quote("2026-10-10 01:00:00", "2026-10-12 01:00:00")).toMatchObject({ ok: true });
  });

  it("uses the AIRPORT's date, not UTC's (UTC is already Oct 10 at 22:30 EDT)", async () => {
    vi.setSystemTime(new Date("2026-10-10T02:30:00Z")); // 22:30 Oct 9 EDT
    expect(await quote("2026-10-09 23:30:00", "2026-10-11 23:30:00")).toMatchObject({ ok: false, code: "inside_notice_period" });
    expect(await quote("2026-10-10 00:30:00", "2026-10-12 00:30:00")).toMatchObject({ ok: true });
    expect(await quote("2026-10-08 10:00:00", "2026-10-11 10:00:00")).toMatchObject({ ok: false, code: "inside_notice_period" });
  });

  it("refuses below the minimum stay", async () => {
    lookup.mockResolvedValue({ status: "found", lot: lot({ min_stay_days: 3 }) });
    expect(await quote("2026-10-10 10:00:00", "2026-10-12 10:00:00")).toMatchObject({ ok: false, status: 400, code: "below_min_stay" });
  });

  it("refuses a reversed range", async () => {
    expect(await quote("2026-10-12 10:00:00", "2026-10-10 10:00:00")).toMatchObject({ ok: false, status: 400 });
  });

  it("a lot that is not sellable here is 404 (production cannot see a staging_only lot)", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    expect(await quote("2026-10-10 10:00:00", "2026-10-15 10:00:00")).toMatchObject({ ok: false, status: 404 });
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
    lookup.mockResolvedValue({ status: "found", lot: lot({ is_active: false }) });
    expect(await quote("2026-10-10 10:00:00", "2026-10-15 10:00:00")).toMatchObject({ ok: false, status: 404 });
  });

  it("an unreadable or broken lot is 503, never 404", async () => {
    lookup.mockResolvedValue({ status: "unavailable", kind: "timeout", message: "x" });
    expect(await quote("2026-10-10 10:00:00", "2026-10-15 10:00:00")).toMatchObject({ ok: false, status: 503 });
    lookup.mockResolvedValue({ status: "invalid", reason: "x" });
    expect(await quote("2026-10-10 10:00:00", "2026-10-15 10:00:00")).toMatchObject({ ok: false, status: 503 });
  });
});
