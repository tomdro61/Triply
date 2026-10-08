import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { addDays, format, subDays } from "date-fns";

const { db, sentry, resendSend, stripeList, getLocation, noSweep, FakeReslabError } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  class FakeReslabError extends Error {
    constructor(public statusCode: number, message: string) {
      super(message);
      this.name = "ReslabError";
    }
  }
  return {
    db: new FakeSupabase(),
    sentry: { captureMessage: vi.fn(), withScope: vi.fn(), captureException: vi.fn() },
    resendSend: vi.fn(),
    stripeList: vi.fn(),
    getLocation: vi.fn(),
    noSweep: vi.fn(),
    FakeReslabError,
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/resend/client", () => ({
  resend: { emails: { send: resendSend } },
  FROM_EMAIL: "Triply <bookings@triplypro.com>",
}));
vi.mock("@/lib/stripe/client", () => ({ stripe: { paymentIntents: { list: stripeList } } }));
vi.mock("@/lib/reslab/client", () => ({ reslab: { getLocation }, ReslabError: FakeReslabError }));
// The cron must never start a ResLab sweep: only the no-sweep accessor and the
// blocked-id set are reachable from it.
vi.mock("@/lib/reslab/search", () => ({
  BLOCKED_RESLAB_LOCATION_IDS: new Set([416]),
  getChannelLocationsNoSweep: noSweep,
}));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: sentry.captureMessage,
  captureException: sentry.captureException,
  withScope: (fn: (scope: unknown) => void) => {
    sentry.withScope();
    fn({ setFingerprint: vi.fn(), setTag: vi.fn(), setContext: vi.fn(), setLevel: vi.fn() });
  },
  flush: vi.fn().mockResolvedValue(true),
}));

import { GET } from "../route";
import { verifyRecoveryToken } from "@/lib/checkout-recovery/unsubscribe-token";

const CRON_SECRET = process.env.CRON_SECRET as string;
const POSTAL = "88 Broadway, Revere, MA 02151";
const MIN = 60;
const nowSec = () => Math.floor(Date.now() / 1000);
const inTenDays = format(addDays(new Date(), 10), "yyyy-MM-dd");
const inTwelveDays = format(addDays(new Date(), 12), "yyyy-MM-dd");
const inTwentyDays = format(addDays(new Date(), 20), "yyyy-MM-dd");
const inTwentyTwoDays = format(addDays(new Date(), 22), "yyyy-MM-dd");
const yesterday = format(subDays(new Date(), 1), "yyyy-MM-dd");
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

interface PiOverrides {
  id?: string;
  status?: string;
  ageMin?: number;
  amount?: number;
  livemode?: boolean;
  metadata?: Record<string, string>;
}

/** A PaymentIntent exactly as POST /api/checkout/lot stamps it. Lot 10 (a
 *  JFK lot) — 416 is on BLOCKED_RESLAB_LOCATION_IDS and has its own test. */
function pi(o: PiOverrides = {}) {
  return {
    id: o.id ?? "pi_abandoned",
    status: o.status ?? "requires_payment_method",
    created: nowSec() - (o.ageMin ?? 50) * MIN,
    amount: o.amount ?? 8423,
    livemode: o.livemode ?? true,
    metadata: {
      lotId: "reslab-10",
      locationId: "10",
      checkin: inTenDays,
      checkout: inTwelveDays,
      checkinTime: "10:00 AM",
      checkoutTime: "6:00 PM",
      parkingTypeId: "7",
      customerEmail: "alice@example.com",
      ...o.metadata,
    },
  };
}

/** Metadata for a DIFFERENT trip (same lot, later dates). */
const otherTrip = { checkin: inTwentyDays, checkout: inTwentyTwoDays };
/** The n-th distinct trip — fixtures with several addresses need one each,
 *  because only the newest attempt per TRIP is ever a candidate. */
const tripN = (n: number) => ({
  checkin: format(addDays(new Date(), 30 + 3 * n), "yyyy-MM-dd"),
  checkout: format(addDays(new Date(), 32 + 3 * n), "yyyy-MM-dd"),
});

/** The same trip as `pi()` books it, as bookings / pending_bookings store it. */
const storedTrip = {
  from: `${inTenDays} 10:00:00`,
  to: `${inTwelveDays} 18:00:00`,
};

let stripePis: ReturnType<typeof pi>[] = [];

function req(headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  return new NextRequest("https://www.triplypro.com/api/cron/checkout-recovery", { headers });
}

const sentTo = () => resendSend.mock.calls.map((c) => c[0].to[0]);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CHECKOUT_RECOVERY_EMAILS_ENABLED = "true";
  process.env.TRIPLY_POSTAL_ADDRESS = POSTAL;
  resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
  stripePis = [];
  stripeList.mockImplementation(() =>
    (async function* () {
      yield* stripePis;
    })()
  );
  // Near JFK, so the airport resolves. No snapshot by default → live lookup.
  getLocation.mockResolvedValue({ name: "Jet Parking JFK", latitude: "40.6650", longitude: "-73.7900" });
  noSweep.mockResolvedValue(null);
  db.tables = {
    bookings: [],
    customers: [],
    pending_bookings: [],
    checkout_recovery_emails: [],
    checkout_recovery_optouts: [],
    newsletter_subscribers: [],
    booking_waitlist: [],
  };
  db.log = [];
  db.clearFailures();
});

afterEach(() => {
  delete process.env.CHECKOUT_RECOVERY_EMAILS_ENABLED;
  delete process.env.TRIPLY_POSTAL_ADDRESS;
});

describe("GET /api/cron/checkout-recovery — auth + gate", () => {
  it("missing or wrong bearer → 401, Stripe never read, nothing sent", async () => {
    expect((await GET(req({}))).status).toBe(401);
    expect((await GET(req({ authorization: "Bearer wrong" }))).status).toBe(401);
    expect(stripeList).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("does nothing unless CHECKOUT_RECOVERY_EMAILS_ENABLED=true", async () => {
    delete process.env.CHECKOUT_RECOVERY_EMAILS_ENABLED;
    stripePis = [pi()];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).disabled).toBe(true);
    expect(stripeList).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("refuses (503, nothing claimed, Sentry) without a postal address — commercial mail must carry one", async () => {
    process.env.TRIPLY_POSTAL_ADDRESS = "   ";
    stripePis = [pi()];
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(stripeList).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
    expect(db.tables.checkout_recovery_emails).toHaveLength(0);
    expect(sentry.captureException).toHaveBeenCalled();
  });

  it("lists only the last 24 h of PaymentIntents, with a request timeout", async () => {
    await GET(req());
    const [params, options] = stripeList.mock.calls[0];
    const created = params.created.gte as number;
    expect(nowSec() - created).toBeGreaterThanOrEqual(24 * 3600 - 5);
    expect(nowSec() - created).toBeLessThanOrEqual(24 * 3600 + 5);
    // Retries off: stripe-node would otherwise retry a timed-out page twice.
    expect(options).toEqual({ timeout: 15_000, maxNetworkRetries: 0 });
  });
});

describe("GET /api/cron/checkout-recovery — selection", () => {
  it("emails only checkouts 45 min – 24 h old", async () => {
    stripePis = [
      pi({ id: "pi_young", ageMin: 30, metadata: { ...tripN(1), customerEmail: "young@example.com" } }),
      pi({ id: "pi_ok", ageMin: 50, metadata: { ...tripN(2), customerEmail: "ok@example.com" } }),
      pi({ id: "pi_edge", ageMin: 23 * 60, metadata: { ...tripN(3), customerEmail: "edge@example.com" } }),
      pi({ id: "pi_old", ageMin: 25 * 60, metadata: { ...tripN(4), customerEmail: "old@example.com" } }),
    ];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(sentTo().sort()).toEqual(["edge@example.com", "ok@example.com"]);
  });

  it("ignores PaymentIntents that are not requires_payment_method", async () => {
    stripePis = [
      pi({ id: "pi_action", status: "requires_action", metadata: { customerEmail: "a@example.com" } }),
      pi({ id: "pi_canceled", status: "canceled", metadata: { customerEmail: "b@example.com" } }),
    ];
    await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("never emails about a check-in that has already passed", async () => {
    stripePis = [
      pi({ id: "pi_past", metadata: { customerEmail: "past@example.com", checkin: yesterday } }),
      pi({ id: "pi_future", metadata: { customerEmail: "future@example.com" } }),
    ];
    const res = await GET(req());
    expect(sentTo()).toEqual(["future@example.com"]);
    expect((await res.json()).skipped.checkinPassed).toBe(1);
  });

  it("skips a PaymentIntent with missing booking metadata instead of guessing", async () => {
    const broken = pi({ id: "pi_broken" });
    delete (broken.metadata as Record<string, string>).checkinTime;
    stripePis = [broken];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).skipped.invalidMetadata).toBe(1);
  });

  it("never invites anyone back to a blocked lot or to a direct lot that cannot be booked yet", async () => {
    stripePis = [
      pi({ id: "pi_blocked", metadata: { lotId: "reslab-416", locationId: "416", customerEmail: "blocked@example.com" } }),
      pi({ id: "pi_direct", metadata: { lotId: "direct-1", customerEmail: "direct@example.com" } }),
      pi({ id: "pi_fine", metadata: { customerEmail: "fine@example.com" } }),
    ];
    const res = await GET(req());
    expect(sentTo()).toEqual(["fine@example.com"]);
    const body = await res.json();
    expect(body.skipped.blockedLot).toBe(1);
    expect(body.skipped.directLot).toBe(1);
  });

  it("skips when the same address paid afterwards (succeeded or authorized), case-insensitively", async () => {
    stripePis = [
      pi({ id: "pi_a", ageMin: 60, metadata: { customerEmail: "Alice@Example.com" } }),
      pi({ id: "pi_a_paid", status: "requires_capture", ageMin: 55, metadata: { ...otherTrip, customerEmail: "alice@example.com" } }),
      pi({ id: "pi_b", ageMin: 60, metadata: { customerEmail: "bob@example.com" } }),
      pi({ id: "pi_b_paid", status: "succeeded", ageMin: 58, metadata: { ...otherTrip, customerEmail: "BOB@example.COM " } }),
    ];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).skipped.paidSince).toBe(2);
  });

  it("a payment made BEFORE the abandoned checkout for a DIFFERENT trip at another lot does not block the email", async () => {
    stripePis = [
      pi({ id: "pi_old_trip", status: "succeeded", ageMin: 20 * 60, metadata: { ...otherTrip, lotId: "reslab-99", locationId: "99" } }),
      pi({ id: "pi_new_trip", ageMin: 50 }),
    ];
    await GET(req());
    expect(sentTo()).toEqual(["alice@example.com"]);
  });

  it("a payment at the SAME lot by the same address, before the abandoned checkout (a date-change attempt), blocks it", async () => {
    stripePis = [
      pi({ id: "pi_booked", status: "requires_capture", ageMin: 20 * 60, metadata: otherTrip }),
      pi({ id: "pi_new_dates", ageMin: 50 }),
    ];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).skipped.sameLotPaid).toBe(1);
  });

  // The two Criticals from the PR #44 review. Checkout mints a NEW
  // PaymentIntent every time the payment step is re-entered, so "paid, then
  // pressed Back" leaves an abandoned PaymentIntent NEWER than the paid one.
  it("same trip paid EARLIER on another PaymentIntent (paid → Back → left) → no email", async () => {
    stripePis = [
      pi({ id: "pi_paid_first", status: "requires_capture", ageMin: 70 }),
      pi({ id: "pi_back_button", ageMin: 60 }),
    ];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).skipped.tripAttempted).toBe(1);
  });

  it("typo'd email first, fixed and paid on the same trip → the typo'd address is never emailed", async () => {
    stripePis = [
      pi({ id: "pi_typo", ageMin: 65, metadata: { customerEmail: "alice@exmaple.com" } }),
      pi({ id: "pi_fixed", status: "requires_capture", ageMin: 60, metadata: { customerEmail: "alice@example.com" } }),
    ];
    await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("typo'd email, fixed, and abandoned AGAIN on the same trip → only the corrected (newest) address is emailed", async () => {
    stripePis = [
      pi({ id: "pi_typo", ageMin: 65, metadata: { customerEmail: "jon@example.com" } }),
      pi({ id: "pi_fixed", ageMin: 60, metadata: { customerEmail: "john@example.com" } }),
    ];
    const res = await GET(req());
    expect(sentTo()).toEqual(["john@example.com"]);
    expect((await res.json()).skipped.superseded).toBe(1);
  });

  it("a NEWER PaymentIntent too young to judge (customer is back on the checkout now) supersedes the old one — nothing is sent yet", async () => {
    stripePis = [
      pi({ id: "pi_old_same_trip", ageMin: 50, metadata: { customerEmail: "back@example.com" } }),
      pi({ id: "pi_new_same_trip", ageMin: 10, metadata: { customerEmail: "back@example.com" } }),
      pi({ id: "pi_old_other", ageMin: 50, metadata: { ...otherTrip, customerEmail: "edit@example.com" } }),
      // Same address, a THIRD trip, mid-3DS right now.
      pi({ id: "pi_new_other", status: "requires_action", ageMin: 5, metadata: { ...tripN(1), customerEmail: "edit@example.com" } }),
    ];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.skipped.superseded).toBe(2);
    expect(body.skipped.tooYoung).toBe(1);
  });

  it("same trip mid-3DS (requires_action) or cancelled by fulfilment on another PaymentIntent → no email", async () => {
    stripePis = [
      pi({ id: "pi_3ds_old", ageMin: 60, metadata: { customerEmail: "three@example.com" } }),
      pi({ id: "pi_3ds", status: "requires_action", ageMin: 50, metadata: { customerEmail: "three@example.com" } }),
      pi({ id: "pi_c_old", ageMin: 60, metadata: { ...otherTrip, customerEmail: "c@example.com" } }),
      pi({ id: "pi_c_canceled", status: "canceled", ageMin: 55, metadata: { ...otherTrip, customerEmail: "c@example.com" } }),
    ];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).skipped.tripAttempted).toBe(2);
  });

  it("skips when the same trip is already in bookings — any email, booked before the abandoned re-entry", async () => {
    stripePis = [pi({ id: "pi_x", ageMin: 60 })];
    db.tables.customers = [{ id: "cust_1", email: "someone-else@example.com" }];
    db.tables.bookings = [
      {
        id: "b1",
        customer_id: "cust_1",
        reslab_location_id: 10,
        status: "confirmed",
        // PostgREST renders a TIMESTAMP column with a "T".
        check_in: storedTrip.from.replace(" ", "T"),
        check_out: storedTrip.to.replace(" ", "T"),
        created_at: minutesAgo(3 * 24 * 60),
      },
    ];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).bookedTrip).toBe(1);
  });

  it("skips when the same address booked (a different trip) since, matching the customer email case-insensitively", async () => {
    stripePis = [pi({ id: "pi_x", ageMin: 60 })];
    db.tables.customers = [{ id: "cust_1", email: "ALICE@example.com" }];
    db.tables.bookings = [
      {
        id: "b1",
        customer_id: "cust_1",
        reslab_location_id: 10,
        status: "confirmed",
        check_in: `${inTwentyDays}T10:00:00`,
        check_out: `${inTwentyTwoDays}T18:00:00`,
        created_at: minutesAgo(10),
      },
    ];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).bookedTrip).toBe(1);
  });

  it("a booking by the same address made BEFORE the abandoned checkout, at another lot, does not block; at the SAME lot it does", async () => {
    stripePis = [pi({ id: "pi_x", ageMin: 60 })];
    db.tables.customers = [{ id: "cust_1", email: "alice@example.com" }];
    db.tables.bookings = [
      {
        id: "b1",
        customer_id: "cust_1",
        reslab_location_id: 99,
        check_in: `${inTwentyDays}T10:00:00`,
        check_out: `${inTwentyTwoDays}T18:00:00`,
        created_at: minutesAgo(5 * 24 * 60),
      },
    ];
    await GET(req());
    expect(sentTo()).toEqual(["alice@example.com"]);

    vi.clearAllMocks();
    resendSend.mockResolvedValue({ data: { id: "email_2" }, error: null });
    noSweep.mockResolvedValue(null);
    getLocation.mockResolvedValue({ name: "Jet Parking JFK", latitude: "40.6650", longitude: "-73.7900" });
    stripeList.mockImplementation(() => (async function* () { yield* stripePis; })());
    db.tables.checkout_recovery_emails = [];
    db.tables.bookings[0].reslab_location_id = 10;
    db.tables.bookings[0].status = "confirmed";
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).bookedTrip).toBe(1);
  });

  it("a booking at the same lot that is already over, cancelled or refunded does NOT block — that is a returning customer", async () => {
    const booking = (overrides: Record<string, unknown>) => ({
      id: "b1",
      customer_id: "cust_1",
      reslab_location_id: 10,
      check_in: `${inTwentyDays}T10:00:00`,
      check_out: `${inTwentyTwoDays}T18:00:00`,
      status: "confirmed",
      created_at: minutesAgo(20 * 24 * 60),
      ...overrides,
    });
    const cases = [
      booking({ check_in: `${format(subDays(new Date(), 12), "yyyy-MM-dd")}T10:00:00`, check_out: `${format(subDays(new Date(), 10), "yyyy-MM-dd")}T18:00:00` }),
      booking({ status: "cancelled" }),
      booking({ status: "refunded" }),
    ];
    for (const b of cases) {
      vi.clearAllMocks();
      resendSend.mockResolvedValue({ data: { id: "email_x" }, error: null });
      noSweep.mockResolvedValue(null);
      getLocation.mockResolvedValue({ name: "Jet Parking JFK", latitude: "40.6650", longitude: "-73.7900" });
      stripePis = [pi({ id: "pi_return", ageMin: 60 })];
      stripeList.mockImplementation(() => (async function* () { yield* stripePis; })());
      db.tables.checkout_recovery_emails = [];
      db.tables.customers = [{ id: "cust_1", email: "alice@example.com" }];
      db.tables.bookings = [b];
      await GET(req());
      expect(sentTo(), JSON.stringify(b)).toEqual(["alice@example.com"]);
    }
  });

  it("skips when Pay Now was clicked since for the same trip or by the same address (pending_bookings)", async () => {
    stripePis = [
      pi({ id: "pi_trip", ageMin: 60, metadata: { customerEmail: "trip@example.com" } }),
      pi({ id: "pi_mail", ageMin: 60, metadata: { ...otherTrip, customerEmail: "mail@example.com" } }),
      pi({ id: "pi_free", ageMin: 60, metadata: { ...tripN(1), customerEmail: "free@example.com" } }),
    ];
    db.tables.pending_bookings = [
      {
        stripe_payment_intent_id: "pi_other_1",
        location_id: 10,
        from_date: storedTrip.from,
        to_date: storedTrip.to,
        status: "expired",
        customer: { email: "stranger@example.com" },
        created_at: minutesAgo(50),
      },
      {
        stripe_payment_intent_id: "pi_other_2",
        location_id: 10,
        from_date: `${inTwentyDays} 11:00:00`,
        to_date: `${inTwentyTwoDays} 11:00:00`,
        status: "processing",
        customer: { email: "Mail@Example.com" },
        created_at: minutesAgo(40),
      },
    ];
    const res = await GET(req());
    expect(sentTo()).toEqual(["free@example.com"]);
    expect((await res.json()).pendingTrip).toBe(2);
  });

  it("a money-retained Pay-Now attempt for the same trip two days ago (outside Stripe's 24 h list) still suppresses", async () => {
    stripePis = [pi({ id: "pi_again", ageMin: 60 })];
    db.tables.pending_bookings = [
      {
        stripe_payment_intent_id: "pi_day_one",
        location_id: 10,
        from_date: storedTrip.from,
        to_date: storedTrip.to,
        status: "needs_reconciliation",
        customer: { email: "alice@example.com" },
        created_at: minutesAgo(2 * 24 * 60),
      },
    ];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).pendingTrip).toBe(1);
  });

  it("the candidate's own pending_bookings row: `pending` / `expired` still emails, anything further never does", async () => {
    stripePis = [
      pi({ id: "pi_declined", ageMin: 60, metadata: { customerEmail: "declined@example.com" } }),
      pi({ id: "pi_done", ageMin: 60, metadata: { ...otherTrip, customerEmail: "done@example.com" } }),
    ];
    db.tables.pending_bookings = [
      {
        stripe_payment_intent_id: "pi_declined",
        location_id: 10,
        from_date: storedTrip.from,
        to_date: storedTrip.to,
        status: "expired",
        customer: { email: "declined@example.com" },
        created_at: minutesAgo(58),
      },
      {
        stripe_payment_intent_id: "pi_done",
        location_id: 10,
        from_date: `${inTwentyDays} 10:00:00`,
        to_date: `${inTwentyTwoDays} 18:00:00`,
        status: "completed",
        customer: { email: "done@example.com" },
        created_at: minutesAgo(58),
      },
    ];
    const res = await GET(req());
    expect(sentTo()).toEqual(["declined@example.com"]);
    expect((await res.json()).pendingTrip).toBe(1);
  });

  it("sends ONE email per address, for the most recent abandoned checkout", async () => {
    stripePis = [
      pi({ id: "pi_first", ageMin: 300, amount: 5000 }),
      pi({ id: "pi_second", ageMin: 60, amount: 6000 }),
    ];
    await GET(req());
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(db.tables.checkout_recovery_emails.map((r) => r.stripe_payment_intent_id)).toEqual(["pi_second"]);
    expect(resendSend.mock.calls[0][0].html).toContain("$60.00");
  });
});

describe("GET /api/cron/checkout-recovery — the lot", () => {
  const snapshotLot = (overrides: Record<string, unknown> = {}) => ({
    id: 10,
    name: "Snapshot Parking JFK",
    latitude: "40.6650",
    longitude: "-73.7900",
    timezone: { id: 1, name: "Eastern", code: "America/New_York" },
    hours_before_reservation: 1,
    ...overrides,
  });

  it("takes the lot from the shared snapshot — no live ResLab call, and the same name on every retry", async () => {
    stripePis = [pi()];
    noSweep.mockResolvedValue([snapshotLot()]);
    await GET(req());
    expect(getLocation).not.toHaveBeenCalled();
    expect(resendSend.mock.calls[0][0].html).toContain("Snapshot Parking JFK (JFK)");
  });

  it("a lot ResLab reports gone (404) is never emailed about, and nothing is claimed", async () => {
    stripePis = [pi()];
    getLocation.mockRejectedValueOnce(new FakeReslabError(404, "Not found"));
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect(db.tables.checkout_recovery_emails).toHaveLength(0);
    expect((await res.json()).lotGone).toBe(1);
  });

  it("a check-in TOMORROW inside a lot's 24 h notice period is not emailed either — the gate is not same-day only", async () => {
    // 8:00 PM New York on Oct 19; check-in Oct 20 at 10:00 AM = 14 h ahead.
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-10-20T00:00:00Z") });
    try {
      const tomorrow = { checkin: "2026-10-20", checkout: "2026-10-22", checkinTime: "10:00 AM" };
      stripePis = [pi({ id: "pi_tmrw", ageMin: 50, metadata: { ...tomorrow, customerEmail: "tmrw@example.com" } })];
      noSweep.mockResolvedValue([snapshotLot({ hours_before_reservation: 24 })]);
      let res = await GET(req());
      expect(resendSend).not.toHaveBeenCalled();
      expect((await res.json()).checkinTooSoon).toBe(1);

      noSweep.mockResolvedValue([snapshotLot({ hours_before_reservation: 12 })]);
      res = await GET(req());
      expect(sentTo()).toEqual(["tmrw@example.com"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the gate runs in the LOT's own zone, not the airport's or the latest US one", async () => {
    // 09:00Z Oct 20 = 11:00 PM Oct 19 in Honolulu, 05:00 AM in New York.
    // Check-in Oct 20 8:00 AM HST = 18:00Z, 9 h ahead there: inside a 12 h
    // notice, clear of a 2 h one. (The select.ts floor, judged in the latest
    // US zone, lets both through — only the lot-zone gate can tell.)
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-10-20T09:00:00Z") });
    try {
      const hawaii = { checkin: "2026-10-20", checkout: "2026-10-22", checkinTime: "8:00 AM" };
      stripePis = [pi({ id: "pi_hnl", ageMin: 50, metadata: { ...hawaii, customerEmail: "hnl@example.com" } })];
      noSweep.mockResolvedValue([
        snapshotLot({ timezone: { id: 2, name: "Hawaii", code: "Pacific/Honolulu" }, hours_before_reservation: 12 }),
      ]);
      let res = await GET(req());
      expect(resendSend).not.toHaveBeenCalled();
      expect((await res.json()).checkinTooSoon).toBe(1);

      noSweep.mockResolvedValue([
        snapshotLot({ timezone: { id: 2, name: "Hawaii", code: "Pacific/Honolulu" }, hours_before_reservation: 2 }),
      ]);
      res = await GET(req());
      expect(sentTo()).toEqual(["hnl@example.com"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a same-day check-in inside the lot's own notice period is not emailed (the link would 400 at ResLab)", async () => {
    // 11:00 AM New York; check-in today at 2:00 PM = 3 h ahead.
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date("2026-10-20T15:00:00Z") });
    try {
      const sameDay = { checkin: "2026-10-20", checkout: "2026-10-22", checkinTime: "2:00 PM" };
      stripePis = [
        pi({ id: "pi_tight", ageMin: 50, metadata: { ...sameDay, customerEmail: "tight@example.com" } }),
      ];
      noSweep.mockResolvedValue([snapshotLot({ hours_before_reservation: 4 })]);
      let res = await GET(req());
      expect(resendSend).not.toHaveBeenCalled();
      expect((await res.json()).checkinTooSoon).toBe(1);
      expect(db.tables.checkout_recovery_emails).toHaveLength(0);

      noSweep.mockResolvedValue([snapshotLot({ hours_before_reservation: 1 })]);
      res = await GET(req());
      expect(sentTo()).toEqual(["tight@example.com"]);
      expect((await res.json()).checkinTooSoon).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /api/cron/checkout-recovery — suppression", () => {
  it("honours this email's opt-out, the newsletter unsubscribe and the waitlist unsubscribe", async () => {
    stripePis = [
      pi({ id: "pi_1", metadata: { ...tripN(1), customerEmail: "optout@example.com" } }),
      pi({ id: "pi_2", metadata: { ...tripN(2), customerEmail: "news@example.com" } }),
      pi({ id: "pi_3", metadata: { ...tripN(3), customerEmail: "wait@example.com" } }),
      pi({ id: "pi_4", metadata: { ...tripN(4), customerEmail: "news-subscribed@example.com" } }),
      pi({ id: "pi_5", metadata: { ...tripN(5), customerEmail: "fine@example.com" } }),
    ];
    const ts = new Date().toISOString();
    db.tables.checkout_recovery_optouts = [{ email: "optout@example.com" }];
    db.tables.newsletter_subscribers = [
      { email: "news@example.com", unsubscribed_at: ts },
      { email: "news-subscribed@example.com", unsubscribed_at: null },
    ];
    db.tables.booking_waitlist = [{ email: "wait@example.com", unsubscribed_at: ts }];
    const res = await GET(req());
    expect(sentTo().sort()).toEqual(["fine@example.com", "news-subscribed@example.com"]);
    expect((await res.json()).suppressed).toBe(3);
  });

  it("fails CLOSED (500, nothing sent) when the opt-out list cannot be read", async () => {
    stripePis = [pi()];
    db.failOnce("checkout_recovery_optouts", "select", "connection reset");
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(resendSend).not.toHaveBeenCalled();
    expect(db.tables.checkout_recovery_emails).toHaveLength(0);
  });

  it("fails CLOSED when bookings or pending_bookings cannot be read — an unknown trip state is never emailed", async () => {
    stripePis = [pi()];
    db.failOnce("bookings", "select", "timeout");
    expect((await GET(req())).status).toBe(500);
    db.failOnce("pending_bookings", "select", "timeout");
    expect((await GET(req())).status).toBe(500);
    expect(resendSend).not.toHaveBeenCalled();
    expect(db.tables.checkout_recovery_emails).toHaveLength(0);
  });
});

describe("GET /api/cron/checkout-recovery — idempotency + 7-day cap", () => {
  it("a second run never re-sends the same checkout", async () => {
    stripePis = [pi()];
    await GET(req());
    await GET(req());
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(db.tables.checkout_recovery_emails).toHaveLength(1);
    expect(db.tables.checkout_recovery_emails[0].status).toBe("sent");
  });

  it("every send carries a Resend idempotency key on the PaymentIntent, so a lost response retried next tick cannot double-send", async () => {
    stripePis = [pi({ id: "pi_idem" })];
    await GET(req());
    expect(resendSend.mock.calls[0][1]).toEqual({ idempotencyKey: "checkout-recovery/pi_idem" });
  });

  it("the UNIQUE claim blocks a send even when the cap query would not (overlapping run)", async () => {
    stripePis = [pi({ id: "pi_race" })];
    // Claimed by a concurrent run in the other Stripe mode, so the livemode-
    // scoped cap lookup does not see it — only the PaymentIntent lock can.
    db.tables.checkout_recovery_emails = [
      {
        id: "claim_other_run",
        stripe_payment_intent_id: "pi_race",
        email: "someone-else@example.com",
        livemode: false,
        status: "claimed",
        created_at: new Date().toISOString(),
      },
    ];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).alreadyClaimed).toBe(1);
  });

  it("at most one recovery email per address per 7 days", async () => {
    stripePis = [
      pi({ id: "pi_recent", metadata: { ...tripN(1), customerEmail: "recent@example.com" } }),
      pi({ id: "pi_stale", metadata: { ...tripN(2), customerEmail: "stale@example.com" } }),
    ];
    db.tables.checkout_recovery_emails = [
      {
        id: "r1",
        stripe_payment_intent_id: "pi_earlier_1",
        email: "recent@example.com",
        livemode: true,
        status: "sent",
        created_at: subDays(new Date(), 3).toISOString(),
      },
      {
        id: "r2",
        stripe_payment_intent_id: "pi_earlier_2",
        email: "stale@example.com",
        livemode: true,
        status: "sent",
        created_at: subDays(new Date(), 8).toISOString(),
      },
    ];
    const res = await GET(req());
    expect(sentTo()).toEqual(["stale@example.com"]);
    expect((await res.json()).cappedWithin7d).toBe(1);
  });

  it("a Resend 409 (key already used — the email may be out) is recorded as sent, alarmed, and never retried", async () => {
    stripePis = [pi({ id: "pi_409" })];
    resendSend.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 409, message: "Idempotency key was used with a different payload", name: "invalid_idempotent_request" },
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sentUnconfirmed).toBe(1);
    expect(body.sendFailed).toBe(0);
    const row = db.tables.checkout_recovery_emails[0];
    expect(row.status).toBe("sent");
    expect(String(row.last_error)).toContain("different payload");
    expect(sentry.captureMessage).toHaveBeenCalled();

    await GET(req());
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it("a claim INSERT that errors (e.g. the 3 s abort) is counted, nothing is sent, and nothing is deleted inline — a commit-after-abort row is left for the sweep", async () => {
    stripePis = [pi({ id: "pi_claim_err" })];
    db.failOnce("checkout_recovery_emails", "insert", "AbortError: signal timed out", "");
    const res = await GET(req());
    expect((await res.json()).claimFailed).toBe(1);
    expect(resendSend).not.toHaveBeenCalled();
    expect(db.log).not.toContainEqual({ table: "checkout_recovery_emails", op: "delete" });
  });

  it("a `retry` row (transient failure last tick) is re-claimed and sent; a `sent`/`failed`/foreign `claimed` row is not", async () => {
    stripePis = [
      pi({ id: "pi_retry", metadata: { ...tripN(1), customerEmail: "retry@example.com" } }),
      pi({ id: "pi_done", metadata: { ...tripN(2), customerEmail: "done@example.com" } }),
    ];
    db.tables.checkout_recovery_emails = [
      { id: "r", stripe_payment_intent_id: "pi_retry", email: "retry@example.com", livemode: true, status: "retry", created_at: minutesAgo(15), claimed_at: minutesAgo(15), last_error: "unavailable" },
      { id: "d", stripe_payment_intent_id: "pi_done", email: "done@example.com", livemode: true, status: "sent", created_at: minutesAgo(15), claimed_at: minutesAgo(15) },
    ];
    const res = await GET(req());
    expect(sentTo()).toEqual(["retry@example.com"]);
    const body = await res.json();
    expect(body.sent).toBe(1);
    // A candidate's OWN `sent` row never caps it; it reaches the claim, the
    // INSERT hits 23505, and the re-claim finds no `retry` row → taken.
    expect(body.alreadyClaimed).toBe(1);
    const row = db.tables.checkout_recovery_emails.find((r) => r.id === "r");
    expect(row?.status).toBe("sent");
    expect(row?.last_error ?? null).toBeNull();
    // The same row id, so the unsubscribe subject and the Resend payload are
    // identical to the first attempt's.
    expect(db.tables.checkout_recovery_emails).toHaveLength(2);
  });

  it("the 7-day cap counts attempts that reached Resend — including a `retry` that timed out after the call — not one that never got there", async () => {
    stripePis = [pi({ id: "pi_new", metadata: { ...tripN(1), customerEmail: "parked@example.com" } })];
    db.tables.checkout_recovery_emails = [
      { id: "old", stripe_payment_intent_id: "pi_old_attempt", email: "parked@example.com", livemode: true, status: "retry", created_at: minutesAgo(2 * 24 * 60), claimed_at: minutesAgo(2 * 24 * 60), send_started_at: null },
    ];
    await GET(req());
    expect(sentTo()).toEqual(["parked@example.com"]);

    vi.clearAllMocks();
    resendSend.mockResolvedValue({ data: { id: "email_2" }, error: null });
    noSweep.mockResolvedValue(null);
    getLocation.mockResolvedValue({ name: "Jet Parking JFK", latitude: "40.6650", longitude: "-73.7900" });
    stripeList.mockImplementation(() => (async function* () { yield* stripePis; })());
    db.tables.checkout_recovery_emails = [
      // Timed out AFTER the Resend call: probably delivered. Counts.
      { id: "old", stripe_payment_intent_id: "pi_old_attempt", email: "parked@example.com", livemode: true, status: "retry", created_at: minutesAgo(2 * 24 * 60), claimed_at: minutesAgo(2 * 24 * 60), send_started_at: minutesAgo(2 * 24 * 60) },
    ];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).cappedWithin7d).toBe(1);
  });

  it("re-claiming a `retry` row keeps send_started_at — the evidence an earlier attempt reached Resend — so a later crash is alarmed, never swept", async () => {
    stripePis = [pi({ id: "pi_retry2" })];
    const firstStamp = minutesAgo(20);
    db.tables.checkout_recovery_emails = [
      { id: "r2", stripe_payment_intent_id: "pi_retry2", email: "alice@example.com", livemode: true, status: "retry", created_at: firstStamp, claimed_at: firstStamp, send_started_at: firstStamp, last_error: "timed out" },
    ];
    // The stamp write of THIS attempt fails → parked again without sending.
    db.failWhen(
      "checkout_recovery_emails",
      "update",
      (p) => p !== null && "send_started_at" in p && !("status" in p),
      "canceling statement due to statement timeout",
      "57014"
    );
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).sendFailed).toBe(1);
    const row = db.tables.checkout_recovery_emails[0];
    expect(row.status).toBe("retry");
    expect(row.send_started_at).toBe(firstStamp);
  });

  it("stale `claimed` rows: one that never reached Resend is released; one that did is alarmed, never retried; a fresh one is left alone", async () => {
    db.tables.checkout_recovery_emails = [
      {
        id: "never_sent",
        stripe_payment_intent_id: "pi_crashed_early",
        email: "early@example.com",
        livemode: true,
        status: "claimed",
        created_at: minutesAgo(20),
        claimed_at: minutesAgo(20),
        send_started_at: null,
      },
      {
        id: "maybe_sent",
        stripe_payment_intent_id: "pi_crashed_late",
        email: "late@example.com",
        livemode: true,
        status: "claimed",
        created_at: minutesAgo(20),
        claimed_at: minutesAgo(20),
        send_started_at: minutesAgo(20),
      },
      {
        id: "fresh",
        stripe_payment_intent_id: "pi_in_flight",
        email: "inflight@example.com",
        livemode: true,
        status: "claimed",
        created_at: minutesAgo(5),
        claimed_at: minutesAgo(5),
        send_started_at: null,
      },
    ];
    const res = await GET(req());
    expect((await res.json()).staleClaims).toEqual({ released: 1, alarmed: 1 });
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureMessage.mock.calls[0][0])).toContain("1 claimed row(s) reached Resend");
    expect(resendSend).not.toHaveBeenCalled();
    expect(db.tables.checkout_recovery_emails.map((r) => r.id).sort()).toEqual(["fresh", "maybe_sent"]);
  });
});

describe("GET /api/cron/checkout-recovery — send failures", () => {
  it("a transient Resend failure parks the row as `retry` (never deleted — the email may be out) so the next tick re-claims it, and is loud", async () => {
    stripePis = [pi()];
    resendSend.mockResolvedValueOnce({ data: null, error: { statusCode: 503, message: "unavailable", name: "x" } });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(db.tables.checkout_recovery_emails).toHaveLength(1);
    expect(db.tables.checkout_recovery_emails[0].status).toBe("retry");
    expect(db.tables.checkout_recovery_emails[0].send_started_at).toBeTruthy();
    expect(sentry.captureMessage).toHaveBeenCalled();
    const firstRowId = db.tables.checkout_recovery_emails[0].id;

    const retry = await GET(req());
    expect(retry.status).toBe(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
    expect(db.tables.checkout_recovery_emails).toHaveLength(1);
    expect(db.tables.checkout_recovery_emails[0].id).toBe(firstRowId);
    expect(db.tables.checkout_recovery_emails[0].status).toBe("sent");
    // Byte-identical payload on the retry → Resend replays, never double-sends.
    expect(resendSend.mock.calls[1][0]).toEqual(resendSend.mock.calls[0][0]);
    expect(resendSend.mock.calls[1][1]).toEqual(resendSend.mock.calls[0][1]);
  });

  it("a permanent rejection keeps the row as failed so it is never retried, with the address redacted from last_error and Sentry", async () => {
    stripePis = [pi()];
    resendSend.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 422, message: "Invalid `to` field: alice@example.com is not allowed", name: "x" },
    });
    await GET(req());
    const row = db.tables.checkout_recovery_emails[0];
    expect(row.status).toBe("failed");
    expect(String(row.last_error)).not.toContain("alice@example.com");
    expect(String(row.last_error)).toContain("[email]");
    for (const call of sentry.captureException.mock.calls) {
      expect(String((call[0] as Error).message)).not.toContain("alice@example.com");
    }
    await GET(req());
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  it("a Resend 401/403 (our key or domain, not this recipient) releases the claim and stops the run instead of burning every address for 7 days", async () => {
    stripePis = [
      pi({ id: "pi_1", metadata: { ...tripN(1), customerEmail: "one@example.com" } }),
      pi({ id: "pi_2", metadata: { ...tripN(2), customerEmail: "two@example.com" } }),
    ];
    resendSend.mockResolvedValueOnce({ data: null, error: { statusCode: 403, message: "domain not verified", name: "x" } });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(db.tables.checkout_recovery_emails.map((r) => r.status)).toEqual(["retry"]);
  });

  it("a Resend 409 whose body lacks statusCode is still recognised by name, not retried every tick", async () => {
    stripePis = [pi({ id: "pi_409_name" })];
    resendSend.mockResolvedValueOnce({
      data: null,
      error: { message: "Idempotency key used with a different payload", name: "invalid_idempotent_request" },
    });
    const res = await GET(req());
    expect((await res.json()).sentUnconfirmed).toBe(1);
    expect(db.tables.checkout_recovery_emails[0].status).toBe("sent");
  });

  it("a Resend call that never answers fails as transient (released, loud) instead of running into the function timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stripePis = [pi()];
      resendSend.mockImplementationOnce(() => new Promise(() => {}));
      const pending = GET(req());
      await vi.advanceTimersByTimeAsync(10_500);
      const res = await pending;
      expect(res.status).toBe(500);
      expect(db.tables.checkout_recovery_emails.map((r) => r.status)).toEqual(["retry"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a ResLab lookup failure still sends (generic lot wording) and is reported", async () => {
    stripePis = [pi()];
    getLocation.mockRejectedValueOnce(new Error("reslab down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(resendSend.mock.calls[0][0].html).toContain("the parking you picked");
    expect(sentry.captureException).toHaveBeenCalled();
  });
});

describe("GET /api/cron/checkout-recovery — the email", () => {
  it("links straight back to the same checkout, says why it was sent, carries the postal address and a working unsubscribe", async () => {
    stripePis = [pi()];
    await GET(req());
    const msg = resendSend.mock.calls[0][0];
    expect(msg.to).toEqual(["alice@example.com"]);
    expect(msg.subject).toBe("Your JFK parking booking isn't finished");
    expect(msg.html).toContain("Jet Parking JFK (JFK)");
    expect(msg.html).toContain("$84.23");
    expect(msg.html).toContain("10:00 AM");
    expect(msg.html).toContain("protection plan or promo");
    expect(msg.html).toContain(POSTAL);
    expect(msg.text).toContain(POSTAL);
    expect(msg.text).toContain("You're getting this because you started a booking");
    expect(msg.html).not.toMatch(/one-time/i);

    const resume = new URL(msg.text.match(/Finish your booking: (\S+)/)[1]);
    expect(resume.pathname).toBe("/checkout");
    expect(resume.searchParams.get("lot")).toBe("reslab-10");
    expect(resume.searchParams.get("checkin")).toBe(inTenDays);
    expect(resume.searchParams.get("checkout")).toBe(inTwelveDays);
    expect(resume.searchParams.get("checkinTime")).toBe("10:00 AM");
    expect(resume.searchParams.get("checkoutTime")).toBe("6:00 PM");

    const unsub = new URL(msg.headers["List-Unsubscribe"].slice(1, -1));
    expect(unsub.pathname).toBe("/api/checkout-recovery/unsubscribe");
    // Keyed on the PaymentIntent, not the ledger row id: stable across a
    // released-and-retried claim, so the Resend idempotent payload matches
    // and a delivered email's link never 404s.
    const id = unsub.searchParams.get("id") as string;
    expect(id).toBe("pi_abandoned");
    expect(verifyRecoveryToken(id, unsub.searchParams.get("token") as string)).toBe(true);
    expect(msg.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    // No discount, no fake urgency.
    expect(msg.html).not.toMatch(/% off|discount|hurry|only \d+ left|expires/i);
  });
});
