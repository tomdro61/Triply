import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { db } = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return { db: new FakeSupabase() };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => db }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));

import { POST } from "../route";
import { GET as LAND } from "@/app/(main)/review/[token]/route";
import { GET as UNSUB_GET, POST as UNSUB_POST } from "../unsubscribe/route";
import { REVIEW_COOKIE, reviewUnsubscribeUrl, signReviewToken } from "@/lib/reviews/token";

const BOOKING = "3f2b8c1e-9a4d-4e2b-8c7a-1d2e3f4a5b6c";
const token = () => signReviewToken(BOOKING, Math.floor(Date.now() / 1000) + 30 * 86_400);

function post(body: unknown, cookie: string | null = token()) {
  return new NextRequest("https://www.triplypro.com/api/reviews", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...(cookie ? { cookie: `${REVIEW_COOKIE}=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db.clearFailures();
  db.tables = {
    pending_bookings: [],
    bookings: [
      {
        id: BOOKING,
        status: "confirmed",
        cancel_state: null,
        location_name: "Jet Parking JFK",
        airport_code: "JFK",
        reslab_location_id: 10,
        direct_lot_id: null,
        stripe_payment_intent_id: null,
        customer_id: "cust-1",
      },
    ],
    customers: [{ id: "cust-1", email: "sam@example.com", first_name: "Sam" }],
    booking_reviews: [],
    review_emails: [],
    review_email_optouts: [],
  };
});

describe("GET /review/{token} (landing)", () => {
  it("moves the token into an HttpOnly cookie and redirects to the token-free page", async () => {
    const t = token();
    const res = await LAND(new NextRequest(`https://www.triplypro.com/review/${t}?r=4`), {
      params: Promise.resolve({ token: t }),
    });
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/review");
    expect(location.search).toBe("?r=4");
    expect(location.toString()).not.toContain(t);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${REVIEW_COOKIE}=${t}`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(db.tables.booking_reviews).toEqual([]); // nothing written on a GET
  });

  it("sets no cookie for something that isn't a token", async () => {
    const res = await LAND(new NextRequest("https://www.triplypro.com/review/%3Cscript%3E"), {
      params: Promise.resolve({ token: "<script>" }),
    });
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("link")).toBe("invalid");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("POST /api/reviews", () => {
  it("saves the review for the booking named by the cookie", async () => {
    const res = await POST(post({ rating: 4, details: { shuttleWait: "under_5", extraCharges: false, comment: "Fine", publishConsent: true } }));
    expect(res.status).toBe(200);
    expect(db.tables.booking_reviews).toMatchObject([{ booking_id: BOOKING, rating: 4, publish_consent: true, display_name: "Sam" }]);
  });

  it("uses the booked guest's first name from the staged payload", async () => {
    db.tables.bookings[0].stripe_payment_intent_id = "pi_1";
    db.tables.pending_bookings.push({ stripe_payment_intent_id: "pi_1", customer: { firstName: "Robin", email: "robin@example.com" } });
    await POST(post({ rating: 5, details: { shuttleWait: null, extraCharges: null, comment: null, publishConsent: true } }));
    expect(db.tables.booking_reviews).toMatchObject([{ display_name: "Robin" }]);
  });

  it("refuses without the cookie, and never accepts a token in the body", async () => {
    expect((await POST(post({ rating: 5 }, null))).status).toBe(401);
    expect((await POST(post({ token: token(), rating: 5 }, null))).status).toBe(401);
    expect((await POST(post({ token: token(), rating: 5 }))).status).toBe(400);
    expect(db.tables.booking_reviews).toEqual([]);
  });

  it("refuses a forged cookie", async () => {
    const forged = token().replace(/.$/, (ch) => (ch === "A" ? "B" : "A"));
    expect((await POST(post({ rating: 1 }, forged))).status).toBe(401);
  });
});

describe("/api/reviews/unsubscribe", () => {
  const url = () => reviewUnsubscribeUrl(BOOKING);

  beforeEach(() => {
    db.tables.review_emails.push({ id: "r1", booking_id: BOOKING, kind: "initial", status: "sent", email: "robin@example.com" });
  });

  it("GET only asks for confirmation (link scanners must not opt anyone out)", async () => {
    const res = await UNSUB_GET(new NextRequest(url()));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Yes, unsubscribe me");
    expect(db.tables.review_email_optouts).toEqual([]);
  });

  it("POST records the address the email went to, and is idempotent", async () => {
    expect((await UNSUB_POST(new NextRequest(url(), { method: "POST" }))).status).toBe(200);
    expect((await UNSUB_POST(new NextRequest(url(), { method: "POST" }))).status).toBe(200);
    expect(db.tables.review_email_optouts).toMatchObject([{ email: "robin@example.com" }]);
  });

  it("rejects a bad token", async () => {
    const bad = new URL(url());
    bad.searchParams.set("token", "x".repeat(43));
    expect((await UNSUB_POST(new NextRequest(bad, { method: "POST" }))).status).toBe(400);
    expect(db.tables.review_email_optouts).toEqual([]);
  });
});
