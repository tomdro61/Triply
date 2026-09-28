import { describe, it, expect, vi, beforeEach } from "vitest";

// The collectors talk to Supabase through the admin client; fake it per test
// with a tiny query recorder that answers by table, in call order. The fake
// also rejects any selected column that the table does not have — the way
// PostgREST answers an unknown column with SQLSTATE 42703 — because a wrong
// column name is exactly the class of bug that makes a section fail every day.
type Answer = { data?: unknown; error?: { code?: string; message: string } | null; count?: number | null };
const answers = vi.hoisted(() => ({
  byTable: new Map<string, Answer[]>(),
  calls: [] as Array<{ table: string; head: boolean; select: string; range: [number, number] | null }>,
}));
const COLUMNS: Record<string, string[]> = {
  bookings: ["id", "created_at", "status", "check_in", "location_timezone", "reslab_location_id", "stripe_payment_intent_id", "customer_id", "airport_code", "promo_code", "discount_amount", "grand_total", "triply_service_fee", "due_at_location", "protection_plan", "protection_plan_price", "protection_plan_wholesale", "channel", "attribution", "customers(email)"],
  pending_bookings: ["stripe_payment_intent_id", "livemode", "status", "last_error", "airport_code", "location_name", "location_id", "created_at"],
  customers: ["id", "email"],
  search_events: ["id", "airport_code", "dates_defaulted", "results_count", "sold_out_count", "degraded"],
  newsletter_subscribers: ["source"],
  booking_waitlist: ["airport_code"],
  chat_sessions: ["id"],
  promo_codes: ["id"],
  search_events_writer_health: ["env", "source", "last_row_at", "rows_24h"],
  digest_runs: ["digest_date", "outcome", "posted_at"],
};
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const chain: Record<string, unknown> = {};
      let head = false;
      let select = "";
      let range: [number, number] | null = null;
      for (const m of ["select", "eq", "in", "gte", "lt", "like", "not", "order", "limit", "range", "abortSignal"]) {
        chain[m] = (...args: unknown[]) => {
          if (m === "select") {
            select = String(args[0]);
            if (args[1] && (args[1] as { head?: boolean }).head) head = true;
          }
          if (m === "range") range = [Number(args[0]), Number(args[1])];
          return chain;
        };
      }
      const resolve = () => {
        answers.calls.push({ table, head, select, range });
        const unknown = select.split(",").map((c) => c.trim()).filter((c) => c && !(COLUMNS[table] ?? []).includes(c));
        if (unknown.length) return { data: null, error: { code: "42703", message: `column ${table}.${unknown[0]} does not exist` }, count: null };
        const q = answers.byTable.get(table) ?? [];
        const a = q.length > 1 ? q.shift()! : q[0] ?? { data: [], error: null, count: 0 };
        // honour the requested page size, as PostgREST would (a queued answer longer than the range is cut)
        const data = Array.isArray(a.data) && range ? a.data.slice(0, range[1] - range[0] + 1) : a.data ?? null;
        return { data, error: a.error ?? null, count: a.count ?? null };
      };
      // maybeSingle answers one row or null, never an array (a queued `data: []` means "no row").
      chain.maybeSingle = async () => { const r = resolve(); return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }; };
      chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(res, rej);
      return chain;
    },
  }),
  createClient: vi.fn(),
}));
vi.mock("@/lib/reslab/location-snapshot", () => ({
  isSnapshotEnabled: () => false,
  readSnapshotMeta: vi.fn(),
  SNAPSHOT_WARN_MS: 10 * 3_600_000,
  SNAPSHOT_MAX_AGE_MS: 24 * 3_600_000,
}));

import { partitionBookings, leadDays, collectDigest, SINCE } from "../collect";
import { windowForEtDay } from "../window";

const set = (table: string, ...a: Answer[]) => answers.byTable.set(table, a);
const NOW = new Date("2026-09-28T13:05:00Z");

function booking(over: Record<string, unknown> = {}) {
  return {
    id: "b1", created_at: "2026-09-27T15:00:00Z", status: "confirmed", check_in: "2026-09-29T10:00:00",
    location_timezone: "America/New_York", reslab_location_id: 112, stripe_payment_intent_id: "pi_live1",
    customer_id: "c1", airport_code: "EWR", promo_code: null, discount_amount: "0", grand_total: "65.38",
    triply_service_fee: "5.95", due_at_location: "0", protection_plan: null, protection_plan_price: null,
    protection_plan_wholesale: null, channel: "organic_search",
    attribution: { v: 1, first: { src: "google.com", ref: "google.com", land: "/blog/newark-parking" } },
    customers: { email: "Ada@Example.com" },
    ...over,
  };
}

/** The other sections' minimum answers so a bookings-focused test does not trip on them. */
function quietOthers() {
  set("search_events", { data: [] }, { count: 0 }, { count: 0 });
  set("search_events_writer_health", { data: [{ env: "production", source: "search", last_row_at: "2026-09-28T03:58:00Z", rows_24h: 500 }] });
  set("digest_runs", { data: { digest_date: "2026-09-26" } });
}

beforeEach(() => {
  answers.byTable.clear();
  answers.calls.length = 0;
});

describe("partitionBookings — test lots out, staging out, unmatched counted (never silently in or out)", () => {
  it("splits by the pending_bookings livemode map", () => {
    const rows = [
      booking({ id: "live", stripe_payment_intent_id: "pi_live" }),
      booking({ id: "stag", stripe_payment_intent_id: "pi_test" }),
      booking({ id: "nopi", stripe_payment_intent_id: null }),
      booking({ id: "nopending", stripe_payment_intent_id: "pi_unknown" }),
      booking({ id: "testlot", reslab_location_id: 195, stripe_payment_intent_id: "pi_live2" }),
      booking({ id: "staff", customers: { email: "tom@triplypro.com" }, stripe_payment_intent_id: "pi_live3" }),
    ] as never[];
    const lm = new Map([["pi_live", true], ["pi_test", false], ["pi_live2", true], ["pi_live3", true]]);
    const p = partitionBookings(rows, lm);
    expect(p.live.map((r) => r.id)).toEqual(["live", "staff"]); // a staff email at a REAL lot is real revenue
    expect(p.staging).toBe(1);
    expect(p.unmatched).toBe(2);
  });
});

describe("leadDays — calendar days from a wall-clock check-in string, in the lot's zone", () => {
  it("uses the date prefix only; a 23:00-local booking for tomorrow is 1 day, not 0 or 2", () => {
    // 03:30 UTC Sept 28 = 23:30 ET Sept 27; check-in Sept 28 ⇒ 1 day
    expect(leadDays("2026-09-28T06:00:00", "2026-09-28T03:30:00Z", "America/New_York")).toBe(1);
    // same instant, a Pacific lot: 20:30 PT Sept 27 ⇒ still 1 day
    expect(leadDays("2026-09-28T06:00:00", "2026-09-28T03:30:00Z", "America/Los_Angeles")).toBe(1);
    expect(leadDays("2026-09-27T23:00:00", "2026-09-27T15:00:00Z", "America/New_York")).toBe(0);
  });
  it("NULL timezone or a malformed check-in ⇒ null (the 'unknown' bucket), never a default zone", () => {
    expect(leadDays("2026-09-28T06:00:00", "2026-09-28T03:30:00Z", null)).toBeNull();
    expect(leadDays("garbage", "2026-09-28T03:30:00Z", "America/New_York")).toBeNull();
  });
});

describe("collectDigest — sections, baselines, isolation", () => {
  const w = windowForEtDay("2026-09-27");

  it("a clean day: bookings counted, fee income summed, repeat detected by email, baselines livemode-joined", async () => {
    // bookings query order: day's list → ONE repeat lookup (prior confirmed rows for every candidate id) → 28-day baseline rows
    set("bookings",
      { data: [booking(), booking({ id: "b2", stripe_payment_intent_id: "pi_live2", protection_plan: "A", protection_plan_price: "12.99", protection_plan_wholesale: "6", customers: { email: "new@example.com" } })] },
      { data: [{ customer_id: "c1" }, { customer_id: "c1" }] }, // ada has booked before; new has not
      // 28-day baseline rows: 35 live confirmed in the last 7 days, +1 staging soak (excluded), +1 test-lot row (excluded)
      { data: [
        ...Array.from({ length: 35 }, (_, i) => booking({ id: `p${i}`, created_at: `2026-09-2${(i % 7)}T12:00:00Z`, stripe_payment_intent_id: `pi_p${i}` })),
        booking({ id: "soak", created_at: "2026-09-22T12:00:00Z", stripe_payment_intent_id: "pi_soak" }),
        booking({ id: "tl", created_at: "2026-09-22T12:00:00Z", reslab_location_id: 195, stripe_payment_intent_id: "pi_tl" }),
      ] },
    );
    // pending_bookings query order: day's livemode join → baseline livemode join → lost sales → stuck pendings
    set("pending_bookings",
      { data: [{ stripe_payment_intent_id: "pi_live1", livemode: true }, { stripe_payment_intent_id: "pi_live2", livemode: true }] },
      { data: [...Array.from({ length: 35 }, (_, i) => ({ stripe_payment_intent_id: `pi_p${i}`, livemode: true })), { stripe_payment_intent_id: "pi_soak", livemode: false }, { stripe_payment_intent_id: "pi_tl", livemode: true }] },
      { data: [] },
      { count: 0 },
    );
    set("customers", { data: [{ id: "c1", email: "ada@example.com" }, { id: "c9", email: "new@example.com" }] });
    set("search_events", { data: [{ airport_code: "JFK", dates_defaulted: false, results_count: 10, sold_out_count: 0, degraded: false }, { airport_code: "JFK", dates_defaulted: true, results_count: 8, sold_out_count: null, degraded: true }] }, { count: 2800 }, { count: 0 });
    set("newsletter_subscribers", { data: [{ source: "blog" }] });
    set("booking_waitlist", { data: [] });
    set("chat_sessions", { count: 3 });
    set("promo_codes", { count: 1 });
    set("search_events_writer_health", { data: [{ env: "production", source: "search", last_row_at: "2026-09-28T03:58:00Z", rows_24h: 500 }, { env: "preview", source: "search", last_row_at: "2026-09-28T12:58:00Z", rows_24h: 9 }] });
    set("digest_runs", { data: { digest_date: "2026-09-26" } });

    const d = await collectDigest(w, NOW);
    expect(d.bookings.ok).toBe(true);
    if (!d.bookings.ok) return;
    const b = d.bookings.data;
    expect(b.count.value).toBe(2);
    expect(b.count.avg7).toBe(5); // 35 live confirmed / 7 — the soak and the test lot did NOT count
    expect(b.count.avg28).toBe(35 / 28);
    expect(b.count.baselineError).toBeUndefined();
    expect(b.count.since).toBe(SINCE.bookings);
    expect(b.gmv).toBe(Math.round((65.38 + 5.95 + 65.38 + 5.95 + 12.99) * 100) / 100);
    expect(b.serviceFees).toBe(11.9);
    expect(b.pgMargin).toBe(6.99);
    expect(b.feeIncome).toBe(18.89);
    expect(b.pgAttachRate).toBe(0.5);
    expect(b.repeatByEmail).toBe(1);
    expect(b.leadTime).toEqual({ sameDay: 0, d1to3: 2, d4to14: 0, d15plus: 0, unknown: 0 });
    expect(b.unpricedRows).toBe(0);
    expect(b.repeatError).toBeUndefined();
    expect(d.health.ok && d.health.data.stuckPending).toEqual({ kind: "n", n: 0 });
    expect(d.whereFrom.ok && d.whereFrom.data.landing.blog).toBe(2);
    expect(d.whereFrom.ok && d.whereFrom.data.topBlogPosts).toEqual([{ path: "/blog/newark-parking", bookings: 2 }]);
    expect(d.funnel.ok && d.funnel.data.soldOutDenominator).toBe(1); // NULL sold_out_count excluded from the denominator
    expect(d.funnel.ok && d.funnel.data.degradedCount).toBe(1);
    // telemetry: production rows only — the fresher preview row must not vouch for production
    expect(d.health.ok && d.health.data.telemetry).toEqual({ kind: "ok", lastRowAt: "2026-09-28T03:58:00Z", rows24h: 500 });
    expect(d.health.ok && d.health.data.lastDigest).toEqual({ kind: "days", n: 1 });
    // the repeat lookup was ONE query, not one per email
    expect(answers.calls.filter((c) => c.table === "bookings" && c.select === "customer_id").length).toBe(1);
    // and every select named only real columns (the fake would have failed otherwise)
    expect(answers.calls.some((c) => c.table === "pending_bookings" && c.select.includes("location_id"))).toBe(true);
  });

  it("a NULL money column makes GMV 'unavailable', never a silently shorter total", async () => {
    // no customers row ⇒ no repeat head count ⇒ bookings answers: list → baseline rows
    set("bookings", { data: [booking({ triply_service_fee: null })] }, { data: [] });
    set("pending_bookings", { data: [{ stripe_payment_intent_id: "pi_live1", livemode: true }] }, { data: [] }, { count: 0 });
    set("customers", { data: [] });
    quietOthers();
    const d = await collectDigest(w, NOW);
    expect(d.bookings.ok && d.bookings.data.gmv).toBe("unavailable");
    expect(d.bookings.ok && d.bookings.data.serviceFees).toBe("unavailable");
    expect(d.bookings.ok && d.bookings.data.count.value).toBe(1);
    expect(d.bookings.ok && d.bookings.data.unpricedRows).toBe(1);
  });

  it("the repeat-customer lookup failing does not take the day's numbers down", async () => {
    set("bookings", { data: [booking()] }, { error: { code: "57014", message: "statement timeout" } }, { data: [] });
    set("pending_bookings", { data: [{ stripe_payment_intent_id: "pi_live1", livemode: true }] }, { data: [] }, { count: 0 });
    set("customers", { data: [{ id: "c1", email: "ada@example.com" }] });
    quietOthers();
    const d = await collectDigest(w, NOW);
    expect(d.bookings.ok).toBe(true);
    if (!d.bookings.ok) return;
    expect(d.bookings.data.count.value).toBe(1);
    expect(d.bookings.data.repeatByEmail).toBe("unavailable");
    expect(d.bookings.data.repeatError).toMatch(/statement timeout/);
  });

  it("a fetch that fills a whole PostgREST page keeps paging, so a cap above 1,000 is reachable", async () => {
    // the day's bookings: three full pages of 1,000 then a 4th page — 3,001 > cap 500 is detected on page 1,
    // but the funnel (cap 4,000) must page: 1,000 + 1,000 + 1,000 + 1,000 + 1 rows
    const ev = (i: number) => ({ airport_code: `A${i % 3}`, dates_defaulted: false, results_count: 5, sold_out_count: 0, degraded: false });
    set("search_events",
      { data: Array.from({ length: 1000 }, (_, i) => ev(i)) },
      { data: Array.from({ length: 1000 }, (_, i) => ev(i)) },
      { data: Array.from({ length: 1000 }, (_, i) => ev(i)) },
      { data: Array.from({ length: 1000 }, (_, i) => ev(i)) },
      { data: [ev(0)] },
      { count: 0 }, { count: 0 });
    set("bookings", { data: [] }, { data: [] });
    set("search_events_writer_health", { data: [] });
    const d = await collectDigest(w, NOW);
    expect(d.funnel).toMatchObject({ ok: false, error: "row cap hit" });
    const ranges = answers.calls.filter((c) => c.table === "search_events" && !c.head).map((c) => c.range);
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999], [3000, 3999], [4000, 4000]]); // cap + 1 rows in total
  });

  it("exactly cap rows is NOT capped (all aggregated); cap + 1 is", async () => {
    set("bookings", { data: Array.from({ length: 500 }, (_, i) => booking({ id: `b${i}`, stripe_payment_intent_id: `pi_${i}`, customers: null })) }, { data: [] });
    set("pending_bookings", { data: Array.from({ length: 500 }, (_, i) => ({ stripe_payment_intent_id: `pi_${i}`, livemode: true })) }, { data: [] }, { count: 0 });
    quietOthers();
    const d = await collectDigest(w, NOW);
    expect(d.bookings.ok && d.bookings.data.count.value).toBe(500);
    // the day's list asked for 501 rows in one range, and the livemode join was chunked into 200s
    expect(answers.calls.find((c) => c.table === "bookings")?.range).toEqual([0, 500]);
    expect(answers.calls.filter((c) => c.table === "pending_bookings" && c.select.includes("livemode")).length).toBe(3);
  });

  it("a head count with no content-range header is an error, never a zero", async () => {
    set("bookings", { data: [] }, { data: [] });
    set("pending_bookings", { data: [] }, { count: null });
    set("chat_sessions", { count: null });
    quietOthers();
    const d = await collectDigest(w, NOW);
    expect(d.health.ok && d.health.data.stuckPending).toMatchObject({ kind: "error", message: expect.stringMatching(/count missing/) });
    expect(d.engagement).toMatchObject({ ok: false, error: expect.stringMatching(/chat_sessions: count missing/) });
  });

  it("a baseline whose window predates the data renders n/a and never divides by 28", async () => {
    set("bookings", { data: [] }, { data: [] });
    set("search_events", { data: [] }, { count: 0 }, { count: 0 });
    set("search_events_writer_health", { data: [] });
    const d = await collectDigest(w, NOW);
    // search_events data starts 2026-09-24: a 7-day window from Sept 20 is not covered ⇒ null
    expect(d.funnel.ok && d.funnel.data.originSearches.avg7).toBeNull();
    expect(d.funnel.ok && d.funnel.data.originSearches.avg28).toBeNull();
    // a bookings 7-day window is covered (data since Feb) ⇒ a number
    expect(d.bookings.ok && d.bookings.data.count.avg7).toBe(0);
    // zero rows from the 7-day writer-health view is the LOUD state
    expect(d.health.ok && d.health.data.telemetry.kind).toBe("silent_7d");
    // and a digest_runs table with no earlier row is "none", distinct from an error
    expect(d.health.ok && d.health.data.lastDigest).toEqual({ kind: "none" });
  });

  it("a baseline query failing keeps the day's numbers and reports the baseline as unavailable", async () => {
    set("bookings", { data: [booking()] }, { error: { code: "57014", message: "statement timeout" } });
    set("pending_bookings", { data: [{ stripe_payment_intent_id: "pi_live1", livemode: true }] }, { data: [] }, { count: 0 });
    set("customers", { data: [] });
    quietOthers();
    const d = await collectDigest(w, NOW);
    expect(d.bookings.ok).toBe(true);
    if (!d.bookings.ok) return;
    expect(d.bookings.data.count.value).toBe(1);
    expect(d.bookings.data.count.avg7).toBeNull();
    expect(d.bookings.data.count.baselineError).toMatch(/statement timeout/);
  });

  it("one failing table isolates to its section; bookings failing does not take the others down", async () => {
    set("bookings", { error: { code: "PGRST205", message: "table not found" } });
    set("search_events", { data: [] }, { count: 0 }, { count: 0 });
    set("search_events_writer_health", { data: [] });
    const d = await collectDigest(w, NOW);
    expect(d.bookings).toMatchObject({ ok: false, error: expect.stringMatching(/PGRST205/) });
    expect(d.whereFrom.ok).toBe(false); // derived from bookings
    expect(d.funnel.ok).toBe(true);
    expect(d.engagement.ok).toBe(true);
  });

  it("a row cap hit is 'unavailable', never a truncated aggregate — in every capped section", async () => {
    set("bookings", { data: Array.from({ length: 501 }, (_, i) => booking({ id: `b${i}`, stripe_payment_intent_id: `pi_${i}` })) });
    set("newsletter_subscribers", { data: Array.from({ length: 1001 }, () => ({ source: "bot" })) });
    quietOthers();
    const d = await collectDigest(w, NOW);
    expect(d.bookings).toMatchObject({ ok: false, error: "row cap hit" });
    expect(d.engagement).toMatchObject({ ok: false, error: "row cap hit" });
  });

  it("lost sales: redacted before they leave the collector, test lots excluded, lot column is location_id", async () => {
    // an empty day ⇒ no livemode join queries ⇒ pending_bookings answers: lost sales → stuck pendings
    set("bookings", { data: [] }, { data: [] });
    set("pending_bookings",
      { data: [
        { status: "released_failed", last_error: "HTTP 422: Validation error for ada@example.com plate ABC1234 [fields: vehicle_make]", airport_code: "BNA", location_name: "Southwestern Airport Parking (BNA)", location_id: 471 },
        { status: "released_failed", last_error: "test", airport_code: "TEST", location_name: "TEST-NY", location_id: 195 },
      ] },
      { count: 0 });
    quietOthers();
    const d = await collectDigest(w, NOW);
    expect(d.lostSales.ok).toBe(true);
    if (!d.lostSales.ok) return;
    expect(d.lostSales.data.rows).toHaveLength(1);
    expect(d.lostSales.data.rows[0].reason).not.toMatch(/example\.com|ABC1234/);
    expect(d.lostSales.data.rows[0].reason).toMatch(/\[email\]/);
    expect(d.lostSales.data.byStatus).toEqual({ released_failed: 1 });
  });

  it("health: a production writer with rows in the 7-day view but none in 26 h is STALE, not ok", async () => {
    set("bookings", { data: [] }, { data: [] });
    set("search_events", { data: [] }, { count: 0 }, { count: 0 });
    set("search_events_writer_health", { data: [{ env: "production", source: "search", last_row_at: "2026-09-25T03:58:00Z", rows_24h: 0 }] });
    set("digest_runs", { error: { code: "PGRST205", message: "relation digest_runs does not exist" } });
    const d = await collectDigest(w, NOW);
    expect(d.health.ok && d.health.data.telemetry).toEqual({ kind: "stale", lastRowAt: "2026-09-25T03:58:00Z", rows24h: 0 });
    // and a run-log read error is an ERROR state, never "no earlier digest"
    expect(d.health.ok && d.health.data.lastDigest).toMatchObject({ kind: "error", message: expect.stringMatching(/PGRST205/) });
  });

  it("every shipped select names only real columns (the fake mirrors PostgREST 42703 for anything else)", async () => {
    set("bookings", { data: [] }, { data: [] });
    quietOthers();
    const d = await collectDigest(w, NOW);
    for (const s of ["bookings", "funnel", "lostSales", "engagement", "health"] as const) {
      expect(d[s].ok, `${s}: ${JSON.stringify(d[s])}`).toBe(true);
    }
  });
});
