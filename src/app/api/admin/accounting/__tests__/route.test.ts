import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/** The `cadrate` query parameter: ResLab's CAD rate on an invoice. */

const m = vi.hoisted(() => ({
  reconcile: vi.fn(async (opts: unknown) => ({ options: opts })),
  user: { email: "admin@example.com" } as { email: string } | null,
}));

vi.mock("@/lib/accounting/reconcile", () => ({ reconcileRevenue: m.reconcile }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } })),
}));
vi.mock("@/config/admin", () => ({ isAdminEmail: (e: string | undefined) => e === "admin@example.com" }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));

import { GET } from "../route";

const get = (query: string) => GET(new NextRequest(`https://www.triplypro.com/api/admin/accounting?from=2026-12-01&to=2026-12-31&by=checkout${query}`));

beforeEach(() => {
  m.reconcile.mockClear();
  m.user = { email: "admin@example.com" };
});

describe("GET /api/admin/accounting — cadrate", () => {
  it("is not passed at all when absent (a US month's options are what they always were)", async () => {
    const res = await get("&invoice=100");
    expect(res.status).toBe(200);
    expect(m.reconcile).toHaveBeenCalledTimes(1);
    expect(m.reconcile.mock.calls[0][0]).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
      by: "checkout",
      invoiceAmount: 100,
      includeReslab: true,
      includeStripe: true,
      includeDirectDetail: false,
    });
    // toEqual would let an `invoiceCadRate: undefined` key through.
    expect(m.reconcile.mock.calls[0][0]).not.toHaveProperty("invoiceCadRate");
  });

  it("passes a rate through", async () => {
    await get("&cadrate=0.7215");
    expect(m.reconcile.mock.calls[0][0]).toMatchObject({ invoiceCadRate: 0.7215 });
  });

  it.each(["1.38", "0.5", "0.4", "0", "-0.72", "abc", "0.72e1", ".72", "0.1234567", "0.7234567", "0.72 ", ""])("refuses %j before any read", async (bad) => {
    const res = await get(`&cadrate=${encodeURIComponent(bad)}`);
    expect(res.status).toBe(400);
    expect(m.reconcile).not.toHaveBeenCalled();
  });

  it("a signed-out caller with a rate still gets 401", async () => {
    m.user = null;
    const res = await get("&cadrate=0.72");
    expect(res.status).toBe(401);
    expect(m.reconcile).not.toHaveBeenCalled();
  });
});
