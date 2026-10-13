/**
 * Admin actions on a direct booking (6b plan §6 / §4): every refusal, each
 * action's happy path, the re-point lock (the booking-notice claim) and its
 * compare-and-sets, the re-send audit claim, and the other-mode guard.
 *
 * lot-notice.ts is NOT mocked: the re-point test proves the real sender then
 * mails the NEW inbox under the `/r1` key, and a sender that holds a fresh
 * claim blocks a re-point.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const h = await vi.hoisted(async () => {
  const { FakeSupabase } = await import("@/lib/booking/__tests__/supabase-fake");
  return {
    db: new FakeSupabase(),
    user: { current: { email: "tom@triplypro.com" } as { email: string } | null },
    isAdmin: { current: true },
    sentry: {
      captureAPIError: vi.fn(),
      captureDirectLotNotice: vi.fn(),
      capturePaymentError: vi.fn(),
      captureBookingError: vi.fn(),
    },
    resendSend: vi.fn(),
    redrive: vi.fn(),
    buildView: vi.fn(),
    sendConfirmation: vi.fn(),
    fetchLot: vi.fn(),
  };
});
const { db, sentry, resendSend, redrive, buildView, sendConfirmation, fetchLot } = h;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user.current } }) } }),
  createAdminClient: async () => h.db,
}));
vi.mock("@/config/admin", () => ({ isAdminEmail: () => h.isAdmin.current }));
vi.mock("@/lib/sentry", () => h.sentry);
vi.mock("@/lib/resend/client", () => ({ resend: { emails: { send: h.resendSend } }, FROM_EMAIL: "Triply <bookings@triplypro.com>" }));
vi.mock("@/lib/booking/create-booking", () => ({
  redriveDirectBookingSends: h.redrive,
  buildDirectResendView: h.buildView,
}));
vi.mock("@/lib/booking/fulfill", () => ({ sendDirectCustomerConfirmation: h.sendConfirmation }));
vi.mock("@/lib/direct/store", () => ({ fetchDirectLot: h.fetchLot }));

const { GET, POST } = await import("../route");
const { sendLotBookingNotice } = await import("@/lib/direct/lot-notice");

const PI = "pi_direct_1";
const TRP = "TRP-ABCD2345";
const LOT_INBOX = ["old@lot.example"];

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    stripe_payment_intent_id: PI,
    reslab_reservation_number: TRP,
    inventory_source: "direct",
    direct_lot_id: "1",
    reslab_location_id: null,
    status: "confirmed",
    livemode: false,
    location_name: "The Parking Point JFK",
    check_in: "2026-10-20T10:00:00",
    check_out: "2026-10-25T14:30:00",
    vehicle_info: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC123" },
    customer_id: "c1",
    lot_notified_at: null,
    lot_notice_claimed_at: null,
    lot_cancel_notified_at: null,
    lot_cancel_notice_claimed_at: null,
    cancel_state: null,
    cancel_claimed_at: null,
    ...over,
  };
}

const terms = (over: Record<string, unknown> = {}) => ({
  stripe_payment_intent_id: PI,
  direct_lot_id: "1",
  livemode: false,
  lot_recipients: LOT_INBOX,
  recipients_rev: 0,
  lot_notice_email_id: null,
  lot_notice_recipients: null,
  lot_cancel_notice_email_id: null,
  ...over,
});

const post = (body: unknown) =>
  POST(new NextRequest("https://x.test/api/admin/direct-bookings/action", { method: "POST", body: JSON.stringify(body) }));
const act = (action: string, reservationNumber = TRP) => post({ reservationNumber, action });
const get = (qs: string) => GET(new NextRequest(`https://x.test/api/admin/direct-bookings/action${qs}`));

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A direct_lot_alerts row (041 + 042's resolved_* columns). */
const alert = (over: Record<string, unknown> = {}) => ({
  subject: PI,
  kind: "lot_notice",
  livemode: false,
  first_seen_at: "2026-10-13T08:00:00Z",
  last_seen_at: "2026-10-13T09:00:00Z",
  alerted_at: "2026-10-13T08:01:00Z",
  detail: { number: TRP, urgent: true },
  resolved_at: null,
  resolved_by: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.clearFailures();
  db.log = [];
  h.user.current = { email: "tom@triplypro.com" };
  h.isAdmin.current = true;
  db.tables = {
    bookings: [booking()],
    customers: [{ id: "c1", first_name: "Account", last_name: "Holder" }],
    pending_bookings: [
      { stripe_payment_intent_id: PI, email_sent: true, customer: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" } },
    ],
    direct_booking_terms: [terms()],
    direct_lot_resends: [],
    direct_lot_alerts: [],
  };
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
  vi.stubEnv("DIRECT_LOT_NOTICE_OVERRIDE_TO", "ops@triplypro.com");
  resendSend.mockResolvedValue({ data: { id: "em_1" }, error: null });
  fetchLot.mockResolvedValue({ status: "found", lot: { notificationEmails: ["new@lot.example"] } });
});
afterEach(() => vi.unstubAllEnvs());

describe("auth, body and booking guards", () => {
  it("401 signed out, 403 not an admin — nothing read", async () => {
    h.user.current = null;
    expect((await act("retry_lot_notice")).status).toBe(401);
    h.user.current = { email: "x@example.com" };
    h.isAdmin.current = false;
    expect((await act("retry_lot_notice")).status).toBe(403);
    expect((await get(`?reservationNumber=${TRP}`)).status).toBe(403);
    expect(db.log).toEqual([]);
  });

  it("400 for a bad body or an unknown action", async () => {
    expect((await post({ reservationNumber: TRP })).status).toBe(400);
    expect((await post({ reservationNumber: "", action: "retry_lot_notice" })).status).toBe(400);
    expect((await act("resend_lot_notice")).status).toBe(400);
    const raw = await POST(new NextRequest("https://x.test/a", { method: "POST", body: "not json" }));
    expect(raw.status).toBe(400);
  });

  it("404 for an unknown number; 409 for a ResLab booking", async () => {
    expect((await act("retry_lot_notice", "TRP-ZZZZ9999")).status).toBe(404);
    db.tables.bookings.push({ ...booking({ id: "r1", reslab_reservation_number: "RTL123", inventory_source: "reslab", direct_lot_id: null }) });
    const res = await act("retry_lot_notice", "RTL123");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/only for bookings at Triply's own lots/);
  });

  it("409 for a booking paid in the other Stripe mode — before any side effect, for every action", async () => {
    db.tables.bookings = [booking({ livemode: true })];
    db.tables.direct_lot_alerts = [alert({ livemode: true })];
    for (const a of ["retry_lot_notice", "repoint_lot_inbox", "resend_lot_cancellation", "resend_customer_confirmation", "resolve_alerts"]) {
      const res = await act(a);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/other environment/);
    }
    expect(redrive).not.toHaveBeenCalled();
    expect(resendSend).not.toHaveBeenCalled();
    expect(fetchLot).not.toHaveBeenCalled();
    expect(db.log.filter((l) => l.op !== "select")).toEqual([]);
    expect(db.tables.direct_lot_alerts[0].resolved_at).toBeNull();
  });

  it("a direct row missing livemode is refused as broken (500), never treated as live", async () => {
    db.tables.bookings = [booking({ livemode: null })];
    expect((await act("retry_lot_notice")).status).toBe(500);
    expect(redrive).not.toHaveBeenCalled();
  });

  it("a booking read failure is a 500 with a Sentry event", async () => {
    db.failOnce("bookings", "select", "boom");
    expect((await act("retry_lot_notice")).status).toBe(500);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });
});

describe("GET — what the modal shows", () => {
  it("returns the inbox on file, the rev and the stamps", async () => {
    db.tables.bookings = [booking({ lot_notified_at: "2026-10-12T15:00:00Z" })];
    db.tables.direct_booking_terms = [terms({ recipients_rev: 2 })];
    const res = await get(`?reservationNumber=${TRP}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lotRecipients: LOT_INBOX,
      cmsInbox: ["new@lot.example"],
      recipientsRev: 2,
      lotNotifiedAt: "2026-10-12T15:00:00Z",
      lotNoticeClaimedAt: null,
      lotCancelNotifiedAt: null,
      customerEmailSent: true,
      openAlerts: [],
      otherEnvironment: false,
    });
  });

  it("returns this booking's OPEN alerts in its own mode — kind and times only, never the detail", async () => {
    db.tables.direct_lot_alerts = [
      alert({ kind: "cancel_notice", first_seen_at: "2026-10-13T07:00:00Z" }),
      alert({ subject: "b1:manifest:1:2026-10-14:abcdef0123456789", kind: "followup", alerted_at: null }),
      alert({ kind: "lot_notice", resolved_at: "2026-10-13T09:30:00Z", resolved_by: "vin@triplypro.com" }), // resolved
      alert({ livemode: true }), // the other environment's
      alert({ subject: "pi_other" }), // another booking
      alert({ subject: "b2:manifest:1:2026-10-14:abcdef0123456789", kind: "followup" }), // another booking's follow-up
      alert({ subject: "1:2026-10-14", kind: "manifest" }), // a lot-level alert
    ];
    const body = await (await get(`?reservationNumber=${TRP}`)).json();
    expect(body.openAlerts).toEqual([
      { kind: "cancel_notice", first_seen_at: "2026-10-13T07:00:00Z", alerted_at: "2026-10-13T08:01:00Z" },
      { kind: "followup", first_seen_at: "2026-10-13T08:00:00Z", alerted_at: null },
    ]);
    expect(JSON.stringify(body.openAlerts)).not.toMatch(/urgent|TRP-/);
  });

  it("an unsent customer confirmation reads false; an alerts read failure is null (shown, reported), not a failed GET", async () => {
    db.tables.pending_bookings[0].email_sent = false;
    db.failOnce("direct_lot_alerts", "select", "boom");
    const res = await get(`?reservationNumber=${TRP}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.customerEmailSent).toBe(false);
    expect(body.openAlerts).toBeNull();
    expect(sentry.captureAPIError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ stage: "open_alerts" }));
  });

  it("the other environment's booking is shown (flagged), not refused", async () => {
    db.tables.bookings = [booking({ livemode: true })];
    const res = await get(`?reservationNumber=${TRP}`);
    expect(res.status).toBe(200);
    expect((await res.json()).otherEnvironment).toBe(true);
  });

  it("the CMS inbox is null (not an error) when the CMS can't say", async () => {
    fetchLot.mockResolvedValue({ status: "unavailable", kind: "timeout", message: "x" });
    const res = await get(`?reservationNumber=${TRP}`);
    expect(res.status).toBe(200);
    expect((await res.json()).cmsInbox).toBeNull();
  });

  it("400 without a number; 503 when the terms read fails", async () => {
    expect((await get("")).status).toBe(400);
    db.failOnce("direct_booking_terms", "select", "boom");
    expect((await get(`?reservationNumber=${TRP}`)).status).toBe(503);
  });
});

describe("retry_lot_notice", () => {
  it("re-drives and returns the tagged outcome", async () => {
    redrive.mockResolvedValue({ kind: "attempted", notice: "sent", customerEmail: "already_sent" });
    const res = await act("retry_lot_notice");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      action: "retry_lot_notice",
      result: { kind: "attempted", notice: "sent", customerEmail: "already_sent" },
    });
    expect(redrive).toHaveBeenCalledWith(PI);
  });

  it("a stale claim (its sender is gone) may be retried", async () => {
    db.tables.bookings = [booking({ lot_notice_claimed_at: ago(6 * 60_000) })];
    redrive.mockResolvedValue({ kind: "attempted", notice: "sent", customerEmail: "already_sent" });
    expect((await act("retry_lot_notice")).status).toBe(200);
  });

  it.each([
    ["not confirmed", { status: "cancelled" }, /cancelled/],
    ["already told", { lot_notified_at: "2026-10-12T15:00:00Z" }, /already told/],
    ["a live claim", { lot_notice_claimed_at: ago(30_000) }, /being sent right now/],
    ["mid-cancel (state)", { cancel_state: "claimed" }, /cancellation .* in progress/],
    ["mid-cancel (claim)", { cancel_claimed_at: ago(1_000) }, /cancellation .* in progress/],
  ])("409 when %s — nothing re-driven", async (_label, over, msg) => {
    db.tables.bookings = [booking(over)];
    const res = await act("retry_lot_notice");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(msg);
    expect(redrive).not.toHaveBeenCalled();
  });

  describe("6b pass 2: the lot was told, but the customer confirmation never went ('Send confirmation now')", () => {
    const told = { lot_notified_at: ago(2 * 24 * 60 * 60_000), lot_notice_claimed_at: ago(2 * 24 * 60 * 60_000) };

    it("re-drives: the notice answers not_claimed, the confirmation is sent once", async () => {
      db.tables.bookings = [booking(told)];
      db.tables.pending_bookings[0].email_sent = false;
      redrive.mockResolvedValue({ kind: "attempted", notice: "not_claimed", customerEmail: "sent" });
      const res = await act("retry_lot_notice");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        action: "retry_lot_notice",
        result: { kind: "attempted", notice: "not_claimed", customerEmail: "sent" },
      });
      expect(redrive).toHaveBeenCalledTimes(1);
      expect(redrive).toHaveBeenCalledWith(PI);
    });

    it("a notice claim still fresh from the (already stamped) send does not block it", async () => {
      db.tables.bookings = [booking({ lot_notified_at: ago(60_000), lot_notice_claimed_at: ago(90_000) })];
      db.tables.pending_bookings[0].email_sent = false;
      redrive.mockResolvedValue({ kind: "attempted", notice: "not_claimed", customerEmail: "sent" });
      expect((await act("retry_lot_notice")).status).toBe(200);
      expect(redrive).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["both done (lot told, confirmation sent)", true],
      ["no checkout record to say the confirmation is unsent", null],
    ])("still 409 'already told' when %s — nothing re-driven", async (_label, emailSent) => {
      db.tables.bookings = [booking(told)];
      if (emailSent === null) db.tables.pending_bookings = [];
      else db.tables.pending_bookings[0].email_sent = emailSent;
      const res = await act("retry_lot_notice");
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/already told/);
      expect(redrive).not.toHaveBeenCalled();
    });

    it("still refused while cancelled or mid-cancel", async () => {
      db.tables.pending_bookings[0].email_sent = false;
      for (const over of [{ status: "cancelled" }, { cancel_state: "claimed" }]) {
        db.tables.bookings = [booking({ ...told, ...over })];
        expect((await act("retry_lot_notice")).status).toBe(409);
      }
      expect(redrive).not.toHaveBeenCalled();
    });

    it("the email_sent read failing is a 503 'nothing was sent' — never a guess", async () => {
      db.tables.bookings = [booking(told)];
      db.tables.pending_bookings[0].email_sent = false;
      db.failOnce("pending_bookings", "select", "connection reset");
      const res = await act("retry_lot_notice");
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/nothing was sent/);
      expect(redrive).not.toHaveBeenCalled();
      expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    });
  });

  it("a Stripe/database read failure inside the re-drive is a 502 'nothing was sent'", async () => {
    redrive.mockRejectedValue(new Error("stripe down"));
    const res = await act("retry_lot_notice");
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/nothing was sent/);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });
});

describe("repoint_lot_inbox", () => {
  it("copies the CMS inbox, bumps the rev (CAS), releases the lock, and shows old → new", async () => {
    const res = await act("repoint_lot_inbox");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "repoint_lot_inbox", from: LOT_INBOX, to: ["new@lot.example"], recipientsRev: 1 });
    expect(db.tables.direct_booking_terms[0]).toMatchObject({ lot_recipients: ["new@lot.example"], recipients_rev: 1 });
    // The lock (the booking-notice claim) is released: a Retry can claim it now.
    expect(db.tables.bookings[0].lot_notice_claimed_at).toBeNull();
    expect(db.tables.bookings[0].lot_notified_at).toBeNull();
    expect(fetchLot).toHaveBeenCalledWith(1);
    expect(sentry.captureAPIError).not.toHaveBeenCalled();
  });

  it("then the real sender mails the NEW inbox under the /r1 key (production, live booking)", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    db.tables.bookings = [booking({ livemode: true })];
    db.tables.direct_booking_terms = [terms({ livemode: true })];
    expect((await act("repoint_lot_inbox")).status).toBe(200);
    const content = {
      number: TRP, lotName: "Lot", customerName: "Ada Lovelace", customerPhone: "555", vehicle: { make: "Ford", model: "F", color: "B", licensePlate: "A", state: "NY" },
      vehicleSizeLabel: "Standard", atLotCents: 0, fromDate: "2026-10-20 10:00:00", toDate: "2026-10-25 14:30:00", parkGuard: false, urgent: false,
    };
    expect(await sendLotBookingNotice(PI, content)).toBe("sent");
    const [msg, opts] = resendSend.mock.calls[0];
    expect(msg.to).toEqual(["new@lot.example"]);
    expect(opts).toEqual({ idempotencyKey: "direct-lot-notice/booking/b1/live/r1" });
  });

  it("a sender holding a FRESH claim blocks it (409) — terms untouched, the sender's claim untouched", async () => {
    const claimedAt = ago(10_000);
    db.tables.bookings = [booking({ lot_notice_claimed_at: claimedAt })];
    const res = await act("repoint_lot_inbox");
    expect(res.status).toBe(409);
    expect(db.tables.direct_booking_terms[0]).toMatchObject({ lot_recipients: LOT_INBOX, recipients_rev: 0 });
    expect(db.tables.bookings[0].lot_notice_claimed_at).toBe(claimedAt);
  });

  it("a STALE claim also refuses (that notice may have been delivered)", async () => {
    db.tables.bookings = [booking({ lot_notice_claimed_at: ago(60 * 60_000) })];
    const res = await act("repoint_lot_inbox");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/may already have been sent/);
  });

  it("a sender that claims between our read and our lock wins: 409, nothing written, its claim kept", async () => {
    let senderClaim = "";
    fetchLot.mockImplementation(async () => {
      senderClaim = new Date().toISOString();
      db.tables.bookings[0].lot_notice_claimed_at = senderClaim; // claimAndSend's claim lands now
      return { status: "found", lot: { notificationEmails: ["new@lot.example"] } };
    });
    const res = await act("repoint_lot_inbox");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/being sent or was already sent/);
    expect(db.tables.direct_booking_terms[0]).toMatchObject({ lot_recipients: LOT_INBOX, recipients_rev: 0 });
    expect(db.tables.bookings[0].lot_notice_claimed_at).toBe(senderClaim);
  });

  it("the terms are written while the lock is held, and a sender facing that lock cannot claim (not_claimed)", async () => {
    let lockDuringWrite: unknown = null;
    db.failWhen("direct_booking_terms", "update", () => {
      lockDuringWrite = db.tables.bookings[0].lot_notice_claimed_at; // the moment of the terms write
      return false; // observe only — the write goes through
    }, "unused");
    expect((await act("repoint_lot_inbox")).status).toBe(200);
    expect(typeof lockDuringWrite).toBe("string");
    // A sender arriving at that moment meets a FRESH claim and stands down.
    db.tables.bookings[0].lot_notice_claimed_at = lockDuringWrite;
    const outcome = await sendLotBookingNotice(PI, {
      number: TRP, lotName: "Lot", customerName: "A", customerPhone: "1", vehicle: { make: "", model: "", color: "", licensePlate: "", state: "" },
      vehicleSizeLabel: "", atLotCents: 0, fromDate: "2026-10-20 10:00:00", toDate: "2026-10-25 14:30:00", parkGuard: false, urgent: false,
    });
    expect(outcome).toBe("not_claimed");
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("CAS on the rev: someone else re-pointed in between → 409, and the lock is still released", async () => {
    fetchLot.mockImplementation(async () => {
      db.tables.direct_booking_terms[0].recipients_rev = 1;
      return { status: "found", lot: { notificationEmails: ["new@lot.example"] } };
    });
    const res = await act("repoint_lot_inbox");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed by someone else/);
    expect(db.tables.direct_booking_terms[0].lot_recipients).toEqual(LOT_INBOX);
    expect(db.tables.bookings[0].lot_notice_claimed_at).toBeNull();
  });

  it("a failed terms write still releases the lock", async () => {
    db.failOnce("direct_booking_terms", "update", "boom");
    const res = await act("repoint_lot_inbox");
    expect(res.status).toBe(503);
    expect(db.tables.bookings[0].lot_notice_claimed_at).toBeNull();
  });

  it("a failed release is reported to Sentry (it goes stale); the re-point itself stands", async () => {
    db.failWhen("bookings", "update", (p) => p !== null && p.lot_notice_claimed_at === null, "boom");
    const res = await act("repoint_lot_inbox");
    expect(res.status).toBe(200);
    expect(db.tables.bookings[0].lot_notice_claimed_at).not.toBeNull();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    const [err, ctx] = sentry.captureAPIError.mock.calls[0];
    expect(ctx).toMatchObject({ stage: "repoint_release" });
    expect(String(err.message)).not.toMatch(/@/); // no addresses in Sentry
  });

  it("a lock-write failure is a 503 and nothing else is written", async () => {
    db.failOnce("bookings", "update", "boom");
    expect((await act("repoint_lot_inbox")).status).toBe(503);
    expect(db.tables.direct_booking_terms[0].recipients_rev).toBe(0);
    // The release ran and found nothing of ours — expected on this path, not reported.
    expect(sentry.captureAPIError).not.toHaveBeenCalled();
  });

  it("a lock write that COMMITTED but answered with an error → the claim is still handed back; 503, terms untouched", async () => {
    db.failAfterCommitWhen("bookings", "update", (p) => p !== null && typeof p.lot_notice_claimed_at === "string", "statement timeout");
    const res = await act("repoint_lot_inbox");
    expect(res.status).toBe(503);
    expect(db.tables.bookings[0].lot_notice_claimed_at).toBeNull(); // released by our own timestamp
    expect(db.tables.direct_booking_terms[0]).toMatchObject({ lot_recipients: LOT_INBOX, recipients_rev: 0 });
    expect(sentry.captureAPIError).not.toHaveBeenCalled();
    // …so a Retry can claim the notice straight away.
    redrive.mockResolvedValue({ kind: "attempted", notice: "sent", customerEmail: "already_sent" });
    expect((await act("retry_lot_notice")).status).toBe(200);
  });

  it("lock write errored AND the release failed → 503, and the release failure is reported", async () => {
    db.failAfterCommitWhen("bookings", "update", (p) => p !== null && typeof p.lot_notice_claimed_at === "string", "statement timeout");
    db.failWhen("bookings", "update", (p) => p !== null && p.lot_notice_claimed_at === null, "boom");
    expect((await act("repoint_lot_inbox")).status).toBe(503);
    expect(db.tables.bookings[0].lot_notice_claimed_at).not.toBeNull(); // goes stale
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureAPIError.mock.calls[0][0].message)).toMatch(/outcome was unknown/);
  });

  it.each([
    ["already told", { lot_notified_at: "2026-10-12T15:00:00Z" }],
    ["not confirmed", { status: "refunded" }],
    ["mid-cancel", { cancel_state: "claimed" }],
  ])("409 when %s — the CMS is never read", async (_l, over) => {
    db.tables.bookings = [booking(over)];
    expect((await act("repoint_lot_inbox")).status).toBe(409);
    expect(fetchLot).not.toHaveBeenCalled();
  });

  it.each([
    ["the same inbox (case/space/duplicates ignored)", { status: "found", lot: { notificationEmails: [" OLD@lot.example", "old@lot.example"] } }, 409],
    ["an empty CMS inbox", { status: "found", lot: { notificationEmails: [] } }, 409],
    ["an invalid CMS address", { status: "found", lot: { notificationEmails: ["not-an-email"] } }, 409],
    ["the lot gone from the CMS", { status: "not_found" }, 409],
    ["the CMS unreachable", { status: "unavailable", kind: "timeout", message: "x" }, 503],
    ["a broken CMS row", { status: "invalid", reason: "x" }, 503],
  ])("refuses %s — nothing locked or written", async (_l, lookup, status) => {
    fetchLot.mockResolvedValue(lookup);
    expect((await act("repoint_lot_inbox")).status).toBe(status);
    expect(db.tables.bookings[0].lot_notice_claimed_at).toBeNull();
    expect(db.tables.direct_booking_terms[0]).toMatchObject({ lot_recipients: LOT_INBOX, recipients_rev: 0 });
    expect(db.log.filter((l) => l.op === "update")).toEqual([]);
  });
});

describe("resend_lot_cancellation", () => {
  beforeEach(() => {
    db.tables.bookings = [booking({ status: "refunded", lot_notified_at: "2026-10-12T15:00:00Z", lot_cancel_notified_at: "2026-10-13T09:00:00Z" })];
  });

  it("sends the cancel email to the booking's inbox (test override here), claims + records the audit row", async () => {
    const res = await act("resend_lot_cancellation");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, action: "resend_lot_cancellation", outcome: "sent", n: 1, recipients: ["ops@triplypro.com"], test: true,
    });
    const [msg, opts] = resendSend.mock.calls[0];
    expect(msg.subject).toBe(`[TEST] CANCELLED — Triply booking ${TRP}`);
    expect(msg.to).toEqual(["ops@triplypro.com"]);
    expect(msg.html).toContain("Ada Lovelace"); // the staged guest, not the account holder
    expect(msg.html).toContain("2:30 PM"); // literal wall-clock time
    expect(opts).toEqual({ idempotencyKey: "direct-lot-reminder/b1/lot_cancel_reminder/1" });
    expect(db.tables.direct_lot_resends).toHaveLength(1);
    expect(db.tables.direct_lot_resends[0]).toMatchObject({
      booking_id: "b1", stripe_payment_intent_id: PI, livemode: false, kind: "lot_cancel_reminder", source: "admin:1",
      sent_by: "tom@triplypro.com", outcome: "sent", email_id: "em_1", recipients: ["ops@triplypro.com"],
    });
    // Never touches a bookings claim/stamp column.
    expect(db.log.filter((l) => l.table === "bookings" && l.op !== "select")).toEqual([]);
  });

  it("production + live: the snapshot inbox, no [TEST]; a second re-send is admin:2 with its own key", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    db.tables.bookings[0].livemode = true;
    db.tables.direct_booking_terms = [terms({ livemode: true })];
    expect((await act("resend_lot_cancellation")).status).toBe(200);
    expect((await act("resend_lot_cancellation")).status).toBe(200);
    expect(resendSend.mock.calls[0][0]).toMatchObject({ to: LOT_INBOX, subject: `CANCELLED — Triply booking ${TRP}` });
    expect(resendSend.mock.calls[1][1]).toEqual({ idempotencyKey: "direct-lot-reminder/b1/lot_cancel_reminder/2" });
    expect(db.tables.direct_lot_resends.map((r) => r.source)).toEqual(["admin:1", "admin:2"]);
  });

  it("two re-sends racing on the same n (two admins at once) → ONE email, the other 409 (the real UNIQUE)", async () => {
    const [a, b] = await Promise.all([act("resend_lot_cancellation"), act("resend_lot_cancellation")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(db.tables.direct_lot_resends).toHaveLength(1);
    expect(db.tables.direct_lot_resends[0]).toMatchObject({ source: "admin:1", outcome: "sent" });
    const loser = a.status === 409 ? a : b;
    expect((await loser.json()).error).toMatch(/another re-send/i);
  });

  it("a concurrent re-send (UNIQUE 23505 on the audit row) → 409, nothing sent", async () => {
    db.failOnce("direct_lot_resends", "insert", "duplicate key value violates unique constraint", "23505");
    const res = await act("resend_lot_cancellation");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/another re-send/i);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("a Resend timeout/5xx is recorded 'unknown'; a 4xx 'failed' — each a Sentry event", async () => {
    resendSend.mockResolvedValueOnce({ data: null, error: { name: "application_error", message: "x", statusCode: null } });
    expect((await (await act("resend_lot_cancellation")).json()).outcome).toBe("unknown");
    resendSend.mockResolvedValueOnce({ data: null, error: { name: "validation_error", message: "bad", statusCode: 422 } });
    expect((await (await act("resend_lot_cancellation")).json()).outcome).toBe("failed");
    expect(db.tables.direct_lot_resends.map((r) => r.outcome)).toEqual(["unknown", "failed"]);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(2);
  });

  it("no override inbox off-production → 503, no audit row", async () => {
    vi.stubEnv("DIRECT_LOT_NOTICE_OVERRIDE_TO", "");
    expect((await act("resend_lot_cancellation")).status).toBe(503);
    expect(db.tables.direct_lot_resends).toEqual([]);
  });

  it("a failed outcome write is a Sentry event; the send result still returns", async () => {
    db.failOnce("direct_lot_resends", "update", "boom");
    const res = await act("resend_lot_cancellation");
    expect(res.status).toBe(200);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["still confirmed", { status: "confirmed", lot_cancel_notified_at: null }],
    ["no cancellation sent yet", { lot_cancel_notified_at: null }],
  ])("409 when %s", async (_l, over) => {
    Object.assign(db.tables.bookings[0], over);
    expect((await act("resend_lot_cancellation")).status).toBe(409);
    expect(resendSend).not.toHaveBeenCalled();
    expect(db.tables.direct_lot_resends).toEqual([]);
  });
});

describe("resend_customer_confirmation", () => {
  const view = {
    ok: true,
    dp: { customer: { email: "ada@example.com" } },
    fr: { number: TRP },
    pgSyncStatus: "not_applicable",
    charged: null,
    promo: { code: null, percent: 0 },
  };

  it("rebuilds the view and sends to the staged guest under a per-re-send key; audited", async () => {
    buildView.mockResolvedValue(view);
    sendConfirmation.mockResolvedValue(true);
    const res = await act("resend_customer_confirmation");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, outcome: "sent", n: 1, recipients: ["ada@example.com"] });
    expect(buildView).toHaveBeenCalledWith(PI);
    expect(sendConfirmation).toHaveBeenCalledWith(view.dp, view.fr, view.pgSyncStatus, null, view.promo, {
      idempotencyKey: "direct-confirmation/resend/b1/1",
    });
    expect(db.tables.direct_lot_resends[0]).toMatchObject({ kind: "customer_confirmation", source: "admin:1", outcome: "sent", recipients: ["ada@example.com"] });
  });

  it("a send that was not confirmed is recorded 'unknown' (a timeout returns false too — it may have been delivered)", async () => {
    buildView.mockResolvedValue(view);
    sendConfirmation.mockResolvedValue(false);
    expect((await (await act("resend_customer_confirmation")).json()).outcome).toBe("unknown");
    expect(db.tables.direct_lot_resends[0]).toMatchObject({ outcome: "unknown", last_error: expect.stringMatching(/may have been delivered/) });
  });

  it("refused (409) while the ORIGINAL confirmation hasn't gone — it is retried automatically; nothing sent or audited", async () => {
    buildView.mockResolvedValue({ ok: false, reason: "unsent" });
    const res = await act("resend_customer_confirmation");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "The original confirmation hasn't gone yet — press 'Send confirmation now' (retried automatically until check-out too)."
    );
    expect(sendConfirmation).not.toHaveBeenCalled();
    expect(db.tables.direct_lot_resends).toEqual([]);
  });

  it.each([
    ["refunded", 409],
    ["not_confirmed", 409],
    ["unreadable", 500],
    ["other_mode", 409],
    ["unsent", 409],
  ])("view refusal %s → %i, no audit row, nothing sent", async (reason, status) => {
    buildView.mockResolvedValue({ ok: false, reason });
    expect((await act("resend_customer_confirmation")).status).toBe(status);
    expect(sendConfirmation).not.toHaveBeenCalled();
    expect(db.tables.direct_lot_resends).toEqual([]);
  });

  it("a Stripe/DB read failure building the view → 502, no audit row", async () => {
    buildView.mockRejectedValue(new Error("stripe down"));
    expect((await act("resend_customer_confirmation")).status).toBe(502);
    expect(db.tables.direct_lot_resends).toEqual([]);
  });

  it("23505 on the audit row → 409, nothing sent", async () => {
    buildView.mockResolvedValue(view);
    db.failOnce("direct_lot_resends", "insert", "dup", "23505");
    expect((await act("resend_customer_confirmation")).status).toBe(409);
    expect(sendConfirmation).not.toHaveBeenCalled();
  });

  it("409 for a cancelled booking or one mid-cancel — the view is never built", async () => {
    db.tables.bookings = [booking({ status: "cancelled" })];
    expect((await act("resend_customer_confirmation")).status).toBe(409);
    db.tables.bookings = [booking({ cancel_claimed_at: ago(1000) })];
    expect((await act("resend_customer_confirmation")).status).toBe(409);
    expect(buildView).not.toHaveBeenCalled();
  });
});

describe("resolve_alerts — \"lot phoned\"", () => {
  const FOLLOWUP = "b1:manifest:1:2026-10-14:abcdef0123456789";
  beforeEach(() => {
    db.tables.direct_lot_alerts = [
      alert(),
      alert({ kind: "cancel_notice" }),
      alert({ subject: FOLLOWUP, kind: "followup" }),
      alert({ kind: "lot_notice", subject: PI, livemode: true }), // the other environment's row for the same PI
      alert({ subject: "pi_other" }), // another booking
      alert({ subject: "b2:manifest:1:2026-10-14:abcdef0123456789", kind: "followup" }), // another booking's follow-up
      alert({ subject: "1:2026-10-14", kind: "manifest" }), // lot-level — never a booking's to resolve
    ];
  });
  const resolvedRows = () => db.tables.direct_lot_alerts.filter((r) => r.resolved_at !== null);

  it("resolves this booking's open lot_notice / cancel_notice / followup rows in its own mode, by this admin", async () => {
    const res = await act("resolve_alerts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "resolve_alerts", resolved: 3 });
    expect(resolvedRows().map((r) => [r.subject, r.kind, r.livemode])).toEqual([
      [PI, "lot_notice", false],
      [PI, "cancel_notice", false],
      [FOLLOWUP, "followup", false],
    ]);
    for (const r of resolvedRows()) {
      expect(r.resolved_by).toBe("tom@triplypro.com");
      expect(typeof r.resolved_at).toBe("string");
    }
    // Nothing else touched; the alerts' own cadence columns untouched.
    expect(db.tables.direct_lot_alerts[0]).toMatchObject({ alerted_at: "2026-10-13T08:01:00Z", first_seen_at: "2026-10-13T08:00:00Z" });
    expect(db.log.filter((l) => l.op !== "select").every((l) => l.table === "direct_lot_alerts")).toBe(true);
  });

  it("an already-resolved row is left as it was; pressing it again resolves nothing (0)", async () => {
    db.tables.direct_lot_alerts[0].resolved_at = "2026-10-13T09:30:00Z";
    db.tables.direct_lot_alerts[0].resolved_by = "vin@triplypro.com";
    expect((await (await act("resolve_alerts")).json()).resolved).toBe(2);
    expect(db.tables.direct_lot_alerts[0]).toMatchObject({ resolved_at: "2026-10-13T09:30:00Z", resolved_by: "vin@triplypro.com" });
    expect((await (await act("resolve_alerts")).json()).resolved).toBe(0);
  });

  it("works on a cancelled booking too (the \"phone the lot to cancel\" alert)", async () => {
    db.tables.bookings = [booking({ status: "cancelled", lot_notified_at: "2026-10-12T15:00:00Z" })];
    expect((await (await act("resolve_alerts")).json()).resolved).toBe(3);
  });

  it("a write failure is a 503 — pressing it again is safe", async () => {
    db.failOnce("direct_lot_alerts", "update", "boom");
    const res = await act("resolve_alerts");
    expect(res.status).toBe(503);
    expect(resolvedRows()).toEqual([]);
    expect((await (await act("resolve_alerts")).json()).resolved).toBe(3);
  });

  it("admin only", async () => {
    h.isAdmin.current = false;
    expect((await act("resolve_alerts")).status).toBe(403);
    expect(resolvedRows()).toEqual([]);
  });
});
