import { describe, it, expect } from "vitest";
import { buildCancellationReport, type CancellationReportRow } from "../report";

const row = (over: Partial<CancellationReportRow>): CancellationReportRow => ({
  status: "confirmed",
  created_at: "2026-07-10T12:00:00Z",
  location_name: "Lot A",
  cancellation_reason: null,
  cancelled_by: null,
  ...over,
});

describe("buildCancellationReport", () => {
  it("counts cancelled AND refunded as cancellations; excludes payment_failed from the base", () => {
    const r = buildCancellationReport([
      row({}),
      row({ status: "completed" }),
      row({ status: "cancelled" }),
      row({ status: "refunded" }),
      row({ status: "payment_failed" }),
    ]);
    expect(r.totals).toEqual({ bookings: 4, cancelled: 2, rate: 0.5 });
  });

  it("buckets by booking month, newest first, with a per-month reason split", () => {
    const r = buildCancellationReport([
      row({ created_at: "2026-06-01T00:00:00Z" }),
      row({ created_at: "2026-06-02T00:00:00Z", status: "refunded", cancellation_reason: "plans_changed" }),
      row({ created_at: "2026-07-01T00:00:00Z", status: "cancelled", cancellation_reason: "lot_turned_away" }),
    ]);
    expect(r.byMonth.map((m) => m.month)).toEqual(["2026-07", "2026-06"]);
    const june = r.byMonth[1];
    expect(june).toMatchObject({ bookings: 2, cancelled: 1, rate: 0.5 });
    expect(june.byReason.plans_changed).toBe(1);
    expect(june.byReason.lot_turned_away).toBe(0);
  });

  it("NULL and unrecognised reasons count as unknown (pre-032 rows)", () => {
    const r = buildCancellationReport([
      row({ status: "refunded" }),
      row({ status: "refunded", cancellation_reason: "bogus" }),
      row({ status: "cancelled", cancellation_reason: "found_cheaper", cancelled_by: "customer" }),
    ]);
    expect(r.byReason).toEqual([
      { reason: "unknown", count: 2 },
      { reason: "found_cheaper", count: 1 },
    ]);
    expect(r.byCancelledBy).toEqual([
      { by: "unknown", count: 2 },
      { by: "customer", count: 1 },
    ]);
  });

  it("per lot: rate over that lot's bookings, lot-fault = turned away + sold out, only lots with cancels", () => {
    const r = buildCancellationReport([
      row({ location_name: "Lot A" }),
      row({ location_name: "Lot A", status: "refunded", cancellation_reason: "lot_turned_away" }),
      row({ location_name: "Lot A", status: "refunded", cancellation_reason: "lot_sold_out" }),
      row({ location_name: "Lot A", status: "cancelled", cancellation_reason: "plans_changed" }),
      row({ location_name: "Lot B" }),
      row({ location_name: null, status: "cancelled" }),
    ]);
    expect(r.byLot).toEqual([
      { lot: "Lot A", bookings: 4, cancelled: 3, rate: 0.75, lotFault: 2 },
      { lot: "Unknown lot", bookings: 1, cancelled: 1, rate: 1, lotFault: 0 },
    ]);
  });

  it("empty input → zero rate, no division by zero", () => {
    const r = buildCancellationReport([]);
    expect(r.totals).toEqual({ bookings: 0, cancelled: 0, rate: 0 });
    expect(r.byMonth).toEqual([]);
  });
});
