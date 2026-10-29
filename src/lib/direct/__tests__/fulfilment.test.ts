import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/booking/reconciliation-alert", () => ({
  RECONCILIATION_ALERT_COLUMNS: "stripe_payment_intent_id, livemode, customer, location_name, airport_code, from_date, to_date, reslab_reservation_number, inventory_source",
  alertNeedsReconciliation: vi.fn(async () => ({ team: "discord", customer: "sent" })),
  scheduleReconciliationAlert: vi.fn(async () => undefined),
}));
import { directCartKey, directPayloadFromRow, directStaleness } from "../fulfilment";
import { fromSnapshot } from "@/lib/booking/fulfilled-reservation";
import { readDirectMetadataMoney } from "../metadata-money";
import { stripHtml } from "@/lib/reslab/client";
import { buildLotSnapshotV2 } from "../lot-snapshot-build";
import { directLotFromRow } from "../store";
import { directLotRow } from "./fixtures";

function snapshot(over: Record<string, unknown> = {}) {
  const out = directLotFromRow(directLotRow(over));
  if (!out.lot) throw new Error("fixture");
  return buildLotSnapshotV2(out.lot)!;
}

const row = (over: Record<string, unknown> = {}) => ({
  stripe_payment_intent_id: "pi_1",
  inventory_source: "direct",
  direct_lot_id: "1",
  lot_snapshot: snapshot(),
  from_date: "2026-10-20 10:00:00",
  to_date: "2026-10-25 10:00:00",
  customer: { firstName: "Ada", lastName: "L", email: "Ada@Example.com", phone: "5" },
  vehicle: { make: "a", model: "b", color: "c", licensePlate: "d", state: "NY" },
  vehicle_size: "none",
  vehicle_size_label: "No oversized vehicle",
  vehicle_surcharge_cents: 0,
  vehicle_surcharge_tax_cents: 0,
  vehicle_size_source: "modal",
  user_id: null,
  ...over,
});

describe("directPayloadFromRow", () => {
  it("accepts a staged row", () => {
    const r = directPayloadFromRow(row());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toMatchObject({ directLotId: 1, fromDate: "2026-10-20 10:00:00", vehicleSize: "none" });
  });
  it.each([
    ["a ResLab row", { inventory_source: "reslab" }],
    ["a v1 snapshot (carries notificationEmails)", { lot_snapshot: { ...snapshot(), v: 1, notificationEmails: ["a@b.com"] } }],
    ["a snapshot for another lot", { lot_snapshot: snapshot({ id: 2 }) }],
    ["an ISO date", { from_date: "2026-10-20T10:00:00Z" }],
    ["a negative surcharge", { vehicle_surcharge_cents: -1 }],
    ["a missing user_id column", { user_id: undefined }],
  ])("refuses %s", (_n, over) => {
    expect(directPayloadFromRow(row(over)).ok).toBe(false);
  });
});

describe("directCartKey", () => {
  it("is namespaced so it can never equal a ResLab key (CMS lot 1 vs ResLab location 1)", () => {
    const k = directCartKey({ customer: { email: " Ada@Example.com ", firstName: "", lastName: "", phone: "" }, directLotId: 1, fromDate: "a", toDate: "b" }, true);
    expect(k).toBe("live|ada@example.com|direct:1|a|b|direct");
  });
});

describe("directStaleness (airport zone, literal times)", () => {
  const base = { fromDate: "2026-10-20 10:00:00", toDate: "2026-10-25 10:00:00", timezone: "America/New_York" };
  const ms = (iso: string) => Date.parse(iso);
  it("ok before check-in", () => {
    expect(directStaleness({ ...base, authorizedAtMs: ms("2026-10-12T15:00:00Z"), nowMs: ms("2026-10-20T13:59:00Z") })).toEqual({ kind: "ok" });
  });
  it("late from check-in (10:00 EDT = 14:00 UTC)", () => {
    expect(directStaleness({ ...base, authorizedAtMs: ms("2026-10-12T15:00:00Z"), nowMs: ms("2026-10-20T14:00:00Z") })).toEqual({ kind: "late" });
  });
  it("release once check-out has passed", () => {
    expect(directStaleness({ ...base, authorizedAtMs: ms("2026-10-12T15:00:00Z"), nowMs: ms("2026-10-25T14:00:00Z") }).kind).toBe("release");
  });
  it("release when authorized after check-in", () => {
    expect(directStaleness({ ...base, authorizedAtMs: ms("2026-10-20T14:01:00Z"), nowMs: ms("2026-10-20T15:00:00Z") }).kind).toBe("release");
  });
  it("unknown on an invalid zone — never a guess", () => {
    expect(directStaleness({ ...base, timezone: "Mars/Olympus", authorizedAtMs: 0, nowMs: 0 }).kind).toBe("unknown");
  });
});

describe("fromSnapshot", () => {
  // Built through the checker — DirectMetadataMoney is branded and cannot be written by hand.
  const checked = readDirectMetadataMoney(
    {
      inventorySource: "direct", directLotId: "1", checkin: "2026-10-20", checkout: "2026-10-25",
      checkinTime: "10:00 AM", checkoutTime: "10:00 AM", parkingOnlyChargeAmountCents: "6366",
      directRateCents: "995", directDays: "5", directSubtotalCents: "4975", directTaxCents: "796",
      directGrandTotalCents: "5771", directDiscountCents: "0", directServiceFeeCents: "595", directTaxRatePercent: "16",
    },
    6366
  );
  if (!checked.ok) throw new Error(`fixture money: ${checked.detail}`);
  const money = checked.money;
  it("money from cents, dueAtLocation 0, the at-lot estimate kept apart", () => {
    const fr = fromSnapshot({
      number: "TRP-AAAA1111", directLotId: 1, snapshot: snapshot(), money, fromDate: "x", toDate: "y",
      vehicleSize: "large_suv_truck", vehicleSizeLabel: "Large SUV / truck", vehicleSurchargeCents: 5000, vehicleSurchargeTaxCents: 800,
    });
    expect(fr.money).toEqual({ subtotal: 49.75, taxTotal: 7.96, feesTotal: 0, grandTotal: 57.71, dueAtLocation: 0, serviceFee: 5.95, discount: 0, chargedOnline: 63.66 });
    expect(fr.atLot).toEqual({ vehicleSize: "large_suv_truck", vehicleSizeLabel: "Large SUV / truck", surchargeCents: 5000, surchargeTaxCents: 800 });
    expect(fr.location).toMatchObject({ reslabLocationId: null, directLotId: 1, stateCode: "NY", zip: "11413", timezone: "America/New_York" });
  });
  it("lot notes survive the callers' stripHtml intact (& and < are text, not markup)", () => {
    const s = snapshot({ booking_instructions: { beforeArrival: null, whenYouArrive: null, importantNotes: "- Cars & trucks <6ft only", whenYouReturn: null, gettingToAirport: null } });
    const fr = fromSnapshot({ number: "TRP-A", directLotId: 1, snapshot: s, money, fromDate: "x", toDate: "y", vehicleSize: "none", vehicleSizeLabel: "No", vehicleSurchargeCents: 0, vehicleSurchargeTaxCents: 0 });
    expect(stripHtml(fr.location.specialConditionsHtml ?? null)).toBe("- Cars & trucks <6ft only");
  });
});
