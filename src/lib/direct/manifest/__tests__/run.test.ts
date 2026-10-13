/**
 * The evening manifest (6b plan §3, §8 "Manifest"): which lots and day, what
 * is listed, the send-once state machine, follow-ups, the noon cutoff, force.
 * All times are fixed instants against America/New_York, including both 2026–27
 * DST changes; booking times are literal wall clocks and must render as such.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mdb, resendSend, sentry } = await vi.hoisted(async () => {
  const { ManifestDb } = await import("@/lib/direct/manifest/__tests__/manifest-db");
  return {
    mdb: new ManifestDb(),
    resendSend: vi.fn(),
    sentry: { captureMessage: vi.fn(), captureException: vi.fn(), fingerprints: [] as string[][] },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => mdb.client }));
vi.mock("@/lib/resend/client", () => ({ resend: { emails: { send: resendSend } }, FROM_EMAIL: "Triply <bookings@triplypro.com>" }));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: sentry.captureMessage,
  captureException: sentry.captureException,
  withScope: (fn: (scope: unknown) => void) =>
    fn({
      setFingerprint: (f: string[]) => sentry.fingerprints.push(f),
      setTag: vi.fn(),
      setContext: vi.fn(),
      setExtra: vi.fn(),
      setLevel: vi.fn(),
      setUser: vi.fn(),
    }),
  flush: vi.fn().mockResolvedValue(true),
  captureCheckIn: vi.fn(),
}));

import { createAdminClient } from "@/lib/supabase/server";
import { runManifestCron, CUTOFF_REASON, CUTOFF_NOT_SENT_REASON, type RunRow } from "../run";
import { renderManifest } from "../render";
import { manifestLotDays } from "../schedule";
import { recipientsHash, type ManifestRow } from "../select";
import { BoundedTimeoutError } from "@/lib/utils/bounded";
import { directLotRow } from "@/lib/direct/__tests__/fixtures";
import { RUNS, ALERTS, RESENDS } from "./manifest-db";
import type { Row } from "@/lib/booking/__tests__/supabase-fake";

const LOT_INBOX = ["Desk@ParkingPoint.example", "owner@parkingpoint.example"];
const OVERRIDE = "ops@triplypro.com";
const HASH = recipientsHash(LOT_INBOX);
/** Oct 31 2026, 18:30 EDT — the evening before the fall-back day. */
const EVENING = "2026-10-31T22:30:00Z";
const TOMORROW = "2026-11-01";

interface BookingOpts {
  id: string;
  pi?: string;
  number?: string;
  checkIn?: string;
  checkOut?: string;
  recipients?: string[];
  guest?: { firstName: string; lastName: string; phone: string } | null;
  over?: Row;
}

function addBooking(o: BookingOpts) {
  const pi = o.pi ?? `pi_${o.id}`;
  mdb.rows("bookings").push({
    id: o.id,
    stripe_payment_intent_id: pi,
    reslab_reservation_number: o.number ?? `TRP-${o.id.toUpperCase()}`,
    inventory_source: "direct",
    direct_lot_id: "1",
    livemode: false,
    status: "confirmed",
    cancel_state: null,
    cancel_claimed_at: null,
    lot_notified_at: "2026-10-30T15:00:00.000Z",
    lot_notice_claimed_at: "2026-10-30T15:00:00.000Z",
    location_name: "The Parking Point JFK",
    location_timezone: "America/New_York",
    lot_snapshot: { name: "The Parking Point JFK", timezone: "America/New_York" },
    check_in: o.checkIn ?? `${TOMORROW}T09:30:00`,
    check_out: o.checkOut ?? "2026-11-05T17:00:00",
    vehicle_info: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC123", state: "NY" },
    vehicle_size_label: "Large SUV / truck",
    vehicle_surcharge_cents: 5000,
    vehicle_surcharge_tax_cents: 519,
    protection_plan: "$1,000 Protection",
    customer_id: null,
    ...o.over,
  });
  mdb.rows("direct_booking_terms").push({ stripe_payment_intent_id: pi, livemode: o.over?.livemode ?? false, lot_recipients: o.recipients ?? LOT_INBOX, recipients_rev: 0 });
  if (o.guest !== null) {
    mdb.rows("pending_bookings").push({
      stripe_payment_intent_id: pi,
      customer: { email: "guest@example.com", ...(o.guest ?? { firstName: "Ada", lastName: "Lovelace", phone: "555-0100" }) },
    });
  }
}

function setBooking(id: string, patch: Row) {
  const b = mdb.rows("bookings").find((r) => r.id === id);
  if (!b) throw new Error(`no booking ${id}`);
  Object.assign(b, patch);
}

function cmsLots(rows: Row[]) {
  mdb.base.rpcHandlers.direct_lots_v2 = () => ({ data: rows, error: null });
}

async function tick(atIso: string, o: Partial<{ livemode: boolean; dry: boolean; disabled: boolean; force: boolean; target: { lotId: string; date: string } | null; deadlineMs: number }> = {}) {
  vi.setSystemTime(new Date(atIso));
  const nowMs = Date.now();
  return runManifestCron({
    supabase: await createAdminClient(),
    livemode: o.livemode ?? false,
    nowMs,
    deadlineMs: o.deadlineMs ?? nowMs + 45_000,
    dry: o.dry ?? false,
    disabled: o.disabled ?? false,
    target: o.target ?? null,
    force: o.force ?? false,
  });
}

const runs = () => mdb.rows(RUNS);
const sends = () => resendSend.mock.calls.map((c) => ({ to: c[0].to as string[], subject: c[0].subject as string, text: c[0].text as string, html: c[0].html as string, key: c[1].idempotencyKey as string }));
const manifestSends = () => sends().filter((s) => s.key.startsWith("direct-lot-manifest/"));
const followUpSends = () => sends().filter((s) => s.key.startsWith("direct-lot-followup/"));
const keyFor = (attempt: number, hash = HASH, date = TOMORROW, mode = "test") => `direct-lot-manifest/1/${date}/${mode}/${hash}/${attempt}`;

function seedRun(over: Partial<RunRow> & Row) {
  mdb.rows(RUNS).push({
    direct_lot_id: "1",
    manifest_date: TOMORROW,
    livemode: false,
    recipients_hash: HASH,
    status: "sending",
    attempt: 1,
    claimed_at: "2026-10-31T22:00:00.000Z",
    attempt_claimed_at: "2026-10-31T22:00:00.000Z",
    had_unknown: false,
    booking_ids: [],
    ids_ever: [],
    recipients: [OVERRIDE],
    test: true,
    first_sent_at: null,
    sent_at: null,
    email_id: null,
    last_error: null,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sentry.fingerprints.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  mdb.reset();
  cmsLots([directLotRow({ notification_emails: LOT_INBOX })]);
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
  vi.stubEnv("DIRECT_LOT_NOTICE_OVERRIDE_TO", OVERRIDE);
  vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "false");
  resendSend.mockResolvedValue({ data: { id: "em_1" }, error: null });
});
afterEach(() => {
  // The manifest can be recovered or forced on the day itself: it never says "tomorrow".
  for (const m of manifestSends()) expect([m.subject, m.text, m.html].join(" ")).not.toMatch(/tomorrow/i);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
describe("lots and day (§3.1)", () => {
  it("keys the lot as '1', computes lot-local today/tomorrow, and sends only 18:00–23:00 lot time", async () => {
    addBooking({ id: "b1" });
    vi.setSystemTime(new Date("2026-10-31T21:59:00Z"));
    const { lots } = await manifestLotDays(await createAdminClient(), false, Date.now());
    expect(lots).toEqual([
      { lotId: "1", timezone: "America/New_York", localDate: "2026-10-31", localMinutes: 17 * 60 + 59, manifestDate: TOMORROW, hasBookingsTomorrow: true, expectsManifest: true },
    ]);

    await tick("2026-10-31T21:59:00Z"); // 17:59 EDT
    expect(resendSend).not.toHaveBeenCalled();
    expect(runs()).toHaveLength(0);

    await tick("2026-10-31T22:00:00Z"); // 18:00 EDT
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(1)]);
    expect(runs()[0]).toMatchObject({ direct_lot_id: "1", manifest_date: TOMORROW, status: "checked", sent_at: expect.any(String) });
  });

  it("22:59 lot time is in the window, 23:00 is not", async () => {
    addBooking({ id: "b1" });
    await tick("2026-11-01T03:00:00Z"); // Oct 31 23:00 EDT
    expect(resendSend).not.toHaveBeenCalled();
    await tick("2026-11-01T02:59:00Z"); // Oct 31 22:59 EDT
    expect(manifestSends()).toHaveLength(1);
  });

  it("fall back (2026-11-01): 17:30 EST is outside the window although it is 18:30 EDT-equivalent; 18:00 EST sends for Nov 2", async () => {
    addBooking({ id: "b1", checkIn: "2026-11-02T01:30:00" });
    await tick("2026-11-01T22:30:00Z"); // 17:30 EST
    expect(resendSend).not.toHaveBeenCalled();
    await tick("2026-11-01T23:00:00Z"); // 18:00 EST
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(1, HASH, "2026-11-02")]);
    expect(manifestSends()[0].text).toContain("1:30 AM");
  });

  it("the fall-back day's ambiguous 1:30 AM arrival renders literally", async () => {
    addBooking({ id: "b1", checkIn: `${TOMORROW}T01:30:00` });
    await tick(EVENING);
    expect(manifestSends()[0].text).toContain("Time: 1:30 AM | Confirmation: TRP-B1");
  });

  it("spring forward (2027-03-14): a 2:30 AM arrival that never exists on the clock renders literally; window follows EDT", async () => {
    addBooking({ id: "b1", checkIn: "2027-03-14T02:30:00", checkOut: "2027-03-16T10:00:00" });
    await tick("2027-03-13T23:00:00Z"); // Mar 13 18:00 EST
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(1, HASH, "2027-03-14")]);
    expect(manifestSends()[0].text).toContain("2:30 AM");

    addBooking({ id: "b2", checkIn: "2027-03-15T08:00:00", checkOut: "2027-03-16T10:00:00" });
    await tick("2027-03-14T21:30:00Z"); // 17:30 EDT
    expect(manifestSends()).toHaveLength(1);
    await tick("2027-03-14T22:00:00Z"); // 18:00 EDT
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(1, HASH, "2027-03-14"), keyFor(1, HASH, "2027-03-15")]);
  });

  it("zone disagreement → the lot is skipped and a lot_config alert row is upserted (last_seen_at + detail only)", async () => {
    addBooking({ id: "b1", over: { location_timezone: "America/Chicago" } });
    mdb.rows(ALERTS).push({ subject: "1:tz", kind: "lot_config", livemode: false, first_seen_at: "2026-10-01T00:00:00.000Z", last_seen_at: "2026-10-01T00:00:00.000Z", alerted_at: "2026-10-01T00:05:00.000Z", detail: {} });
    const r = await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(runs()).toHaveLength(0);
    expect(r.lots).toEqual([]);
    const alert = mdb.rows(ALERTS).find((a) => a.subject === "1:tz");
    expect(alert).toMatchObject({ kind: "lot_config", livemode: false, first_seen_at: "2026-10-01T00:00:00.000Z", alerted_at: "2026-10-01T00:05:00.000Z", last_seen_at: new Date(EVENING).toISOString() });
    expect(JSON.stringify(alert?.detail)).toContain("TRP-B1");
    expect(JSON.stringify(alert?.detail)).not.toMatch(/Ada|555-0100|@/);
  });

  it("an invalid zone and two bookings disagreeing are both zone problems", async () => {
    addBooking({ id: "b1", over: { location_timezone: null, lot_snapshot: { name: "X", timezone: "Mars/Olympus" } } });
    const r1 = await manifestLotDays(await createAdminClient(), false, Date.parse(EVENING));
    expect(r1.problems).toEqual([expect.objectContaining({ lotId: "1", kind: "tz" })]);
    mdb.reset();
    cmsLots([]);
    addBooking({ id: "b1" });
    addBooking({ id: "b2", over: { location_timezone: "America/Chicago", lot_snapshot: { name: "X", timezone: "America/Chicago" } } });
    const r2 = await manifestLotDays(await createAdminClient(), false, Date.parse(EVENING));
    expect(r2.lots).toEqual([]);
    expect(r2.problems[0].detail).toContain("America/Chicago vs America/New_York");
  });

  it("a failed CMS read is a 'cms' problem; booked lots still get their manifest", async () => {
    mdb.base.rpcHandlers.direct_lots_v2 = () => ({ data: null, error: { message: "boom", code: "XX000" } });
    addBooking({ id: "b1" });
    const r = await tick(EVENING);
    expect(manifestSends()).toHaveLength(1);
    expect(r.problems).toEqual([expect.objectContaining({ lotId: "all", kind: "cms" })]);
    expect(mdb.rows(ALERTS).map((a) => a.subject)).toEqual(["all:cms"]);
  });

  it("staging sees test-mode rows only; production (live key) sees live rows only and mails the lot's own inbox", async () => {
    addBooking({ id: "live", over: { livemode: true } });
    addBooking({ id: "test1" });
    await tick(EVENING, { livemode: false });
    expect(manifestSends()).toHaveLength(1);
    expect(manifestSends()[0]).toMatchObject({ to: [OVERRIDE], key: keyFor(1) });
    expect(manifestSends()[0].text).toContain("TRP-TEST1");
    expect(manifestSends()[0].text).not.toContain("TRP-LIVE");
    expect(manifestSends()[0].subject).toMatch(/^\[TEST\] /);

    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    await tick(EVENING, { livemode: true });
    const live = manifestSends()[1];
    expect(live.key).toBe(keyFor(1, HASH, TOMORROW, "live"));
    expect(live.to).toEqual(["desk@parkingpoint.example", "owner@parkingpoint.example"]);
    expect(live.subject).not.toContain("[TEST]");
    expect(live.text).toContain("TRP-LIVE");
    expect(live.text).not.toContain("TRP-TEST1");
    expect(runs().map((r) => r.livemode).sort()).toEqual([false, true]);
  });
});

// ---------------------------------------------------------------------------
describe("rows and content (§3.2, §3.3)", () => {
  it("lists arrivals and departures with 12-hour literal times, guest, phone, vehicle, size, at-lot amount and Park Guard", async () => {
    addBooking({ id: "a1", checkIn: `${TOMORROW}T14:05:00` });
    addBooking({ id: "d1", checkIn: "2026-10-28T08:00:00", checkOut: `${TOMORROW}T23:45:00`, over: { protection_plan: null, vehicle_surcharge_cents: 0, vehicle_surcharge_tax_cents: 0 }, guest: { firstName: "Grace", lastName: "Hopper", phone: "555-0199" } });
    addBooking({ id: "both", checkIn: `${TOMORROW}T06:00:00`, checkOut: `${TOMORROW}T20:00:00` });
    await tick(EVENING);
    const [m] = manifestSends();
    expect(m.subject).toBe("[TEST] Reminder — Triply bookings for Sun, Nov 1, 2026 at The Parking Point JFK (2 arrivals, 2 departures)");
    expect(m.text).toContain("A reminder of the bookings we have already emailed you.");
    expect(m.text).toContain("As of 6:30 PM lot time. New bookings and every cancellation still come as separate emails — a cancellation email always overrides this list.");
    const arrivals = m.text.slice(m.text.indexOf("Arrivals"), m.text.indexOf("Departures"));
    const departures = m.text.slice(m.text.indexOf("Departures"));
    expect(arrivals.indexOf("TRP-BOTH")).toBeLessThan(arrivals.indexOf("TRP-A1"));
    expect(arrivals).toContain("Time: 2:05 PM | Confirmation: TRP-A1 | Guest: Ada Lovelace | Phone: 555-0100 | Vehicle: Black Ford F-150 — plate ABC123 (NY) | Size: Large SUV / truck | Collect at the lot (est.): $55.19 (oversized-vehicle surcharge incl. tax) | Park Guard: Yes");
    expect(departures).toContain("Time: 11:45 PM | Confirmation: TRP-D1 | Guest: Grace Hopper | Phone: 555-0199");
    expect(departures).toContain("At the lot: Nothing | Park Guard: No");
    // A departing car paid its surcharge at drop-off: never "collect" again.
    expect(departures).toContain("Confirmation: TRP-BOTH | Guest: Ada Lovelace | Phone: 555-0100 | Vehicle: Black Ford F-150 — plate ABC123 (NY) | Size: Large SUV / truck | At the lot: Collected at drop-off | Park Guard: Yes");
    expect(departures).not.toContain("Collect at the lot");
    expect(m.html).toContain("Arrivals and departures at The Parking Point JFK — Sun, Nov 1");
    expect(m.text).not.toMatch(/no arrivals/i);
  });

  it("escapes booking text in the HTML and shows an unknown at-lot amount as unknown, never $0", async () => {
    addBooking({ id: "b1", guest: { firstName: "<b>Ada</b>", lastName: "L", phone: "1" }, over: { vehicle_surcharge_tax_cents: null } });
    await tick(EVENING);
    const [m] = manifestSends();
    expect(m.html).toContain("&lt;b&gt;Ada&lt;/b&gt;");
    expect(m.html).not.toContain("<b>Ada</b>");
    expect(m.text).toContain("Collect at the lot (est.): Unknown — see the booking email");
  });

  it("leaves off a mid-cancel row and an unstamped row", async () => {
    addBooking({ id: "ok" });
    addBooking({ id: "midcancel", over: { cancel_claimed_at: "2026-10-31T22:29:00.000Z" } });
    addBooking({ id: "midstate", over: { cancel_state: "claimed" } });
    addBooking({ id: "untold", over: { lot_notified_at: null } });
    await tick(EVENING);
    const [m] = manifestSends();
    expect(m.text).toContain("TRP-OK");
    expect(m.text).not.toMatch(/TRP-MIDCANCEL|TRP-MIDSTATE|TRP-UNTOLD/);
    expect(runs()[0].ids_ever).toEqual(["ok"]);
  });

  it("an unlisted booking tomorrow: no manifest and NEVER an empty-day email for that lot", async () => {
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "true");
    addBooking({ id: "untold", over: { lot_notified_at: null, lot_notice_claimed_at: null } });
    const r = await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(runs()).toHaveLength(0);
    expect(r.lots[0]).toMatchObject({ lotId: "1", hasBookingsTomorrow: true, expectsManifest: true });
  });

  it("one manifest per recipient set: the inbox changed between bookings", async () => {
    addBooking({ id: "old", recipients: ["old@lot.example"] });
    addBooking({ id: "new", recipients: [" NEW@lot.example ", "new@lot.example"] });
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    mdb.rows("bookings").forEach((b) => (b.livemode = true));
    await tick(EVENING, { livemode: true });
    const bySet = Object.fromEntries(manifestSends().map((s) => [s.to.join(","), s.text]));
    expect(Object.keys(bySet).sort()).toEqual(["new@lot.example", "old@lot.example"]);
    expect(bySet["old@lot.example"]).toContain("TRP-OLD");
    expect(bySet["old@lot.example"]).not.toContain("TRP-NEW");
    expect(bySet["new@lot.example"]).toContain("TRP-NEW");
    expect(bySet["new@lot.example"]).not.toContain("TRP-OLD");
    expect(runs().map((r) => r.recipients_hash).sort()).toEqual([recipientsHash(["new@lot.example"]), recipientsHash(["old@lot.example"])].sort());
  });
});

// ---------------------------------------------------------------------------
describe("empty day (§3.1, E1)", () => {
  it("sellable + checkout open + no booking tomorrow → the empty reminder to the CMS inbox (override off production)", async () => {
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "true");
    addBooking({ id: "later", checkIn: "2026-11-02T09:00:00" }); // a booked lot, but not tomorrow
    await tick(EVENING);
    const [m] = manifestSends();
    expect(m.key).toBe(keyFor(1));
    expect(m.to).toEqual([OVERRIDE]);
    expect(m.subject).toBe("[TEST] Reminder — Triply, Sun, Nov 1, 2026 at The Parking Point JFK: nothing in this reminder");
    expect(m.text).toContain("Nothing in this reminder — new bookings come as separate emails.");
    expect(m.text).not.toMatch(/no arrivals|TRP-LATER/i);
    expect(runs()[0]).toMatchObject({ booking_ids: [], ids_ever: [], status: "checked" });
  });

  it("not sellable → nothing", async () => {
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "true");
    cmsLots([directLotRow({ notification_emails: LOT_INBOX, is_active: false })]);
    const r = await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(r.lots).toEqual([]);
  });

  it("production before DIRECT_BOOKING_OPEN → nothing, even with the preview flag set", async () => {
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "true");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    cmsLots([directLotRow({ notification_emails: LOT_INBOX, visibility: "production" })]);
    const r = await tick(EVENING, { livemode: true });
    expect(resendSend).not.toHaveBeenCalled();
    expect(r.lots).toEqual([]);
  });

  it("a booking that appears before the send supersedes the empty reminder", async () => {
    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "true");
    mdb.beforeMutation = (table, op, payload) => {
      if (table === RUNS && op === "insert") {
        mdb.beforeMutation = null;
        addBooking({ id: "late", over: { lot_notified_at: null } });
        expect(payload.booking_ids).toEqual([]);
      }
    };
    const r = await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(r.runs.superseded).toBe(1);
    expect(runs()[0]).toMatchObject({ status: "failed", last_error: expect.stringMatching(/^superseded:/) });
  });
});

// ---------------------------------------------------------------------------
describe("send once (§3.4)", () => {
  it("a double-fired cron sends one manifest", async () => {
    addBooking({ id: "b1" });
    vi.setSystemTime(new Date(EVENING));
    const nowMs = Date.now();
    const opts = { livemode: false, nowMs, deadlineMs: nowMs + 45_000, dry: false, disabled: false, target: null, force: false };
    await Promise.all([runManifestCron({ ...opts, supabase: await createAdminClient() }), runManifestCron({ ...opts, supabase: await createAdminClient() })]);
    await tick("2026-10-31T22:40:00Z");
    expect(manifestSends()).toHaveLength(1);
    expect(runs()).toHaveLength(1);
  });

  it("every status write on a run is a compare-and-set on (attempt, status, claimed_at)", async () => {
    addBooking({ id: "b1" });
    addBooking({ id: "b2" });
    resendSend.mockResolvedValueOnce({ data: null, error: { name: "application_error", message: "lost", statusCode: null } });
    await tick(EVENING);
    setBooking("b2", { status: "cancelled" });
    await tick("2026-10-31T22:45:00Z");
    const runUpdates = mdb.updates.filter((u) => u.table === RUNS);
    expect(runUpdates.length).toBeGreaterThanOrEqual(4);
    for (const u of runUpdates) expect(u.filters).toEqual(expect.arrayContaining(["attempt.eq", "status.eq", "claimed_at.eq"]));
  });

  it("a lost lease (another sender moved the claim) sends nothing", async () => {
    addBooking({ id: "b1" });
    mdb.beforeMutation = (table, op) => {
      if (table === RUNS && op === "update") {
        mdb.beforeMutation = null;
        runs()[0].claimed_at = "2026-10-31T22:30:01.000Z";
      }
    };
    const r = await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(r.runs.lost_lease).toBe(1);
  });

  it("unknown → stays sending (had_unknown); a fresh claim is left alone; the takeover repeats the SAME key and an accepted earlier request counts as sent", async () => {
    addBooking({ id: "b1" });
    resendSend.mockRejectedValueOnce(new BoundedTimeoutError("Resend", 10_000));
    await tick(EVENING);
    expect(runs()[0]).toMatchObject({ status: "sending", had_unknown: true, attempt: 1 });

    await tick("2026-10-31T22:33:00Z"); // 3 min: the claim is fresh
    expect(manifestSends()).toHaveLength(1);

    resendSend.mockResolvedValueOnce({ data: null, error: { name: "invalid_idempotent_request", message: "same key, different body", statusCode: 409 } });
    await tick("2026-10-31T22:40:00Z");
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(1), keyFor(1)]);
    expect(runs()[0]).toMatchObject({ status: "checked", attempt: 1, sent_at: expect.any(String) });
  });

  it("after an unknown, a definite failure keeps the run sending under the same key — never a new attempt", async () => {
    addBooking({ id: "b1" });
    resendSend
      .mockResolvedValueOnce({ data: null, error: { name: "internal_server_error", message: "500", statusCode: 500 } })
      .mockResolvedValueOnce({ data: null, error: { name: "rate_limit_exceeded", message: "429", statusCode: 429 } });
    await tick(EVENING);
    await tick("2026-10-31T22:40:00Z");
    expect(runs()[0]).toMatchObject({ status: "sending", had_unknown: true, attempt: 1 });
    await tick("2026-10-31T22:50:00Z");
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(1), keyFor(1), keyFor(1)]);
    expect(runs()[0]).toMatchObject({ status: "checked", attempt: 1 });
  });

  it("a definite failure with nothing unknown → failed; the next tick in the window is attempt 2 (a new key)", async () => {
    addBooking({ id: "b1" });
    resendSend.mockResolvedValueOnce({ data: null, error: { name: "validation_error", message: "bad", statusCode: 422 } });
    await tick(EVENING);
    // The send-started marker went down before the request, and the refusal cleared it.
    expect(mdb.updates.filter((u) => u.table === RUNS)[0].payload).toMatchObject({ had_unknown: true, booking_ids: ["b1"], ids_ever: ["b1"] });
    expect(runs()[0]).toMatchObject({ status: "failed", had_unknown: false, attempt: 1 });
    await tick("2026-10-31T22:40:00Z");
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(1), keyFor(2)]);
    expect(runs()[0]).toMatchObject({ status: "checked", attempt: 2 });
  });

  it("the takeover re-checks the list and drops a booking cancelled since the first attempt; the follow-up then reminds the lot", async () => {
    addBooking({ id: "b1" });
    addBooking({ id: "b2" });
    resendSend.mockRejectedValueOnce(new BoundedTimeoutError("Resend", 10_000));
    await tick(EVENING);
    expect(runs()[0].ids_ever).toEqual(expect.arrayContaining(["b1", "b2"]));
    expect(runs()[0].ids_ever).toHaveLength(2);
    setBooking("b2", { status: "cancelled", cancel_state: "refund_issued" });

    await tick("2026-10-31T22:40:00Z");
    const [, retry] = manifestSends();
    expect(retry.key).toBe(keyFor(1));
    expect(retry.text).toContain("TRP-B1");
    expect(retry.text).not.toContain("TRP-B2");
    expect(runs()[0]).toMatchObject({ booking_ids: ["b1"], status: "checked" });
    expect(followUpSends()).toHaveLength(1);
    expect(followUpSends()[0]).toMatchObject({ subject: "[TEST] CANCELLED — Triply booking TRP-B2", to: [OVERRIDE] });
    expect(followUpSends()[0].key).toBe(`direct-lot-followup/b2/1/${TOMORROW}/${HASH}/1`);
  });

  it("accepted but not recorded → stays sending; the takeover repeats the same key", async () => {
    addBooking({ id: "b1" });
    mdb.beforeMutation = (table, op, payload) => {
      if (table === RUNS && op === "update" && payload.status === "sent") {
        mdb.beforeMutation = null;
        mdb.failNext(RUNS, "update");
      }
    };
    const r = await tick(EVENING);
    expect(r.errors).toBeGreaterThan(0);
    expect(runs()[0].status).toBe("sending");
    await tick("2026-10-31T22:40:00Z");
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(1), keyFor(1)]);
    expect(runs()[0].status).toBe("checked");
  });

  it("no override inbox off production → no claim, reported", async () => {
    vi.stubEnv("DIRECT_LOT_NOTICE_OVERRIDE_TO", "");
    addBooking({ id: "b1" });
    const r = await tick(EVENING);
    expect(r.runs.no_recipients).toBe(1);
    expect(runs()).toHaveLength(0);
    expect(sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining("DIRECT_LOT_NOTICE_OVERRIDE_TO"), "warning");
  });

  it("out of budget → no claim at all", async () => {
    addBooking({ id: "b1" });
    vi.setSystemTime(new Date(EVENING));
    const r = await tick(EVENING, { deadlineMs: Date.now() });
    expect(r.runs.out_of_budget).toBe(1);
    expect(r.budgetExhausted).toBe(true);
    expect(runs()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("follow-up and cutoff (§3.4 steps 5–6)", () => {
  it("never before sent: a cancelled booking on an unknown run gets no reminder while the run can still send", async () => {
    addBooking({ id: "b1" });
    addBooking({ id: "b2" });
    resendSend.mockRejectedValue(new BoundedTimeoutError("Resend", 10_000));
    await tick(EVENING);
    setBooking("b2", { status: "cancelled" });
    await tick("2026-10-31T22:40:00Z");
    await tick("2026-10-31T22:50:00Z");
    expect(followUpSends()).toHaveLength(0);
    expect(runs()[0]).toMatchObject({ status: "sending", had_unknown: true });
  });

  it("covers ids_ever (not just the current list), once — the UNIQUE claim stops a second reminder", async () => {
    addBooking({ id: "b1" });
    addBooking({ id: "b2", over: { status: "refunded" } });
    seedRun({ status: "sent", sent_at: "2026-10-31T22:00:05.000Z", booking_ids: ["b1"], ids_ever: ["b1", "b2"] });
    await tick(EVENING);
    await tick("2026-10-31T22:40:00Z");
    expect(followUpSends().map((s) => s.key)).toEqual([`direct-lot-followup/b2/1/${TOMORROW}/${HASH}/1`]);
    expect(mdb.rows(RESENDS)).toEqual([
      expect.objectContaining({ booking_id: "b2", kind: "manifest_followup_cancel", source: `manifest:1:${TOMORROW}:${HASH}`, sent_by: "manifest", livemode: false, outcome: "sent", attempts: 1 }),
    ]);
    expect(runs()[0].status).toBe("checked");
  });

  it("an earlier follow-up already sent (another tick) → no second reminder", async () => {
    addBooking({ id: "b2", over: { status: "cancelled" } });
    seedRun({ status: "sent", sent_at: "2026-10-31T22:00:05.000Z", booking_ids: ["b2"], ids_ever: ["b2"] });
    mdb.rows(RESENDS).push({ id: "r1", booking_id: "b2", stripe_payment_intent_id: "pi_b2", livemode: false, kind: "manifest_followup_cancel", source: `manifest:1:${TOMORROW}:${HASH}`, attempts: 1, sent_by: "manifest", outcome: "sent", updated_at: "2026-10-31T22:01:00.000Z" });
    await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(runs()[0].status).toBe("checked");
  });

  it("three failed follow-up attempts → a followup alert row, then the run is checked", async () => {
    addBooking({ id: "b2", over: { status: "cancelled" } });
    seedRun({ status: "sent", sent_at: "2026-10-31T22:00:05.000Z", booking_ids: ["b2"], ids_ever: ["b2"] });
    resendSend.mockResolvedValue({ data: null, error: { name: "validation_error", message: "bad to", statusCode: 422 } });
    await tick(EVENING);
    await tick("2026-10-31T22:40:00Z");
    expect(runs()[0].status).toBe("sent");
    await tick("2026-10-31T22:50:00Z");
    expect(followUpSends().map((s) => s.key.split("/").pop())).toEqual(["1", "2", "3"]);
    const subject = `b2:manifest:1:${TOMORROW}:${HASH}`;
    expect(mdb.rows(ALERTS)).toEqual([expect.objectContaining({ subject, kind: "followup", livemode: false, detail: expect.objectContaining({ number: "TRP-B2", attempts: 3 }) })]);
    expect(runs()[0].status).toBe("checked");
    await tick("2026-10-31T23:00:00Z");
    expect(followUpSends()).toHaveLength(3);
  });

  it("noon cutoff: 11:59 lot time still re-sends a stale run; at 12:00 it is possibly delivered → follow-up → checked with had_unknown and no sent_at", async () => {
    addBooking({ id: "b1" });
    addBooking({ id: "b2" });
    resendSend.mockRejectedValue(new BoundedTimeoutError("Resend", 10_000));
    await tick(EVENING);
    await tick("2026-11-01T16:59:00Z"); // Nov 1 11:59 EST (after fall back)
    expect(manifestSends()).toHaveLength(2);

    setBooking("b2", { status: "cancelled" });
    resendSend.mockResolvedValue({ data: { id: "em_f" }, error: null });
    await tick("2026-11-01T17:05:00Z"); // 12:05 EST: past the cutoff, the 16:59 claim is stale
    expect(manifestSends()).toHaveLength(2);
    expect(followUpSends().map((s) => s.subject)).toEqual(["[TEST] CANCELLED — Triply booking TRP-B2"]);
    expect(runs()[0]).toMatchObject({ status: "checked", had_unknown: true, sent_at: null, last_error: CUTOFF_REASON });
  });

  it("the kill switch stops new manifests but recovery and follow-ups keep running", async () => {
    addBooking({ id: "new" });
    addBooking({ id: "b2", over: { status: "cancelled" } });
    seedRun({ manifest_date: "2026-10-31", recipients_hash: HASH, status: "sent", sent_at: "2026-10-30T22:00:05.000Z", booking_ids: ["b2"], ids_ever: ["b2"] });
    const r = await tick(EVENING, { disabled: true });
    expect(manifestSends()).toHaveLength(0);
    expect(followUpSends()).toHaveLength(1);
    expect(r.runs.checked).toBe(1);
    expect(runs().map((x) => x.manifest_date)).toEqual(["2026-10-31"]);
  });

  it("recovery keeps following up sent runs up to 3 days back, and ignores older ones", async () => {
    addBooking({ id: "b2", over: { status: "cancelled" } });
    addBooking({ id: "b3", over: { status: "cancelled" } });
    seedRun({ manifest_date: "2026-10-28", status: "sent", sent_at: "2026-10-27T22:00:05.000Z", booking_ids: ["b2"], ids_ever: ["b2"] });
    seedRun({ manifest_date: "2026-10-27", status: "sent", sent_at: "2026-10-26T22:00:05.000Z", booking_ids: ["b3"], ids_ever: ["b3"] });
    await tick(EVENING); // UTC Oct 31: floor Oct 28
    expect(followUpSends().map((s) => s.key)).toEqual([`direct-lot-followup/b2/1/2026-10-28/${HASH}/1`]);
    expect(runs().map((r) => [r.manifest_date, r.status])).toEqual([
      ["2026-10-28", "checked"],
      ["2026-10-27", "sent"],
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("force (§3.5)", () => {
  it("from checked → attempt + 1 under a new key with a fresh list", async () => {
    addBooking({ id: "b1" });
    await tick(EVENING);
    addBooking({ id: "b3" });
    const r = await tick("2026-11-01T04:00:00Z", { force: true, target: { lotId: "1", date: TOMORROW } }); // 00:00 EDT: outside the window, force ignores it
    expect(r.force?.runs).toEqual([{ recipientsHash: HASH, outcome: "sent" }]);
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(1), keyFor(2)]);
    expect(manifestSends()[1].text).toContain("TRP-B3");
    expect(runs()[0]).toMatchObject({ attempt: 2, status: "checked" });
  });

  it("only from checked or failed, only before the cutoff, never with the kill switch", async () => {
    addBooking({ id: "b1" });
    resendSend.mockRejectedValueOnce(new BoundedTimeoutError("Resend", 10_000));
    await tick(EVENING);
    const sending = await tick("2026-10-31T22:31:00Z", { force: true, target: { lotId: "1", date: TOMORROW } });
    expect(sending.force?.runs).toEqual([{ recipientsHash: HASH, outcome: "not_forceable" }]);

    const off = await tick("2026-10-31T22:32:00Z", { force: true, disabled: true, target: { lotId: "1", date: TOMORROW } });
    expect(off.status).toBe(409);

    const late = await tick("2026-11-01T17:00:00Z", { force: true, target: { lotId: "1", date: TOMORROW } });
    expect(late.status).toBe(409);
    expect(late.force?.refused).toMatch(/cutoff/);
    expect(manifestSends()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("the send-started marker (had_unknown)", () => {
  /** Make the `sent` write fail once: Resend accepted, the run was not recorded (the sender "crashed"). */
  function failSentWriteOnce() {
    mdb.beforeMutation = (table, op, payload) => {
      if (table === RUNS && op === "update" && payload.status === "sent") {
        mdb.beforeMutation = null;
        mdb.failNext(RUNS, "update");
      }
    };
  }

  it("accepted but not recorded, then every listed booking cancelled → the takeover follows up and checks the run, never 'failed'", async () => {
    addBooking({ id: "b1" });
    failSentWriteOnce();
    await tick(EVENING);
    expect(runs()[0]).toMatchObject({ status: "sending", had_unknown: true, ids_ever: ["b1"], sent_at: null });
    setBooking("b1", { status: "cancelled", cancel_state: "refund_issued" });

    const r = await tick("2026-10-31T22:40:00Z");
    expect(manifestSends()).toHaveLength(1);
    expect(followUpSends().map((s) => s.key)).toEqual([`direct-lot-followup/b1/1/${TOMORROW}/${HASH}/1`]);
    expect(r.runs.closed_checked).toBe(1);
    expect(runs()[0]).toMatchObject({ status: "checked", had_unknown: true, sent_at: null, last_error: expect.stringMatching(/^nothing_to_list:/) });
  });

  it("a takeover refused (429) after a possibly-delivered attempt stays sending — never attempt 2", async () => {
    addBooking({ id: "b1" });
    failSentWriteOnce();
    await tick(EVENING);
    resendSend.mockResolvedValueOnce({ data: null, error: { name: "rate_limit_exceeded", message: "429", statusCode: 429 } });
    await tick("2026-10-31T22:40:00Z");
    expect(runs()[0]).toMatchObject({ status: "sending", had_unknown: true, attempt: 1 });
    await tick("2026-10-31T22:50:00Z");
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(1), keyFor(1), keyFor(1)]);
    expect(runs()[0]).toMatchObject({ status: "checked", attempt: 1, sent_at: expect.any(String) });
  });

  it("the marker write fails → nothing is sent; the takeover sends attempt 1", async () => {
    addBooking({ id: "b1" });
    mdb.failNext(RUNS, "update"); // the first run UPDATE after the claim is the marker
    const r = await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(r.errors).toBeGreaterThan(0);
    expect(runs()[0]).toMatchObject({ status: "sending", had_unknown: false, ids_ever: [] });

    await tick("2026-10-31T22:40:00Z");
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(1)]);
    expect(runs()[0]).toMatchObject({ status: "checked", attempt: 1 });
  });

  it("nothing_to_list with an attempt possibly delivered → follow-ups, then checked (marker set, or ids_ever from an earlier attempt)", async () => {
    addBooking({ id: "b1", over: { status: "cancelled" } });
    addBooking({ id: "b2", over: { status: "refunded" } });
    seedRun({ had_unknown: true, booking_ids: ["b1"], ids_ever: ["b1"] });
    const h2 = recipientsHash(["other@lot.example"]);
    seedRun({ recipients_hash: h2, attempt: 2, had_unknown: false, booking_ids: ["b2"], ids_ever: ["b2"] });
    const r = await tick(EVENING);
    expect(manifestSends()).toHaveLength(0);
    expect(followUpSends().map((s) => s.key).sort()).toEqual([`direct-lot-followup/b1/1/${TOMORROW}/${HASH}/1`, `direct-lot-followup/b2/1/${TOMORROW}/${h2}/1`].sort());
    expect(r.runs.closed_checked).toBe(2);
    for (const run of runs()) expect(run).toMatchObject({ status: "checked", had_unknown: true, last_error: expect.stringMatching(/^nothing_to_list:/) });
  });

  it("nothing_to_list with nothing ever handed to Resend → failed (no follow-up)", async () => {
    addBooking({ id: "b1", over: { status: "cancelled" } });
    seedRun({ had_unknown: false, booking_ids: ["b1"], ids_ever: [] });
    const r = await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(r.runs.nothing_to_list).toBe(1);
    expect(runs()[0]).toMatchObject({ status: "failed", had_unknown: false, last_error: expect.stringMatching(/^nothing_to_list:/) });
  });

  it("superseded with an attempt possibly delivered → follow-ups for ids_ever, then checked", async () => {
    // A forced empty-day attempt of a run whose earlier (booked) attempt listed b1, since cancelled.
    addBooking({ id: "b1", over: { status: "cancelled" } });
    addBooking({ id: "late", over: { lot_notified_at: null } }); // a booking the lot has now — supersedes the empty reminder
    seedRun({ had_unknown: true, booking_ids: [], ids_ever: ["b1"] });
    const r = await tick(EVENING);
    expect(manifestSends()).toHaveLength(0);
    expect(followUpSends().map((s) => s.key)).toEqual([`direct-lot-followup/b1/1/${TOMORROW}/${HASH}/1`]);
    expect(r.runs.closed_checked).toBe(1);
    expect(runs()[0]).toMatchObject({ status: "checked", had_unknown: true, last_error: expect.stringMatching(/^superseded:/) });
  });

  it("a double-fired cron: the second tick finds the first mid-send (in_flight) or done (already_done); one manifest", async () => {
    addBooking({ id: "b1" });
    vi.setSystemTime(new Date(EVENING));
    const nowMs = Date.now();
    const opts = { livemode: false, nowMs, deadlineMs: nowMs + 45_000, dry: false, disabled: false, target: null, force: false };
    let reached: () => void = () => {};
    let release: () => void = () => {};
    const atResend = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    resendSend.mockImplementationOnce(async () => {
      reached();
      await gate;
      return { data: { id: "em_a" }, error: null };
    });
    const first = runManifestCron({ ...opts, supabase: await createAdminClient() });
    await atResend; // A holds the claim, the marker is down, its request is in Resend
    const second = await runManifestCron({ ...opts, supabase: await createAdminClient() });
    release();
    const a = await first;
    expect(a.runs).toEqual({ sent: 1, checked: 1 });
    expect(second.runs).toEqual({ in_flight: 1 });

    const third = await runManifestCron({ ...opts, supabase: await createAdminClient() });
    expect(third.runs).toEqual({ already_done: 1 });
    expect(manifestSends()).toHaveLength(1);
    expect(runs()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("kill switch, zones and follow-up alerts (review pass 1)", () => {
  it("kill switch: a stale claim that never reached Resend is closed failed — no email", async () => {
    addBooking({ id: "b1" });
    seedRun({ had_unknown: false, booking_ids: ["b1"], ids_ever: [] });
    const r = await tick(EVENING, { disabled: true });
    expect(resendSend).not.toHaveBeenCalled();
    expect(r.runs.kill_switch).toBe(1);
    expect(runs()[0]).toMatchObject({ status: "failed", had_unknown: false, last_error: expect.stringMatching(/^kill switch: not sent/) });
  });

  it("kill switch: a possibly-delivered run is retried under the SAME key and its follow-ups go", async () => {
    addBooking({ id: "b1" });
    addBooking({ id: "b2", over: { status: "cancelled" } });
    seedRun({ had_unknown: true, booking_ids: ["b1", "b2"], ids_ever: ["b1", "b2"] });
    await tick(EVENING, { disabled: true });
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(1)]);
    expect(manifestSends()[0].text).toContain("TRP-B1");
    expect(manifestSends()[0].text).not.toContain("TRP-B2");
    expect(followUpSends().map((s) => s.key)).toEqual([`direct-lot-followup/b2/1/${TOMORROW}/${HASH}/1`]);
    expect(runs()[0]).toMatchObject({ status: "checked", attempt: 1 });
  });

  it("a zone dispute does not hold up already-sent work: a sent run and a possibly-delivered emptied run still get their follow-ups", async () => {
    addBooking({ id: "dispute", over: { location_timezone: "America/Chicago" } }); // lot 1's zone is now in dispute
    addBooking({ id: "b2", over: { status: "cancelled" } });
    addBooking({ id: "b3", over: { status: "cancelled" } });
    seedRun({ status: "sent", sent_at: "2026-10-31T22:00:05.000Z", booking_ids: ["b2"], ids_ever: ["b2"] });
    const h2 = recipientsHash(["other@lot.example"]);
    seedRun({ recipients_hash: h2, had_unknown: true, booking_ids: ["b3"], ids_ever: ["b3"] });
    const r = await tick(EVENING);
    expect(r.lots).toEqual([]);
    expect(manifestSends()).toHaveLength(0);
    expect(followUpSends().map((s) => s.key).sort()).toEqual([`direct-lot-followup/b2/1/${TOMORROW}/${HASH}/1`, `direct-lot-followup/b3/1/${TOMORROW}/${h2}/1`].sort());
    expect(runs().map((x) => x.status)).toEqual(["checked", "checked"]);
  });

  it("a zone dispute with a booking still to list: no send, the run stays sending (no_zone)", async () => {
    addBooking({ id: "b1", over: { location_timezone: "America/Chicago" } });
    seedRun({ had_unknown: true, booking_ids: ["b1"], ids_ever: ["b1"] });
    const r = await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(r.runs.no_zone).toBe(1);
    expect(runs()[0]).toMatchObject({ status: "sending", had_unknown: true });
  });

  it("a gave-up follow-up counts as done only once its alert row is written; detail has the TRP number, date and reason — no PII", async () => {
    addBooking({ id: "b2", over: { status: "cancelled" } });
    seedRun({ status: "sent", sent_at: "2026-10-31T22:00:05.000Z", booking_ids: ["b2"], ids_ever: ["b2"] });
    mdb.rows(RESENDS).push({ id: "r1", booking_id: "b2", stripe_payment_intent_id: "pi_b2", livemode: false, kind: "manifest_followup_cancel", source: `manifest:1:${TOMORROW}:${HASH}`, attempts: 3, sent_by: "manifest", outcome: "failed", updated_at: "2026-10-31T22:01:00.000Z" });
    mdb.failNext(ALERTS, "insert");
    const r = await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(r.errors).toBeGreaterThan(0);
    expect(mdb.rows(ALERTS)).toEqual([]);
    expect(runs()[0].status).toBe("sent");

    await tick("2026-10-31T22:40:00Z");
    const [alert] = mdb.rows(ALERTS);
    expect(alert).toMatchObject({
      subject: `b2:manifest:1:${TOMORROW}:${HASH}`,
      kind: "followup",
      resolved_at: null,
      detail: expect.objectContaining({ trp: "TRP-B2", manifestDate: TOMORROW, reason: expect.stringContaining("3 attempts") }),
    });
    expect(JSON.stringify(alert.detail)).not.toMatch(/Ada|Lovelace|555-0100|@/);
    expect(runs()[0].status).toBe("checked");
    expect(resendSend).not.toHaveBeenCalled();
  });

  it.each([
    ["America/Los_Angeles", "LAX", "2026-11-01T05:30:00Z"], // Oct 31 22:30 PDT
    ["Pacific/Honolulu", null, "2026-11-01T08:30:00Z"], // Oct 31 22:30 HST
  ])("%s at 22:30 local: manifest for lot-local tomorrow and its rows found", async (zone, airport, at) => {
    cmsLots(airport ? [directLotRow({ notification_emails: LOT_INBOX, airport_code: airport })] : []);
    const tz = { location_timezone: zone, lot_snapshot: { name: "West Lot", timezone: zone } };
    addBooking({ id: "arr", checkIn: `${TOMORROW}T07:15:00`, over: tz });
    addBooking({ id: "dep", checkIn: "2026-10-28T08:00:00", checkOut: `${TOMORROW}T21:00:00`, over: tz });
    addBooking({ id: "later", checkIn: "2026-11-02T07:15:00", over: tz });
    const r = await tick(at);
    expect(r.lots).toEqual([expect.objectContaining({ lotId: "1", timezone: zone, localDate: "2026-10-31", localMinutes: 22 * 60 + 30, manifestDate: TOMORROW, inWindow: true })]);
    const [m] = manifestSends();
    expect(m.key).toBe(keyFor(1));
    expect(m.text).toContain("Time: 7:15 AM | Confirmation: TRP-ARR");
    expect(m.text).toContain("Time: 9:00 PM | Confirmation: TRP-DEP");
    expect(m.text).not.toContain("TRP-LATER");
    expect(m.text).toContain("As of 10:30 PM lot time.");
  });

  it("a guest missing from the checkout payload falls back to the customers row; still missing → placeholder + Sentry with the TRP number only", async () => {
    mdb.rows("customers").push({ id: "cust1", email: "kj@example.com", first_name: "Katherine", last_name: "Johnson", phone: "555-0123" });
    addBooking({ id: "nopending", guest: null, over: { customer_id: "cust1" } });
    addBooking({ id: "nophone", guest: { firstName: "Mary", lastName: "Jackson", phone: "" }, over: { customer_id: "cust1" } });
    addBooking({ id: "nobody", guest: null });
    await tick(EVENING);
    const [m] = manifestSends();
    expect(m.text).toContain("Confirmation: TRP-NOPENDING | Guest: Katherine Johnson | Phone: 555-0123");
    expect(m.text).toContain("Confirmation: TRP-NOPHONE | Guest: Mary Jackson | Phone: 555-0123");
    expect(m.text).toContain("Confirmation: TRP-NOBODY | Guest: (see admin) | Phone: —");
    const guestReports = sentry.captureMessage.mock.calls.map((c) => String(c[0])).filter((msg) => msg.includes("no guest name or phone"));
    expect(guestReports).toHaveLength(1);
    expect(guestReports[0]).toContain("TRP-NOBODY");
    expect(guestReports[0]).not.toMatch(/Katherine|Mary|555-|@/);
    expect(sentry.fingerprints).toContainEqual(["direct-lot-manifest", "guest-missing", "TRP-NOBODY"]);
  });

  it("force from failed → attempt + 1, and ids_ever gains the forced list", async () => {
    addBooking({ id: "b1" });
    addBooking({ id: "b3" });
    seedRun({ status: "failed", had_unknown: false, booking_ids: ["b1"], ids_ever: ["b1"], last_error: "Resend validation_error 422: bad" });
    const r = await tick("2026-11-01T04:00:00Z", { force: true, target: { lotId: "1", date: TOMORROW } }); // 00:00 EDT, before the cutoff
    expect(r.force?.runs).toEqual([{ recipientsHash: HASH, outcome: "sent" }]);
    expect(manifestSends().map((s) => s.key)).toEqual([keyFor(2)]);
    expect(runs()[0]).toMatchObject({ attempt: 2, status: "checked" });
    expect([...(runs()[0].ids_ever as string[])].sort()).toEqual(["b1", "b3"]);
  });
});

// ---------------------------------------------------------------------------
describe("review pass 2: unknown zone past the date, refused attempts, gave-up noise", () => {
  /** A booking whose zone disagrees with its lot snapshot: lot 1's zone is in dispute (unknown). */
  const disputeZone = () => addBooking({ id: "dispute", over: { location_timezone: "America/Chicago" } });
  /** Oct 29 — before UTC today − 1 (Oct 30) at EVENING: past noon on that date in every US zone. */
  const PAST = "2026-10-29";

  it("MED-1: a possibly-delivered run, zone unknown, date passed → past the cutoff: follow-ups, then checked (never `sending` for good)", async () => {
    disputeZone();
    addBooking({ id: "b1", checkIn: `${PAST}T09:30:00` }); // still listable: the takeover could never close it
    addBooking({ id: "b2", checkIn: `${PAST}T10:30:00`, over: { status: "cancelled" } });
    seedRun({ manifest_date: PAST, had_unknown: true, booking_ids: ["b1", "b2"], ids_ever: ["b1", "b2"] });
    const r = await tick(EVENING);
    expect(manifestSends()).toHaveLength(0);
    expect(followUpSends().map((s) => s.key)).toEqual([`direct-lot-followup/b2/1/${PAST}/${HASH}/1`]);
    expect(r.runs.cutoff_checked).toBe(1);
    expect(runs()[0]).toMatchObject({ status: "checked", had_unknown: true, sent_at: null, last_error: CUTOFF_REASON });
  });

  it("MED-1: zone unknown, date passed, nothing ever reached Resend → failed (CUTOFF_NOT_SENT_REASON), no follow-up", async () => {
    disputeZone();
    addBooking({ id: "b1", checkIn: `${PAST}T09:30:00` });
    seedRun({ manifest_date: PAST, had_unknown: false, booking_ids: ["b1"], ids_ever: [] });
    const r = await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(r.runs.failed).toBe(1);
    expect(runs()[0]).toMatchObject({ status: "failed", had_unknown: false, last_error: CUTOFF_NOT_SENT_REASON });
  });

  it("zone KNOWN, past the cutoff, nothing ever reached Resend → failed (CUTOFF_NOT_SENT_REASON) too — never recorded as possibly delivered", async () => {
    addBooking({ id: "b1", checkIn: `${PAST}T09:30:00` });
    seedRun({ manifest_date: PAST, had_unknown: false, booking_ids: ["b1"], ids_ever: [] });
    const r = await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(r.runs.failed).toBe(1);
    expect(runs()[0]).toMatchObject({ status: "failed", had_unknown: false, last_error: CUTOFF_NOT_SENT_REASON });
  });

  it("MED-1: zone unknown, date not yet before UTC today − 1 → unchanged: the run stays sending (no_zone), nothing sent", async () => {
    disputeZone();
    addBooking({ id: "b1", checkIn: "2026-10-30T09:30:00" });
    seedRun({ manifest_date: "2026-10-30", had_unknown: true, booking_ids: ["b1"], ids_ever: ["b1"] });
    const r = await tick(EVENING);
    expect(resendSend).not.toHaveBeenCalled();
    expect(r.runs.no_zone).toBe(1);
    expect(runs()[0]).toMatchObject({ status: "sending", had_unknown: true });
  });

  it("MED-2: a definitely refused attempt leaves ids_ever as it was; a later attempt that died before its marker then closes `failed` — no follow-up for a list the lot never got", async () => {
    addBooking({ id: "b1" });
    resendSend.mockResolvedValueOnce({ data: null, error: { name: "validation_error", message: "bad", statusCode: 422 } });
    await tick(EVENING);
    expect(runs()[0]).toMatchObject({ status: "failed", had_unknown: false, attempt: 1, ids_ever: [] });

    // Attempt 2 is claimed, then its sender dies before the send-started marker lands.
    mdb.beforeMutation = (table, op, payload) => {
      if (table === RUNS && op === "update" && payload.had_unknown === true) {
        mdb.beforeMutation = null;
        mdb.failNext(RUNS, "update");
      }
    };
    await tick("2026-10-31T22:40:00Z");
    expect(manifestSends()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ status: "sending", had_unknown: false, attempt: 2, ids_ever: [] });

    setBooking("b1", { status: "cancelled", cancel_state: "refund_issued" });
    const r = await tick("2026-10-31T22:50:00Z"); // the 22:40 claim is stale: takeover
    expect(r.runs.nothing_to_list).toBe(1);
    expect(followUpSends()).toHaveLength(0);
    expect(runs()[0]).toMatchObject({ status: "failed", had_unknown: false, last_error: expect.stringMatching(/^nothing_to_list:/) });
  });

  it("LOW-1: a gave-up follow-up is reported to Sentry once, though the run stays open across ticks; the alert row is still refreshed", async () => {
    addBooking({ id: "b2", over: { status: "cancelled" } });
    addBooking({ id: "b3", over: { status: "cancelled" } });
    seedRun({ status: "sent", sent_at: "2026-10-31T22:00:05.000Z", booking_ids: ["b2", "b3"], ids_ever: ["b2", "b3"] });
    const source = `manifest:1:${TOMORROW}:${HASH}`;
    mdb.rows(RESENDS).push(
      { id: "r2", booking_id: "b2", stripe_payment_intent_id: "pi_b2", livemode: false, kind: "manifest_followup_cancel", source, attempts: 3, sent_by: "manifest", outcome: "failed", updated_at: "2026-10-31T22:01:00.000Z" },
      // Another sender is mid-send on b3: the run stays `sent` (follow-ups pending) on both ticks.
      { id: "r3", booking_id: "b3", stripe_payment_intent_id: "pi_b3", livemode: false, kind: "manifest_followup_cancel", source, attempts: 1, sent_by: "manifest", outcome: "sending", updated_at: "2026-10-31T22:29:00.000Z" }
    );
    const gaveUp = () => sentry.fingerprints.filter((f) => f[1] === "followup-gave-up");
    await tick(EVENING);
    expect(gaveUp()).toEqual([["direct-lot-manifest", "followup-gave-up", "b2"]]);
    const firstSeen = mdb.rows(ALERTS)[0].last_seen_at;

    await tick("2026-10-31T22:32:00Z");
    expect(runs()[0].status).toBe("sent");
    expect(gaveUp()).toHaveLength(1);
    expect(mdb.rows(ALERTS)).toHaveLength(1);
    expect(mdb.rows(ALERTS)[0].last_seen_at).not.toBe(firstSeen);
    expect(resendSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("render", () => {
  const row = (over: Partial<ManifestRow>): ManifestRow => ({
    bookingId: "b",
    piId: "pi_b",
    number: "TRP-X",
    lotName: "The Parking Point JFK",
    checkIn: `${TOMORROW} 09:30:00`,
    checkOut: "2026-11-05 17:00:00",
    guestName: "Ada Lovelace",
    guestPhone: "555-0100",
    guestMissing: false,
    vehicle: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC123", state: "NY" },
    sizeLabel: "Large SUV / truck",
    atLotCents: 5519,
    parkGuard: false,
    ...over,
  });

  it("heads every manifest with the date, never 'tomorrow'; departures say the surcharge was collected at drop-off", () => {
    const full = renderManifest({
      lotName: "The Parking Point JFK",
      manifestDate: TOMORROW,
      rows: [row({ number: "TRP-A" }), row({ number: "TRP-D", checkIn: "2026-10-28 08:00:00", checkOut: `${TOMORROW} 23:45:00`, atLotCents: null })],
      asOfMinutes: 18 * 60 + 30,
      test: false,
    });
    const empty = renderManifest({ lotName: "The Parking Point JFK", manifestDate: TOMORROW, rows: [], asOfMinutes: 18 * 60, test: true });
    for (const e of [full, empty]) {
      expect([e.subject, e.text, e.html].join(" ")).not.toMatch(/tomorrow/i);
      expect(e.text).toContain("Arrivals and departures at The Parking Point JFK — Sun, Nov 1");
      expect(e.html).toContain("Arrivals and departures at The Parking Point JFK — Sun, Nov 1");
    }
    const departures = full.text.slice(full.text.indexOf("Departures"));
    expect(departures).toContain("Confirmation: TRP-D");
    expect(departures).toContain("At the lot: Collected at drop-off");
    expect(departures).not.toContain("Collect at the lot");
    expect(full.html.slice(full.html.indexOf("Departures"))).toContain("Collected at drop-off");
    expect(full.text.slice(0, full.text.indexOf("Departures"))).toContain("Collect at the lot (est.): $55.19");
  });
});
