/**
 * The direct-lot alerts cron (6b plan §5, §8 "Alerts"): thresholds (incl. the
 * < 2 h fast path and the 60 s mid-send skip), stay bounds, URGENT ordering and
 * re-alert cadence, Discord failure, first_seen_at / last_seen_at rules and new
 * episodes, resolved alerts, test mode, @here, the no-PII rule, phone-the-lot,
 * and the manifest checks. All times are fixed instants against
 * America/New_York; booking times are literal lot-local wall clocks.
 *
 * The cron runs every 10 minutes and an owned row not seen for > 25 min starts
 * a new episode, so a test that spans longer ticks every 10 minutes
 * (`ticksThrough`, `postTimes`) unless it is testing the gap itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { mdb, sentry } = await vi.hoisted(async () => {
  const { ManifestDb } = await import("@/lib/direct/manifest/__tests__/manifest-db");
  return {
    mdb: new ManifestDb(),
    sentry: { captureMessage: vi.fn(), captureException: vi.fn(), fingerprints: [] as string[][] },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: async () => mdb.client }));
vi.mock("@/lib/resend/client", () => ({ resend: { emails: { send: vi.fn() } }, FROM_EMAIL: "Triply <bookings@triplypro.com>" }));
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
import { runAlertsCron } from "../run";
import { directLotRow } from "@/lib/direct/__tests__/fixtures";
import { recipientsHash } from "@/lib/direct/manifest/select";
import { CUTOFF_NOT_SENT_REASON, CUTOFF_REASON } from "@/lib/direct/manifest/run";
import { RUNS, ALERTS } from "@/lib/direct/manifest/__tests__/manifest-db";
import type { Row } from "@/lib/booking/__tests__/supabase-fake";
import type { Embed } from "@/lib/digest/render";

/** Oct 31 2026, 10:00 EDT. */
const MORNING = "2026-10-31T14:00:00Z";
/** Oct 31 2026, 20:30 EDT — tomorrow's manifest is expected by now. */
const NIGHT = "2026-11-01T00:30:00Z";
const TOMORROW = "2026-11-01";
const LOT_INBOX = ["desk@parkingpoint.example"];
const HOOK = "https://discord.example/webhook";

const PII = {
  first: "Grace",
  last: "Hopper",
  phone: "917-555-0142",
  email: "grace.hopper@example.com",
  address: "150-57 183rd St",
  plate: "HOPPER1",
};

const discord = vi.fn<typeof fetch>();

interface PostedBody {
  username: string;
  content?: string;
  allowed_mentions?: { parse: string[] };
  embeds: Embed[];
}
const posted = (): PostedBody[] => discord.mock.calls.map((c) => JSON.parse(String(c[1]?.body)));
const postedLines = (p: PostedBody) => p.embeds[0].fields.flatMap((f) => f.value.split("\n"));
const alertRow = (kind: string, subject: string) => mdb.rows(ALERTS).find((r) => r.kind === kind && r.subject === subject);
const isoAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function booking(id: string, over: Row = {}) {
  const pi = `pi_${id}`;
  mdb.rows("bookings").push({
    id,
    stripe_payment_intent_id: pi,
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
    lot_cancel_notice_claimed_at: null,
    created_at: "2026-10-29T12:00:00.000Z",
    location_name: "The Parking Point JFK",
    location_timezone: "America/New_York",
    lot_snapshot: { name: "The Parking Point JFK", timezone: "America/New_York", address: PII.address },
    check_in: "2026-11-03T09:30:00",
    check_out: "2026-11-05T17:00:00",
    customer_name: `${PII.first} ${PII.last}`,
    customer_email: PII.email,
    customer_phone: PII.phone,
    vehicle_info: { make: "Ford", model: "F-150", color: "Black", licensePlate: PII.plate, state: "NY" },
    ...over,
  });
  mdb.rows("pending_bookings").push({
    stripe_payment_intent_id: pi,
    customer: { firstName: PII.first, lastName: PII.last, phone: PII.phone, email: PII.email },
  });
  mdb.rows("direct_booking_terms").push({ stripe_payment_intent_id: pi, livemode: over.livemode ?? false, lot_recipients: LOT_INBOX, recipients_rev: 0 });
}

/** A booking the lot was told about and the manifest would list. */
const listed = (id: string, over: Row = {}) =>
  booking(id, { lot_notified_at: "2026-10-30T15:00:00.000Z", lot_notice_claimed_at: "2026-10-30T15:00:00.000Z", check_in: `${TOMORROW}T09:30:00`, ...over });

function run(over: Row) {
  mdb.rows(RUNS).push({
    direct_lot_id: "1",
    manifest_date: TOMORROW,
    livemode: false,
    recipients_hash: recipientsHash(LOT_INBOX),
    status: "sent",
    attempt: 1,
    claimed_at: "2026-10-31T22:00:00.000Z",
    attempt_claimed_at: "2026-10-31T22:00:00.000Z",
    had_unknown: false,
    booking_ids: [],
    ids_ever: [],
    recipients: ["ops@triplypro.com"],
    test: true,
    first_sent_at: "2026-10-31T22:00:05.000Z",
    sent_at: "2026-10-31T22:00:05.000Z",
    email_id: "em_1",
    last_error: null,
    ...over,
  });
}

type TickOptions = Partial<{ livemode: boolean; dry: boolean; manifestsDisabled: boolean }>;
async function tick(atIso: string, o: TickOptions = {}) {
  vi.setSystemTime(new Date(atIso));
  const nowMs = Date.now();
  return runAlertsCron({
    supabase: await createAdminClient(),
    livemode: o.livemode ?? false,
    nowMs,
    deadlineMs: nowMs + 45_000,
    dry: o.dry ?? false,
    webhookUrl: HOOK,
    manifestsDisabled: o.manifestsDisabled ?? false,
    fetchImpl: discord,
  });
}

const plusMin = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();

/** Every 10 minutes after `fromIso`, up to and including `toIso`, as the cron runs. Returns the last result. */
async function ticksThrough(fromIso: string, toIso: string, o: TickOptions = {}) {
  for (let t = Date.parse(fromIso) + 10 * 60_000; t < Date.parse(toIso); t += 10 * 60_000) await tick(new Date(t).toISOString(), o);
  return tick(toIso, o);
}

/** Minutes after `startIso` at which each TRP number was posted, ticking every 10 min through `minutes`. */
async function postTimes(startIso: string, minutes: number) {
  const at: Record<string, number[]> = {};
  for (let m = 0; m <= minutes; m += 10) {
    const before = discord.mock.calls.length;
    await tick(plusMin(startIso, m));
    for (const p of posted().slice(before)) {
      for (const l of postedLines(p)) (at[l.match(/TRP-\w+/)?.[0] ?? l] ??= []).push(m);
    }
  }
  return at;
}

beforeEach(() => {
  vi.clearAllMocks();
  sentry.fingerprints.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  mdb.reset();
  mdb.base.rpcHandlers.direct_lots_v2 = () => ({ data: [directLotRow({ notification_emails: LOT_INBOX })], error: null });
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "staging");
  vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "false");
  discord.mockImplementation(async () => new Response(null, { status: 204 }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
describe("lot_notice thresholds", () => {
  it("20 min grace; any age once check-in is < 2 h away; a claim < 60 s old is a notice mid-send", async () => {
    vi.setSystemTime(new Date(MORNING));
    booking("young", { created_at: isoAgo(10) }); // check-in in days: waits out the grace
    booking("old", { created_at: isoAgo(25) });
    booking("soon", { created_at: isoAgo(2), check_in: "2026-10-31T11:30:00" }); // 90 min away
    booking("sending", { created_at: isoAgo(2), check_in: "2026-10-31T11:30:00", lot_notice_claimed_at: isoAgo(0.5) });
    booking("stuck", { created_at: isoAgo(2), check_in: "2026-10-31T11:30:00", lot_notice_claimed_at: isoAgo(2) });
    booking("told", { created_at: isoAgo(60), lot_notified_at: isoAgo(50) });
    const r = await tick(MORNING);
    expect(r.lines.map((l) => [l.text.match(/TRP-\w+/)?.[0], l.urgent])).toEqual([
      ["TRP-SOON", true],
      ["TRP-STUCK", true],
      ["TRP-OLD", false],
    ]);
  });

  it("URGENT when check-in is < 24 h away or passed, or the zone is unknown", async () => {
    vi.setSystemTime(new Date(MORNING));
    booking("passed", { check_in: "2026-10-31T08:00:00" });
    booking("in20h", { check_in: "2026-11-01T06:00:00" });
    booking("in30h", { check_in: "2026-11-01T16:00:00" });
    booking("nozone", { location_timezone: null, lot_snapshot: { name: "The Parking Point JFK" } });
    booking("badzone", { location_timezone: "Mars/Olympus", lot_snapshot: { timezone: "Not/AZone" } });
    const r = await tick(MORNING);
    const urgency = Object.fromEntries(r.lines.map((l) => [l.text.match(/TRP-\w+/)?.[0], l.urgent]));
    expect(urgency).toEqual({ "TRP-PASSED": true, "TRP-IN20H": true, "TRP-IN30H": false, "TRP-NOZONE": true, "TRP-BADZONE": true });
    expect(r.lines.find((l) => l.text.includes("TRP-PASSED"))?.text).toBe(
      "[TEST] 🚨 URGENT TRP-PASSED — lot notice not confirmed, it may not have arrived; check-in 2026-10-31 08:00 lot time (check-in passed 2 h ago)"
    );
    expect(r.lines.find((l) => l.text.includes("TRP-NOZONE"))?.text).toContain("lot time zone unknown");
  });

  it("bounded by the stay: check-out lot-local yesterday still counts, the day before does not", async () => {
    vi.setSystemTime(new Date(MORNING));
    booking("yday", { check_in: "2026-10-28T09:00:00", check_out: "2026-10-30T08:00:00" });
    booking("over", { check_in: "2026-10-27T09:00:00", check_out: "2026-10-29T23:00:00" });
    booking("other_mode", { livemode: true });
    booking("reslab", { inventory_source: "reslab" });
    const r = await tick(MORNING);
    expect(r.lines.map((l) => l.text.match(/TRP-\w+/)?.[0])).toEqual(["TRP-YDAY"]);
  });
});

// ---------------------------------------------------------------------------
describe("posting, cadence and rows", () => {
  it("one post, URGENT first, as 'Triply Alerts'; alerted_at only after Discord accepted it", async () => {
    vi.setSystemTime(new Date(MORNING));
    booking("later"); // not urgent
    booking("now", { check_in: "2026-10-31T12:00:00" });
    const r = await tick(MORNING);
    expect(r.status).toBe(200);
    expect(discord).toHaveBeenCalledTimes(1);
    const [p] = posted();
    expect(p.username).toBe("Triply Alerts");
    expect(postedLines(p).map((l) => l.match(/TRP-\w+/)?.[0])).toEqual(["TRP-NOW", "TRP-LATER"]);
    expect(alertRow("lot_notice", "pi_now")).toMatchObject({ alerted_at: expect.any(String), first_seen_at: expect.any(String), livemode: false });
    expect(alertRow("lot_notice", "pi_later")?.alerted_at).toEqual(expect.any(String));
  });

  it("URGENT re-alerts hourly (counted from the tick, not the post), the rest every 6 h; nothing re-posts in between", async () => {
    booking("later");
    booking("now", { check_in: "2026-10-31T12:00:00" });
    const at = await postTimes(MORNING, 6 * 60);
    expect(at).toEqual({ "TRP-NOW": [0, 60, 120, 180, 240, 300, 360], "TRP-LATER": [0, 360] });
    expect(alertRow("lot_notice", "pi_now")?.alerted_at).toBe(plusMin(MORNING, 360));
  });

  it("an item that turns URGENT is posted at once, without waiting for its 6 h", async () => {
    // 28 h away at 10:00 EDT; Nov 1 14:00 is EST (19:00Z), after the fall-back.
    booking("b1", { check_in: "2026-11-01T14:00:00" });
    const at = await postTimes(MORNING, 6 * 60);
    expect(at["TRP-B1"]).toEqual([0, 310]); // 19:10Z: under 24 h away — then hourly from there
    expect(postedLines(posted()[0])[0]).not.toContain("URGENT");
    expect(postedLines(posted()[1])[0]).toContain("🚨 URGENT TRP-B1");
  });

  it("a failed post does not use up the URGENT escalation: the next tick posts it again", async () => {
    vi.setSystemTime(new Date(MORNING));
    booking("b1", { check_in: "2026-10-31T12:00:00" }); // 2 h away: URGENT
    // Alerted 30 min ago while it was not yet URGENT; seen by the last tick.
    mdb.rows(ALERTS).push({
      subject: "pi_b1", kind: "lot_notice", livemode: false, first_seen_at: isoAgo(600), last_seen_at: isoAgo(10), alerted_at: isoAgo(30),
      detail: { number: "TRP-B1", urgent: false, alertedUrgent: false },
    });
    discord.mockImplementation(async () => new Response("bad", { status: 400 }));
    const r1 = await tick(MORNING);
    expect(r1.status).toBe(502);
    expect(alertRow("lot_notice", "pi_b1")).toMatchObject({ alerted_at: isoAgo(30), detail: { urgent: true } });
    expect(alertRow("lot_notice", "pi_b1")?.detail).not.toHaveProperty("alertedUrgent");

    discord.mockImplementation(async () => new Response(null, { status: 204 }));
    const r2 = await tick(plusMin(MORNING, 10));
    expect(r2.posts).toEqual([expect.objectContaining({ outcome: "posted", urgent: 1 })]);
    expect(alertRow("lot_notice", "pi_b1")).toMatchObject({ alerted_at: plusMin(MORNING, 10), detail: { urgent: true, alertedUrgent: true, everAlerted: true } });
    await tick(plusMin(MORNING, 20));
    expect(discord).toHaveBeenCalledTimes(2); // the failed post + the retry; nothing at +20 (hourly now)
  });

  it("a Discord failure leaves alerted_at NULL (502), and the next tick posts again", async () => {
    booking("b1");
    discord.mockImplementation(async () => new Response("bad", { status: 400 }));
    const r = await tick(MORNING);
    expect(r.status).toBe(502);
    expect(r.ok).toBe(false);
    expect(r.posts).toEqual([{ items: 1, urgent: 0, outcome: "failed", status: 400 }]);
    expect(alertRow("lot_notice", "pi_b1")).toMatchObject({ alerted_at: null });

    discord.mockImplementation(async () => new Response(null, { status: 204 }));
    await tick("2026-10-31T14:10:00Z");
    expect(discord).toHaveBeenCalledTimes(2);
    expect(alertRow("lot_notice", "pi_b1")?.alerted_at).toEqual(expect.any(String));
  });

  it("writers touch last_seen_at + detail only: first_seen_at and alerted_at are never reset within an episode", async () => {
    booking("b1");
    await tick(MORNING);
    const first = { ...alertRow("lot_notice", "pi_b1") };
    await tick("2026-10-31T14:10:00Z");
    const after = alertRow("lot_notice", "pi_b1");
    expect(after?.first_seen_at).toBe(first.first_seen_at);
    expect(after?.alerted_at).toBe(first.alerted_at);
    expect(after?.last_seen_at).toBe("2026-10-31T14:10:00.000Z");
    // Both writes are upserts (record: last_seen_at + detail; posted: alerted_at + detail) — no UPDATE outside a new episode.
    expect(mdb.updates.filter((u) => u.table === ALERTS)).toEqual([]);
  });

  it("a new episode after a gap: treated as new — posted at once, grace restarted, first_seen_at reset by compare-and-set", async () => {
    vi.setSystemTime(new Date(MORNING));
    booking("n1"); // not URGENT: within one episode it would wait 6 h
    booking("c1", { status: "cancelled", lot_notified_at: "2026-10-30T15:00:00.000Z" });
    const lastSeen = isoAgo(40); // missed by the last 3 ticks
    mdb.rows(ALERTS).push(
      { subject: "pi_n1", kind: "lot_notice", livemode: false, first_seen_at: isoAgo(300), last_seen_at: lastSeen, alerted_at: isoAgo(50), detail: { urgent: false } },
      { subject: "pi_c1", kind: "cancel_notice", livemode: false, first_seen_at: isoAgo(300), last_seen_at: lastSeen, alerted_at: isoAgo(50), detail: { urgent: false } }
    );
    await tick(MORNING);
    expect(postedLines(posted()[0]).map((l) => l.match(/TRP-\w+/)?.[0])).toEqual(["TRP-N1"]);
    expect(alertRow("lot_notice", "pi_n1")).toMatchObject({ first_seen_at: new Date(MORNING).toISOString(), alerted_at: new Date(MORNING).toISOString() });
    // The cancel waits its 30 min grace again (the old alerted_at no longer counts)…
    expect(alertRow("cancel_notice", "pi_c1")).toMatchObject({ first_seen_at: new Date(MORNING).toISOString(), alerted_at: null });
    const resets = mdb.updates.filter((u) => u.table === ALERTS);
    expect(resets.map((u) => u.payload)).toEqual([
      { first_seen_at: new Date(MORNING).toISOString(), alerted_at: null },
      { first_seen_at: new Date(MORNING).toISOString(), alerted_at: null },
    ]);
    expect(resets.every((u) => u.filters.includes("last_seen_at.eq"))).toBe(true);
    // …and is posted when it is over.
    const at = await postTimes(MORNING, 30);
    expect(at["TRP-C1"]).toEqual([30]);
  });

  it("a partial failure of a split post: the accepted part is marked, the rest posts on the next tick (502)", async () => {
    vi.setSystemTime(new Date(MORNING));
    for (let i = 0; i < 25; i++) booking(`n${String(i).padStart(2, "0")}`, { check_in: "2026-10-31T12:00:00" });
    for (let i = 0; i < 25; i++) mdb.rows(ALERTS).push({ subject: `${i}:tz`, kind: "lot_config", livemode: false, first_seen_at: isoAgo(90), last_seen_at: isoAgo(5), alerted_at: null, detail: { lotId: String(i), problem: "tz", reason: "z".repeat(150) } });
    let calls = 0;
    discord.mockImplementation(async () => (++calls === 2 ? new Response("bad", { status: 400 }) : new Response(null, { status: 204 })));
    const r = await tick(MORNING);
    expect(r.status).toBe(502);
    expect(r.posts.map((p) => p.outcome)).toEqual(["posted", "failed"]);
    const [part1, part2] = posted();
    const rowOf = (l: string) => {
      const trp = l.match(/TRP-(\w+)/)?.[1];
      return trp ? alertRow("lot_notice", `pi_${trp.toLowerCase()}`) : alertRow("lot_config", `${l.match(/Lot (\d+)/)?.[1]}:tz`);
    };
    expect(postedLines(part1).map((l) => rowOf(l)?.alerted_at)).toEqual(postedLines(part1).map(() => new Date(MORNING).toISOString()));
    expect(postedLines(part2).map((l) => rowOf(l)?.alerted_at)).toEqual(postedLines(part2).map(() => null));

    calls = 10; // Discord is back
    await tick(plusMin(MORNING, 10));
    const notAccepted = r.lines.filter((l) => l.due && !postedLines(part1).includes(l.text)).map((l) => l.text);
    expect(notAccepted.length).toBeGreaterThan(0);
    expect(posted().slice(2).flatMap(postedLines).sort()).toEqual(notAccepted.sort());
  });

  it("Sentry: one error per URGENT item, fingerprinted per kind + booking; TRP number only", async () => {
    booking("a", { check_in: "2026-10-31T12:00:00" });
    booking("b", { check_in: "2026-10-31T13:00:00" });
    booking("calm");
    await tick(MORNING);
    expect(sentry.fingerprints.filter((f) => f[0] === "direct-lot-alert")).toEqual([
      ["direct-lot-alert", "lot_notice", "pi_a"],
      ["direct-lot-alert", "lot_notice", "pi_b"],
    ]);
    const urgentMessages = sentry.captureMessage.mock.calls.filter((c) => String(c[0]).includes("URGENT"));
    expect(urgentMessages).toHaveLength(2);
    expect(urgentMessages.every((c) => c[1] === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("test mode, @here and the no-PII rule", () => {
  it("test mode: [TEST] on the title and every line, and never @here — even when URGENT", async () => {
    booking("now", { check_in: "2026-10-31T12:00:00" });
    booking("later");
    await tick(MORNING);
    const [p] = posted();
    expect(p.embeds[0].title.startsWith("[TEST] ")).toBe(true);
    expect(postedLines(p).every((l) => l.startsWith("[TEST] "))).toBe(true);
    expect(p.content).toBeUndefined();
    expect(p.allowed_mentions).toBeUndefined();
  });

  it("live: @here (allowed to ping) only on a post with an URGENT item", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    booking("later", { livemode: true });
    await tick(MORNING, { livemode: true });
    expect(posted()[0].content).toBeUndefined();
    expect(posted()[0].embeds[0].title.startsWith("[TEST]")).toBe(false);

    booking("now", { livemode: true, check_in: "2026-10-31T13:00:00" });
    await tick("2026-10-31T14:10:00Z", { livemode: true });
    expect(posted()[1]).toMatchObject({ content: "@here", allowed_mentions: { parse: ["everyone"] } });
    expect(postedLines(posted()[1])).toEqual([
      "🚨 URGENT TRP-NOW — lot notice not confirmed, it may not have arrived; check-in 2026-10-31 13:00 lot time (check-in in 3 h)",
    ]);
  });

  it("no name, phone, email, address or plate reaches Discord, Sentry, the alert rows or the response", async () => {
    vi.setSystemTime(new Date(NIGHT));
    booking("n1", { check_in: "2026-10-31T21:00:00" });
    booking("c1", { status: "cancelled", lot_notified_at: "2026-10-30T15:00:00.000Z" });
    listed("m1");
    mdb.rows(ALERTS).push({
      subject: "1:tz", kind: "lot_config", livemode: false, first_seen_at: isoAgo(90), last_seen_at: "2026-11-01T01:25:00.000Z", alerted_at: null,
      detail: { lotId: "1", problem: "tz", reason: `zone disagreement; contact ${PII.email}` },
    });
    const r = await tick("2026-11-01T01:30:00Z"); // 21:30 EDT: cancel first seen now — tick on past its grace
    await ticksThrough("2026-11-01T01:30:00Z", "2026-11-01T02:05:00Z");
    // The seeded lot_config row (the manifest cron's) is left out: only what this cron writes or sends.
    const ours = mdb.rows(ALERTS).filter((a) => a.kind !== "lot_config");
    const everything = JSON.stringify([posted(), sentry.captureMessage.mock.calls, ours, r]);
    for (const value of Object.values(PII)) expect(everything).not.toContain(value);
    expect(everything).toContain("[email]");
    const lines = posted().flatMap(postedLines);
    expect(lines.some((l) => l.includes("TRP-N1"))).toBe(true);
    expect(lines.some((l) => l.includes("TRP-C1"))).toBe(true);
    expect(lines.some((l) => l.includes("Lot 1 — no manifest for 2026-11-01 (would list TRP-M1)"))).toBe(true);
  });

  it("the message for a mixed tick (exact text)", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    booking("u1", { livemode: true, check_in: "2026-10-31T11:00:00" });
    booking("c1", { livemode: true, status: "refunded", lot_notified_at: "2026-10-30T15:00:00.000Z" });
    await tick("2026-10-31T13:20:00Z", { livemode: true }); // first sight of the cancel
    await ticksThrough("2026-10-31T13:20:00Z", "2026-10-31T13:50:00Z", { livemode: true }); // its 30 min grace
    expect(discord).toHaveBeenCalledTimes(2);
    const p = posted()[1];
    expect(p.content).toBeUndefined(); // the URGENT item was alerted 30 min ago: not due again yet
    expect(p.allowed_mentions).toBeUndefined();
    expect(p.embeds[0]).toEqual({
      title: "⚠️ Direct lots — 1 alert",
      description:
        "Open problems with direct-lot bookings — TRP numbers and lot ids only (no customer details); look them up in /admin/bookings. URGENT items repeat hourly, the rest every 6 h, until fixed.",
      color: 0xf59e0b,
      fields: [
        { name: "Lot not told of a cancellation", value: "TRP-C1 — cancelled, but the lot has not been sent the cancellation (check-in 2026-11-03 09:30 lot time)" },
      ],
      footer: { text: "Triply Alerts · production (live Stripe)" },
    });
  });
});

// ---------------------------------------------------------------------------
describe("cancel_notice", () => {
  it("alerts 30 min after first sight; first_seen_at is never reset", async () => {
    booking("c1", { status: "cancelled", lot_notified_at: "2026-10-30T15:00:00.000Z" });
    await tick(MORNING);
    expect(discord).not.toHaveBeenCalled();
    const firstSeen = alertRow("cancel_notice", "pi_c1")?.first_seen_at;
    expect(firstSeen).toBe("2026-10-31T14:00:00.000Z");

    await tick("2026-10-31T14:20:00Z");
    expect(discord).not.toHaveBeenCalled();
    expect(alertRow("cancel_notice", "pi_c1")?.first_seen_at).toBe(firstSeen);

    await tick("2026-10-31T14:31:00Z");
    expect(discord).toHaveBeenCalledTimes(1);
    expect(alertRow("cancel_notice", "pi_c1")).toMatchObject({ first_seen_at: firstSeen, alerted_at: expect.any(String) });
  });

  it("a claimed-but-unstamped booking notice counts as told; cancel already sent and never-told are not cancel alerts", async () => {
    booking("claimed", { status: "cancelled", lot_notice_claimed_at: "2026-10-30T15:00:00.000Z" });
    booking("done", { status: "cancelled", lot_notified_at: "2026-10-30T15:00:00.000Z", lot_cancel_notified_at: "2026-10-30T16:00:00.000Z" });
    booking("never", { status: "refunded" });
    booking("stale", { status: "cancelled", lot_notified_at: "2026-10-20T15:00:00.000Z", check_out: "2026-10-29T10:00:00" });
    await tick(MORNING);
    await ticksThrough(MORNING, "2026-10-31T14:31:00Z");
    expect(postedLines(posted()[0]).map((l) => l.match(/TRP-\w+/)?.[0])).toEqual(["TRP-CLAIMED"]);
  });

  it("phone the lot: cancelled, never emailed, but we posted a lot_notice alert for it", async () => {
    booking("phoned", { status: "cancelled" });
    booking("quiet", { status: "cancelled" });
    mdb.rows(ALERTS).push(
      { subject: "pi_phoned", kind: "lot_notice", livemode: false, first_seen_at: isoAgo(600), last_seen_at: isoAgo(600), alerted_at: isoAgo(590), detail: {} },
      { subject: "pi_quiet", kind: "lot_notice", livemode: false, first_seen_at: isoAgo(600), last_seen_at: isoAgo(600), alerted_at: null, detail: {} }
    );
    await tick(MORNING);
    const lines = postedLines(posted()[0]);
    expect(lines).toEqual([
      "[TEST] TRP-PHONED — cancelled; the lot was never emailed this booking but we alerted on it (it may have been phoned) — phone the lot to cancel (check-in 2026-11-03 09:30 lot time)",
    ]);
    expect(alertRow("cancel_notice", "pi_phoned")).toMatchObject({ alerted_at: expect.any(String), detail: { reason: "phone the lot to cancel" } });
  });

  it("phone the lot also when the lot_notice alert was URGENT but never posted (Sentry emailed), or resolved (the lot was phoned)", async () => {
    vi.setSystemTime(new Date(MORNING));
    booking("urgent", { status: "cancelled" });
    booking("resolved", { status: "cancelled" });
    booking("earlier", { status: "cancelled" });
    booking("quiet", { status: "cancelled" });
    mdb.rows(ALERTS).push(
      { subject: "pi_urgent", kind: "lot_notice", livemode: false, first_seen_at: isoAgo(600), last_seen_at: isoAgo(600), alerted_at: null, detail: { urgent: true } },
      {
        subject: "pi_resolved", kind: "lot_notice", livemode: false, first_seen_at: isoAgo(600), last_seen_at: isoAgo(600), alerted_at: null,
        resolved_at: isoAgo(300), resolved_by: "tom@triplypro.com", detail: { urgent: false },
      },
      // Posted in an earlier episode (alerted_at cleared by the reset since).
      { subject: "pi_earlier", kind: "lot_notice", livemode: false, first_seen_at: isoAgo(600), last_seen_at: isoAgo(600), alerted_at: null, detail: { urgent: false, everAlerted: true } },
      { subject: "pi_quiet", kind: "lot_notice", livemode: false, first_seen_at: isoAgo(600), last_seen_at: isoAgo(600), alerted_at: null, detail: { urgent: false } }
    );
    await tick(MORNING);
    expect(postedLines(posted()[0]).map((l) => l.match(/TRP-\w+/)?.[0]).sort()).toEqual(["TRP-EARLIER", "TRP-RESOLVED", "TRP-URGENT"]);
  });
});

// ---------------------------------------------------------------------------
describe("resolved alerts", () => {
  it("an item whose own row a person resolved is closed: not posted, not re-recorded, not counted against the cap", async () => {
    vi.setSystemTime(new Date(MORNING));
    booking("fixed", { check_in: "2026-10-31T12:00:00" }); // URGENT lot_notice, resolved
    booking("open", { check_in: "2026-10-31T12:30:00" });
    booking("phoned", { status: "cancelled" }); // phone-the-lot, its cancel_notice row resolved
    const resolved = { resolved_at: isoAgo(5), resolved_by: "tom@triplypro.com" };
    mdb.rows(ALERTS).push(
      { subject: "pi_fixed", kind: "lot_notice", livemode: false, first_seen_at: isoAgo(120), last_seen_at: isoAgo(10), alerted_at: isoAgo(90), detail: { urgent: true }, ...resolved },
      { subject: "pi_phoned", kind: "lot_notice", livemode: false, first_seen_at: isoAgo(600), last_seen_at: isoAgo(600), alerted_at: isoAgo(590), detail: {} },
      { subject: "pi_phoned", kind: "cancel_notice", livemode: false, first_seen_at: isoAgo(60), last_seen_at: isoAgo(10), alerted_at: isoAgo(60), detail: {}, ...resolved },
      {
        subject: "b-9:manifest:1:2026-10-31:abc", kind: "followup", livemode: false, first_seen_at: isoAgo(20), last_seen_at: isoAgo(10), alerted_at: null,
        detail: { trp: "TRP-F9", manifestDate: "2026-10-31", reason: "x" }, ...resolved,
      }
    );
    const r = await tick(MORNING);
    expect(r).toMatchObject({ open: 1, resolved: 2, scans: { lot_notice: { shown: 1, overflow: 0 } } });
    expect(posted().flatMap(postedLines).map((l) => l.match(/TRP-\w+/)?.[0])).toEqual(["TRP-OPEN"]);
    expect(alertRow("lot_notice", "pi_fixed")).toMatchObject({ last_seen_at: isoAgo(10), alerted_at: isoAgo(90), ...resolved });
    expect(sentry.fingerprints).not.toContainEqual(["direct-lot-alert", "lot_notice", "pi_fixed"]);
  });
});

// ---------------------------------------------------------------------------
describe("manifest", () => {
  const manifestLines = () => posted().flatMap(postedLines).filter((l) => l.includes("Lot 1 —"));

  it("expected for tomorrow from 20:00 lot time: none before, an alert after when no run exists", async () => {
    listed("m1");
    await tick("2026-10-31T23:50:00Z"); // 19:50 EDT
    expect(discord).not.toHaveBeenCalled();
    await tick(NIGHT);
    expect(manifestLines()).toEqual(["[TEST] Lot 1 — no manifest for 2026-11-01 (would list TRP-M1)"]);
    expect(alertRow("manifest", "1:2026-11-01")).toMatchObject({ detail: { lotId: "1", manifestDate: TOMORROW } });
  });

  it("a sent run, a checked run or a fresh in-flight claim settles it; a stale `sending` does not", async () => {
    listed("m1");
    run({ status: "sent" });
    await tick(NIGHT);
    expect(discord).not.toHaveBeenCalled();

    mdb.rows(RUNS).length = 0;
    run({ status: "sending", sent_at: null, first_sent_at: null, claimed_at: "2026-11-01T00:28:00.000Z" });
    await tick(NIGHT);
    expect(discord).not.toHaveBeenCalled();

    mdb.rows(RUNS)[0].claimed_at = "2026-11-01T00:10:00.000Z";
    await tick(NIGHT);
    expect(manifestLines()).toEqual(["[TEST] Lot 1 — manifest for 2026-11-01 not sent — the run stalled before reaching Resend (attempt 1)"]);

    // A send that was started (had_unknown) may have been delivered: "not confirmed", not "not sent".
    mdb.rows(RUNS)[0].had_unknown = true;
    const r = await tick(plusMin(NIGHT, 1));
    expect(r.lines.filter((l) => l.kind === "manifest").map((l) => l.text)).toEqual([
      "[TEST] Lot 1 — manifest for 2026-11-01 not confirmed sent — stuck at attempt 1",
    ]);
  });

  it("per recipient set: a set with no run is missing even when another set's run was sent", async () => {
    listed("a");
    listed("b");
    mdb.rows("direct_booking_terms").find((t) => t.stripe_payment_intent_id === "pi_b")!.lot_recipients = ["new-inbox@parkingpoint.example"];
    run({ status: "sent" }); // only the old inbox's run
    await tick(NIGHT);
    expect(manifestLines()).toEqual(["[TEST] Lot 1 — no manifest for 2026-11-01 (would list TRP-B)"]);
  });

  it("a booking notified too late for an in-window tick is not expected on the manifest", async () => {
    listed("late", { lot_notified_at: "2026-11-01T00:15:00.000Z" }); // 20:15 EDT, 15 min before NIGHT
    await tick(NIGHT);
    expect(discord).not.toHaveBeenCalled();
  });

  it("tomorrow's bookings all unlisted → URGENT lot_notice alerts, but no manifest alert", async () => {
    booking("u1", { check_in: `${TOMORROW}T09:30:00` });
    booking("u2", { check_in: `${TOMORROW}T10:30:00`, cancel_state: null });
    listed("midcancel", { cancel_claimed_at: "2026-10-31T23:00:00.000Z" });
    await tick(NIGHT);
    const lines = posted().flatMap(postedLines);
    expect(lines.filter((l) => l.includes("URGENT")).map((l) => l.match(/TRP-\w+/)?.[0])).toEqual(["TRP-U1", "TRP-U2"]);
    expect(manifestLines()).toEqual([]);
    expect(mdb.rows(ALERTS).filter((r) => r.kind === "manifest")).toEqual([]);
  });

  it("deliberate no-sends are ignored; other failures and cutoff-closed runs alert", async () => {
    run({ status: "failed", sent_at: null, last_error: "nothing_to_list: every booking on the list was cancelled before the send" });
    run({ recipients_hash: "aaaaaaaaaaaaaaaa", status: "failed", sent_at: null, last_error: "superseded: the lot has a booking for this date now" });
    await tick(MORNING);
    expect(discord).not.toHaveBeenCalled();

    mdb.rows(RUNS).length = 0;
    run({ status: "failed", sent_at: null, attempt: 2, last_error: "Resend validation_error 422: bad address desk@parkingpoint.example" });
    run({ manifest_date: "2026-10-31", status: "checked", sent_at: null, had_unknown: true, last_error: CUTOFF_REASON });
    await tick(MORNING);
    expect(manifestLines()).toEqual([
      "[TEST] Lot 1 — manifest for 2026-10-31 closed at the noon cutoff without a confirmed send — it may not have arrived",
      "[TEST] Lot 1 — manifest for 2026-11-01 failed to send (attempt 2: Resend validation_error 422: bad address [email])",
    ]);
  });

  it("a `sent` run whose date has passed: its follow-ups never completed", async () => {
    run({ manifest_date: "2026-10-31", status: "sent" }); // today: the follow-up still has time
    run({ manifest_date: "2026-10-30", status: "sent" }); // yesterday: stuck
    run({ manifest_date: "2026-10-29", status: "checked" }); // done
    const r = await tick(MORNING);
    expect(r.lines.filter((l) => l.kind === "manifest").map((l) => l.text)).toEqual([
      "[TEST] Lot 1 — manifest for 2026-10-30 was sent, but its follow-up check never completed — a cancellation since may not have reached the lot",
    ]);
  });

  it("a stale `sending` run that never reached Resend (had_unknown = false) is 'not sent' once past the noon cutoff", async () => {
    // No listed booking: only the past-cutoff rule can see it.
    run({ manifest_date: "2026-10-31", status: "sending", sent_at: null, first_sent_at: null, had_unknown: false, claimed_at: "2026-10-31T03:00:00.000Z" });
    run({ manifest_date: "2026-10-30", recipients_hash: "bbbbbbbbbbbbbbbb", status: "sending", sent_at: null, first_sent_at: null, had_unknown: false, claimed_at: "2026-10-30T03:00:00.000Z" });
    // Started a send (may have been delivered), its date not yet passed: the manifest cron's cutoff path owns it, not this rule.
    run({ manifest_date: "2026-10-31", recipients_hash: "cccccccccccccccc", status: "sending", sent_at: null, first_sent_at: null, had_unknown: true, claimed_at: "2026-10-30T03:00:00.000Z" });
    const morning = await tick(MORNING); // 10:00 EDT: today's run is before its cutoff
    expect(morning.lines.filter((l) => l.kind === "manifest").map((l) => l.text)).toEqual([
      "[TEST] Lot 1 — manifest for 2026-10-30 not sent — the run stalled before reaching Resend (attempt 1)",
    ]);
    const noon = await tick("2026-10-31T16:00:00Z"); // 12:00 EDT
    expect(noon.lines.filter((l) => l.kind === "manifest").map((l) => l.text)).toEqual([
      "[TEST] Lot 1 — manifest for 2026-10-30 not sent — the run stalled before reaching Resend (attempt 1)",
      "[TEST] Lot 1 — manifest for 2026-10-31 not sent — the run stalled before reaching Resend (attempt 1)",
    ]);
  });

  it("6b pass 2: a run that may have been delivered, still `sending` after its date has passed, is reported (follow-ups pending)", async () => {
    run({ manifest_date: "2026-10-30", status: "sending", sent_at: null, first_sent_at: null, had_unknown: true, claimed_at: "2026-10-30T03:00:00.000Z" });
    // A fresh claim is the manifest cron at work right now: not reported.
    run({ manifest_date: "2026-10-29", recipients_hash: "dddddddddddddddd", status: "sending", sent_at: null, first_sent_at: null, had_unknown: true, claimed_at: isoAgo(0) });
    vi.setSystemTime(new Date(MORNING));
    mdb.rows(RUNS)[1].claimed_at = new Date(Date.parse(MORNING) - 60_000).toISOString();
    const r = await tick(MORNING);
    expect(r.lines.filter((l) => l.kind === "manifest").map((l) => l.text)).toEqual([
      "[TEST] Lot 1 — manifest for 2026-10-30 may have been delivered; follow-ups pending — a cancellation since may not have reached the lot",
    ]);
  });

  it("6b pass 2: a run the manifest cron closed `failed` past the date with the lot's zone unknown (never reached Resend) is still 'not sent'", async () => {
    run({ manifest_date: "2026-10-30", status: "failed", sent_at: null, first_sent_at: null, had_unknown: false, last_error: CUTOFF_NOT_SENT_REASON });
    const r = await tick(MORNING);
    expect(r.lines.filter((l) => l.kind === "manifest").map((l) => l.text)).toEqual([
      "[TEST] Lot 1 — manifest for 2026-10-30 not sent — the run stalled before reaching Resend (attempt 1)",
    ]);
  });

  it("today's (last evening's) manifest is checked too", async () => {
    listed("t1", { check_in: "2026-10-31T15:00:00", check_out: "2026-11-02T10:00:00" });
    await tick(MORNING);
    expect(manifestLines()).toEqual(["[TEST] Lot 1 — no manifest for 2026-10-31 (would list TRP-T1)"]);
  });

  it("empty-day lot past the E1 gate: alerted only while no run exists; never for a lot that fails it", async () => {
    await tick(NIGHT);
    expect(discord).not.toHaveBeenCalled(); // DIRECT_CHECKOUT_PREVIEW off: not eligible

    vi.stubEnv("DIRECT_CHECKOUT_PREVIEW", "true");
    await tick("2026-11-01T00:31:00Z");
    expect(manifestLines()).toEqual(["[TEST] Lot 1 — no manifest for 2026-10-31 (empty-day reminder)", "[TEST] Lot 1 — no manifest for 2026-11-01 (empty-day reminder)"]);
  });

  it("notes the manifest kill switch", async () => {
    listed("m1");
    await tick(NIGHT, { manifestsDisabled: true });
    expect(manifestLines()[0]).toContain("[DIRECT_LOT_MANIFEST_DISABLED is on]");
  });
});

// ---------------------------------------------------------------------------
describe("lot_config / followup (the manifest cron's rows)", () => {
  it("open while last_seen_at is under an hour old; alerted_at is set on them too", async () => {
    vi.setSystemTime(new Date(MORNING));
    mdb.rows(ALERTS).push(
      { subject: "1:tz", kind: "lot_config", livemode: false, first_seen_at: isoAgo(300), last_seen_at: isoAgo(30), alerted_at: null, detail: { lotId: "1", problem: "tz", reason: "bookings disagree" } },
      { subject: "2:cms", kind: "lot_config", livemode: false, first_seen_at: isoAgo(300), last_seen_at: isoAgo(70), alerted_at: null, detail: { lotId: "2", problem: "cms", reason: "old" } },
      {
        subject: "b-1:manifest:1:2026-10-31:abc", kind: "followup", livemode: false, first_seen_at: isoAgo(20), last_seen_at: isoAgo(10), alerted_at: null,
        detail: { number: "TRP-F1", lotId: "1", manifestDate: "2026-10-31", attempts: 3, reason: "x" },
      },
      { subject: "3:tz", kind: "lot_config", livemode: true, first_seen_at: isoAgo(30), last_seen_at: isoAgo(5), alerted_at: null, detail: { lotId: "3", problem: "tz", reason: "live" } }
    );
    await tick(MORNING);
    expect(postedLines(posted()[0])).toEqual([
      "[TEST] TRP-F1 — the follow-up cancellation for the lot 1 manifest of 2026-10-31 was not confirmed sent after 3 attempts — phone the lot",
      "[TEST] Lot 1 setup problem (tz): bookings disagree",
    ]);
    expect(alertRow("lot_config", "1:tz")?.alerted_at).toEqual(expect.any(String));
    expect(alertRow("lot_config", "2:cms")?.alerted_at).toBeNull();
    expect(mdb.rows(ALERTS).find((r) => r.subject === "3:tz")?.alerted_at).toBeNull();

    await tick("2026-10-31T15:00:00Z"); // 1 h later: not URGENT, waits 6 h
    expect(discord).toHaveBeenCalledTimes(1);
  });

  it("followup: open until resolved while the stay lasts — whatever its last_seen_at — re-alerting every 6 h", async () => {
    vi.setSystemTime(new Date(MORNING));
    // The manifest cron writes a followup row once, when it gives up: last_seen_at goes stale at once.
    mdb.rows(ALERTS).push(
      { subject: "b-1:manifest:1:2026-10-31:abc", kind: "followup", livemode: false, first_seen_at: isoAgo(180), last_seen_at: isoAgo(180), alerted_at: null, detail: { trp: "TRP-F1", manifestDate: "2026-10-31", reason: "no confirmed send after 3 attempts" } },
      // The stay is over: manifest date + 1 < lot-local today (no booking zone here: judged against UTC today − 1).
      { subject: "b-2:manifest:1:2026-10-28:abc", kind: "followup", livemode: false, first_seen_at: isoAgo(3000), last_seen_at: isoAgo(3000), alerted_at: null, detail: { trp: "TRP-F2", manifestDate: "2026-10-28", reason: "x" } },
      // No date to judge by: kept open.
      { subject: "b-3:manifest:1:2026-10-31:abc", kind: "followup", livemode: false, first_seen_at: isoAgo(180), last_seen_at: isoAgo(180), alerted_at: null, detail: { trp: "TRP-F3", reason: "x" } }
    );
    const r = await tick(MORNING);
    expect(r.lines.map((l) => l.text)).toEqual([
      "[TEST] TRP-F1 — the follow-up cancellation for the lot 1 manifest of 2026-10-31 was not confirmed sent — phone the lot",
      "[TEST] TRP-F3 — the follow-up cancellation for the lot 1 manifest of ? was not confirmed sent — phone the lot",
    ]);
    expect(discord).toHaveBeenCalledTimes(1);
    // The followup row is the manifest cron's: only alerted_at is written, its detail is left alone.
    expect(alertRow("followup", "b-1:manifest:1:2026-10-31:abc")).toMatchObject({ alerted_at: new Date(MORNING).toISOString(), detail: { trp: "TRP-F1", manifestDate: "2026-10-31", reason: "no confirmed send after 3 attempts" } });

    await tick(plusMin(MORNING, 5 * 60)); // 5 h: not yet
    expect(discord).toHaveBeenCalledTimes(1);
    await tick(plusMin(MORNING, 6 * 60)); // 6 h: again
    expect(postedLines(posted()[1]).map((l) => l.match(/TRP-\w+/)?.[0])).toEqual(["TRP-F1", "TRP-F3"]);

    Object.assign(alertRow("followup", "b-1:manifest:1:2026-10-31:abc") ?? {}, { resolved_at: isoAgo(1), resolved_by: "tom@triplypro.com" });
    const after = await tick(plusMin(MORNING, 13 * 60));
    expect(after.lines.map((l) => l.text.match(/TRP-\w+/)?.[0])).toEqual(["TRP-F3"]);
  });

  it("6b pass 2: newest first — 200 open-but-expired rows can't starve a current failure out of the read limit", async () => {
    vi.setSystemTime(new Date(MORNING));
    for (let i = 0; i < 200; i++) {
      // Unresolved, but the stay ended Oct 21: closed by the stay filter. Older last_seen_at than the current one.
      mdb.rows(ALERTS).push({
        subject: `old-${i}:manifest:1:2026-10-20:abc`, kind: "followup", livemode: false,
        first_seen_at: isoAgo(16_000 + i), last_seen_at: isoAgo(15_000 + i), alerted_at: isoAgo(15_000 + i),
        detail: { trp: `TRP-OLD${i}`, manifestDate: "2026-10-20", stayEnds: "2026-10-21 10:00:00", reason: "x" },
      });
    }
    mdb.rows(ALERTS).push({
      subject: "now-1:manifest:1:2026-10-31:abc", kind: "followup", livemode: false, first_seen_at: isoAgo(20), last_seen_at: isoAgo(10), alerted_at: null,
      detail: { trp: "TRP-NOW", manifestDate: "2026-10-31", stayEnds: "2026-11-05 10:00:00", reason: "no confirmed send after 3 attempts" },
    });
    const r = await tick(MORNING);
    expect(r.lines.map((l) => l.text.match(/TRP-\w+/)?.[0])).toEqual(["TRP-NOW"]);
  });

  it("a followup whose stay ends with the lot-local day (the booking's zone), not the UTC one", async () => {
    vi.setSystemTime(new Date("2026-11-01T02:30:00Z"));
    const id = "6f2c1a4e-0000-4000-8000-000000000001";
    booking("fz", { id, status: "cancelled", location_timezone: "America/Los_Angeles", lot_snapshot: { timezone: "America/Los_Angeles" } });
    mdb.rows(ALERTS).push({ subject: `${id}:manifest:1:2026-10-30:abc`, kind: "followup", livemode: false, first_seen_at: isoAgo(60), last_seen_at: isoAgo(60), alerted_at: null, detail: { trp: "TRP-FZ", manifestDate: "2026-10-30" } });
    // Nov 1 02:30Z: Oct 31 19:30 in Los Angeles — Oct 30 + 1 is still lot-local "yesterday": open.
    expect((await tick("2026-11-01T02:30:00Z")).lines.map((l) => l.text.match(/TRP-\w+/)?.[0])).toEqual(["TRP-FZ"]);
    // Nov 1 08:00Z: Nov 1 01:00 in Los Angeles — over.
    expect((await tick("2026-11-01T08:00:00Z")).lines).toEqual([]);
  });

  it("a followup stays open until the booking's CHECK-OUT (stayEnds), not just the day after the manifest date", async () => {
    vi.setSystemTime(new Date(MORNING));
    mdb.rows(ALERTS).push(
      // Arrived Oct 28 (manifest date), leaves Nov 5: the lot still holds the space — open.
      { subject: "b-7:manifest:1:2026-10-28:abc", kind: "followup", livemode: false, first_seen_at: isoAgo(3000), last_seen_at: isoAgo(3000), alerted_at: null, detail: { trp: "TRP-LONG", manifestDate: "2026-10-28", stayEnds: "2026-11-05 10:00:00", reason: "x" } },
      // Left Oct 28 (no booking zone here: judged against UTC today − 2, closing late, never early): over.
      { subject: "b-8:manifest:1:2026-10-28:abc", kind: "followup", livemode: false, first_seen_at: isoAgo(3000), last_seen_at: isoAgo(3000), alerted_at: null, detail: { trp: "TRP-SHORT", manifestDate: "2026-10-28", stayEnds: "2026-10-28 18:00:00", reason: "x" } }
    );
    expect((await tick(MORNING)).lines.map((l) => l.text.match(/TRP-\w+/)?.[0])).toEqual(["TRP-LONG"]);
  });
});

// ---------------------------------------------------------------------------
describe("alerted_at is never a silent zero-row write", () => {
  it("an owned row whose record write failed is inserted when its post is accepted", async () => {
    vi.setSystemTime(new Date(MORNING));
    booking("b1", { check_in: "2026-10-31T12:00:00" });
    mdb.failNext(ALERTS, "insert"); // the record upsert
    const r = await tick(MORNING);
    expect(r.status).toBe(500); // the failed record write is counted
    expect(r.posts).toEqual([expect.objectContaining({ outcome: "posted" })]);
    expect(alertRow("lot_notice", "pi_b1")).toMatchObject({ alerted_at: new Date(MORNING).toISOString(), detail: { urgent: true, alertedUrgent: true } });
    await tick(plusMin(MORNING, 10));
    expect(discord).toHaveBeenCalledTimes(1); // recorded: not posted again
  });

  it("a manifest-cron row that vanished before alerted_at was written is reported, not silently skipped", async () => {
    vi.setSystemTime(new Date(MORNING));
    mdb.rows(ALERTS).push({ subject: "1:tz", kind: "lot_config", livemode: false, first_seen_at: isoAgo(30), last_seen_at: isoAgo(5), alerted_at: null, detail: { lotId: "1", problem: "tz", reason: "r" } });
    mdb.beforeMutation = (table, op) => {
      if (table === ALERTS && op === "update") mdb.rows(ALERTS).length = 0;
    };
    const r = await tick(MORNING);
    expect(r.status).toBe(500);
    expect(sentry.fingerprints).toContainEqual(["direct-lot-alerts", "db", "alerted_at missing", "lot_config"]);
  });
});

// ---------------------------------------------------------------------------
describe("starvation", () => {
  it("lot_notice cap: upcoming URGENT check-ins rank before passed ones", async () => {
    vi.setSystemTime(new Date(MORNING));
    for (let i = 0; i < 25; i++) booking(`p${String(i).padStart(2, "0")}`, { check_in: "2026-10-30T08:00:00", check_out: "2026-11-05T10:00:00" });
    booking("soon", { check_in: "2026-10-31T13:00:00" });
    const r = await tick(MORNING);
    expect(r.scans.lot_notice).toMatchObject({ shown: 25, overflow: 1 });
    expect(r.lines[0].text).toContain("TRP-SOON");
  });
});

// ---------------------------------------------------------------------------
describe("failures and dry run", () => {
  it("a failed scan is reported and counted (500); the other scans still post", async () => {
    booking("b1");
    mdb.failNext(RUNS, "select");
    const r = await tick(MORNING);
    expect(r.status).toBe(500);
    expect(r.scans.manifest.ok).toBe(false);
    expect(r.scans.lot_notice.ok).toBe(true);
    expect(postedLines(posted()[0])[0]).toContain("TRP-B1");
    expect(sentry.fingerprints).toContainEqual(["direct-lot-alerts", "scan", "manifest"]);
  });

  it("dry: computes what would be posted, writes, posts and reports nothing", async () => {
    booking("b1", { check_in: "2026-10-31T12:00:00" });
    const r = await tick(MORNING, { dry: true });
    expect(r.messages).toHaveLength(1);
    expect(r.messages?.[0].embed.fields[0].value).toContain("TRP-B1");
    expect(discord).not.toHaveBeenCalled();
    expect(mdb.rows(ALERTS)).toEqual([]);
    expect(mdb.updates).toEqual([]);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("splits only past Discord's limits, every part within them, alerted_at for each accepted part", async () => {
    vi.setSystemTime(new Date(MORNING));
    for (let i = 0; i < 25; i++) booking(`n${String(i).padStart(2, "0")}`, { check_in: "2026-10-31T12:00:00" });
    for (let i = 0; i < 25; i++) booking(`c${String(i).padStart(2, "0")}`, { status: "cancelled", lot_notified_at: "2026-10-30T15:00:00.000Z" });
    for (let i = 0; i < 25; i++) mdb.rows(ALERTS).push({ subject: `${i}:tz`, kind: "lot_config", livemode: false, first_seen_at: isoAgo(90), last_seen_at: isoAgo(5), alerted_at: null, detail: { lotId: String(i), problem: "tz", reason: "z".repeat(250) } });
    booking("extra", { check_in: "2026-10-31T12:30:00" }); // the 26th lot_notice: overflow
    const r = await tick(MORNING);
    expect(r.scans.lot_notice).toMatchObject({ shown: 25, overflow: 1 });
    const bodies = posted();
    expect(bodies.length).toBeGreaterThan(1);
    for (const b of bodies) {
      const e = b.embeds[0];
      const chars = e.title.length + e.description.length + e.footer.text.length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
      expect(chars).toBeLessThanOrEqual(6_000);
      expect(e.fields.length).toBeLessThanOrEqual(25);
      expect(e.fields.every((f) => f.value.length <= 1_024)).toBe(true);
    }
    expect(bodies[0].embeds[0].description).toContain("Not shown this time: Lot notice not confirmed — it may not have arrived +1");
    expect(bodies.flatMap(postedLines)).toHaveLength(50); // 25 URGENT + 25 config (the cancels wait out their grace)
    expect(mdb.rows(ALERTS).filter((a) => a.kind === "lot_notice" && a.alerted_at).length).toBe(25);
  });
});
