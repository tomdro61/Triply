import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { addDays, format, subDays } from "date-fns";

const { db, sentry, resendSend, stripeList, getLocation } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    sentry: { captureMessage: vi.fn(), withScope: vi.fn(), captureException: vi.fn() },
    resendSend: vi.fn(),
    stripeList: vi.fn(),
    getLocation: vi.fn(),
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/resend/client", () => ({
  resend: { emails: { send: resendSend } },
  FROM_EMAIL: "Triply <bookings@triplypro.com>",
}));
vi.mock("@/lib/stripe/client", () => ({ stripe: { paymentIntents: { list: stripeList } } }));
vi.mock("@/lib/reslab/client", () => ({ reslab: { getLocation } }));
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
const MIN = 60;
const nowSec = () => Math.floor(Date.now() / 1000);
const inTenDays = format(addDays(new Date(), 10), "yyyy-MM-dd");
const inTwelveDays = format(addDays(new Date(), 12), "yyyy-MM-dd");
const yesterday = format(subDays(new Date(), 1), "yyyy-MM-dd");

interface PiOverrides {
  id?: string;
  status?: string;
  ageMin?: number;
  amount?: number;
  livemode?: boolean;
  metadata?: Record<string, string>;
}

/** A PaymentIntent exactly as POST /api/checkout/lot stamps it. */
function pi(o: PiOverrides = {}) {
  return {
    id: o.id ?? "pi_abandoned",
    status: o.status ?? "requires_payment_method",
    created: nowSec() - (o.ageMin ?? 50) * MIN,
    amount: o.amount ?? 8423,
    livemode: o.livemode ?? true,
    metadata: {
      lotId: "reslab-416",
      locationId: "416",
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

let stripePis: ReturnType<typeof pi>[] = [];

function req(headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  return new NextRequest("https://www.triplypro.com/api/cron/checkout-recovery", { headers });
}

const sentTo = () => resendSend.mock.calls.map((c) => c[0].to[0]);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CHECKOUT_RECOVERY_EMAILS_ENABLED = "true";
  resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
  stripePis = [];
  stripeList.mockImplementation(() =>
    (async function* () {
      yield* stripePis;
    })()
  );
  // Near JFK, so the airport resolves.
  getLocation.mockResolvedValue({ name: "Jet Parking JFK", latitude: "40.6650", longitude: "-73.7900" });
  db.tables = {
    bookings: [],
    customers: [],
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

  it("lists only the last 24 h of PaymentIntents", async () => {
    await GET(req());
    const created = stripeList.mock.calls[0][0].created.gte as number;
    expect(nowSec() - created).toBeGreaterThanOrEqual(24 * 3600 - 5);
    expect(nowSec() - created).toBeLessThanOrEqual(24 * 3600 + 5);
  });
});

describe("GET /api/cron/checkout-recovery — selection", () => {
  it("emails only checkouts 45 min – 24 h old", async () => {
    stripePis = [
      pi({ id: "pi_young", ageMin: 30, metadata: { customerEmail: "young@example.com" } }),
      pi({ id: "pi_ok", ageMin: 50, metadata: { customerEmail: "ok@example.com" } }),
      pi({ id: "pi_edge", ageMin: 23 * 60, metadata: { customerEmail: "edge@example.com" } }),
      pi({ id: "pi_old", ageMin: 25 * 60, metadata: { customerEmail: "old@example.com" } }),
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

  it("skips when the same address paid afterwards (succeeded or authorized), case-insensitively", async () => {
    stripePis = [
      pi({ id: "pi_a", ageMin: 60, metadata: { customerEmail: "Alice@Example.com" } }),
      pi({ id: "pi_a_paid", status: "requires_capture", ageMin: 55, metadata: { customerEmail: "alice@example.com" } }),
      pi({ id: "pi_b", ageMin: 60, metadata: { customerEmail: "bob@example.com" } }),
      pi({ id: "pi_b_paid", status: "succeeded", ageMin: 58, metadata: { customerEmail: "BOB@example.COM " } }),
    ];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).skipped.paidSince).toBe(2);
  });

  it("a payment made BEFORE the abandoned checkout (an earlier trip) does not block the email", async () => {
    stripePis = [
      pi({ id: "pi_old_trip", status: "succeeded", ageMin: 20 * 60 }),
      pi({ id: "pi_new_trip", ageMin: 50 }),
    ];
    await GET(req());
    expect(sentTo()).toEqual(["alice@example.com"]);
  });

  it("skips when a booking was completed since, matching the customer email case-insensitively", async () => {
    stripePis = [pi({ id: "pi_x", ageMin: 60 })];
    db.tables.customers = [{ id: "cust_1", email: "ALICE@example.com" }];
    db.tables.bookings = [
      { id: "b1", customer_id: "cust_1", created_at: new Date(Date.now() - 10 * 60_000).toISOString() },
    ];
    const res = await GET(req());
    expect(resendSend).not.toHaveBeenCalled();
    expect((await res.json()).bookedSince).toBe(1);
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

describe("GET /api/cron/checkout-recovery — suppression", () => {
  it("honours this email's opt-out, the newsletter unsubscribe and the waitlist unsubscribe", async () => {
    stripePis = [
      pi({ id: "pi_1", metadata: { customerEmail: "optout@example.com" } }),
      pi({ id: "pi_2", metadata: { customerEmail: "news@example.com" } }),
      pi({ id: "pi_3", metadata: { customerEmail: "wait@example.com" } }),
      pi({ id: "pi_4", metadata: { customerEmail: "news-subscribed@example.com" } }),
      pi({ id: "pi_5", metadata: { customerEmail: "fine@example.com" } }),
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
      pi({ id: "pi_recent", metadata: { customerEmail: "recent@example.com" } }),
      pi({ id: "pi_stale", metadata: { customerEmail: "stale@example.com" } }),
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
});

describe("GET /api/cron/checkout-recovery — send failures", () => {
  it("a transient Resend failure releases the claim so the next tick can retry, and is loud", async () => {
    stripePis = [pi()];
    resendSend.mockResolvedValueOnce({ data: null, error: { statusCode: 503, message: "unavailable", name: "x" } });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(db.tables.checkout_recovery_emails).toHaveLength(0);
    expect(sentry.captureMessage).toHaveBeenCalled();

    const retry = await GET(req());
    expect(retry.status).toBe(200);
    expect(resendSend).toHaveBeenCalledTimes(2);
    expect(db.tables.checkout_recovery_emails[0].status).toBe("sent");
  });

  it("a permanent rejection keeps the row as failed so it is never retried", async () => {
    stripePis = [pi()];
    resendSend.mockResolvedValueOnce({ data: null, error: { statusCode: 422, message: "invalid to", name: "x" } });
    await GET(req());
    expect(db.tables.checkout_recovery_emails[0].status).toBe("failed");
    await GET(req());
    expect(resendSend).toHaveBeenCalledTimes(1);
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
  it("links straight back to the same checkout and carries a working unsubscribe", async () => {
    stripePis = [pi()];
    await GET(req());
    const msg = resendSend.mock.calls[0][0];
    expect(msg.to).toEqual(["alice@example.com"]);
    expect(msg.subject).toBe("Your JFK parking booking isn't finished");
    expect(msg.html).toContain("Jet Parking JFK (JFK)");
    expect(msg.html).toContain("$84.23");
    expect(msg.html).toContain("10:00 AM");

    const resume = new URL(msg.text.match(/Finish your booking: (\S+)/)[1]);
    expect(resume.pathname).toBe("/checkout");
    expect(resume.searchParams.get("lot")).toBe("reslab-416");
    expect(resume.searchParams.get("checkin")).toBe(inTenDays);
    expect(resume.searchParams.get("checkout")).toBe(inTwelveDays);
    expect(resume.searchParams.get("checkinTime")).toBe("10:00 AM");
    expect(resume.searchParams.get("checkoutTime")).toBe("6:00 PM");

    const unsub = new URL(msg.headers["List-Unsubscribe"].slice(1, -1));
    expect(unsub.pathname).toBe("/api/checkout-recovery/unsubscribe");
    const id = unsub.searchParams.get("id") as string;
    expect(id).toBe(db.tables.checkout_recovery_emails[0].id);
    expect(verifyRecoveryToken(id, unsub.searchParams.get("token") as string)).toBe(true);
    expect(msg.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    // No discount, no fake urgency.
    expect(msg.html).not.toMatch(/% off|discount|hurry|only \d+ left|expires/i);
  });
});
