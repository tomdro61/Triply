/**
 * update-pi on a DIRECT-lot PaymentIntent (review: test-coverage I1). The route
 * is unchanged, but a refactor that rebuilt metadata from scratch would drop
 * the surcharge terms and make every direct booking fail its integrity check
 * at Pay. Pins: the amount moves with the tier, every direct key survives.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { stripeMock } = vi.hoisted(() => ({
  stripeMock: { paymentIntents: { retrieve: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/stripe/client", () => ({ stripe: stripeMock }));
vi.mock("@/lib/sentry", () => ({ capturePaymentError: vi.fn() }));

import { POST } from "../route";
import { getProtectionPlan, protectionMetadataPatch } from "@/lib/parkguard/plans";
import { directVehicleEstimate } from "@/lib/direct/vehicle-estimate";

const DIRECT_META = {
  inventorySource: "direct",
  lotId: "direct-1",
  directLotId: "1",
  directDays: "5",
  directTaxRatePercent: "16",
  directSurcharges: "small_suv:500,midsize_suv:700,large_suv_truck:1000",
  parkingOnlyChargeAmount: "63.66",
  parkingOnlyChargeAmountCents: "6366",
};

const post = (protectionPlanCode: string | null) =>
  POST(
    new NextRequest("http://localhost/api/checkout/lot/update-pi", {
      method: "POST",
      body: JSON.stringify({ paymentIntentId: "pi_d", protectionPlanCode }),
      headers: { "content-type": "application/json" },
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  stripeMock.paymentIntents.retrieve.mockResolvedValue({
    id: "pi_d",
    status: "requires_payment_method",
    amount: 7665,
    metadata: { ...DIRECT_META, ...protectionMetadataPatch(getProtectionPlan("A")!) },
  });
  stripeMock.paymentIntents.update.mockImplementation(async (_id: string, p: { amount: number; metadata: Record<string, string | null> }) => ({
    id: "pi_d",
    amount: p.amount,
    metadata: p.metadata,
  }));
});

describe("update-pi on a direct PaymentIntent", () => {
  it("Plan A → none: back to the parking-only 6366, every direct key kept, estimate still computable", async () => {
    const res = await post(null);
    expect(res.status).toBe(200);
    const [, params] = stripeMock.paymentIntents.update.mock.calls[0];
    expect(params.amount).toBe(6366);
    expect(params.metadata).toMatchObject(DIRECT_META);
    const meta = params.metadata as Record<string, string | undefined>;
    expect(directVehicleEstimate("large_suv_truck", meta)).toMatchObject({ ok: true, surchargeCents: 5000, surchargeTaxCents: 800 });
  });

  it("→ Plan B: 6366 + 799 = 7165, direct keys kept", async () => {
    await post("B");
    const [, params] = stripeMock.paymentIntents.update.mock.calls[0];
    expect(params.amount).toBe(7165);
    expect(params.metadata).toMatchObject({ ...DIRECT_META, protectionPlanCode: "B" });
  });
});
