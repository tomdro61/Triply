import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const runs = vi.hoisted(() => ({
  existing: null as null | { outcome: string; posted_at: string },
  readError: null as null | { code: string; message: string },
  writeError: null as null | { code: string; message: string },
  upserts: [] as unknown[],
  clientThrows: null as null | Error,
}));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: async () => {
    if (runs.clientThrows) throw runs.clientThrows;
    return {
      from: () => ({
        select: () => ({ eq: () => ({ abortSignal: () => ({ maybeSingle: async () => ({ data: runs.readError ? null : runs.existing, error: runs.readError }) }) }) }),
        upsert: (row: unknown) => ({ abortSignal: async () => { runs.upserts.push(row); return { error: runs.writeError }; } }),
      }),
    };
  },
}));
const collectMock = vi.hoisted(() => ({ collectDigest: vi.fn() }));
vi.mock("@/lib/digest/collect", () => collectMock);
const readMock = vi.hoisted(() => ({ writeModelRead: vi.fn(), READ_TIMEOUT_MS: 6_000 }));
vi.mock("@/lib/digest/read", () => readMock);
const discordMock = vi.hoisted(() => ({ postToDiscord: vi.fn() }));
vi.mock("@/lib/digest/discord", () => discordMock);
const captureMock = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", () => captureMock);
const sentryMock = vi.hoisted(() => ({ captureCheckIn: vi.fn((..._args: unknown[]) => "chk"), flush: vi.fn(async () => true) }));
vi.mock("@sentry/nextjs", () => sentryMock);

import { GET } from "../route";
import type { DigestData } from "@/lib/digest/types";

const T0 = Date.parse("2026-09-28T13:05:00Z");
function req(query = "") {
  return new NextRequest(`https://www.triplypro.com/api/cron/daily-digest${query}`, { headers: { authorization: "Bearer test-secret" } });
}
function digest(over: Partial<DigestData> = {}): DigestData {
  const ok = <T>(data: T) => ({ ok: true as const, data });
  return {
    dateEt: "2026-09-27", windowLabel: "Sept 27, 2026 · 00:00–24:00 ET", generatedAt: new Date(T0).toISOString(),
    bookings: ok({ count: { value: 6, avg7: 5, avg28: 3, since: "2026-02-19" }, staging: 0, unmatched: 0, otherStatus: 0, refunded: 0, disputed: 0, cancelledOrFailed: 0, gmv: 600, chargedOnline: 590, avgOrder: 100, feeIncome: 40, serviceFees: 30, pgMargin: 10, pgRefundedWholesaleEaten: 0, pgAttachRate: 0.3, dirtyPgRows: 0, promoBookings: 0, promoDiscount: 0, repeatByEmail: 1, repeatCapped: false, unpricedRows: 0, leadTime: { sameDay: 3, d1to3: 2, d4to14: 1, d15plus: 0, unknown: 0 } }),
    whereFrom: ok({ byChannel: [], topAirports: [], landing: { blog: 5, airportPage: 0, homepage: 1, other: 0, none: 0 }, aiReferrals: 0, topBlogPosts: [] }),
    funnel: ok({ originSearches: { value: 400, avg7: 380, avg28: null, since: "2026-09-24" }, distinctAirports: 30, topAirports: [], datesDefaultedShare: 0.1, meanResults: 9, nothingBookableShare: 0.05, nothingBookableDegraded: 0, zeroResultShare: 0.06, pricedSearches: 300, nothingBookableByAirport: [], lotSoldOutRate: 0.2, degradedCount: 2 }),
    lostSales: ok({ byStatus: { completed: 6 }, rows: [] }),
    engagement: ok({ newsletterBySource: {}, waitlistByAirport: {}, chatSessions: 2, welcomeCodesMinted: 1 }),
    health: ok({ telemetry: { kind: "ok" as const, lastRowAt: "2026-09-28T03:58:00Z", rows24h: 500 }, snapshot: { kind: "off" as const }, stuckPending: { kind: "n" as const, n: 0 }, emailNotSent: { kind: "n" as const, n: 0, capped: false, numbers: [], lookbackDays: 7 }, lastDigest: { kind: "days" as const, n: 1 } }),
    ...over,
  };
}
const checkIns = () => sentryMock.captureCheckIn.mock.calls.map((c) => (c[0] as { status: string }).status);
/** The closing check-in must be queued BEFORE the last flush, or the frozen function drops it. */
const flushedAfterClose = () => {
  const closeAt = sentryMock.captureCheckIn.mock.invocationCallOrder.at(-1) ?? 0;
  const lastFlushAt = sentryMock.flush.mock.invocationCallOrder.at(-1) ?? 0;
  return lastFlushAt > closeAt;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  process.env.CRON_SECRET = "test-secret";
  process.env.DISCORD_DAILY_DIGEST_WEBHOOK_URL = "https://discord.test/hook";
  runs.existing = null;
  runs.readError = null;
  runs.writeError = null;
  runs.clientThrows = null;
  runs.upserts.length = 0;
  collectMock.collectDigest.mockReset().mockResolvedValue(digest());
  readMock.writeModelRead.mockReset().mockResolvedValue({ kind: "ok", text: "Six bookings." });
  discordMock.postToDiscord.mockReset().mockResolvedValue({ kind: "posted", status: 204, retried: false });
  captureMock.captureAPIError.mockReset();
  sentryMock.captureCheckIn.mockClear();
  sentryMock.flush.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.CRON_SECRET;
  delete process.env.DISCORD_DAILY_DIGEST_WEBHOOK_URL;
});

describe("GET /api/cron/daily-digest", () => {
  it("401 without the secret", async () => {
    const res = await GET(new NextRequest("https://www.triplypro.com/api/cron/daily-digest"));
    expect(res.status).toBe(401);
    expect(collectMock.collectDigest).not.toHaveBeenCalled();
  });

  it("503 + Sentry when no webhook is configured (a monitor's failure must be loud)", async () => {
    delete process.env.DISCORD_DAILY_DIGEST_WEBHOOK_URL;
    delete process.env.DISCORD_SESSION_WEBHOOK_URL;
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(captureMock.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("posts yesterday (ET) by default, records the run, checks in ok, and flushes AFTER the closing check-in", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, dateEt: "2026-09-27", outcome: "posted", modelRead: "ok", runLog: { read: "ok", write: "ok" } });
    expect(collectMock.collectDigest.mock.calls[0][0].dateEt).toBe("2026-09-27");
    expect(discordMock.postToDiscord).toHaveBeenCalledTimes(1);
    expect(runs.upserts[0]).toMatchObject({ digest_date: "2026-09-27", outcome: "posted", model_read: "ok" });
    expect(checkIns()).toEqual(["in_progress", "ok"]);
    expect(flushedAfterClose()).toBe(true);
  });

  it("is idempotent per date: an existing run answers already_posted with no post, unless ?force=1", async () => {
    runs.existing = { outcome: "posted", posted_at: "2026-09-28T13:05:10Z" };
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ ok: true, outcome: "already_posted", previous: { outcome: "posted" } });
    expect(discordMock.postToDiscord).not.toHaveBeenCalled();
    expect(checkIns()).toEqual(["in_progress", "ok"]);
    expect(flushedAfterClose()).toBe(true);
    const forced = await GET(req("?force=1"));
    expect(discordMock.postToDiscord).toHaveBeenCalledTimes(1);
    expect(await forced.json()).toMatchObject({ runLog: { read: "skipped" } }); // nothing was read, and it says so
  });

  it("a redelivery of a could_not_run day mirrors the recorded failure — it must not flip the monitor green", async () => {
    runs.existing = { outcome: "could_not_run", posted_at: "x" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, outcome: "already_posted" });
    expect(checkIns()).toEqual(["in_progress", "error"]);
  });

  it("a run-log READ error still posts, but flags the possible duplicate, records it, and is a 500 + error check-in", async () => {
    runs.readError = { code: "PGRST205", message: "Could not find the table 'public.digest_runs'" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, outcome: "posted", runLog: { read: "error" } });
    expect(discordMock.postToDiscord).toHaveBeenCalledTimes(1);
    const embed = discordMock.postToDiscord.mock.calls[0][1] as { description: string };
    expect(embed.description).toMatch(/run log unreadable/);
    expect(captureMock.captureAPIError).toHaveBeenCalledTimes(1);
    expect(checkIns()).toEqual(["in_progress", "error"]);
  });

  it("a run-log WRITE error after a good post is a 500 + error check-in (the next delivery would duplicate)", async () => {
    runs.writeError = { code: "42501", message: "permission denied" };
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, outcome: "posted", runLog: { write: "error" } });
    expect(captureMock.captureAPIError).toHaveBeenCalledTimes(1);
    expect(checkIns()).toEqual(["in_progress", "error"]);
  });

  it("?date= is validated: a non-real date, the future, and > 90 days back are 400", async () => {
    expect((await GET(req("?date=2026-02-30"))).status).toBe(400);
    expect((await GET(req("?date=2026-09-28"))).status).toBe(400); // today (ET) is not closed
    expect((await GET(req("?date=2026-05-01"))).status).toBe(400);
    expect((await GET(req("?date=2026-09-20"))).status).toBe(200);
    expect(collectMock.collectDigest.mock.calls[0][0].dateEt).toBe("2026-09-20");
  });

  it("bookings failed ⇒ a red no-number embed is posted, the model read is skipped, and the run is a 500", async () => {
    collectMock.collectDigest.mockResolvedValue(digest({ bookings: { ok: false, error: "timeout" } }));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(readMock.writeModelRead).not.toHaveBeenCalled();
    const embed = discordMock.postToDiscord.mock.calls[0][1] as { title: string; fields: unknown[] };
    expect(embed.title).toMatch(/COULD NOT RUN/);
    expect(embed.fields).toEqual([]);
    expect(runs.upserts[0]).toMatchObject({ outcome: "could_not_run", model_read: "skipped" });
    expect(checkIns()).toEqual(["in_progress", "error"]);
  });

  it("one section failed ⇒ posted_partial, 200, one Sentry event, flushed after the ok check-in", async () => {
    collectMock.collectDigest.mockResolvedValue(digest({ engagement: { ok: false, error: "PGRST205" } }));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "posted_partial", sectionsFailed: 1 });
    expect(captureMock.captureAPIError).toHaveBeenCalledTimes(1);
    expect(checkIns()).toEqual(["in_progress", "ok"]);
    expect(flushedAfterClose()).toBe(true);
  });

  it("a Discord failure is a 502 + Sentry + error check-in, recorded as post_failed (so the next run may retry)", async () => {
    discordMock.postToDiscord.mockResolvedValue({ kind: "failed", status: 429, body: "retry-after exceeds budget", retried: false });
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(runs.upserts[0]).toMatchObject({ outcome: "post_failed" });
    expect(checkIns()).toEqual(["in_progress", "error"]);
    // a post_failed record does NOT block a retry
    runs.existing = { outcome: "post_failed", posted_at: "x" };
    discordMock.postToDiscord.mockResolvedValue({ kind: "posted", status: 204, retried: false });
    expect((await GET(req())).status).toBe(200);
  });

  it("a Discord failure does not hide a collect failure: both Sentry events fire", async () => {
    collectMock.collectDigest.mockResolvedValue(digest({ bookings: { ok: false, error: "timeout" } }));
    discordMock.postToDiscord.mockResolvedValue({ kind: "failed", status: 503, body: "down", retried: true });
    const res = await GET(req());
    expect(res.status).toBe(502);
    const messages = captureMock.captureAPIError.mock.calls.map((c) => (c[0] as Error).message);
    expect(messages.some((m) => /could not run/.test(m))).toBe(true);
    expect(messages.some((m) => /Discord post failed/.test(m))).toBe(true);
  });

  it("a withheld model read still posts, labelled", async () => {
    readMock.writeModelRead.mockResolvedValue({ kind: "withheld", reason: "failed number check ($9)" });
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ outcome: "posted", modelRead: "withheld" });
    const embed = discordMock.postToDiscord.mock.calls[0][1] as { description: string };
    expect(embed.description).toMatch(/Read withheld/);
  });

  it("the model read is skipped when collect ate the budget, so the post still gets its time", async () => {
    collectMock.collectDigest.mockImplementation(async () => {
      vi.setSystemTime(new Date(T0 + 40_000)); // 40 s into a 50 s budget
      return digest();
    });
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ outcome: "posted", modelRead: "unavailable" });
    expect(readMock.writeModelRead).not.toHaveBeenCalled();
    const embed = discordMock.postToDiscord.mock.calls[0][1] as { description: string };
    expect(embed.description).toMatch(/out of time/);
  });

  it("?dry=1 collects, reads and renders but posts nothing, records nothing and never opens a check-in", async () => {
    delete process.env.DISCORD_DAILY_DIGEST_WEBHOOK_URL; // dry mode needs no webhook
    readMock.writeModelRead.mockResolvedValue({ kind: "withheld", reason: "failed number check (35.07%)", text: "Some read." });
    const res = await GET(req("?date=2026-09-27&dry=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, dry: true, dateEt: "2026-09-27", verdict: "ok", modelRead: "withheld", modelReadReason: "failed number check (35.07%)", withheldText: "Some read." });
    expect(body.embed.fields.map((f: { name: string }) => f.name)).toContain("Bookings");
    expect(discordMock.postToDiscord).not.toHaveBeenCalled();
    expect(runs.upserts).toHaveLength(0);
    expect(sentryMock.captureCheckIn).not.toHaveBeenCalled();
    expect(captureMock.captureAPIError).not.toHaveBeenCalled();
  });

  it("?dry=1 does not post the crash embed either, and reports ok:false for a could-not-run day", async () => {
    runs.clientThrows = new Error("supabaseKey is required");
    const res = await GET(req("?dry=1"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ outcome: "crashed", crashEmbedPosted: false });
    expect(discordMock.postToDiscord).not.toHaveBeenCalled();
    expect(sentryMock.captureCheckIn).not.toHaveBeenCalled();
    runs.clientThrows = null;
    collectMock.collectDigest.mockResolvedValue(digest({ bookings: { ok: false, error: "timeout" } }));
    const dryRes = await GET(req("?dry=1"));
    expect(dryRes.status).toBe(200);
    expect(await dryRes.json()).toMatchObject({ ok: false, dry: true, verdict: "could_not_run", sectionsFailed: 1 });
    expect(discordMock.postToDiscord).not.toHaveBeenCalled();
  });

  it("an unexpected throw is caught: Sentry, a red CRASHED embed, an error check-in, 500 — never a dangling in_progress", async () => {
    runs.clientThrows = new Error("supabaseKey is required");
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, outcome: "crashed", crashEmbedPosted: true });
    const embed = discordMock.postToDiscord.mock.calls[0][1] as { title: string; fields: unknown[] };
    expect(embed.title).toMatch(/CRASHED/);
    expect(embed.fields).toEqual([]);
    expect(captureMock.captureAPIError).toHaveBeenCalledTimes(1);
    expect(checkIns()).toEqual(["in_progress", "error"]);
    expect(flushedAfterClose()).toBe(true);
  });
});
