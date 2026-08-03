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
