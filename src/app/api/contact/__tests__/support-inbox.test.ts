/**
 * /api/contact with ENABLE_SUPPORT_INBOX=true: the ticket, the booking match
 * (email must equal the booking's), the instant reply, the urgent alert, and
 * "a message is never lost" when the ticket store or Discord fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const resendSend = vi.hoisted(() => vi.fn());
const sentry = vi.hoisted(() => ({ captureAPIError: vi.fn(), captureContactHoneypotDrop: vi.fn() }));
const discord = vi.hoisted(() => ({ postToDiscord: vi.fn(), isDiscordWebhookUrl: vi.fn(() => true) }));
const db = vi.hoisted(() => ({
  booking: null as null | Record<string, unknown>,
  bookingError: null as null | { message: string },
  insertError: null as null | { message: string },
  inserted: [] as Array<Record<string, unknown>>,
  lookups: [] as Array<{ select: string; col: string; value: string }>,
  updates: [] as Array<Record<string, unknown>>,
  recentAlerts: 0,
  pingFilters: [] as Array<[string, string, unknown]>,
}));

// after(): throws outside a request scope (the route then runs inline);
// a test can capture the callback to prove it runs AFTER the response.
const afterHook = vi.hoisted(() => ({ capture: false, fn: null as null | (() => Promise<void>) }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => Promise<void>) => {
    if (!afterHook.capture) throw new Error("no request scope");
    afterHook.fn = fn;
  },
}));

vi.mock("@/lib/resend/client", () => ({
  resend: { emails: { send: resendSend } },
  FROM_EMAIL: "Triply <bookings@triplypro.com>",
}));
vi.mock("@/lib/sentry", () => sentry);
vi.mock("@/lib/digest/discord", () => discord);
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(async () => ({
    from(table: string) {
      if (table === "bookings") {
        const call = { select: "", col: "", value: "" };
        db.lookups.push(call);
        const chain = {
          select: (cols: string) => ((call.select = cols), chain),
          eq: (col: string, value: string) => ((call.col = col), (call.value = value), chain),
          limit: () => chain,
          // Every support DB call is bounded (3 s); the fake never hangs.
          abortSignal: () => chain,
          maybeSingle: async () => ({ data: db.booking, error: db.bookingError }),
        };
        return chain;
      }
      return {
        insert(row: Record<string, unknown>) {
          db.inserted.push(row);
          const single = async () =>
            db.insertError ? { data: null, error: db.insertError } : { data: { id: "t1", ticket_number: 1042 }, error: null };
          return { select: () => ({ abortSignal: () => ({ single }), single }) };
        },
        update(patch: Record<string, unknown>) {
          db.updates.push(patch);
          const done = { abortSignal: async () => ({ error: null }) };
          return { eq: () => done };
        },
        // mayPing's rank: live urgent tickets in the window up to this one.
        select() {
          const f: Array<[string, string, unknown]> = [];
          db.pingFilters = f;
          const count = {
            eq: (c: string, v: unknown) => (f.push(["eq", c, v]), count),
            gte: (c: string, v: unknown) => (f.push(["gte", c, v]), count),
            lte: (c: string, v: unknown) => (f.push(["lte", c, v]), count),
            abortSignal: async () => ({ count: db.recentAlerts, error: null }),
          };
          return count;
        },
      };
    },
  })),
}));

import { POST } from "../route";
import { __resetContactRateLimitForTests } from "@/lib/attribution/limiter";

// 2026-11-10 12:00 New York.
const NOW = new Date(Date.UTC(2026, 10, 10, 17, 0, 0));

const bookingRow = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  reslab_reservation_number: "TRP1234",
  status: "confirmed",
  check_in: "2026-11-20T08:00:00",
  check_out: "2026-11-25T18:00:00",
  location_timezone: "America/New_York",
  location_name: "Runway Park",
  location_address: "1 Airport Rd",
  airport_code: "EWR",
  customers: { email: "Pat@Example.com" },
  ...over,
});

const form = {
  name: "Pat",
  email: "pat@example.com",
  subject: "Cancellation Request",
  message: "Please cancel my booking",
  reservationNumber: "trp 1234",
};

function req(body: unknown) {
  return new NextRequest("https://www.triplypro.com/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.ENABLE_SUPPORT_INBOX = "true";
  process.env.ENABLE_SELF_SERVE_CANCEL = "true";
  process.env.DISCORD_SUPPORT_WEBHOOK_URL = "https://discord.com/api/webhooks/1/abc";
  // A production deployment (live Stripe key); the test-mode case has its own test.
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_dummy_for_unit_tests");
  resendSend.mockReset();
  resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
  sentry.captureAPIError.mockReset();
  discord.postToDiscord.mockReset();
  discord.postToDiscord.mockResolvedValue({ kind: "posted", status: 200, retried: false });
  Object.assign(db, { booking: bookingRow(), bookingError: null, insertError: null, inserted: [], lookups: [], updates: [], recentAlerts: 0, pingFilters: [] });
  Object.assign(afterHook, { capture: false, fn: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  __resetContactRateLimitForTests();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.ENABLE_SUPPORT_INBOX;
  delete process.env.ENABLE_SELF_SERVE_CANCEL;
  delete process.env.DISCORD_SUPPORT_WEBHOOK_URL;
  vi.unstubAllEnvs();
});

describe("POST /api/contact — support inbox on", () => {
  it("matches the booking (email case-insensitive), stores the ticket, sends self-cancel steps", async () => {
    const res = await POST(req(form));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, confirmationSent: true, ticketNumber: 1042, urgent: false });
    expect(db.inserted[0]).toMatchObject({
      reservation_number: "TRP1234",
      booking_id: "b1",
      booking_match: "matched",
      priority: "normal",
      auto_reply_kind: "self_cancel",
    });
    const [team, reply] = resendSend.mock.calls.map((c) => c[0]);
    expect(team.subject).toBe("[Contact Form] #1042 Cancellation Request");
    expect(reply.to).toEqual(["pat@example.com"]);
    expect(reply.replyTo).toBe("support@triplypro.com");
    expect(reply.subject).toContain("Triply #1042");
    expect(reply.html).toContain("Runway Park");
    expect(reply.html).not.toContain("Please cancel my booking"); // nothing the caller typed
    expect(db.updates[0]).toMatchObject({ auto_reply_sent: true });
    expect(discord.postToDiscord).not.toHaveBeenCalled();
    // The lookup: normalised number, exact equality (index), the customer's email joined in.
    expect(db.lookups[0]).toMatchObject({ col: "reslab_reservation_number", value: "TRP1234" });
    expect(db.lookups[0].select).toContain("customers!inner(email)");
  });

  it("reads the customer join whether PostgREST returns an object or an array; no customer = mismatch", async () => {
    db.booking = bookingRow({ customers: [{ email: "pat@example.com" }] });
    await POST(req(form));
    expect(db.inserted[0]).toMatchObject({ booking_match: "matched" });
    __resetContactRateLimitForTests();
    db.booking = bookingRow({ customers: null });
    await POST(req(form));
    expect(db.inserted[1]).toMatchObject({ booking_match: "email_mismatch", booking_id: null });
  });

  it("a refunded booking gets 'already cancelled', not 'we'll cancel it'", async () => {
    db.booking = bookingRow({ status: "refunded" });
    await POST(req(form));
    expect(db.inserted[0]).toMatchObject({ auto_reply_kind: "already_cancelled" });
    expect(resendSend.mock.calls[1][0].html).toContain("Cancelled and refunded");
  });

  it("the response never reveals booking state: an on-trip booking alone does not make `urgent` true", async () => {
    db.booking = bookingRow({ check_in: "2026-11-09T06:00:00", check_out: "2026-11-12T18:00:00" }); // on the trip
    const res = await POST(req({ ...form, subject: "Booking Help", message: "quick question" }));
    expect((await res.json()).urgent).toBe(false); // the caller can't learn the customer is away
    expect(db.inserted[0]).toMatchObject({ priority: "urgent" }); // the team still sees it as urgent
    expect(discord.postToDiscord).toHaveBeenCalledTimes(1);
  });

  it("a NULL booking status is never treated as a live booking", async () => {
    db.booking = bookingRow({ status: null, check_in: "2026-11-09T06:00:00", check_out: "2026-11-12T18:00:00" });
    const res = await POST(req({ ...form, subject: "Booking Help" }));
    expect((await res.json()).urgent).toBe(false);
    expect(db.inserted[0]).toMatchObject({ auto_reply_kind: "booking_details" });
  });

  it("a reservation under ANOTHER email reveals nothing about it", async () => {
    db.booking = bookingRow({ customers: { email: "someone-else@example.com" } });
    const res = await POST(req(form));
    expect(res.status).toBe(200);
    expect(db.inserted[0]).toMatchObject({ booking_id: null, booking_match: "email_mismatch", auto_reply_kind: "cancel_support" });
    const reply = resendSend.mock.calls[1][0];
    expect(reply.html).not.toContain("Runway Park");
    expect(reply.html).not.toContain("1 Airport Rd");
    expect(resendSend.mock.calls[0][0].html).toContain("DIFFERENT email");
  });

  it("an urgent ticket pages Discord with @here and no customer details, and records the alert", async () => {
    db.booking = bookingRow({ check_in: "2026-11-09T06:00:00", check_out: "2026-11-12T18:00:00" }); // on the trip
    const res = await POST(req({ ...form, subject: "Problem at the Lot", message: "Shuttle never came, I'm stranded" }));
    expect((await res.json()).urgent).toBe(true);
    expect(discord.postToDiscord).toHaveBeenCalledTimes(1);
    const [, embed, opts] = discord.postToDiscord.mock.calls[0];
    expect(opts.content).toContain("@here");
    expect(JSON.stringify(embed)).not.toContain("pat@example.com");
    expect(JSON.stringify(embed)).not.toContain("never came"); // reason labels are ours; the message itself is never posted
    expect(embed.title).toContain("#1042");
    expect(db.updates[0]).toHaveProperty("alerted_at");
    expect(resendSend.mock.calls[0][0].subject).toContain("[URGENT]");
  });

  it("a failed Discord post is reported and the ticket stays un-alerted; the request still succeeds", async () => {
    discord.postToDiscord.mockResolvedValue({ kind: "failed", status: 500, body: "x", retried: false });
    const res = await POST(req({ ...form, subject: "Problem at the Lot" }));
    expect(res.status).toBe(200);
    expect(db.updates[0]).not.toHaveProperty("alerted_at");
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("an urgent request still pages Discord when the ticket store is down", async () => {
    db.insertError = { message: "down" };
    await POST(req({ ...form, subject: "Problem at the Lot" }));
    expect(discord.postToDiscord).toHaveBeenCalledTimes(1);
    expect(discord.postToDiscord.mock.calls[0][1].title).toContain("NOT saved");
  });

  it("a THROWN team-email send still sends the reply and alert when the ticket is stored", async () => {
    resendSend.mockRejectedValueOnce(new Error("socket hang up"));
    const res = await POST(req({ ...form, subject: "Problem at the Lot" }));
    expect(res.status).toBe(200);
    expect(resendSend).toHaveBeenCalledTimes(2); // team (threw) + reply
    // The urgent @here, then a plain note that the team email didn't send.
    expect(discord.postToDiscord).toHaveBeenCalledTimes(2);
    expect(discord.postToDiscord.mock.calls[1][1].title).toContain("the team email failed or is unconfirmed");
    expect(discord.postToDiscord.mock.calls[1][2].allowedMentions).toEqual({ parse: [] });
  });

  // Review round 1 (#156) ------------------------------------------------------

  it("a failed team email on a stored, non-urgent ticket is posted to Discord (not just Sentry)", async () => {
    resendSend.mockResolvedValueOnce({ data: null, error: { message: "daily quota" } });
    const res = await POST(req({ ...form, subject: "General Inquiry", reservationNumber: "" }));
    expect(res.status).toBe(200);
    expect(discord.postToDiscord).toHaveBeenCalledTimes(1);
    expect(discord.postToDiscord.mock.calls[0][1].title).toBe("Support ticket #1042: the team email failed or is unconfirmed");
  });

  it("past the ping cap the urgent alert still posts, without @here", async () => {
    db.recentAlerts = 4; // this ticket is the 4th live urgent one in the window
    await POST(req({ ...form, subject: "Problem at the Lot" }));
    const [, , opts] = discord.postToDiscord.mock.calls[0];
    expect(opts.content).not.toContain("@here");
    expect(opts.allowedMentions).toEqual({ parse: [] });
  });

  it("the cap ranks live urgent tickets by number in the last 10 minutes (concurrency-safe)", async () => {
    db.recentAlerts = 3; // the 3rd: still pings
    await POST(req({ ...form, subject: "Problem at the Lot" }));
    expect(discord.postToDiscord.mock.calls[0][2].content).toContain("@here");
    const f = db.pingFilters;
    expect(f).toContainEqual(["eq", "livemode", true]);
    expect(f).toContainEqual(["eq", "priority", "urgent"]);
    expect(f).toContainEqual(["lte", "ticket_number", 1042]);
    const since = f.find(([op, c]) => op === "gte" && c === "created_at")?.[2] as string;
    expect(Date.parse(since)).toBe(NOW.getTime() - 10 * 60_000);
  });

  it("alerts and bookkeeping run AFTER the response (their latency can't reveal a booking)", async () => {
    afterHook.capture = true;
    const res = await POST(req({ ...form, subject: "Problem at the Lot" }));
    expect(res.status).toBe(200);
    expect(discord.postToDiscord).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
    await afterHook.fn?.();
    expect(discord.postToDiscord).toHaveBeenCalledTimes(1);
    expect(db.updates).toHaveLength(1);
  });

  it("each email carries a stable idempotency key (a retry after a timeout doesn't email twice)", async () => {
    await POST(req(form));
    await POST(req(form));
    const keys = resendSend.mock.calls.map((c) => c[1]?.idempotencyKey);
    expect(keys[0]).toMatch(/^contact-team-[0-9a-f]{40}$/);
    expect(keys[1]).toMatch(/^contact-reply-[0-9a-f]{40}$/);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).toBe(keys[1]);
  });

  it("a staging (test-mode) ticket is marked test, never pings, and says so in the team email", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy_for_unit_tests");
    await POST(req({ ...form, subject: "Problem at the Lot" }));
    expect(db.inserted[0]).toMatchObject({ livemode: false });
    expect(resendSend.mock.calls[0][0].subject).toMatch(/^\[TEST\] /);
    const [, embed, opts] = discord.postToDiscord.mock.calls[0];
    expect(embed.title).toMatch(/^\[TEST\] /);
    expect(opts.content).not.toContain("@here");
  });

  it("a live ticket records livemode true", async () => {
    await POST(req(form));
    expect(db.inserted[0]).toMatchObject({ livemode: true });
  });

  it("a failed instant reply is reported to Sentry, not just logged", async () => {
    resendSend
      .mockResolvedValueOnce({ data: { id: "team" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "suppressed" } });
    const res = await POST(req(form));
    expect(await res.json()).toMatchObject({ confirmationSent: false });
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    expect(db.updates[0]).toMatchObject({ auto_reply_sent: false });
  });

  it("the ticket store failing never loses the message: both emails still go out", async () => {
    db.insertError = { message: 'relation "support_tickets" does not exist' };
    const res = await POST(req(form));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, ticketNumber: null });
    expect(resendSend).toHaveBeenCalledTimes(2);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("team email failing is fine when the ticket is stored, a 500 when it isn't", async () => {
    resendSend.mockResolvedValueOnce({ data: null, error: { message: "daily cap" } });
    expect((await POST(req(form))).status).toBe(200);

    __resetContactRateLimitForTests();
    db.insertError = { message: "down" };
    resendSend.mockResolvedValueOnce({ data: null, error: { message: "daily cap" } });
    expect((await POST(req(form))).status).toBe(500);
  });

  it("a booking lookup error still files the ticket, without the booking", async () => {
    db.bookingError = { message: "timeout" };
    await POST(req(form));
    expect(db.inserted[0]).toMatchObject({ booking_match: "lookup_failed", reservation_number: "TRP1234", booking_id: null });
    expect(resendSend.mock.calls[0][0].html).toContain("lookup FAILED");
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("with the flag off, nothing touches the ticket store", async () => {
    delete process.env.ENABLE_SUPPORT_INBOX;
    const res = await POST(req(form));
    expect(await res.json()).toEqual({ success: true, confirmationSent: true });
    expect(db.inserted).toEqual([]);
  });
});
