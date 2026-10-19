/**
 * GET /api/cron/direct-lot-manifest — the route shell: auth, parameter
 * validation, dry run (renders, writes and sends nothing), kill switch, force
 * refusals, the JSON summary and the Sentry cron check-in. The state machine
 * itself is covered in src/lib/direct/manifest/__tests__/run.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { mdb, resendSend, sentry } = await vi.hoisted(async () => {
  const { ManifestDb } = await import("@/lib/direct/manifest/__tests__/manifest-db");
  return { mdb: new ManifestDb(), resendSend: vi.fn(), sentry: { captureMessage: vi.fn(), captureException: vi.fn(), captureCheckIn: vi.fn() } };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => mdb.client }));
vi.mock("@/lib/resend/client", () => ({ resend: { emails: { send: resendSend } }, FROM_EMAIL: "Triply <bookings@triplypro.com>" }));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: sentry.captureMessage,
  captureException: sentry.captureException,
  captureCheckIn: sentry.captureCheckIn,
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setFingerprint: vi.fn(), setTag: vi.fn(), setContext: vi.fn(), setExtra: vi.fn(), setLevel: vi.fn(), setUser: vi.fn() }),
  flush: vi.fn().mockResolvedValue(true),
}));

import { GET } from "../route";
import { directLotRow } from "@/lib/direct/__tests__/fixtures";
import { RUNS, ALERTS } from "@/lib/direct/manifest/__tests__/manifest-db";

const CRON_SECRET = process.env.CRON_SECRET as string;
const EVENING = "2026-10-31T22:30:00Z"; // 18:30 EDT
const TOMORROW = "2026-11-01";

function req(query = "", headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  return new NextRequest(`https://www.triplypro.com/api/cron/direct-lot-manifest${query}`, { headers });
}

function addBooking(id: string, over: Record<string, unknown> = {}) {
  mdb.rows("bookings").push({
    id,
    stripe_payment_intent_id: `pi_${id}`,
    reslab_reservation_number: `TRP-${id.toUpperCase()}`,
    inventory_source: "direct",
    direct_lot_id: "1",
    livemode: false,
    status: "confirmed",
    cancel_state: null,
    cancel_claimed_at: null,
    lot_notified_at: "2026-10-30T15:00:00.000Z",
    location_name: "The Parking Point JFK",
    location_timezone: "America/New_York",
    lot_snapshot: { name: "The Parking Point JFK", timezone: "America/New_York" },
    check_in: `${TOMORROW}T09:30:00`,
    check_out: "2026-11-05T17:00:00",
    vehicle_info: { make: "Ford", model: "F-150", color: "Black", licensePlate: "ABC123", state: "NY" },
    vehicle_size_label: "Standard",
    vehicle_surcharge_cents: 0,
    vehicle_surcharge_tax_cents: 0,
    protection_plan: null,
    customer_id: null,
    ...over,
  });
  mdb.rows("direct_booking_terms").push({ stripe_payment_intent_id: `pi_${id}`, livemode: false, lot_recipients: ["desk@lot.example"] });
  mdb.rows("pending_bookings").push({ stripe_payment_intent_id: `pi_${id}`, customer: { firstName: "Ada", lastName: "Lovelace", phone: "555-0100" } });
}

const checkIns = () => sentry.captureCheckIn.mock.calls.map((c) => c[0].status);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(EVENING));
  mdb.reset();
  mdb.base.rpcHandlers.direct_lots_v2 = () => ({ data: [directLotRow({ notification_emails: ["desk@lot.example"] })], error: null });
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
  vi.stubEnv("DIRECT_LOT_NOTICE_OVERRIDE_TO", "ops@triplypro.com");
  vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "false");
  vi.stubEnv("DIRECT_LOT_MANIFEST_DISABLED", "");
  sentry.captureCheckIn.mockReturnValue("checkin_1");
  resendSend.mockResolvedValue({ data: { id: "em_1" }, error: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/cron/direct-lot-manifest", () => {
  it("401 without the cron secret", async () => {
    expect((await GET(req("", {}))).status).toBe(401);
    expect((await GET(req("", { authorization: "Bearer nope" }))).status).toBe(401);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it.each([
    ["?lot=1", "lot and date go together"],
    ["?force=1", "lot and date go together"],
    ["?lot=direct-1&date=2026-11-01&force=1", "numeric"],
    ["?lot=1&date=2026-02-30&force=1", "real YYYY-MM-DD"],
    ["?lot=1&date=2026-11-01", "need force=1"],
    ["?lot=1&date=2026-11-01&force=1&dry=1", "exclusive"],
  ])("400 for %s", async (query, message) => {
    const res = await GET(req(query));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(message);
  });

  it("a tick sends the manifest and returns the summary; the cron monitor closes ok", async () => {
    addBooking("b1");
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, livemode: false, dry: false, disabled: false, errors: 0, runs: { sent: 1, checked: 1 } });
    expect(body.lots).toEqual([expect.objectContaining({ lotId: "1", manifestDate: TOMORROW, inWindow: true })]);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(checkIns()).toEqual(["in_progress", "ok"]);
  });

  it("?dry=1 renders the manifest and writes, sends and checks in nothing", async () => {
    addBooking("b1");
    addBooking("bad", { direct_lot_id: "2", location_timezone: "America/Chicago" });
    const res = await GET(req("?dry=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dry).toBe(true);
    expect(body.manifests).toEqual([
      expect.objectContaining({ lotId: "1", manifestDate: TOMORROW, to: ["ops@triplypro.com"], test: true, bookings: ["TRP-B1"], subject: expect.stringContaining("[TEST] Reminder") }),
    ]);
    expect(body.manifests[0].text).toContain("TRP-B1");
    expect(body.problems).toEqual([expect.objectContaining({ lotId: "2", kind: "tz" })]);
    expect(resendSend).not.toHaveBeenCalled();
    expect(mdb.rows(RUNS)).toEqual([]);
    expect(mdb.rows(ALERTS)).toEqual([]);
    expect(sentry.captureCheckIn).not.toHaveBeenCalled();
  });

  it("?dry=1&lot&date previews one lot and date, even outside the window", async () => {
    vi.setSystemTime(new Date("2026-10-31T14:00:00Z")); // 10:00 EDT
    addBooking("b1");
    const body = await (await GET(req(`?dry=1&lot=1&date=${TOMORROW}`))).json();
    expect(body.manifests.map((m: { bookings: string[] }) => m.bookings)).toEqual([["TRP-B1"]]);
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("DIRECT_LOT_MANIFEST_DISABLED=true sends no new manifest", async () => {
    vi.stubEnv("DIRECT_LOT_MANIFEST_DISABLED", "true");
    addBooking("b1");
    const body = await (await GET(req())).json();
    expect(body.disabled).toBe(true);
    expect(resendSend).not.toHaveBeenCalled();
    expect(mdb.rows(RUNS)).toEqual([]);
  });

  it("a refused force is a 4xx for the caller, not a failed cron", async () => {
    addBooking("b1");
    const res = await GET(req(`?lot=1&date=${TOMORROW}&force=1`));
    expect(res.status).toBe(404);
    expect((await res.json()).force.refused).toMatch(/no manifest run/);
    expect(checkIns()).toEqual(["in_progress", "ok"]);
  });

  it("an unreadable schedule is a 500 with an error check-in", async () => {
    mdb.base.failOnce("bookings", "select", "connection reset");
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
    expect(checkIns()).toEqual(["in_progress", "error"]);
    expect(sentry.captureException).toHaveBeenCalled();
  });

  it("a DB failure mid-tick is a 500 with an error check-in", async () => {
    addBooking("b1");
    mdb.failNext(RUNS, "insert");
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).runs.error).toBe(1);
    expect(checkIns()).toEqual(["in_progress", "error"]);
  });
});
