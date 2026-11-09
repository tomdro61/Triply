/**
 * GET /api/reservations/[id] — the confirmation page's data source.
 *
 *   - a DIRECT booking (TRP- number, inventory_source "direct") is answered from
 *     the bookings row + lot snapshot with ZERO ResLab calls (plan 4b §2.2);
 *   - a ResLab booking returns exactly what it did before (plus the additive
 *     `inventorySource: "reslab"`);
 *   - 404 (no such booking) stays apart from 500 (a failed read / bad data);
 *   - both return a `costBreakdown` checked against what Stripe took (plan
 *     2026-10-12), refused (ok:false) — never $0 lines — when any input is
 *     unknown, plus the fallback's `cardPayment` (Stripe's own amount,
 *     a released hold, or unknown — never a row-computed "charged").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { directRow } from "@/lib/direct/__tests__/reservation-view-fixtures";

type Result = { data: unknown; error: { message: string; code?: string } | null };

const h = vi.hoisted(() => {
  const state: {
    /** The ownership lookup (`.maybeSingle()`): customer_id + customers(email). */
    authRow: { data: unknown; error: { message: string; code?: string } | null };
    /** The detail read (`.single()`). */
    detailRow: { data: unknown; error: { message: string; code?: string } | null };
    detailSelect: string | null;
    /** The staged checkout row (`pending_bookings.customer`) a direct confirmation reads the guest from. */
    pendingRow: { data: unknown; error: { message: string; code?: string } | null };
    /** The `.eq()` the staged read used (column, value). */
    pendingEq: Array<[string, unknown]>;
    /** The signed-in user (null = guest, ownership proven by ?email=). */
    user: { id: string; email: string; email_confirmed_at: string | null } | null;
    /** When set, the ownership lookup answers per confirmation number (a missing number → no row). */
    rowsById: Record<string, { data: unknown; error: { message: string; code?: string } | null }> | null;
    /** How many ownership lookups (`.maybeSingle()` on bookings) ran. */
    authLookups: number;
    /** The columns the last ownership lookup selected. */
    authSelect: string | null;
  } = {
    authRow: { data: null, error: null },
    detailRow: { data: null, error: null },
    detailSelect: null,
    pendingRow: { data: null, error: null },
    pendingEq: [],
    user: null,
    rowsById: null,
    authLookups: 0,
    authSelect: null,
  };
  const adminClient = {
    from: (table: string) => {
      if (table === "pending_bookings") {
        const p = {
          select: () => p,
          eq: (col: string, val: unknown) => {
            state.pendingEq.push([col, val]);
            return p;
          },
          abortSignal: () => p,
          maybeSingle: async () => state.pendingRow,
        };
        return p;
      }
      if (table !== "bookings") throw new Error(`unexpected table ${table}`);
      let selected = "";
      let eqValue: unknown = null;
      const q = {
        select: (cols: string) => {
          selected = cols;
          return q;
        },
        eq: (_col: string, val: unknown) => {
          eqValue = val;
          return q;
        },
        maybeSingle: async () => {
          state.authLookups++;
          state.authSelect = selected;
          if (state.rowsById) return state.rowsById[String(eqValue)] ?? { data: null, error: null };
          return state.authRow;
        },
        single: async () => {
          state.detailSelect = selected;
          return state.detailRow;
        },
      };
      return q;
    },
  };
  return {
    state,
    adminClient,
    getReservation: vi.fn(),
    captureBookingError: vi.fn(),
    retrievePi: vi.fn(),
    /** What reportCostBreakdownFallback sent to Sentry (scope + message). */
    sentryEvents: [] as SentryEvent[],
    /** When set, buildCostBreakdown throws it (the route guard test). */
    breakdownThrows: null as Error | null,
    currentEvent: null as SentryEvent | null,
  };
});

interface SentryEvent {
  level?: string;
  fingerprint?: string[];
  tags: Record<string, string>;
  contexts: Record<string, unknown>;
  message?: string;
}

vi.mock("@/lib/supabase/server", () => ({
  // Guest (no session) — ownership is proven by ?email=.
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.state.user } }) } }),
  createAdminClient: async () => h.adminClient,
}));
vi.mock("@/lib/reslab/client", () => ({ reslab: { getReservation: h.getReservation } }));
vi.mock("@/lib/sentry", () => ({ captureBookingError: h.captureBookingError }));
vi.mock("@sentry/nextjs", () => ({
  withScope: (fn: (scope: {
    setLevel: (l: string) => void;
    setFingerprint: (f: string[]) => void;
    setTag: (k: string, v: string) => void;
    setContext: (k: string, v: unknown) => void;
  }) => void) => {
    const ev: SentryEvent = { tags: {}, contexts: {} };
    h.currentEvent = ev;
    fn({
      setLevel: (l) => { ev.level = l; },
      setFingerprint: (f) => { ev.fingerprint = f; },
      setTag: (k, v) => { ev.tags[k] = v; },
      setContext: (k, v) => { ev.contexts[k] = v; },
    });
    h.sentryEvents.push(ev);
    h.currentEvent = null;
  },
  captureException: (e: Error) => {
    if (h.currentEvent) h.currentEvent.message = e.message;
  },
}));
vi.mock("@/lib/booking/cost-breakdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking/cost-breakdown")>();
  return {
    ...actual,
    buildCostBreakdown: (input: Parameters<typeof actual.buildCostBreakdown>[0]) => {
      if (h.breakdownThrows) throw h.breakdownThrows;
      return actual.buildCostBreakdown(input);
    },
  };
});
vi.mock("@/lib/stripe/client", () => ({ stripe: { paymentIntents: { retrieve: h.retrievePi } } }));

/**
 * The shared attempt table (migration 051), faked in memory with its rules:
 * any bucket at its limit refuses the whole take and charges nothing;
 * otherwise every bucket is charged one try. Release gives one back.
 */
const limit = vi.hoisted(() => {
  const attempts = new Map<string, number>();
  return {
    attempts,
    /** "fake" = the rules above; otherwise answer this for every take. */
    mode: "fake" as "fake" | { kind: "error"; detail: string },
    takes: [] as Array<{ keys: string[]; kinds: string[]; limits: number[] }>,
    releases: [] as string[][],
    unknownIp: [] as string[],
  };
});
vi.mock("@/lib/confirmation/guest-lookup-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/confirmation/guest-lookup-limit")>();
  return {
    ...actual,
    takeGuestLookup: async (buckets: { keys: string[]; kinds: string[]; limits: number[] }) => {
      limit.takes.push(buckets);
      if (limit.mode !== "fake") return limit.mode;
      const full = buckets.keys.some((k, i) => (limit.attempts.get(k) ?? 0) >= buckets.limits[i]);
      if (full) return { kind: "blocked" as const, retryAfterSeconds: 3600 };
      for (const k of buckets.keys) limit.attempts.set(k, (limit.attempts.get(k) ?? 0) + 1);
      return { kind: "allowed" as const, keys: buckets.keys };
    },
    releaseGuestLookup: async (keys: string[]) => {
      limit.releases.push(keys);
      for (const k of keys) limit.attempts.set(k, Math.max(0, (limit.attempts.get(k) ?? 0) - 1));
    },
    noteUnknownGuestIp: (id: string) => {
      limit.unknownIp.push(id);
    },
  };
});

// after(): the callbacks are queued, so a test can tell "after the response"
// from "inline"; flushAfter() runs them.
const afterQueue = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afterQueue.push(fn);
  },
}));
async function flushAfter() {
  while (afterQueue.length > 0) await afterQueue.shift()!();
}

import { GET } from "../route";
import { bookingKey } from "@/lib/confirmation/booking-key";
import { __resetGuestLookupRateLimitForTests } from "@/lib/attribution/limiter";
import { __resetCostBreakdownReportsForTests } from "@/lib/booking/read-card-payment";

const EMAIL = "dana@example.com";
const call = (id: string) =>
  GET(new NextRequest(`https://x.test/api/reservations/${id}?email=${encodeURIComponent(EMAIL)}`), {
    params: Promise.resolve({ id }),
  });

const ownedBy = (email: string): Result => ({ data: { customer_id: "c1", customers: { email } }, error: null });

/** A settled PaymentIntent as Stripe returns it with `expand: ["latest_charge"]`. */
const settledPi = (amountReceived: number, amountRefunded = 0, discountPercent?: string) => ({
  id: "pi_test",
  status: "succeeded",
  amount_received: amountReceived,
  metadata: discountPercent ? { discountPercent } : {},
  latest_charge: { id: "ch_test", amount_refunded: amountRefunded },
});

/** A Stripe SDK error as the client throws it (type + code). */
const stripeError = (type: string, code?: string) =>
  Object.assign(new Error("An error occurred with our connection to Stripe."), { type, ...(code ? { code } : {}) });

const PI_READ_OPTIONS = { timeout: 4000, maxNetworkRetries: 0 };

beforeEach(() => {
  h.getReservation.mockReset();
  h.captureBookingError.mockReset();
  h.retrievePi.mockReset();
  h.sentryEvents = [];
  h.breakdownThrows = null;
  __resetCostBreakdownReportsForTests();
  h.state.authRow = ownedBy(EMAIL);
  h.state.detailRow = { data: null, error: null };
  h.state.detailSelect = null;
  // What a direct booking always has: the guest as typed at checkout (here the same as the customers row).
  h.state.pendingRow = { data: { customer: { firstName: "Dana", lastName: "Rivera", email: EMAIL, phone: "5551234567" } }, error: null };
  h.state.pendingEq = [];
  h.state.user = null;
  h.state.rowsById = null;
  h.state.authLookups = 0;
  h.state.authSelect = null;
  vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", "test-booking-link-secret");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_route");
  limit.attempts.clear();
  limit.mode = "fake";
  limit.takes = [];
  limit.releases = [];
  limit.unknownIp = [];
  afterQueue.length = 0;
  __resetGuestLookupRateLimitForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("direct booking", () => {
  const TRP = "TRP-7K3M9QXA";
  const row = () =>
    directRow({
      triply_service_fee: "5.95",
      check_in: "2026-11-02T08:00:00",
      check_out: "2026-11-05T07:00:00",
      protection_plan: null,
      protection_plan_price: null,
      pg_identifier: null,
      pg_sync_status: null,
      stripe_payment_intent_id: "pi_direct",
    });

  // The staging booking from the 4b-2 walk: 2 days at $9.95, 16 % tax, Plan A,
  // a Small SUV paying $10.00 + $1.60 at the lot; Stripe took $42.02.
  const rowD0k1 = () =>
    directRow({
      subtotal: "19.90",
      tax_total: "3.18",
      grand_total: "23.08",
      triply_service_fee: "5.95",
      protection_plan: "Plan A",
      protection_plan_code: "A",
      protection_plan_price: "12.99",
      vehicle_size: "small_suv",
      vehicle_size_label: "Small SUV",
      vehicle_surcharge_cents: 1000,
      vehicle_surcharge_tax_cents: 160,
      check_in: "2026-10-14T09:00:00",
      check_out: "2026-10-16T09:00:00",
      pg_identifier: "PG-1",
      pg_sync_status: "synced",
      stripe_payment_intent_id: "pi_d0k1",
    });

  beforeEach(() => {
    // 29.85 + 4.78 + 5.95 — the at-lot surcharge is never charged online.
    h.retrievePi.mockResolvedValue(settledPi(4058));
  });

  it("builds the response from the row + snapshot and never calls ResLab", async () => {
    h.state.detailRow = { data: row(), error: null };
    const res = await call(TRP);
    expect(res.status).toBe(200);
    expect(h.getReservation).not.toHaveBeenCalled();
    const { reservation } = await res.json();
    expect(reservation.inventorySource).toBe("direct");
    expect(reservation.reservationNumber).toBe(TRP);
    expect(reservation.airportCode).toBe("JFK");
    expect(reservation.location).toMatchObject({ id: "1", latitude: 40.6681, longitude: -73.7914 });
    // Literal airport-local times, exactly as stored (T → space), never converted.
    expect(reservation.items[0]).toMatchObject({ fromDate: "2026-11-02 08:00:00", toDate: "2026-11-05 07:00:00", numberOfDays: 3 });
    // Online figures exclude the at-lot estimate; dueAtLocation is the stored 0.
    expect(reservation.grandTotal).toBe(40.58);
    expect(reservation.dueNow).toBe(40.58);
    expect(reservation.dueAtLocation).toBe(0);
    expect(reservation.atLotEstimate).toEqual({ vehicleSize: "suv", vehicleSizeLabel: "SUV / Van", surcharge: 30, surchargeTax: 4.8, total: 34.8 });
    expect(reservation.costBreakdown).toMatchObject({ ok: true, totalLabel: "Charged to card", totalCents: 4058, tripTotalCents: 7538 });
    expect(reservation.cardPayment).toEqual({ status: "charged", chargedCents: 4058, refundedCents: 0, netPaidCents: null });
    // One bounded attempt: the client's default retries would triple the 4 s bound.
    expect(h.retrievePi).toHaveBeenCalledWith("pi_direct", { expand: ["latest_charge"] }, PI_READ_OPTIONS);
    expect(h.captureBookingError).not.toHaveBeenCalled();
    expect(h.sentryEvents).toEqual([]);
  });

  it("shows the guest typed at checkout — the address the confirmation went to — not the account's customers row", async () => {
    h.state.detailRow = { data: row(), error: null };
    h.state.pendingRow = {
      data: { customer: { firstName: "Pat", lastName: "Guest", email: "pat.guest@example.com", phone: "5559990000" } },
      error: null,
    };
    const { reservation } = await (await call(TRP)).json();
    expect(reservation.customer).toEqual({ firstName: "Pat", lastName: "Guest", email: "pat.guest@example.com", phone: "5559990000" });
    expect(h.captureBookingError).not.toHaveBeenCalled();
  });

  it("a failed staged-guest read still answers (customers row) and is reported", async () => {
    h.state.detailRow = { data: row(), error: null };
    h.state.pendingRow = { data: null, error: { message: "timeout" } };
    const res = await call(TRP);
    expect(res.status).toBe(200);
    expect((await res.json()).reservation.customer.email).toBe("dana@example.com");
    expect(h.captureBookingError).toHaveBeenCalledTimes(1);
    expect(String(h.captureBookingError.mock.calls[0][0].message)).toMatch(/staged guest read failed/);
  });

  it("reads promo_code, protection_plan_code and stripe_payment_intent_id in the detail select", async () => {
    h.state.detailRow = { data: row(), error: null };
    await call(TRP);
    expect(h.state.detailSelect).toContain("promo_code");
    expect(h.state.detailSelect).toContain("protection_plan_code");
    expect(h.state.detailSelect).toContain("stripe_payment_intent_id");
  });

  it("TRP-D0K1KGXC: the breakdown matches the booking's numbers to the cent", async () => {
    h.state.detailRow = { data: rowD0k1(), error: null };
    h.retrievePi.mockResolvedValue(settledPi(4202));
    const res = await call("TRP-D0K1KGXC");
    expect(res.status).toBe(200);
    const { reservation } = await res.json();
    expect(reservation.costBreakdown).toEqual({
      ok: true,
      source: "direct",
      lines: [
        { key: "parking", label: "Parking — 2 days", cents: 1990, credit: false },
        { key: "taxes", label: "Taxes", cents: 318, credit: false },
        { key: "service_fee", label: "Triply service fee", cents: 595, credit: false },
        { key: "protection", label: "Parking Protection — Plan A", cents: 1299, credit: false },
      ],
      totalLabel: "Charged to card",
      totalCents: 4202,
      paidOnlineCents: 4202,
      dueAtLocationCents: 0,
      atLot: { cents: 1160, surchargeCents: 1000, surchargeTaxCents: 160, vehicleSizeLabel: "Small SUV" },
      tripTotalCents: 5362,
      tripTotalIsEstimate: true,
      refundedCents: 0,
      netPaidCents: null,
      cancelled: false,
    });
    expect(reservation.dueNow).toBe(42.02);
    expect(reservation.cardPayment).toEqual({ status: "charged", chargedCents: 4202, refundedCents: 0, netPaidCents: null });
    expect(h.sentryEvents).toEqual([]);
  });

  it("Stripe fails → ok:false with the error's type/code, NO charged figure, one warning per reason class", async () => {
    h.state.detailRow = { data: row(), error: null };
    h.retrievePi.mockRejectedValue(stripeError("StripeConnectionError", "ECONNRESET"));
    const res = await call(TRP);
    expect(res.status).toBe(200);
    const { reservation } = await res.json();
    expect(reservation.costBreakdown).toEqual({
      ok: false,
      reason: "Stripe PaymentIntent read failed (StripeConnectionError/ECONNRESET)",
    });
    // dueNow is computed from the row — it must never be shown as "charged".
    expect(reservation.cardPayment).toEqual({ status: "unknown" });
    expect(h.sentryEvents).toHaveLength(1);
    expect(h.sentryEvents[0]).toMatchObject({
      level: "warning",
      fingerprint: ["cost-breakdown-fallback", "stripe_read_failed"],
      tags: { "cost_breakdown.reason": "stripe_read_failed", inventory_source: "direct", "payment.intentId": "pi_direct" },
      contexts: { booking: { confirmationNumber: TRP, reason: "Stripe PaymentIntent read failed (StripeConnectionError/ECONNRESET)" } },
    });
    // A revisit on the same warm instance does not mint another event.
    await call(TRP);
    expect(h.sentryEvents).toHaveLength(1);
  });

  it("two bookings with the same cause share ONE fingerprint (one issue), each carrying its own number", async () => {
    h.retrievePi.mockRejectedValue(stripeError("StripeConnectionError"));
    h.state.detailRow = { data: row(), error: null };
    await call(TRP);
    await call("TRP-2B4C6D8F");
    expect(h.sentryEvents.map((e) => e.fingerprint)).toEqual([
      ["cost-breakdown-fallback", "stripe_read_failed"],
      ["cost-breakdown-fallback", "stripe_read_failed"],
    ]);
    expect(h.sentryEvents.map((e) => (e.contexts.booking as { confirmationNumber: string }).confirmationNumber)).toEqual([
      TRP,
      "TRP-2B4C6D8F",
    ]);
  });

  it("a released hold on a cancelled booking → 'released', no amount, nothing to Sentry", async () => {
    h.state.detailRow = { data: { ...row(), status: "cancelled" }, error: null };
    h.retrievePi.mockResolvedValue({ id: "pi_direct", status: "canceled", amount_received: 0, metadata: {}, latest_charge: null });
    const { reservation } = await (await call(TRP)).json();
    expect(reservation.costBreakdown.ok).toBe(false);
    expect(reservation.cardPayment).toEqual({ status: "released" });
    expect(h.sentryEvents).toEqual([]);
  });

  it("reads the direct columns in the detail select", async () => {
    h.state.detailRow = { data: row(), error: null };
    await call(TRP);
    for (const col of ["inventory_source", "lot_snapshot", "direct_lot_id", "vehicle_size", "vehicle_size_label", "vehicle_surcharge_cents", "vehicle_surcharge_tax_cents"]) {
      expect(h.state.detailSelect).toContain(col);
    }
  });

  it("an admin asking for a TRP- number with no row → 404, no ResLab call", async () => {
    // Guest path 403s first on a missing row; reproduce the admin path by
    // letting the ownership read pass and the detail read find nothing.
    h.state.detailRow = { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" } };
    const res = await call(TRP);
    expect(res.status).toBe(404);
    expect(h.getReservation).not.toHaveBeenCalled();
  });

  it("a failed detail read on a TRP- number → 500 (not a ResLab 404)", async () => {
    h.state.detailRow = { data: null, error: { message: "connection reset", code: "08006" } };
    const res = await call(TRP);
    expect(res.status).toBe(500);
    expect(h.getReservation).not.toHaveBeenCalled();
    expect(h.captureBookingError).toHaveBeenCalled();
  });

  it("a snapshot that does not parse → 500 + Sentry, never a guessed page", async () => {
    h.state.detailRow = { data: { ...row(), lot_snapshot: { v: 9 } }, error: null };
    const res = await call(TRP);
    expect(res.status).toBe(500);
    expect(h.getReservation).not.toHaveBeenCalled();
    expect(h.captureBookingError).toHaveBeenCalledTimes(1);
  });

  it("a promo booking: dueNow is the online charge net of the discount; grandTotal stays pre-discount", async () => {
    h.state.detailRow = {
      data: {
        ...row(),
        discount_amount: "2.99",
        promo_code: "FALL10",
        protection_plan: "Plan A",
        protection_plan_code: "A",
        protection_plan_price: "12.99",
      },
      error: null,
    };
    // 10 % of the 29.85 subtotal = 2.985 → 2.99.
    h.retrievePi.mockResolvedValue(settledPi(5058, 0, "10"));
    const res = await call(TRP);
    expect(res.status).toBe(200);
    const { reservation } = await res.json();
    expect(reservation.grandTotal).toBe(53.57); // 34.63 + 5.95 + 12.99
    expect(reservation.dueNow).toBe(50.58); // − 2.99
    expect(reservation.costBreakdown.ok).toBe(true);
    expect(reservation.costBreakdown.lines).toContainEqual({ key: "promo", label: "Promo discount (FALL10)", cents: 299, credit: true });
    expect(reservation.costBreakdown.totalCents).toBe(5058);
    expect(reservation.protectionPlan).toBe("Plan A");
    expect(reservation.protectionPlanPrice).toBe(12.99);
    // For the GA4 purchase event (D3).
    expect(reservation.promoDiscount).toBe(2.99);
    expect(reservation.promoCode).toBe("FALL10");
    expect(h.captureBookingError).not.toHaveBeenCalled();
  });

  it.each([
    ["service fee NULL", { triply_service_fee: null }],
    ["service fee garbled", { triply_service_fee: "abc" }],
    ["service fee negative", { triply_service_fee: "-5.95" }],
    ["protection plan without a price", { protection_plan: "Plan A", protection_plan_price: null }],
    ["protection plan with a $0 price", { protection_plan: "Plan A", protection_plan_price: "0" }],
  ])("%s on a direct row → 500 + ONE Sentry event (never the lenient $0)", async (_label, overrides) => {
    h.state.detailRow = { data: { ...row(), ...overrides }, error: null };
    const res = await call(TRP);
    expect(res.status).toBe(500);
    expect(h.getReservation).not.toHaveBeenCalled();
    expect(h.captureBookingError).toHaveBeenCalledTimes(1);
  });

  it.each(["payment_failed", "something_new"])("status %s on a direct row → 500 + Sentry", async (status) => {
    h.state.detailRow = { data: { ...row(), status }, error: null };
    const res = await call(TRP);
    expect(res.status).toBe(500);
    expect(h.getReservation).not.toHaveBeenCalled();
    expect(h.captureBookingError).toHaveBeenCalledTimes(1);
    expect(String(h.captureBookingError.mock.calls[0][0].message)).toContain("unexpected status");
  });

  it("source and number disagree (TRP- number on a reslab row) → 500, no ResLab call", async () => {
    h.state.detailRow = { data: { ...row(), inventory_source: "reslab" }, error: null };
    const res = await call(TRP);
    expect(res.status).toBe(500);
    expect(h.getReservation).not.toHaveBeenCalled();
  });

  it("source and number disagree (RTL number on a direct row) → 500, no ResLab call", async () => {
    h.state.detailRow = { data: row(), error: null };
    const res = await call("RTL123");
    expect(res.status).toBe(500);
    expect(h.getReservation).not.toHaveBeenCalled();
  });

  it("guest with the wrong email → 403 before anything is read", async () => {
    h.state.authRow = ownedBy("someone-else@example.com");
    h.state.pendingRow = { data: { customer: { email: "also-someone-else@example.com" } }, error: null };
    const res = await call(TRP);
    expect(res.status).toBe(403);
    expect(h.state.detailSelect).toBeNull();
  });

  describe("guest email in the x-booking-email header (kept out of URLs)", () => {
    const callWith = (id: string, opts: { header?: string; query?: string }) =>
      GET(
        new NextRequest(
          `https://x.test/api/reservations/${id}${opts.query ? `?email=${encodeURIComponent(opts.query)}` : ""}`,
          { headers: opts.header ? { "x-booking-email": opts.header } : {} }
        ),
        { params: Promise.resolve({ id }) }
      );

    it("the header alone opens the booking", async () => {
      h.state.detailRow = { data: row(), error: null };
      const res = await callWith(TRP, { header: EMAIL });
      expect(res.status).toBe(200);
      expect((await res.json()).reservation.reservationNumber).toBe(TRP);
    });

    it("every answer says Vary: x-booking-email (the service worker's cache must not hand it to another guest)", async () => {
      h.state.detailRow = { data: row(), error: null };
      expect((await callWith(TRP, { header: EMAIL })).headers.get("vary")).toContain("x-booking-email");
      expect((await callWith(TRP, {})).headers.get("vary")).toContain("x-booking-email");
    });

    it("?email= alone still works (emailed links)", async () => {
      h.state.detailRow = { data: row(), error: null };
      expect((await callWith(TRP, { query: EMAIL })).status).toBe(200);
    });

    it("a wrong header → 403 before anything is read", async () => {
      h.state.pendingRow = { data: { customer: { email: "also-someone-else@example.com" } }, error: null };
      const res = await callWith(TRP, { header: "someone-else@example.com" });
      expect(res.status).toBe(403);
      expect(h.state.detailSelect).toBeNull();
    });

    it("the header decides when both are sent: wrong header + right query → 403", async () => {
      h.state.pendingRow = { data: { customer: { email: "also-someone-else@example.com" } }, error: null };
      const res = await callWith(TRP, { header: "someone-else@example.com", query: EMAIL });
      expect(res.status).toBe(403);
    });

    it("no header and no query → 403 'Authentication required'", async () => {
      const res = await callWith(TRP, {});
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Authentication required");
    });
  });

  describe("guest access: the signed key, and the capped email path", () => {
    const guestCall = (id: string, opts: { email?: string; query?: string; key?: string; ip?: string } = {}) => {
      const headers: Record<string, string> = {};
      if (opts.email !== undefined) headers["x-booking-email"] = opts.email;
      if (opts.key !== undefined) headers["x-booking-key"] = opts.key;
      if (opts.ip !== undefined) headers["x-forwarded-for"] = opts.ip;
      return GET(
        new NextRequest(`https://x.test/api/reservations/${id}${opts.query ? `?email=${encodeURIComponent(opts.query)}` : ""}`, {
          headers,
        }),
        { params: Promise.resolve({ id }) }
      );
    };
    const keyRow = (livemode: boolean | null): Result => ({ data: { livemode }, error: null });

    describe("the email path is capped", () => {
      it("the walk: one email across many numbers → 403 ten times, then 429 with Retry-After, and no lookup", async () => {
        h.state.rowsById = {};
        const statuses: number[] = [];
        for (let i = 0; i < 10; i++) statuses.push((await guestCall(`RTL90000${i}`, { email: EMAIL })).status);
        expect(statuses).toEqual(Array(10).fill(403));
        const lookups = h.state.authLookups;
        const res = await guestCall("RTL900010", { email: EMAIL });
        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("3600");
        expect((await res.json()).error).toMatch(/too many/i);
        expect(h.state.authLookups).toBe(lookups);
        expect(h.getReservation).not.toHaveBeenCalled();
      });

      it("wrong emails on one number → 429 from the 6th, and then the RIGHT email is refused too", async () => {
        h.state.detailRow = { data: row(), error: null };
        h.state.pendingRow = { data: { customer: { email: "also-someone-else@example.com" } }, error: null };
        for (let i = 1; i <= 5; i++) expect((await guestCall(TRP, { email: `guess${i}@example.com` })).status).toBe(403);
        expect((await guestCall(TRP, { email: "guess6@example.com" })).status).toBe(429);
        expect((await guestCall(TRP, { email: EMAIL })).status).toBe(429);
        expect(h.state.detailSelect).toBeNull();
      });

      it("the number bucket is charged for a number with no booking (403 and 429 never tell which numbers exist)", async () => {
        h.state.rowsById = {};
        expect((await guestCall("RTL999999", { email: EMAIL })).status).toBe(403);
        expect(limit.takes).toHaveLength(1);
        expect(limit.takes[0].kinds).toEqual(["number", "email"]);
        expect(limit.releases).toEqual([]);
        for (let i = 2; i <= 5; i++) await guestCall("RTL999999", { email: `x${i}@example.com` });
        expect((await guestCall("RTL999999", { email: "x6@example.com" })).status).toBe(429);
      });

      it("a match gives the try back, after the response", async () => {
        h.state.detailRow = { data: row(), error: null };
        const res = await guestCall(TRP, { email: EMAIL });
        expect(res.status).toBe(200);
        expect(limit.releases).toEqual([]);
        await flushAfter();
        expect(limit.releases).toEqual([limit.takes[0].keys]);
        // Matching over and over never locks the owner out.
        for (let i = 0; i < 8; i++) {
          expect((await guestCall(TRP, { email: EMAIL })).status).toBe(200);
          await flushAfter();
        }
      });

      it("emails compare normalised (case, spaces), and the bucket is the normalised email", async () => {
        h.state.detailRow = { data: row(), error: null };
        expect((await guestCall(TRP, { email: "  DANA@Example.com " })).status).toBe(200);
        await guestCall("RTL1", { email: "dana@example.com" });
        expect(limit.takes[0].keys[1]).toBe(limit.takes[1].keys[1]);
      });

      it("an empty, whitespace-only or over-long email → 403 with nothing taken", async () => {
        for (const email of ["", "   ", "a".repeat(250) + "@x.co"]) {
          const res = await guestCall(TRP, { email });
          expect(res.status).toBe(403);
        }
        expect(limit.takes).toEqual([]);
        expect(h.state.authLookups).toBe(0);
      });

      it("the address bucket: a known IP is charged, an unknown one is skipped", async () => {
        h.state.rowsById = {};
        await guestCall("RTL1", { email: EMAIL, ip: "203.0.113.7" });
        expect(limit.unknownIp).toEqual([]);
        await guestCall("RTL2", { email: EMAIL });
        expect(limit.takes[0].kinds).toEqual(["number", "email", "ip"]);
        expect(limit.takes[1].kinds).toEqual(["number", "email"]);
        expect(limit.unknownIp).toEqual(["RTL2"]);
      });

      it("the per-instance brake: a burst from one address → 429 before the shared limiter is asked", async () => {
        h.state.rowsById = {};
        for (let i = 0; i < 10; i++) await guestCall(`RTL8${i}`, { email: `p${i}@example.com`, ip: "198.51.100.9" });
        expect(limit.takes).toHaveLength(10);
        const res = await guestCall("RTL811", { email: "p11@example.com", ip: "198.51.100.9" });
        expect(res.status).toBe(429);
        expect(res.headers.get("retry-after")).toBe("60");
        expect(limit.takes).toHaveLength(10);
      });

      it("fails closed: the limiter erroring → 500 'try again', nothing looked up", async () => {
        limit.mode = { kind: "error", detail: "timeout" };
        h.state.detailRow = { data: row(), error: null };
        const res = await guestCall(TRP, { email: EMAIL });
        expect(res.status).toBe(500);
        expect((await res.json()).error).toBe("Unable to verify reservation. Please try again.");
        expect(h.state.authLookups).toBe(0);
        expect(h.captureBookingError).toHaveBeenCalled();
      });

      it("an undecided answer gives the try back: a failed lookup or a failed staged read → 500 + release", async () => {
        h.state.authRow = { data: null, error: { message: "db down" } };
        expect((await guestCall(TRP, { email: EMAIL })).status).toBe(500);
        h.state.authRow = {
          data: { customer_id: "c1", stripe_payment_intent_id: "pi_direct", customers: { email: "booker@example.com" } },
          error: null,
        };
        h.state.pendingRow = { data: null, error: { message: "timeout" } };
        expect((await guestCall(TRP, { email: EMAIL })).status).toBe(500);
        await flushAfter();
        expect(limit.releases).toHaveLength(2);
      });

      it("a missing signing secret → 503, reported", async () => {
        vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", "");
        const res = await guestCall(TRP, { email: EMAIL });
        expect(res.status).toBe(503);
        expect(limit.takes).toEqual([]);
        expect(h.captureBookingError).toHaveBeenCalled();
      });

      it("a signed-in customer never touches the limiter", async () => {
        h.state.user = { id: "u1", email: EMAIL, email_confirmed_at: "2026-01-01" };
        h.state.authRow = { data: { customer_id: "c1", stripe_payment_intent_id: "pi_direct", customers: { user_id: "u1", email: EMAIL } }, error: null };
        h.state.detailRow = { data: row(), error: null };
        expect((await guestCall(TRP, { email: "anything@example.com" })).status).toBe(200);
        expect(limit.takes).toEqual([]);
      });
    });

    describe("the signed key", () => {
      it("a valid key alone opens the booking, and the limiter is never asked", async () => {
        h.state.authRow = keyRow(false);
        h.state.detailRow = { data: row(), error: null };
        const res = await guestCall(TRP, { key: bookingKey(TRP) });
        expect(res.status).toBe(200);
        expect((await res.json()).reservation.reservationNumber).toBe(TRP);
        expect(limit.takes).toEqual([]);
        expect(h.state.authSelect).toContain("livemode");
      });

      it("the key decides: a valid key with a wrong email still opens it", async () => {
        h.state.authRow = keyRow(false);
        h.state.detailRow = { data: row(), error: null };
        expect((await guestCall(TRP, { key: bookingKey(TRP), email: "someone-else@example.com" })).status).toBe(200);
        expect(limit.takes).toEqual([]);
      });

      it("a full email bucket never blocks a valid key", async () => {
        h.state.rowsById = {};
        for (let i = 0; i < 10; i++) await guestCall(`RTL7${i}`, { email: EMAIL });
        h.state.rowsById = { [TRP]: keyRow(false) };
        h.state.detailRow = { data: row(), error: null };
        expect((await guestCall(TRP, { key: bookingKey(TRP), email: EMAIL })).status).toBe(200);
      });

      it("another booking's key, a wrong shape or a forged value is not a key: the email path decides", async () => {
        h.state.detailRow = { data: row(), error: null };
        for (const key of [bookingKey("TRP-OTHER123"), "short", "AbCdEfGhIjKlMnOpQrStUv"]) {
          // No email → 403 'Authentication required'.
          const alone = await guestCall(TRP, { key });
          expect(alone.status).toBe(403);
          expect((await alone.json()).error).toBe("Authentication required");
          // With the right email → opens through the capped email path (a try is taken).
          const before = limit.takes.length;
          expect((await guestCall(TRP, { key, email: EMAIL })).status).toBe(200);
          expect(limit.takes.length).toBe(before + 1);
        }
      });

      it("a valid key for a number with no booking → 403", async () => {
        h.state.authRow = { data: null, error: null };
        expect((await guestCall("RTL123456", { key: bookingKey("RTL123456") })).status).toBe(403);
      });

      it("a row from the other Stripe mode is refused on the key path (shared database)", async () => {
        h.state.detailRow = { data: row(), error: null };
        // This deployment is test mode: a live row, or a pre-015 NULL row (live), is not ours.
        for (const livemode of [true, null]) {
          h.state.authRow = keyRow(livemode);
          expect((await guestCall(TRP, { key: bookingKey(TRP) })).status).toBe(403);
        }
        vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_route");
        h.state.authRow = keyRow(null);
        expect((await guestCall(TRP, { key: bookingKey(TRP) })).status).toBe(200);
        h.state.authRow = keyRow(false);
        expect((await guestCall(TRP, { key: bookingKey(TRP) })).status).toBe(403);
      });

      it("a failed lookup on the key path → 500, never 403", async () => {
        h.state.authRow = { data: null, error: { message: "db down" } };
        const res = await guestCall(TRP, { key: bookingKey(TRP) });
        expect(res.status).toBe(500);
        expect(limit.takes).toEqual([]);
      });

      it("a missing secret with a key → 503, reported", async () => {
        const key = bookingKey(TRP);
        vi.stubEnv("BOOKING_LINK_SIGNING_SECRET", "");
        expect((await guestCall(TRP, { key })).status).toBe(503);
      });

      it("every answer varies by the key header too", async () => {
        h.state.authRow = keyRow(false);
        h.state.detailRow = { data: row(), error: null };
        expect((await guestCall(TRP, { key: bookingKey(TRP) })).headers.get("vary")).toContain("x-booking-key");
        expect((await guestCall(TRP, {})).headers.get("vary")).toContain("x-booking-key");
      });
    });
  });

  describe("booked by a signed-in customer FOR someone else (filed under the booker's customers row)", () => {
    const ACCOUNT = "booker@example.com";
    const withPi = (email: string): Result => ({ data: { customer_id: "c1", stripe_payment_intent_id: "pi_direct", customers: { email, user_id: "u_booker" } }, error: null });

    it("the guest's emailed link (?email=<typed>) opens the booking", async () => {
      h.state.authRow = withPi(ACCOUNT);
      h.state.detailRow = { data: row(), error: null };
      const res = await call(TRP);
      expect(res.status).toBe(200);
      expect(h.state.pendingEq[0]).toEqual(["stripe_payment_intent_id", "pi_direct"]);
    });

    it("a guest let in by the typed email never sees the account holder's details, even if a later read fails (Codex)", async () => {
      h.state.authRow = withPi(ACCOUNT);
      h.state.detailRow = { data: row(), error: null }; // customers row = Dana Rivera (the account holder here)
      const typed = { firstName: "Pat", lastName: "Guest", email: EMAIL, phone: "5559990000" };
      let reads = 0;
      h.state.pendingRow = { data: { customer: typed }, error: null };
      const original = h.adminClient.from;
      h.adminClient.from = (table: string) => {
        if (table === "pending_bookings" && ++reads > 1) {
          // Any second read fails — the page must not need one.
          h.state.pendingRow = { data: null, error: { message: "timeout" } };
        }
        return original(table);
      };
      try {
        const res = await call(TRP);
        expect(res.status).toBe(200);
        expect((await res.json()).reservation.customer).toEqual(typed);
        expect(reads).toBe(1);
      } finally {
        h.adminClient.from = original;
      }
    });

    it("same for a guest SIGNED IN with the typed (verified) address — one read, never the account holder's details", async () => {
      h.state.authRow = withPi(ACCOUNT);
      h.state.detailRow = { data: row(), error: null };
      h.state.user = { id: "u_guest", email: EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" };
      const typed = { firstName: "Pat", lastName: "Guest", email: EMAIL, phone: "5559990000" };
      let reads = 0;
      h.state.pendingRow = { data: { customer: typed }, error: null };
      const original = h.adminClient.from;
      h.adminClient.from = (table: string) => {
        if (table === "pending_bookings" && ++reads > 1) h.state.pendingRow = { data: null, error: { message: "timeout" } };
        return original(table);
      };
      try {
        const res = await call(TRP);
        expect(res.status).toBe(200);
        expect((await res.json()).reservation.customer).toEqual(typed);
        expect(reads).toBe(1);
      } finally {
        h.adminClient.from = original;
      }
    });

    it("an email that is neither the account's nor the typed one → 403", async () => {
      h.state.authRow = withPi(ACCOUNT);
      h.state.pendingRow = { data: { customer: { email: "typed@example.com" } }, error: null };
      expect((await call(TRP)).status).toBe(403);
    });

    it("a failed staged read during the access check → 500 'try again', never a 403", async () => {
      h.state.authRow = withPi(ACCOUNT);
      h.state.pendingRow = { data: null, error: { message: "timeout" } };
      const res = await call(TRP);
      expect(res.status).toBe(500);
      expect(h.state.detailSelect).toBeNull();
    });

    it("the guest signed in with that verified address owns it too; unverified does not", async () => {
      h.state.authRow = withPi(ACCOUNT);
      h.state.detailRow = { data: row(), error: null };
      h.state.user = { id: "u_guest", email: EMAIL, email_confirmed_at: "2026-10-01T00:00:00Z" };
      expect((await call(TRP)).status).toBe(200);
      h.state.user = { id: "u_guest", email: EMAIL, email_confirmed_at: null };
      expect((await call(TRP)).status).toBe(403);
    });

    it("an admin viewing someone else's booking never depends on the staged read (a failing read is not a 500)", async () => {
      h.state.authRow = withPi(ACCOUNT);
      h.state.detailRow = { data: row(), error: null };
      h.state.pendingRow = { data: null, error: { message: "timeout" } };
      h.state.user = { id: "u_admin", email: "tom@triplypro.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
      expect((await call(TRP)).status).toBe(200);
      // Only the page's guest read ran (and failed → customers row); none for the access check.
      expect(h.state.pendingEq).toHaveLength(1);
    });

    it("the account holder's own email still works without reading the staged row", async () => {
      h.state.authRow = withPi(EMAIL);
      h.state.detailRow = { data: row(), error: null };
      h.state.pendingRow = { data: { customer: { firstName: "Pat", lastName: "Guest", email: "pat@example.com", phone: "5559990000" } }, error: null };
      expect((await call(TRP)).status).toBe(200);
      // One staged read — the page's guest details — none for the access check.
      expect(h.state.pendingEq).toHaveLength(1);
    });
  });

  it("a direct booking with no staged guest is reported (the page may show the account's details)", async () => {
    h.state.detailRow = { data: row(), error: null };
    h.state.pendingRow = { data: null, error: null };
    const res = await call(TRP);
    expect(res.status).toBe(200);
    expect(h.captureBookingError).toHaveBeenCalledTimes(1);
    expect(String(h.captureBookingError.mock.calls[0][0].message)).toMatch(/staged guest missing/);
  });
});

describe("ResLab booking — unchanged", () => {
  const RTL = "RTL856901";
  const reslabRow = {
    vehicle_info: { make: "Toyota", model: "Camry", color: "Blue", licensePlate: "XYZ987", state: "NJ" },
    triply_service_fee: "5.95",
    check_in: "2026-10-02T11:30:00",
    check_out: "2026-10-05T07:00:00",
    protection_plan: "Plan A",
    protection_plan_code: "A",
    protection_plan_price: "12.99",
    pg_identifier: "PG-9",
    pg_sync_status: "synced",
    airport_code: "EWR",
    inventory_source: "reslab",
    direct_lot_id: null,
    lot_snapshot: null,
    vehicle_size: null,
    vehicle_size_label: null,
    vehicle_surcharge_cents: null,
    vehicle_surcharge_tax_cents: null,
    status: "confirmed",
    subtotal: "60",
    tax_total: "8.82",
    fees_total: "2",
    grand_total: "70.82",
    discount_amount: null,
    promo_code: null,
    due_at_location: "20",
    stripe_payment_intent_id: "pi_reslab",
    customers: { first_name: "Sam", last_name: "Lee", email: EMAIL, phone: "5550001111" },
  };
  // 70.82 + 5.95 + 12.99 − 20.00 due at the location.
  const CHARGED = 6976;
  beforeEach(() => {
    h.retrievePi.mockResolvedValue(settledPi(CHARGED));
  });
  const reslabReservation = {
    reservation_number: RTL,
    reserved_by: "Sam Lee",
    cancelled: 0,
    history: [
      {
        id: 4242,
        reserved_for: "Sam Q Lee",
        email: EMAIL,
        phone: "5550001111",
        grand_total: 70.82,
        subtotal: 60,
        total_tax: 8.82,
        total_fees: 2,
        due_at_location_total: 20,
        location: {
          id: 52,
          name: "Some ResLab Lot",
          address: "1 Airport Rd",
          city: "Newark",
          state: { code: "NJ" },
          zip_code: "07114",
          phone: "9735550000",
          latitude: "40.69",
          longitude: "-74.17",
        },
        dates: [
          {
            from_date: "2026-10-02 00:00:00",
            to_date: "2026-10-05 00:00:00",
            number_of_days: 3,
            type: { name: "Outdoor" },
            parking_rates: [
              {
                from_date: "2026-10-02 00:00:00",
                to_date: "2026-10-05 00:00:00",
                number_of_days: 3,
                number_of_parkings: 1,
                rate: { location_parking_type: { name: "Outdoor Self Park" } },
              },
            ],
          },
        ],
        extra_fields: [
          { name: "car_make", value: "Toyota" },
          { name: "empty", value: "" },
        ],
      },
    ],
  };

  it("returns the same response as before (one ResLab call; Supabase times win)", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    const res = await call(RTL);
    expect(res.status).toBe(200);
    expect(h.getReservation).toHaveBeenCalledTimes(1);
    expect(h.getReservation).toHaveBeenCalledWith(RTL);
    expect(h.captureBookingError).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      reservation: {
        id: 4242,
        reservationNumber: RTL,
        inventorySource: "reslab",
        status: "confirmed",
        grandTotal: 70.82 + 5.95 + 12.99,
        subtotal: 60,
        taxTotal: 8.82,
        feesTotal: 2,
        serviceFee: 5.95,
        protectionPlan: "Plan A",
        protectionPlanPrice: 12.99,
        pgIdentifier: "PG-9",
        pgSyncStatus: "synced",
        airportCode: "EWR",
        // For GA4 (promo plan D3): the row's discount_amount (null → 0) and code.
        promoDiscount: 0,
        promoCode: null,
        dueNow: 70.82 + 5.95 + 12.99 - 20,
        dueAtLocation: 20,
        costBreakdown: {
          ok: true,
          source: "reslab",
          lines: [
            { key: "parking", label: "Parking — 3 days", cents: 6200, credit: false },
            { key: "taxes", label: "Taxes", cents: 882, credit: false },
            { key: "service_fee", label: "Triply service fee", cents: 595, credit: false },
            { key: "protection", label: "Parking Protection — Plan A", cents: 1299, credit: false },
          ],
          totalLabel: "Total",
          totalCents: 8976,
          paidOnlineCents: 6976,
          dueAtLocationCents: 2000,
          atLot: null,
          tripTotalCents: null,
          tripTotalIsEstimate: false,
          refundedCents: 0,
          netPaidCents: null,
          cancelled: false,
        },
        cardPayment: { status: "charged", chargedCents: 6976, refundedCents: 0, netPaidCents: null },
        fallbackDue: { kind: "amount", cents: 2000 },
        customer: { firstName: "Sam", lastName: "Q Lee", email: EMAIL, phone: "5550001111" },
        items: [
          {
            type: "parking",
            fromDate: "2026-10-02 11:30:00",
            toDate: "2026-10-05 07:00:00",
            numberOfDays: 3,
            numberOfSpots: 1,
            parkingType: "Outdoor Self Park",
          },
        ],
        location: {
          id: 52,
          name: "Some ResLab Lot",
          address: "1 Airport Rd",
          city: "Newark",
          state: "NJ",
          zipCode: "07114",
          phone: "9735550000",
          latitude: "40.69",
          longitude: "-74.17",
        },
        vehicleInfo: reslabRow.vehicle_info,
        extraFields: { car_make: "Toyota" },
      },
    });
  });

  it("a row whose read failed (inventory_source unknown) still goes to ResLab, as before", async () => {
    h.state.detailRow = { data: null, error: { message: "timeout", code: "57014" } };
    h.getReservation.mockResolvedValue(reslabReservation);
    const res = await call(RTL);
    expect(res.status).toBe(200);
    expect(h.getReservation).toHaveBeenCalledTimes(1);
    expect(h.captureBookingError).toHaveBeenCalledTimes(1); // the failed read is still surfaced
    // No breakdown and no card figure: fee, discount and plan are unknown, so
    // nothing may render as $0 (and there is no PaymentIntent id to read).
    const { reservation } = await res.json();
    expect(reservation.costBreakdown).toEqual({ ok: false, reason: "booking row read failed" });
    expect(reservation.cardPayment).toEqual({ status: "unknown" });
    // GA4 (D3): an unknown discount is null, never 0.
    expect(reservation.promoDiscount).toBeNull();
    expect(reservation.promoCode).toBeNull();
    expect(h.retrievePi).not.toHaveBeenCalled();
    expect(h.sentryEvents).toHaveLength(1);
    expect(h.sentryEvents[0]).toMatchObject({ level: "error", fingerprint: ["cost-breakdown-fallback", "row_read_failed"] });
  });

  // RTL869257: the rate changes mid-stay, so ResLab splits the stay into one
  // parking_rates line per rate period (3 + 1 + 1 days). The page said "3 days".
  const splitRateReservation = {
    ...reslabReservation,
    history: [
      {
        ...reslabReservation.history[0],
        dates: [
          {
            from_date: "2026-10-02 06:00:00",
            to_date: "2026-10-06 23:30:00",
            type: { name: "Outdoor" },
            parking_rates: [
              { from_date: "2026-10-02 00:00:00", to_date: "2026-10-04 00:00:00", number_of_days: 3, number_of_parkings: 1, rate: { location_parking_type: { name: "Outdoor Self Park" } } },
              { from_date: "2026-10-05 00:00:00", to_date: "2026-10-05 00:00:00", number_of_days: 1, number_of_parkings: 1, rate: null },
              { from_date: "2026-10-06 00:00:00", to_date: "2026-10-06 00:00:00", number_of_days: 1, number_of_parkings: 1, rate: null },
            ],
          },
        ],
      },
    ],
  };

  it("a stay split over several rate periods counts every period's days (5, not the first line's 3)", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    h.getReservation.mockResolvedValue(splitRateReservation);
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.items[0].numberOfDays).toBe(5);
    expect(reservation.costBreakdown.lines[0]).toMatchObject({ key: "parking", label: "Parking — 5 days" });
    expect(reservation.items[0].parkingType).toBe("Outdoor Self Park");
  });

  it("without row times, the dates are the whole stay's, not the first rate period's", async () => {
    h.state.detailRow = { data: null, error: { message: "timeout", code: "57014" } };
    h.getReservation.mockResolvedValue(splitRateReservation);
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.items[0]).toMatchObject({ fromDate: "2026-10-02 06:00:00", toDate: "2026-10-06 23:30:00", numberOfDays: 5 });
  });

  // 10 % of ResLab's 60.00 sub_total (the base /api/checkout/lot discounts) = 6.00.
  const promoRow = { ...reslabRow, discount_amount: "6.00", promo_code: "SAVE10" };

  it("a promo booking: checked against the code's percent; the card line is net of it; grandTotal (GA4) is unchanged", async () => {
    h.state.detailRow = { data: promoRow, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    h.retrievePi.mockResolvedValue(settledPi(CHARGED - 600, 0, "10"));
    const res = await call(RTL);
    const { reservation } = await res.json();
    expect(reservation.grandTotal).toBe(70.82 + 5.95 + 12.99);
    expect(reservation.costBreakdown.ok).toBe(true);
    expect(reservation.costBreakdown.lines).toContainEqual({ key: "promo", label: "Promo discount (SAVE10)", cents: 600, credit: true });
    expect(reservation.costBreakdown.totalCents).toBe(8376);
    expect(reservation.costBreakdown.paidOnlineCents).toBe(6376);
    expect(reservation.cardPayment).toEqual({ status: "charged", chargedCents: 6376, refundedCents: 0, netPaidCents: null });
    // For the GA4 purchase event (D3): the row's discount and code.
    expect(reservation.promoDiscount).toBe(6);
    expect(reservation.promoCode).toBe("SAVE10");
    expect(h.sentryEvents).toEqual([]);
  });

  it("a promo whose percent is not on the PaymentIntent → fallback (the discount cannot be checked), Stripe's amount still shown", async () => {
    h.state.detailRow = { data: promoRow, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    h.retrievePi.mockResolvedValue(settledPi(CHARGED - 600));
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.costBreakdown).toEqual({ ok: false, reason: "promo discount cannot be checked against the code's percent" });
    expect(reservation.cardPayment).toEqual({ status: "charged", chargedCents: 6376, refundedCents: 0, netPaidCents: null });
    expect(h.sentryEvents[0].fingerprint).toEqual([
      "cost-breakdown-fallback",
      "breakdown_promo_discount_cannot_be_checked_against_the_code_s_percent",
    ]);
  });

  it("a promo that absorbed a price move (discount ≠ the code's percent) → fallback", async () => {
    h.state.detailRow = { data: { ...reslabRow, discount_amount: "9.00", promo_code: "SAVE10" }, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    h.retrievePi.mockResolvedValue(settledPi(CHARGED - 900, 0, "10"));
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.costBreakdown).toEqual({ ok: false, reason: "promo discount does not match the code's percent" });
  });

  it("a promo booking whose Stripe read fails: ok:false and NO charged figure — never grandTotal, never a row-computed amount", async () => {
    h.state.detailRow = { data: promoRow, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    h.retrievePi.mockRejectedValue(stripeError("StripeConnectionError"));
    const res = await call(RTL);
    expect(res.status).toBe(200);
    const { reservation } = await res.json();
    expect(reservation.costBreakdown).toEqual({ ok: false, reason: "Stripe PaymentIntent read failed (StripeConnectionError)" });
    expect(reservation.cardPayment).toEqual({ status: "unknown" });
    expect(reservation).not.toHaveProperty("paidOnline");
    expect(reservation.dueAtLocation).toBe(20); // the fallback can still say what is due at the location
    expect(h.sentryEvents).toHaveLength(1);
    expect(h.sentryEvents[0]).toMatchObject({
      level: "warning",
      fingerprint: ["cost-breakdown-fallback", "stripe_read_failed"],
      tags: { inventory_source: "reslab", "payment.intentId": "pi_reslab" },
      contexts: { booking: { confirmationNumber: RTL } },
    });
  });

  it("an authorization still held is not a charge → unknown, not reported", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    h.retrievePi.mockResolvedValue({ id: "pi_reslab", status: "requires_capture", amount_received: 0, metadata: {}, latest_charge: null });
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.costBreakdown.ok).toBe(false);
    expect(reservation.cardPayment).toEqual({ status: "unknown" });
    expect(h.sentryEvents).toEqual([]);
  });

  it("a canceled PaymentIntent → released (no amount), not reported", async () => {
    h.state.detailRow = { data: { ...reslabRow, status: "cancelled", cancel_state: "released" }, error: null };
    h.getReservation.mockResolvedValue({ ...reslabReservation, cancelled: 1 });
    h.retrievePi.mockResolvedValue({ id: "pi_reslab", status: "canceled", amount_received: 0, metadata: {}, latest_charge: null });
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.status).toBe("cancelled");
    expect(reservation.costBreakdown).toEqual({ ok: false, reason: "the card hold was released" });
    expect(reservation.cardPayment).toEqual({ status: "released" });
    expect(h.sentryEvents).toEqual([]);
  });

  it.each(["requires_capture", "processing"])(
    "a cancelled booking whose PaymentIntent is %s is a LIVE hold — unknown (never 'released'), reported as an error",
    async (status) => {
      h.state.detailRow = { data: { ...reslabRow, status: "cancelled", cancel_state: "admin_claimed" }, error: null };
      h.getReservation.mockResolvedValue({ ...reslabReservation, cancelled: 1 });
      h.retrievePi.mockResolvedValue({ id: "pi_reslab", status, amount_received: 0, metadata: {}, latest_charge: null });
      const { reservation } = await (await call(RTL)).json();
      expect(reservation.cardPayment).toEqual({ status: "unknown" });
      expect(reservation.costBreakdown.ok).toBe(false);
      expect(reservation.costBreakdown.reason).toContain("a live hold remains");
      expect(h.sentryEvents).toHaveLength(1);
      expect(h.sentryEvents[0]).toMatchObject({
        level: "error",
        fingerprint: ["cost-breakdown-fallback", "live_hold_on_cancelled_booking"],
        contexts: { booking: { confirmationNumber: RTL } },
      });
    }
  );

  it("a CONFIRMED booking whose PaymentIntent is canceled: 'released' (nothing charged — true), but reported as an error", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    h.retrievePi.mockResolvedValue({ id: "pi_reslab", status: "canceled", amount_received: 0, metadata: {}, latest_charge: null });
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.status).toBe("confirmed");
    expect(reservation.cardPayment).toEqual({ status: "released" });
    expect(h.sentryEvents).toHaveLength(1);
    expect(h.sentryEvents[0]).toMatchObject({
      level: "error",
      fingerprint: ["cost-breakdown-fallback", "released_on_live_booking"],
    });
  });

  it("ResLab omits due_at_location_total → fallback, and the due is 'unconfirmed' (never read as 'nothing due')", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    const history = { ...reslabReservation.history[0], due_at_location_total: null };
    h.getReservation.mockResolvedValue({ ...reslabReservation, history: [history] });
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.costBreakdown).toEqual({ ok: false, reason: "due at location unreadable" });
    expect(reservation.fallbackDue).toEqual({ kind: "unconfirmed" });
  });

  it("a live $20 due + a mismatched anchor → the due is still shown as recorded, beside Stripe's amount", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    h.retrievePi.mockResolvedValue(settledPi(CHARGED + 2000)); // as if the due share had been charged online
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.costBreakdown).toEqual({ ok: false, reason: "the parts do not add up to what the card was charged" });
    expect(reservation.fallbackDue).toEqual({ kind: "amount", cents: 2000 });
    expect(reservation.cardPayment).toMatchObject({ status: "charged", chargedCents: CHARGED + 2000 });
  });

  it("Stripe unreadable: the due amount was never in question → shown as recorded", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    h.retrievePi.mockRejectedValue(stripeError("StripeConnectionError"));
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.fallbackDue).toEqual({ kind: "amount", cents: 2000 });
  });

  it("a recorded due above the grand total ($200 on $88) → unconfirmed, never printed", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    const history = { ...reslabReservation.history[0], grand_total: 88, due_at_location_total: 200 };
    h.getReservation.mockResolvedValue({ ...reslabReservation, history: [history] });
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.costBreakdown.ok).toBe(false);
    expect(reservation.fallbackDue).toEqual({ kind: "unconfirmed" });
  });

  it("a $0 due + a promo refusal (the split is in doubt) → unconfirmed, not 'nothing due'", async () => {
    h.state.detailRow = { data: { ...reslabRow, discount_amount: "9.00", promo_code: "SAVE10" }, error: null };
    const history = { ...reslabReservation.history[0], due_at_location_total: 0 };
    h.getReservation.mockResolvedValue({ ...reslabReservation, history: [history] });
    h.retrievePi.mockResolvedValue(settledPi(8076, 0, "10"));
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.costBreakdown).toEqual({ ok: false, reason: "promo discount does not match the code's percent" });
    expect(reservation.fallbackDue).toEqual({ kind: "unconfirmed" });
  });

  it("a boolean long_term_discount from ResLab → no 500; the breakdown falls back", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    const history = { ...reslabReservation.history[0], long_term_discount: true };
    h.getReservation.mockResolvedValue({ ...reslabReservation, history: [history] });
    const res = await call(RTL);
    expect(res.status).toBe(200);
    const { reservation } = await res.json();
    expect(reservation.costBreakdown).toEqual({ ok: false, reason: "long-stay discount unreadable" });
  });

  it("ANY throw in the breakdown → ok:false 'breakdown threw' + the original exception to Sentry; never a 500", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    h.breakdownThrows = new TypeError("Cannot read properties of undefined (reading 'trim')");
    const res = await call(RTL);
    expect(res.status).toBe(200);
    const { reservation } = await res.json();
    expect(reservation.costBreakdown).toEqual({ ok: false, reason: "breakdown threw" });
    expect(reservation.cardPayment).toEqual({ status: "charged", chargedCents: CHARGED, refundedCents: 0, netPaidCents: null });
    expect(reservation.fallbackDue).toEqual({ kind: "amount", cents: 2000 });
    expect(h.sentryEvents).toHaveLength(1);
    expect(h.sentryEvents[0]).toMatchObject({
      level: "error",
      fingerprint: ["cost-breakdown-fallback", "breakdown_threw"],
      message: "Cannot read properties of undefined (reading 'trim')",
    });
  });

  it("the PaymentIntent carries a promo percent but no discount was recorded → fallback (checked whenever EITHER side has a promo)", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    h.retrievePi.mockResolvedValue(settledPi(CHARGED - 600, 0, "10"));
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.costBreakdown).toEqual({ ok: false, reason: "promo discount does not match the code's percent" });
  });

  it("dedupe is per booking AND class: a transient Stripe warning does not mask a later breakdown error", async () => {
    h.state.detailRow = { data: { ...reslabRow, grand_total: "60.82" }, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    h.retrievePi.mockRejectedValueOnce(stripeError("StripeConnectionError"));
    await call(RTL); // warning
    await call(RTL); // Stripe answers → the persistent breakdown error
    await call(RTL); // same error again → deduped
    expect(h.sentryEvents.map((e) => [e.level, e.fingerprint?.[1]])).toEqual([
      ["warning", "stripe_read_failed"],
      ["error", "breakdown_reslab_s_total_no_longer_matches_the_booking_modified_after_booking"],
    ]);
  });

  it("the protection line is named from protection_plan_code", async () => {
    h.state.detailRow = {
      data: { ...reslabRow, protection_plan: "Plan B — $500", protection_plan_code: "B", protection_plan_price: "7.99" },
      error: null,
    };
    h.getReservation.mockResolvedValue(reslabReservation);
    h.retrievePi.mockResolvedValue(settledPi(CHARGED - 500)); // 12.99 → 7.99
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.costBreakdown.ok).toBe(true);
    expect(reservation.costBreakdown.lines).toContainEqual({ key: "protection", label: "Parking Protection — Plan B", cents: 799, credit: false });
  });

  it("no PaymentIntent on the row → ok:false; no Stripe call", async () => {
    h.state.detailRow = { data: { ...reslabRow, stripe_payment_intent_id: null }, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.costBreakdown).toEqual({ ok: false, reason: "booking has no PaymentIntent" });
    expect(reservation.cardPayment).toEqual({ status: "unknown" });
    expect(h.retrievePi).not.toHaveBeenCalled();
  });

  it("ResLab's total moved after booking (date edit) → ok:false; the fallback shows what Stripe took", async () => {
    h.state.detailRow = { data: { ...reslabRow, grand_total: "60.82" }, error: null };
    h.getReservation.mockResolvedValue(reslabReservation);
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.costBreakdown.ok).toBe(false);
    expect(reservation.cardPayment).toEqual({ status: "charged", chargedCents: CHARGED, refundedCents: 0, netPaidCents: null });
  });

  it("a cancelled booking with a refund: the record stays, nothing due at the location, the refund is shown", async () => {
    h.state.detailRow = { data: { ...reslabRow, status: "refunded", cancel_state: "refund_issued" }, error: null };
    h.getReservation.mockResolvedValue({ ...reslabReservation, cancelled: 1 });
    h.retrievePi.mockResolvedValue(settledPi(CHARGED, CHARGED - 600));
    const { reservation } = await (await call(RTL)).json();
    expect(reservation.status).toBe("cancelled");
    expect(reservation.costBreakdown).toMatchObject({
      ok: true,
      cancelled: true,
      dueAtLocationCents: 0,
      refundedCents: CHARGED - 600,
      netPaidCents: 600,
    });
    expect(reservation.cardPayment).toEqual({ status: "charged", chargedCents: CHARGED, refundedCents: CHARGED - 600, netPaidCents: 600 });
  });

  it("keeps the lenient ResLab-path fee/protection handling (NULL fee → 0; plan without price → suppressed + Sentry)", async () => {
    h.state.detailRow = {
      data: { ...reslabRow, triply_service_fee: null, protection_plan_price: null },
      error: null,
    };
    h.getReservation.mockResolvedValue(reslabReservation);
    const res = await call(RTL);
    expect(res.status).toBe(200);
    const { reservation } = await res.json();
    expect(reservation.serviceFee).toBe(0);
    expect(reservation.protectionPlan).toBeNull();
    expect(reservation.protectionPlanPrice).toBe(0);
    expect(reservation.grandTotal).toBe(70.82);
    expect(h.captureBookingError).toHaveBeenCalledTimes(1);
    // …but the Payment summary refuses: a NULL fee / unreadable premium is
    // unknown, never $0. The card side is what Stripe took.
    expect(reservation.costBreakdown.ok).toBe(false);
    expect(reservation.cardPayment).toEqual({ status: "charged", chargedCents: CHARGED, refundedCents: 0, netPaidCents: null });
    expect(h.sentryEvents).toHaveLength(1);
    expect(h.sentryEvents[0].level).toBe("error");
  });

  it("ResLab 404 → 404; other ResLab failure → 500", async () => {
    h.state.detailRow = { data: reslabRow, error: null };
    h.getReservation.mockRejectedValueOnce(new Error("ResLab API error 404: not found"));
    expect((await call(RTL)).status).toBe(404);
    h.getReservation.mockRejectedValueOnce(new Error("ResLab API error 502: bad gateway"));
    expect((await call(RTL)).status).toBe(500);
  });

  describe("cancelled status — either side counts", () => {
    const run = async (
      row: { status: string; cancel_state?: string | null } | null,
      reslabCancelled: 0 | 1
    ) => {
      h.state.detailRow = row
        ? { data: { ...reslabRow, cancel_state: null, ...row }, error: null }
        : { data: null, error: { message: "timeout", code: "57014" } };
      h.getReservation.mockResolvedValue({ ...reslabReservation, cancelled: reslabCancelled });
      const res = await call(RTL);
      expect(res.status).toBe(200);
      return (await res.json()).reservation.status as string;
    };
    const sentryMessages = () =>
      h.captureBookingError.mock.calls.map(([err]) => (err as Error).message);

    it("reads cancel_state in the detail select", async () => {
      await run({ status: "confirmed" }, 0);
      expect(h.state.detailSelect).toContain("cancel_state");
    });

    it("live on both sides → confirmed, nothing captured", async () => {
      expect(await run({ status: "confirmed" }, 0)).toBe("confirmed");
      expect(h.captureBookingError).not.toHaveBeenCalled();
    });

    it("a finished cancel (ResLab cancelled, row refunded) → cancelled, nothing captured", async () => {
      expect(await run({ status: "refunded", cancel_state: "refund_issued" }, 1)).toBe("cancelled");
      expect(h.captureBookingError).not.toHaveBeenCalled();
    });

    it.each(["refunded", "cancelled"])(
      "row %s but ResLab still live (failed admin ResLab cancel / Stripe-dashboard refund) → cancelled + Sentry",
      async (status) => {
        expect(await run({ status }, 0)).toBe("cancelled");
        expect(sentryMessages()).toEqual([
          `Booking ${RTL} is ${status} in our database but still live in ResLab — if it was meant to be cancelled, release the ResLab reservation; if not, set the row back to confirmed`,
        ]);
      }
    );

    it("cancelled in ResLab only, no cancel of ours in flight → cancelled + Sentry (refund owed?)", async () => {
      expect(await run({ status: "confirmed", cancel_state: null }, 1)).toBe("cancelled");
      expect(sentryMessages()).toEqual([
        `Booking ${RTL} is cancelled in ResLab but confirmed in our database — check whether the customer is owed a refund`,
      ]);
    });

    it.each(["claimed", "admin_claimed"])(
      "cancelled in ResLab while our cancel holds the claim (%s) → cancelled, nothing captured",
      async (cancel_state) => {
        expect(await run({ status: "confirmed", cancel_state }, 1)).toBe("cancelled");
        expect(h.captureBookingError).not.toHaveBeenCalled();
      }
    );

    it("a disputed booking is not cancelled", async () => {
      expect(await run({ status: "disputed" }, 0)).toBe("confirmed");
      expect(h.captureBookingError).not.toHaveBeenCalled();
    });

    it("a failed row read falls back to ResLab's flag alone, as before", async () => {
      expect(await run(null, 0)).toBe("confirmed");
      h.captureBookingError.mockReset();
      expect(await run(null, 1)).toBe("cancelled");
      expect(h.captureBookingError).toHaveBeenCalledTimes(1); // the failed read only
    });
  });
});

describe("ResLab booking — a stamped discountCents (promo plan Part 1)", () => {
  const RTL = "RTL856901";
  // The same lot and money as "ResLab booking — unchanged": grand 70.82 of
  // which 20.00 is due at the location, fee 5.95, Plan A 12.99 → 69.76 online.
  const row = {
    vehicle_info: { make: "Toyota", model: "Camry", color: "Blue", licensePlate: "XYZ987", state: "NJ" },
    triply_service_fee: "5.95",
    check_in: "2026-10-02T11:30:00",
    check_out: "2026-10-05T07:00:00",
    protection_plan: "Plan A",
    protection_plan_code: "A",
    protection_plan_price: "12.99",
    pg_identifier: "PG-9",
    pg_sync_status: "synced",
    airport_code: "EWR",
    inventory_source: "reslab",
    direct_lot_id: null,
    lot_snapshot: null,
    vehicle_size: null,
    vehicle_size_label: null,
    vehicle_surcharge_cents: null,
    vehicle_surcharge_tax_cents: null,
    status: "confirmed",
    subtotal: "60",
    tax_total: "8.82",
    fees_total: "2",
    grand_total: "70.82",
    discount_amount: "5.00",
    promo_code: "JFK5",
    due_at_location: "20",
    stripe_payment_intent_id: "pi_reslab",
    customers: { first_name: "Sam", last_name: "Lee", email: EMAIL, phone: "5550001111" },
  };
  const reservation = {
    reservation_number: RTL,
    reserved_by: "Sam Lee",
    cancelled: 0,
    history: [
      {
        id: 4242,
        reserved_for: "Sam Lee",
        email: EMAIL,
        phone: "5550001111",
        grand_total: 70.82,
        subtotal: 60,
        total_tax: 8.82,
        total_fees: 2,
        due_at_location_total: 20,
        location: { id: 52, name: "Some ResLab Lot", address: "1 Airport Rd", city: "Newark", state: { code: "NJ" }, zip_code: "07114" },
        dates: [],
      },
    ],
  };
  const CHARGED = 6976 - 500;
  const stampedPi = (metadata: Record<string, string>, amountReceived = CHARGED) => ({ ...settledPi(amountReceived), metadata });

  it("a fixed code (no percent): checked against the stamp — 'Promo discount (JFK5)', the card line net of it, nothing reported", async () => {
    h.state.detailRow = { data: row, error: null };
    h.getReservation.mockResolvedValue(reservation);
    h.retrievePi.mockResolvedValue(stampedPi({ discountCents: "500" }));
    const { reservation: r } = await (await call(RTL)).json();
    expect(r.costBreakdown.ok).toBe(true);
    expect(r.costBreakdown.lines).toContainEqual({ key: "promo", label: "Promo discount (JFK5)", cents: 500, credit: true });
    expect(r.costBreakdown.paidOnlineCents).toBe(CHARGED);
    expect(h.sentryEvents).toEqual([]);
  });

  it("both keys: the stamp is the authority — the percent (10 % of 60 = 6.00) is not consulted", async () => {
    h.state.detailRow = { data: row, error: null };
    h.getReservation.mockResolvedValue(reservation);
    h.retrievePi.mockResolvedValue(stampedPi({ discountCents: "500", discountPercent: "10" }));
    const { reservation: r } = await (await call(RTL)).json();
    expect(r.costBreakdown.ok).toBe(true);
  });

  it("an unusable stamp → fallback, reported as its own class", async () => {
    h.state.detailRow = { data: row, error: null };
    h.getReservation.mockResolvedValue(reservation);
    h.retrievePi.mockResolvedValue(stampedPi({ discountCents: "5.00" }));
    const { reservation: r } = await (await call(RTL)).json();
    expect(r.costBreakdown).toEqual({ ok: false, reason: "stamped promo discount unreadable" });
    expect(r.cardPayment).toEqual({ status: "charged", chargedCents: CHARGED, refundedCents: 0, netPaidCents: null });
    expect(h.sentryEvents[0].fingerprint).toEqual(["cost-breakdown-fallback", "breakdown_stamped_promo_discount_unreadable"]);
  });

  it("a stamp larger than the parking paid online (70.82 − 20.00) → fallback, reported", async () => {
    h.state.detailRow = { data: { ...row, discount_amount: "50.83" }, error: null };
    h.getReservation.mockResolvedValue(reservation);
    h.retrievePi.mockResolvedValue(stampedPi({ discountCents: "5083" }, 6976 - 5083));
    const { reservation: r } = await (await call(RTL)).json();
    expect(r.costBreakdown).toEqual({ ok: false, reason: "stamped promo discount exceeds the parking paid online" });
    expect(h.sentryEvents[0].fingerprint).toEqual([
      "cost-breakdown-fallback",
      "breakdown_stamped_promo_discount_exceeds_the_parking_paid_online",
    ]);
  });
});
