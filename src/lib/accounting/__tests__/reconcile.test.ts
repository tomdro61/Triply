import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReconcileOptions } from "../types";

/**
 * Focused coverage for the staging/test-booking EXCLUSION in reconcileRevenue.
 *
 * Context: staging soaks write real `confirmed` rows to the SHARED prod DB, but
 * their payment is a TEST-mode Stripe PI (unreadable by the live key →
 * `resource_missing`) and their reservation lives only in staging ResLab (404s
 * in prod ResLab). Left in, their prod-ResLab 404 nulled the whole month's
 * Triply-revenue total. The fix drops them — but ONLY when BOTH signals
 * corroborate, so a real booking with a merely bad/foreign PI is never silently
 * dropped from every total.
 *
 * These tests pin: (1) a true staging row is excluded + the gate resolves;
 * (2) a real booking whose PI 404s but whose ResLab resolves is KEPT + surfaced;
 * (3) a test-mode reconcile key disables the exclusion entirely; (4) a restricted
 * live key (`rk_live_`) still counts as live.
 */

// Mutable registries referenced inside the (hoisted) vi.mock factories.
const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  // pi id -> PaymentIntent-shaped object, or absent => throws resource_missing.
  pis: new Map<string, unknown>(),
  // reservation number -> ResLab response, or absent => 404.
  reservations: new Map<string, unknown>(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(async () => {
    const builder: Record<string, unknown> = {};
    for (const m of ["from", "select", "gte", "lte", "order"]) {
      builder[m] = () => builder;
    }
    builder.returns = () => Promise.resolve({ data: h.rows, error: null });
    return builder;
  }),
}));

vi.mock("@/config/admin", () => ({
  // No test-LOT rows in these fixtures; the staging path is what's under test.
  isAtTestLot: () => false,
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
  by: "created",
  invoiceAmount: 0,
  includeReslab: true,
  includeStripe: true,
};

/** A confirmed booking row shaped like the Supabase select in reconcile.ts. */
function pushRow(resNum: string | null, pi: string | null) {
  h.rows.push({
    id: resNum ?? "orphan",
    reslab_reservation_number: resNum,
    status: "confirmed",
    created_at: "2026-07-15T00:00:00Z",
    check_in: "2026-07-20 10:00:00",
    check_out: "2026-07-25 10:00:00",
    grand_total: 100,
    subtotal: 80,
    due_at_location: 20,
    triply_service_fee: 10,
    service_fee_refunded: false,
    protection_plan: null,
    protection_plan_price: 0,
    pg_identifier: null,
    stripe_payment_intent_id: pi,
    reslab_location_id: 100, // a real (non-test) lot
    location_name: "Lot A",
    airport_code: "JFK",
    customers: { email: "a@b.com" },
  });
}

/** Register a readable live PI for `pi` (a real prod charge). */
function registerLivePI(pi: string) {
  h.pis.set(pi, {
    amount_received: 9000,
    latest_charge: { amount_refunded: 0, balance_transaction: { fee: 300 } },
    status: "succeeded",
  });
}

/** Register a resolvable prod-ResLab reservation for `resNum`. */
function registerReservation(resNum: string) {
  h.reservations.set(resNum, {
    cancelled: 0,
    history: [
      {
        location_total: 80,
        due_at_location_total: 20,
        channel_total: 12,
        commissions_total: 0,
        grand_total: 100,
        subtotal: 80,
        refund_amount: 0,
        partial_refund: 0,
      },
    ],
  });
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
      if (url.endsWith("/authenticate")) {
        return { ok: true, json: async () => ({ token: "tok" }) } as unknown as Response;
      }
      const resNum = url.split("/reservations/")[1] ?? "";
      const data = h.reservations.get(resNum);
      // Absent registration → definitive 404 (reservation truly not in prod ResLab).
      if (data === undefined) {
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }
      // A registration marked with __httpStatus simulates a non-404 error (5xx/etc).
      if (typeof data === "object" && data !== null && "__httpStatus" in data) {
        const status = (data as { __httpStatus: number }).__httpStatus;
        return { ok: false, status, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, json: async () => data } as unknown as Response;
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reconcileRevenue — staging exclusion", () => {
  it("excludes a true staging row (both Stripe 404 AND ResLab 404) and resolves the completeness gate", async () => {
    registerLivePI("pi_real");
    registerReservation("RTL_REAL");
    pushRow("RTL_REAL", "pi_real");
    // Staging soak row: PI is test-mode (unregistered → resource_missing) and the
    // reservation is staging-only (unregistered → prod-ResLab 404).
    pushRow("RTL_STAGE", "pi_stage");

    const r = await reconcileRevenue(OPTS);

    expect(r.counts.stagingExcluded).toBe(1);
    expect(r.stagingExcludedReservations).toEqual(["RTL_STAGE"]);
    // Dropped from the detail rows (and therefore the CSV).
    expect(r.bookings.map((b) => b.reslab_reservation_number)).toEqual(["RTL_REAL"]);
    // Its expected prod-ResLab 404 is scrubbed from the integrity warning.
    expect(r.reslab.fetchErrors.some((e) => e.resNum === "RTL_STAGE")).toBe(false);
    // Gate resolves: the only remaining confirmed row cross-checked cleanly, so
    // Triply revenue is a real number instead of null.
    expect(r.triplyNet.total).not.toBeNull();
    // Only the real row contributes to the totals.
    expect(r.grossRevenue).toBe(100);
    expect(r.counts.total).toBe(1);
  });

  it("KEEPS a real booking whose PI 404s but whose ResLab reservation resolves, and surfaces it", async () => {
    // Real prod booking with a mis-stored/foreign PI: Stripe can't read it, but
    // the reservation IS in prod ResLab. Must NOT be excluded.
    registerReservation("RTL_BADPI");
    pushRow("RTL_BADPI", "pi_foreign");

    const r = await reconcileRevenue(OPTS);

    expect(r.counts.stagingExcluded).toBe(0);
    expect(r.stagingExcludedReservations).toEqual([]);
    // Kept in the totals + detail rows.
    expect(r.bookings.map((b) => b.reslab_reservation_number)).toEqual(["RTL_BADPI"]);
    expect(r.grossRevenue).toBe(100);
    // Surfaced loudly as a Stripe fetch error instead of masked.
    expect(r.stripeFetch.errors.some((e) => e.resNum === "RTL_BADPI")).toBe(true);
  });

  it("does NOT exclude anything under a TEST reconcile key (resource_missing is inverted there)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    registerLivePI("pi_real");
    registerReservation("RTL_REAL");
    pushRow("RTL_REAL", "pi_real");
    pushRow("RTL_STAGE", "pi_stage"); // both signals would fire, but key is test-mode

    const r = await reconcileRevenue(OPTS);

    expect(r.counts.stagingExcluded).toBe(0);
    expect(r.bookings).toHaveLength(2);
  });

  it("treats a restricted live key (rk_live_) as live", async () => {
    process.env.STRIPE_SECRET_KEY = "rk_live_dummy";
    registerLivePI("pi_real");
    registerReservation("RTL_REAL");
    pushRow("RTL_REAL", "pi_real");
    pushRow("RTL_STAGE", "pi_stage");

    const r = await reconcileRevenue(OPTS);

    expect(r.counts.stagingExcluded).toBe(1);
    expect(r.stagingExcludedReservations).toEqual(["RTL_STAGE"]);
  });

  it("does NOT exclude on a TRANSIENT ResLab error (502) — only a definitive 404 corroborates", async () => {
    // Real booking with a foreign PI (Stripe resource_missing) while prod ResLab is
    // flaky (502). Must be KEPT — a transient error must not be read as "absent".
    h.reservations.set("RTL_TRANSIENT", { __httpStatus: 502 });
    pushRow("RTL_TRANSIENT", "pi_foreign");

    const r = await reconcileRevenue(OPTS);

    expect(r.counts.stagingExcluded).toBe(0);
    expect(r.bookings.map((b) => b.reslab_reservation_number)).toEqual(["RTL_TRANSIENT"]);
    // The real 502 stays visible (not scrubbed, since the row wasn't excluded)...
    expect(r.reslab.fetchErrors.some((e) => e.resNum === "RTL_TRANSIENT")).toBe(true);
    // ...and it's surfaced as an unreadable-PI note that does NOT claim "resolves".
    const note = r.stripeFetch.errors.find((e) => e.resNum === "RTL_TRANSIENT");
    expect(note?.err).toMatch(/cannot confirm staging/);
    expect(note?.err ?? "").not.toMatch(/resolves/);
    // A transient ResLab gap fails toward a VISIBLE null total, not a silent drop.
    expect(r.triplyNet.total).toBeNull();
  });

  it("does NOT exclude on a 200-with-empty-history response (reservation resolved, not absent)", async () => {
    // HTTP 200 but no history[0] → the reservation DID resolve in prod ResLab, so
    // reslabNotFound stays false and the row is kept, not excluded.
    h.reservations.set("RTL_EMPTY", { cancelled: 0, history: [] });
    pushRow("RTL_EMPTY", "pi_foreign");

    const r = await reconcileRevenue(OPTS);

    expect(r.counts.stagingExcluded).toBe(0);
    expect(r.bookings.map((b) => b.reslab_reservation_number)).toEqual(["RTL_EMPTY"]);
  });

  it("does not assert 'resolves' for an orphan row (null reservation number, unreadable PI)", async () => {
    // Orphan charge: PI captured but reservation creation failed → null res number.
    // Its PI 404s (resource_missing); ResLab is never queried (no number). Must be
    // kept, and the diagnostic must NOT claim the reservation resolved.
    pushRow(null, "pi_orphan");

    const r = await reconcileRevenue(OPTS);

    expect(r.counts.stagingExcluded).toBe(0);
    expect(r.bookings).toHaveLength(1);
    const note = r.stripeFetch.errors.find((e) => e.err.includes("no ResLab reservation number"));
    expect(note).toBeDefined();
    expect(note?.err ?? "").not.toMatch(/resolves/);
  });

  it("under ?reslab=0 (includeReslab off) excludes nothing and never asserts 'resolves'", async () => {
    registerLivePI("pi_real");
    pushRow("RTL_REAL", "pi_real");
    pushRow("RTL_STAGE", "pi_stage"); // resource_missing, but ResLab not consulted

    const r = await reconcileRevenue({ ...OPTS, includeReslab: false });

    expect(r.counts.stagingExcluded).toBe(0);
    expect(r.bookings).toHaveLength(2);
    const note = r.stripeFetch.errors.find((e) => e.resNum === "RTL_STAGE");
    expect(note?.err).toMatch(/cross-check disabled/);
    expect(note?.err ?? "").not.toMatch(/resolves/);
  });
});

/**
 * ResLab's "RL Fee" — the `channel_fee` line in history[0].fees[].
 *
 * ResLab began billing this on reservations created 2026-07-30 and later. It is
 * charged ON TOP of the lot settlement, so omitting it made "Owed to ResLab"
 * under-state the invoice by the full fee (Aug 2026: $4,078.13 shown vs
 * $4,194.62 invoiced — the $116.49 gap was exactly this column).
 *
 * These pin the three rules that actually reproduce the invoice, each verified
 * against the August 2026 settlement report:
 *   1. the fee is ADDED to the amount owed — including on Due-at-Lot bookings,
 *      where the lot settlement is $0 and the fee is all that's billed;
 *   2. a ResLab-CANCELLED reservation is not billed, even though its history
 *      still carries the fee line (RTL829990: $4.61 present, $0 invoiced);
 *   3. the settlement follows ResLab's billing rule, not our booking status —
 *      a `disputed` row IS billed (RTL828863: $8.08).
 * Plus the parsing trap: `total_fees` mixes in the LOT's fees and must not be
 * substituted for the channel_fee line (RTL828143: $19.40 vs the $5.40 billed).
 */
describe("reconcileRevenue — ResLab channel fee (RL Fee)", () => {
  /** Register a reservation with explicit money + fee lines. */
  function registerWithFees(
    resNum: string,
    opts: {
      locationTotal: number;
      dueAtLocationTotal?: number;
      channelTotal?: number;
      cancelled?: number;
      fees?: Array<{ fee_type: string; dollar_amount: number }>;
    }
  ) {
    h.reservations.set(resNum, {
      cancelled: opts.cancelled ?? 0,
      history: [
        {
          location_total: opts.locationTotal,
          due_at_location_total: opts.dueAtLocationTotal ?? 0,
          channel_total: opts.channelTotal ?? 12,
          commissions_total: 0,
          grand_total: 100,
          subtotal: 80,
          refund_amount: 0,
          partial_refund: 0,
          fees: opts.fees ?? [],
        },
      ],
    });
  }

  /** A booking row with a caller-chosen status. */
  function pushRowWithStatus(resNum: string, pi: string, status: string) {
    pushRow(resNum, pi);
    (h.rows[h.rows.length - 1] as { status: string }).status = status;
  }

  it("adds the channel fee to the amount owed and reports both components", async () => {
    registerLivePI("pi_1");
    registerWithFees("RTL_FEE", {
      locationTotal: 80,
      dueAtLocationTotal: 20,
      fees: [{ fee_type: "channel_fee", dollar_amount: 3 }],
    });
    pushRow("RTL_FEE", "pi_1");

    const r = await reconcileRevenue(OPTS);

    expect(r.reslab.sumLocationTotal).toBe(60); // 80 − 20
    expect(r.reslab.sumChannelFee).toBe(3);
    expect(r.reslab.sumAmountOwed).toBe(63);
    expect(r.reslab.settlementRows).toBe(1);
    expect(r.bookings[0]?.reslab_channel_fee).toBe(3);
  });

  it("measures variance against the fee-inclusive total", async () => {
    registerLivePI("pi_1");
    registerWithFees("RTL_FEE", {
      locationTotal: 80,
      dueAtLocationTotal: 20,
      fees: [{ fee_type: "channel_fee", dollar_amount: 3 }],
    });
    pushRow("RTL_FEE", "pi_1");

    // An invoice for exactly lots + fee reconciles to zero. Before the fee was
    // included, this same invoice showed a −$3 variance.
    const r = await reconcileRevenue({ ...OPTS, invoiceAmount: 63 });
    expect(r.reslab.variance).toBe(0);
  });

  it("bills the fee on a Due-at-Lot booking, where the lot settlement is $0", async () => {
    registerLivePI("pi_1");
    // Due-at-Lot: location_total === due_at_location_total, so nothing is owed
    // to the lot — but ResLab still bills their fee (12 such rows in Aug 2026).
    registerWithFees("RTL_DAL", {
      locationTotal: 146,
      dueAtLocationTotal: 146,
      fees: [{ fee_type: "channel_fee", dollar_amount: 8.08 }],
    });
    pushRow("RTL_DAL", "pi_1");

    const r = await reconcileRevenue(OPTS);

    expect(r.reslab.sumLocationTotal).toBe(0);
    expect(r.reslab.sumAmountOwed).toBe(8.08);
  });

  it("does NOT bill the fee on a ResLab-cancelled reservation that still carries the fee line", async () => {
    registerLivePI("pi_1");
    registerLivePI("pi_2");
    registerWithFees("RTL_LIVE", {
      locationTotal: 50,
      fees: [{ fee_type: "channel_fee", dollar_amount: 2.5 }],
    });
    // ResLab zeroes the money on cancel but leaves the fee line in place.
    registerWithFees("RTL_CXL", {
      locationTotal: 0,
      cancelled: 1,
      fees: [{ fee_type: "channel_fee", dollar_amount: 4.61 }],
    });
    pushRow("RTL_LIVE", "pi_1");
    pushRowWithStatus("RTL_CXL", "pi_2", "refunded");

    const r = await reconcileRevenue(OPTS);

    // The cancelled row's $4.61 must not reach the invoice comparison.
    expect(r.reslab.sumChannelFee).toBe(2.5);
    expect(r.reslab.sumAmountOwed).toBe(52.5);
    expect(r.reslab.settlementRows).toBe(1);
    // Still reported per-row, so the CSV shows what ResLab actually holds.
    expect(
      r.bookings.find((b) => b.reslab_reservation_number === "RTL_CXL")?.reslab_channel_fee
    ).toBe(4.61);
  });

  it("bills a non-confirmed (disputed) row that ResLab has not cancelled", async () => {
    registerLivePI("pi_1");
    registerWithFees("RTL_DISPUTED", {
      locationTotal: 146,
      dueAtLocationTotal: 146,
      cancelled: 0,
      fees: [{ fee_type: "channel_fee", dollar_amount: 8.08 }],
    });
    pushRowWithStatus("RTL_DISPUTED", "pi_1", "disputed");

    const r = await reconcileRevenue(OPTS);

    // Gating the settlement on `status === "confirmed"` would drop this and
    // under-state the invoice — ResLab bills it regardless of our status.
    expect(r.reslab.sumAmountOwed).toBe(8.08);
    expect(r.reslab.settlementRows).toBe(1);
    // But it stays OUT of the confirmed-scoped money-flow / P&L figures.
    expect(r.confirmed.channelFee).toBe(0);
  });

  it("ignores location fees — only the channel_fee line is ours", async () => {
    registerLivePI("pi_1");
    // RTL828143's shape: total_fees $19.40 = $14 location + $5.40 channel.
    // Using total_fees here would over-bill by the lot's own $14.
    registerWithFees("RTL_MIXED", {
      locationTotal: 80,
      fees: [
        { fee_type: "location_fee", dollar_amount: 4 },
        { fee_type: "location_fee", dollar_amount: 10 },
        { fee_type: "channel_fee", dollar_amount: 5.4 },
      ],
    });
    pushRow("RTL_MIXED", "pi_1");

    const r = await reconcileRevenue(OPTS);

    expect(r.reslab.sumChannelFee).toBe(5.4);
    expect(r.reslab.sumAmountOwed).toBe(85.4);
  });

  it("treats a reservation with no fees[] as a zero fee (pre-2026-07-30 bookings)", async () => {
    registerLivePI("pi_1");
    registerReservation("RTL_OLD"); // no fees[] key at all
    pushRow("RTL_OLD", "pi_1");

    const r = await reconcileRevenue(OPTS);

    expect(r.reslab.sumChannelFee).toBe(0);
    expect(r.reslab.sumAmountOwed).toBe(60); // 80 − 20, unchanged
    expect(r.bookings[0]?.reslab_channel_fee).toBe(0);
  });

  it("deducts the fee from Triply's revenue so the margin isn't overstated", async () => {
    registerLivePI("pi_1");
    registerWithFees("RTL_FEE", {
      locationTotal: 80,
      dueAtLocationTotal: 20,
      channelTotal: 12,
      fees: [{ fee_type: "channel_fee", dollar_amount: 3 }],
    });
    pushRow("RTL_FEE", "pi_1");

    const r = await reconcileRevenue(OPTS);

    // Channel commission stays GROSS (it's the contract figure)...
    expect(r.triplyNet.parkingChannelCommission).toBe(12);
    // ...with the fee broken out and already deducted from the total:
    // service fee 10 + PG 0 + channel 12 − fee 3 = 19.
    expect(r.triplyNet.reslabChannelFee).toBe(3);
    expect(r.triplyNet.total).toBe(19);
  });

  it("reports null fee figures when the ResLab cross-check is disabled", async () => {
    registerLivePI("pi_1");
    pushRow("RTL_FEE", "pi_1");

    const r = await reconcileRevenue({ ...OPTS, includeReslab: false });

    expect(r.reslab.sumChannelFee).toBeNull();
    expect(r.reslab.sumAmountOwed).toBeNull();
    expect(r.confirmed.channelFee).toBeNull();
    expect(r.triplyNet.reslabChannelFee).toBeNull();
  });
});
