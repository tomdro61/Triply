/**
 * GET /api/cron/direct-lot-alerts — the route shell: auth, kill switch, the
 * webhook requirement (no fallback), dry run, the JSON summary, the HTTP status
 * for a failed scan / failed post, and the Sentry cron check-in. The scans and
 * posting rules are covered in src/lib/direct/alerts/__tests__/run.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const { mdb, sentry } = await vi.hoisted(async () => {
  const { ManifestDb } = await import("@/lib/direct/manifest/__tests__/manifest-db");
  return { mdb: new ManifestDb(), sentry: { captureMessage: vi.fn(), captureException: vi.fn(), captureCheckIn: vi.fn() } };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => mdb.client }));
vi.mock("@/lib/resend/client", () => ({ resend: { emails: { send: vi.fn() } }, FROM_EMAIL: "Triply <bookings@triplypro.com>" }));
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
import { ALERTS, RUNS } from "@/lib/direct/manifest/__tests__/manifest-db";

const CRON_SECRET = process.env.CRON_SECRET as string;
const MORNING = "2026-10-31T14:00:00Z"; // 10:00 EDT
const HOOK = "https://discord.example/alerts-webhook";
const fetchMock = vi.fn<typeof fetch>();

function req(query = "", headers: Record<string, string> = { authorization: `Bearer ${CRON_SECRET}` }) {
  return new NextRequest(`https://www.triplypro.com/api/cron/direct-lot-alerts${query}`, { headers });
}

function addUntold(id: string, over: Record<string, unknown> = {}) {
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
    lot_notified_at: null,
    lot_notice_claimed_at: null,
    lot_cancel_notified_at: null,
    created_at: "2026-10-30T12:00:00.000Z",
    location_timezone: "America/New_York",
    lot_snapshot: { name: "The Parking Point JFK", timezone: "America/New_York" },
    check_in: "2026-10-31T12:00:00",
    check_out: "2026-11-05T17:00:00",
    ...over,
  });
}

const checkIns = () => sentry.captureCheckIn.mock.calls.map((c) => c[0].status);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MORNING));
  mdb.reset();
  mdb.base.rpcHandlers.direct_lots_v2 = () => ({ data: [directLotRow({ notification_emails: ["desk@lot.example"] })], error: null });
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
  vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "false");
  vi.stubEnv("DIRECT_LOT_ALERTS_DISABLED", "");
  vi.stubEnv("DIRECT_LOT_MANIFEST_DISABLED", "");
  vi.stubEnv("DISCORD_DAILY_DIGEST_WEBHOOK_URL", HOOK);
  vi.stubEnv("DISCORD_SESSION_WEBHOOK_URL", "https://discord.example/session-webhook");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
  sentry.captureCheckIn.mockReturnValue("checkin_1");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/cron/direct-lot-alerts", () => {
  it("401 without the cron secret", async () => {
    expect((await GET(req("", {}))).status).toBe(401);
    expect((await GET(req("", { authorization: "Bearer nope" }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a tick posts to the digest webhook as Triply Alerts, records the alert and closes the monitor ok", async () => {
    addUntold("b1");
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, livemode: false, dry: false, open: 1, due: 1, urgentDue: 1, errors: 0, posts: [{ items: 1, urgent: 1, outcome: "posted" }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(HOOK);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).username).toBe("Triply Alerts");
    expect(mdb.rows(ALERTS)).toEqual([expect.objectContaining({ subject: "pi_b1", kind: "lot_notice", livemode: false, alerted_at: expect.any(String) })]);
    expect(checkIns()).toEqual(["in_progress", "ok"]);
  });

  it("nothing open: 200, no post", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).open).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(checkIns()).toEqual(["in_progress", "ok"]);
  });

  it("DIRECT_LOT_ALERTS_DISABLED=true → 200 and nothing at all", async () => {
    vi.stubEnv("DIRECT_LOT_ALERTS_DISABLED", "true");
    addUntold("b1");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disabled: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mdb.rows(ALERTS)).toEqual([]);
    expect(sentry.captureCheckIn).not.toHaveBeenCalled();
  });

  it("no digest webhook → Sentry error + 500; never falls back to the session webhook", async () => {
    vi.stubEnv("DISCORD_DAILY_DIGEST_WEBHOOK_URL", "");
    addUntold("b1");
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).outcome).toBe("no_webhook");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(mdb.rows(ALERTS)).toEqual([]);
  });

  it("?dry=1 returns what would be posted; writes, posts and checks in nothing", async () => {
    addUntold("b1");
    const res = await GET(req("?dry=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dry).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].embed.fields[0].value).toContain("[TEST] 🚨 URGENT TRP-B1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mdb.rows(ALERTS)).toEqual([]);
    expect(mdb.rows(RUNS)).toEqual([]);
    expect(sentry.captureCheckIn).not.toHaveBeenCalled();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("?dry=1 works without a webhook configured", async () => {
    vi.stubEnv("DISCORD_DAILY_DIGEST_WEBHOOK_URL", "");
    addUntold("b1");
    const res = await GET(req("?dry=1"));
    expect(res.status).toBe(200);
    expect((await res.json()).messages).toHaveLength(1);
  });

  it("a Discord failure is a 502 with an error check-in; alerted_at stays NULL", async () => {
    addUntold("b1");
    fetchMock.mockImplementation(async () => new Response("nope", { status: 401 }));
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
    expect(mdb.rows(ALERTS)[0]).toMatchObject({ alerted_at: null });
    expect(checkIns()).toEqual(["in_progress", "error"]);
  });

  it("a failed scan is a 500 with an error check-in; the other scans still post", async () => {
    addUntold("b1");
    mdb.failNext(RUNS, "select");
    const res = await GET(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.scans.manifest.ok).toBe(false);
    expect(body.posts).toEqual([expect.objectContaining({ outcome: "posted" })]);
    expect(checkIns()).toEqual(["in_progress", "error"]);
  });

  it("live Stripe key: live rows only, no [TEST], @here for an URGENT item", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_dummy");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    addUntold("test1");
    addUntold("live1", { livemode: true });
    const res = await GET(req());
    expect(res.status).toBe(200);
    const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(sent.content).toBe("@here");
    expect(sent.allowed_mentions).toEqual({ parse: ["everyone"] });
    expect(sent.embeds[0].fields[0].value).toBe(
      "🚨 URGENT TRP-LIVE1 — the lot was never told of this booking; check-in 2026-10-31 12:00 lot time (check-in in 2 h)"
    );
    expect(mdb.rows(ALERTS).map((a) => [a.subject, a.livemode])).toEqual([["pi_live1", true]]);
  });
});
