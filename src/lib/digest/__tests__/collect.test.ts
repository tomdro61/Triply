import { describe, it, expect, vi, beforeEach } from "vitest";

// The collectors talk to Supabase through the admin client; fake it per test
// with a tiny query recorder that answers by table, in call order. The fake
// also rejects any selected column that the table does not have — the way
// PostgREST answers an unknown column with SQLSTATE 42703 — because a wrong
// column name is exactly the class of bug that makes a section fail every day.
type Answer = { data?: unknown; error?: { code?: string; message: string } | null; count?: number | null };
const answers = vi.hoisted(() => ({
  byTable: new Map<string, Answer[]>(),
  calls: [] as Array<{ table: string; head: boolean; select: string; range: [number, number] | null; eqs: Array<[string, unknown]> }>,
}));
const COLUMNS: Record<string, string[]> = {
  bookings: ["id", "created_at", "status", "check_in", "location_timezone", "reslab_location_id", "stripe_payment_intent_id", "livemode", "customer_id", "airport_code", "promo_code", "discount_amount", "grand_total", "triply_service_fee", "due_at_location", "protection_plan", "protection_plan_price", "protection_plan_wholesale", "channel", "attribution", "customers(email)"],
  pending_bookings: ["stripe_payment_intent_id", "livemode", "status", "last_error", "airport_code", "location_name", "location_id", "created_at", "reslab_reservation_number", "email_sent"],
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
      const eqs: Array<[string, unknown]> = [];
      for (const m of ["select", "eq", "in", "gte", "lt", "like", "not", "order", "limit", "range", "abortSignal"]) {
        chain[m] = (...args: unknown[]) => {
          if (m === "select") {
            select = String(args[0]);
            if (args[1] && (args[1] as { head?: boolean }).head) head = true;
          }
          if (m === "range") range = [Number(args[0]), Number(args[1])];
          if (m === "eq") eqs.push([String(args[0]), args[1]]);
          return chain;
        };
      }
      const resolve = () => {
        answers.calls.push({ table, head, select, range, eqs });
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
    location_timezone: "America/New_York", reslab_location_id: 112, stripe_payment_intent_id: "pi_live1", livemode: true,
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
  it("splits by bookings.livemode itself (NULL = a pre-015 live row); a direct-lot row is classified like any other", () => {
    const rows = [
      booking({ id: "live", stripe_payment_intent_id: "pi_live" }),
      booking({ id: "stag", stripe_payment_intent_id: "pi_test", livemode: false }),
      booking({ id: "nopi", stripe_payment_intent_id: null }),
      booking({ id: "legacy", stripe_payment_intent_id: "pi_old", livemode: null }),
      booking({ id: "testlot", reslab_location_id: 195, stripe_payment_intent_id: "pi_live2" }),
      booking({ id: "staff", customers: { email: "tom@triplypro.com" }, stripe_payment_intent_id: "pi_live3" }),
      booking({ id: "direct", reslab_location_id: null, stripe_payment_intent_id: "pi_direct" }),
      booking({ id: "directsoak", reslab_location_id: null, stripe_payment_intent_id: "pi_direct_test", livemode: false }),
      booking({ id: "devskip", stripe_payment_intent_id: null, livemode: false }),
    ] as never[];
    const p = partitionBookings(rows);
    expect(p.live.map((r) => r.id)).toEqual(["live", "legacy", "staff", "direct"]); // a staff email at a REAL lot is real revenue
    expect(p.staging).toBe(3);
    expect(p.unmatched).toBe(1);
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
        booking({ id: "soak", created_at: "2026-09-22T12:00:00Z", stripe_payment_intent_id: "pi_soak", livemode: false }),
        booking({ id: "tl", created_at: "2026-09-22T12:00:00Z", reslab_location_id: 195, stripe_payment_intent_id: "pi_tl" }),
      ] },
    );
    // pending_bookings query order: lost sales → stuck pendings → unsent confirmation emails
    // (no livemode join any more — bookings.livemode is read directly)
    set("pending_bookings", { data: [] }, { count: 0 }, { data: [] });
    set("customers", { data: [{ id: "c1", email: "ada@example.com" }, { id: "c9", email: "new@example.com" }] });
    set("search_events", { data: [{ airport_code: "JFK", dates_defaulted: false, results_count: 10, sold_out_count: 2, degraded: false }, { airport_code: "JFK", dates_defaulted: true, results_count: 8, sold_out_count: null, degraded: true }] }, { count: 2800 }, { count: 0 });
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
    expect(d.funnel.ok && d.funnel.data.pricedSearches).toBe(1); // NULL sold_out_count excluded from the denominator
    expect(d.funnel.ok && d.funnel.data.degradedCount).toBe(1);
    // 2 sold out but 10 still returned ⇒ NOT "nothing bookable"; lot sold-out rate 2/12
    expect(d.funnel.ok && d.funnel.data.nothingBookableShare).toBe(0);
    expect(d.funnel.ok && d.funnel.data.zeroResultShare).toBe(0);
    expect(d.funnel.ok && d.funnel.data.lotSoldOutRate).toBeCloseTo(2 / 12);
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
    set("pending_bookings", { data: [] }, { count: 0 }, { data: [] });
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
    set("pending_bookings", { data: [] }, { count: 0 }, { data: [] });
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
    set("pending_bookings", { data: [] }, { count: 0 }, { data: [] });
    quietOthers();
    const d = await collectDigest(w, NOW);
    expect(d.bookings.ok && d.bookings.data.count.value).toBe(500);
    // the day's list asked for 501 rows in one range, and livemode came from bookings itself (no pending_bookings join)
    expect(answers.calls.find((c) => c.table === "bookings")?.range).toEqual([0, 500]);
    expect(answers.calls.find((c) => c.table === "bookings")?.select).toMatch(/\blivemode\b/);
    expect(answers.calls.filter((c) => c.table === "pending_bookings" && !c.head && c.select.includes("stripe_payment_intent_id")).length).toBe(0);
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
    set("pending_bookings", { data: [] }, { count: 0 }, { data: [] });
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
    // pending_bookings answers: lost sales → stuck pendings → unsent emails
    set("bookings", { data: [] }, { data: [] });
    set("pending_bookings",
      { data: [
        { status: "released_failed", last_error: "HTTP 422: Validation error for ada@example.com plate ABC1234 [fields: vehicle_make]", airport_code: "BNA", location_name: "Southwestern Airport Parking (BNA)", location_id: 471 },
        { status: "released_failed", last_error: "test", airport_code: "TEST", location_name: "TEST-NY", location_id: 195 },
      ] },
      { count: 0 }, { data: [] });
    quietOthers();
    const d = await collectDigest(w, NOW);
    expect(d.lostSales.ok).toBe(true);
    if (!d.lostSales.ok) return;
    expect(d.lostSales.data.rows).toHaveLength(1);
    expect(d.lostSales.data.rows[0].reason).not.toMatch(/example\.com|ABC1234/);
    expect(d.lostSales.data.rows[0].reason).toMatch(/\[email\]/);
    expect(d.lostSales.data.byStatus).toEqual({ released_failed: 1 });
  });

  it("lost sales: a direct-lot checkout (location_id NULL, TRP- number in the error) is counted, not dropped or crashed on", async () => {
    set("bookings", { data: [] }, { data: [] });
    set("pending_bookings",
      { data: [
        { status: "released_failed", last_error: "capture declined for TRP-7K2M9QXA plate ABC1234", airport_code: "JFK", location_name: "The Parking Point JFK", location_id: null },
        { status: "completed", last_error: null, airport_code: "JFK", location_name: "The Parking Point JFK", location_id: null },
      ] },
      { count: 0 }, { data: [] });
    quietOthers();
    const d = await collectDigest(w, NOW);
    expect(d.lostSales.ok).toBe(true);
    if (!d.lostSales.ok) return;
    expect(d.lostSales.data.byStatus).toEqual({ released_failed: 1, completed: 1 });
    expect(d.lostSales.data.rows).toEqual([{ airport: "JFK", lot: "The Parking Point JFK", status: "released_failed", reason: "capture declined for TRP-7K2M9QXA plate [plate]" }]);
  });

  it("health: completed live checkouts with email_sent=false are listed by number (RTL + TRP), test lots out, odd numbers never printed", async () => {
    set("bookings", { data: [] }, { data: [] });
    set("pending_bookings", { data: [] }, { count: 0 }, { data: [
      { reslab_reservation_number: "RTL854206", location_id: 112 },
      { reslab_reservation_number: "TRP-7K2M9QXA", location_id: null },
      { reslab_reservation_number: "RTL1", location_id: 195 }, // test lot
      { reslab_reservation_number: "ada@example.com", location_id: 112 }, // never printed raw
      { reslab_reservation_number: null, location_id: 112 },
    ] });
    quietOthers();
    const d = await collectDigest(w, NOW);
    expect(d.health.ok && d.health.data.emailNotSent).toEqual({
      kind: "n", n: 4, capped: false, lookbackDays: 7,
      numbers: ["RTL854206", "TRP-7K2M9QXA", "(unrecognised number)", "(no number)"],
    });
    const q = answers.calls.find((c) => c.table === "pending_bookings" && c.select.startsWith("reslab_reservation_number"))!;
    // live mode only, completed only, email not sent — never a staging row in the production digest
    expect(q.eqs).toEqual(expect.arrayContaining([["livemode", true], ["status", "completed"], ["email_sent", false]]));
    expect(q.eqs.find(([k]) => k === "inventory_source")).toBeUndefined(); // both sources
  });

  it("health: the unsent-email query failing is an error state, never 'none'; over the cap is reported as capped", async () => {
    set("bookings", { data: [] }, { data: [] });
    set("pending_bookings", { data: [] }, { count: 0 }, { error: { code: "57014", message: "statement timeout" } });
    quietOthers();
    const d = await collectDigest(w, NOW);
    expect(d.health.ok && d.health.data.emailNotSent).toMatchObject({ kind: "error", message: expect.stringMatching(/57014 statement timeout/) });
    // the rest of health still stands
    expect(d.health.ok && d.health.data.stuckPending).toEqual({ kind: "n", n: 0 });

    answers.byTable.clear();
    set("bookings", { data: [] }, { data: [] });
    set("pending_bookings", { data: [] }, { count: 0 }, { data: Array.from({ length: 51 }, (_, i) => ({ reslab_reservation_number: `RTL9${i}`, location_id: 112 })) });
    quietOthers();
    const d2 = await collectDigest(w, NOW);
    expect(d2.health.ok && d2.health.data.emailNotSent).toMatchObject({ kind: "n", n: 50, capped: true });
  });

  it("funnel: zero-result searches split into outcome, sell-out attribution, and degraded", async () => {
    set("bookings", { data: [] }, { data: [] });
    quietOthers(); // first — it resets search_events
    set("search_events", { data: [
      { airport_code: "EWR", dates_defaulted: false, results_count: 0, sold_out_count: 3, degraded: false }, // sold out
      { airport_code: "EWR", dates_defaulted: false, results_count: 0, sold_out_count: 2, degraded: true },  // degraded: not inventory
      { airport_code: "EWR", dates_defaulted: false, results_count: 0, sold_out_count: 0, degraded: false }, // the $0.00 swallow: no lot, none sold out
      { airport_code: "EWR", dates_defaulted: false, results_count: 5, sold_out_count: 1, degraded: false },
      { airport_code: "EWR", dates_defaulted: false, results_count: 0, sold_out_count: null, degraded: true }, // not priced
    ] }, { count: 0 }, { count: 0 });
    const d = await collectDigest(w, NOW);
    expect(d.funnel.ok).toBe(true);
    if (!d.funnel.ok) return;
    expect(d.funnel.data.pricedSearches).toBe(4);
    expect(d.funnel.data.zeroResultShare).toBe(3 / 4);
    expect(d.funnel.data.nothingBookableShare).toBe(1 / 4);
    expect(d.funnel.data.nothingBookableDegraded).toBe(1);
    expect(d.funnel.data.lotSoldOutRate).toBeCloseTo(6 / 11);
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
