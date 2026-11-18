import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReconcileOptions } from "../types";

/**
 * The whole reconcile result for a US-dollar month, captured from `main`
 * BEFORE accounting learned about Canadian-dollar reservations. Currency work
 * must never update this snapshot: a change here means a US month's figures
 * changed. Keys added to the result since are removed by `usView` below, and
 * each is asserted empty for a US month first.
 */

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  pis: new Map<string, unknown>(),
  reservations: new Map<string, unknown>(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(async () => {
    const builder: Record<string, unknown> = {};
    for (const m of ["from", "select", "gte", "lte", "order"]) builder[m] = () => builder;
    builder.returns = () => Promise.resolve({ data: h.rows, error: null });
    return builder;
  }),
}));

vi.mock("@/lib/stripe/client", () => ({
  stripe: {
    paymentIntents: {
      retrieve: vi.fn(async (id: string) => {
        const pi = h.pis.get(id);
        if (pi === undefined) {
          const err = new Error(`No such payment_intent: ${id}`) as Error & { code: string };
          err.code = "resource_missing";
          throw err;
        }
        return pi;
      }),
    },
  },
}));

import { reconcileRevenue } from "../reconcile";

const OPTS: ReconcileOptions = {
  from: "2026-07-01",
  to: "2026-07-31",
  by: "checkout",
  invoiceAmount: 250,
  includeReslab: true,
  includeStripe: true,
};

function row(resNum: string, over: Record<string, unknown> = {}) {
  h.rows.push({
    id: `id-${resNum}`,
    reslab_reservation_number: resNum,
    status: "confirmed",
    created_at: "2026-07-10T12:00:00Z",
    check_in: "2026-07-20 10:00:00",
    check_out: "2026-07-25 10:00:00",
    grand_total: 100,
    subtotal: 80,
    due_at_location: 0,
    triply_service_fee: 5.95,
    service_fee_refunded: false,
    protection_plan: null,
    protection_plan_price: 0,
    protection_plan_wholesale: null,
    pg_identifier: null,
    stripe_payment_intent_id: `pi_${resNum}`,
    reslab_location_id: 100,
    location_name: "Lot A",
    airport_code: "JFK",
    inventory_source: "reslab",
    direct_lot_id: null,
    livemode: true,
    discount_amount: 0,
    customers: { email: "a@example.com" },
    ...over,
  });
}

function pi(resNum: string, received: number, refunded = 0, metadata: Record<string, string> = {}) {
  h.pis.set(`pi_${resNum}`, {
    amount_received: received,
    latest_charge: { amount_refunded: refunded, balance_transaction: { fee: Math.round(received * 0.029) + 30 } },
    status: "succeeded",
    metadata,
  });
}

function reservation(resNum: string, history: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  h.reservations.set(resNum, { cancelled: 0, history: [history], ...extra });
}

const HISTORY = {
  location_total: 82,
  due_at_location_total: 0,
  channel_total: 18,
  commissions_total: 64,
  grand_total: 100,
  subtotal: 80,
  total_fees: 12,
  total_tax: 8,
  refund_amount: 0,
  partial_refund: 0,
  fees: [
    { fee_type: "location_fee", dollar_amount: 8 },
    { fee_type: "channel_fee", dollar_amount: 4 },
  ],
};
const USD = { location: { currency: { code: "USD" } } };

function usMonth() {
  // 1. Plain confirmed, ResLab states USD.
  row("US1");
  pi("US1", 10595);
  reservation("US1", { ...HISTORY, ...USD });
  // 2. Confirmed with Park Guard; ResLab gives no currency (older shape); string amounts.
  row("US2", { protection_plan: "Plan A", protection_plan_price: 12.99, protection_plan_wholesale: 6, pg_identifier: "pg2" });
  pi("US2", 11894);
  reservation("US2", { ...HISTORY, location_total: "82.00", channel_total: "18.00" });
  // 3. Confirmed, part due at the lot, with a stamped promo discount.
  row("US3", { grand_total: 120, subtotal: 100, due_at_location: 20, discount_amount: 5 });
  pi("US3", 10095, 0, { discountCents: "500" });
  reservation("US3", { ...HISTORY, ...USD, grand_total: 120, subtotal: 100, location_total: 98, due_at_location_total: 20, channel_total: 22 });
  // 4. Refunded, fee kept.
  row("US4", { status: "refunded" });
  pi("US4", 10595, 10000);
  reservation("US4", { ...HISTORY, ...USD, grand_total: 0, location_total: 0, channel_total: 0 }, { cancelled: 1 });
  // 5. Refunded in full, with Park Guard.
  row("US5", { status: "refunded", service_fee_refunded: true, protection_plan: "Plan B", protection_plan_price: 8.99, protection_plan_wholesale: 4 });
  pi("US5", 11494, 11494);
  reservation("US5", { ...HISTORY, ...USD }, { cancelled: 1 });
  // 6. Cancelled before capture.
  row("US6", { status: "cancelled", stripe_payment_intent_id: null });
  reservation("US6", { ...HISTORY, ...USD }, { cancelled: 1 });
  // 7. Disputed: ResLab still bills it.
  row("US7", { status: "disputed" });
  pi("US7", 10595);
  reservation("US7", { ...HISTORY, ...USD });
  // 8. Confirmed, the ResLab read fails (5xx): holds the completeness gate open.
  row("US8");
  pi("US8", 10595);
  h.reservations.set("US8", { __httpStatus: 503 });
  // 9. Confirmed, grand total drifted from ResLab's.
  row("US9", { grand_total: 101 });
  pi("US9", 10695);
  reservation("US9", { ...HISTORY, ...USD });
}

/** The result as `main` returned it: keys added since are checked empty, then removed. */
function usView(result: Awaited<ReturnType<typeof reconcileRevenue>>) {
  return result;
}

beforeEach(() => {
  h.rows = [];
  h.pis.clear();
  h.reservations.clear();
  process.env.STRIPE_SECRET_KEY = "sk_live_dummy";
  process.env.RESLAB_API_KEY = "k";
  process.env.RESLAB_API_URL = "https://reslab.test/v1";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/authenticate")) return { ok: true, json: async () => ({ token: "tok" }) } as unknown as Response;
      const data = h.reservations.get(url.split("/reservations/")[1] ?? "");
      if (data === undefined) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      if (typeof data === "object" && data !== null && "__httpStatus" in data) {
        return { ok: false, status: (data as { __httpStatus: number }).__httpStatus, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, json: async () => data } as unknown as Response;
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("US baseline — the reconcile result for a US-dollar month", () => {
  it("a mixed month, ResLab and Stripe cross-checks on", async () => {
    usMonth();
    expect(usView(await reconcileRevenue(OPTS))).toMatchSnapshot();
  });

  it("the same month without the failed read (the headline is a figure)", async () => {
    usMonth();
    h.rows = h.rows.filter((r) => (r as { reslab_reservation_number: string }).reslab_reservation_number !== "US8");
    expect(usView(await reconcileRevenue(OPTS))).toMatchSnapshot();
  });

  it("ResLab cross-check off", async () => {
    usMonth();
    expect(usView(await reconcileRevenue({ ...OPTS, includeReslab: false }))).toMatchSnapshot();
  });

  it("Stripe cross-check off", async () => {
    usMonth();
    expect(usView(await reconcileRevenue({ ...OPTS, includeStripe: false }))).toMatchSnapshot();
  });
});
