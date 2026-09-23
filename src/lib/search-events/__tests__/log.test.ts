import { describe, it, expect, vi, beforeEach } from "vitest";

// after() requires a live Next.js request scope, which vitest doesn't provide.
// Forcing it to throw exercises the same fallback path a real unit test run
// hits anyway — identical pattern to availability/__tests__/log.test.ts.
vi.mock("next/server", () => ({
  after: () => {
    throw new Error("no request scope");
  },
}));

const supabase = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(async () => supabase),
}));

const sentry = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: sentry.captureAPIError }));

import {
  logSearchEvent,
  resolveEnv,
  rowIsInsertable,
  uninsertableReasons,
  sanitizeRow,
  __resetSearchEventsLogWarnStateForTests,
  type SearchEventRow,
} from "../log";
import { createAdminClient } from "@/lib/supabase/server";

const flush = () => new Promise((r) => setTimeout(r, 0));

function row(overrides: Partial<SearchEventRow> = {}): SearchEventRow {
  return {
    search_id: "11111111-1111-1111-1111-111111111111",
    env: "production",
    airport_code: "JFK",
    check_in: "2026-10-01",
    check_out: "2026-10-05",
    stay_days: 4,
    lead_days: 9,
    dates_defaulted: false,
    results_count: 5,
    cheapest_price_cents: 12000,
    sold_out_count: 1,
    degraded: false,
    stale: false,
    source: "search",
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    ga_client_id: null,
    ...overrides,
  };
}

/** A happy-path insert chain that records what was inserted. */
function okInsert() {
  const inserted: unknown[] = [];
  const abortSignal = vi.fn(() => Promise.resolve({ error: null }));
  supabase.from.mockReturnValue({
    insert: (r: unknown) => {
      inserted.push(r);
      return { abortSignal };
    },
  });
  return { inserted, abortSignal };
}

beforeEach(() => {
  __resetSearchEventsLogWarnStateForTests();
  supabase.from.mockReset();
  sentry.captureAPIError.mockClear();
  vi.mocked(createAdminClient).mockClear();
  // vi.spyOn reuses the existing spy (and its call history) once console.warn
  // has already been spied once in this file — clear explicitly rather than
  // vi.restoreAllMocks(), which would also tear down the vi.mock() factories
  // above.
  const warnSpy = vi.spyOn(console, "warn");
  warnSpy.mockClear();
  warnSpy.mockImplementation(() => {});
  delete process.env.NEXT_PHASE;
  delete process.env.SEARCH_EVENTS_LOG_DISABLED;
  delete process.env.NEXT_PUBLIC_APP_ENV;
  delete process.env.VERCEL_ENV;
});

describe("resolveEnv (re-exported from availability/log)", () => {
  it("is the same function availability_log uses, so the two tables can never disagree on 'production'", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "production";
    expect(resolveEnv()).toBe("production");
  });
});

describe("logSearchEvent", () => {
  it("inserts the row with an abort signal, via the after() fallback outside a request scope", async () => {
    const { inserted, abortSignal } = okInsert();
    logSearchEvent(row());
    await flush();

    expect(supabase.from).toHaveBeenCalledWith("search_events");
    expect(inserted).toEqual([row()]);
    expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("never throws when supabase reports a PGRST205 error (table not migrated yet)", async () => {
    supabase.from.mockReturnValue({
      insert: () => ({
        abortSignal: () =>
          Promise.resolve({
            error: { code: "PGRST205", message: 'Could not find the table "search_events"' },
          }),
      }),
    });

    expect(() => logSearchEvent(row())).not.toThrow();
    await flush();

    expect(console.warn).toHaveBeenCalledWith(
      "[search-events] insert failed (further failures reported to Sentry hourly):",
      'PGRST205: Could not find the table "search_events"',
      ""
    );
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("never throws when createAdminClient itself throws (no service-role key)", async () => {
    vi.mocked(createAdminClient).mockImplementationOnce(async () => {
      throw new Error("no service-role key");
    });

    expect(() => logSearchEvent(row())).not.toThrow();
    await flush();

    expect(console.warn).toHaveBeenCalledWith(
      "[search-events] insert failed (further failures reported to Sentry hourly):",
      "no service-role key",
      ""
    );
  });

  it("never throws when the insert rejects outright (network failure)", async () => {
    supabase.from.mockReturnValue({
      insert: () => ({ abortSignal: () => Promise.reject(new Error("network down")) }),
    });

    expect(() => logSearchEvent(row())).not.toThrow();
    await flush();

    expect(console.warn).toHaveBeenCalledWith(
      "[search-events] insert failed (further failures reported to Sentry hourly):",
      "network down",
      ""
    );
  });

  it("is a no-op during next build (NEXT_PHASE=phase-production-build)", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    okInsert();

    logSearchEvent(row());
    await flush();

    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("is a no-op when the kill switch is on", async () => {
    process.env.SEARCH_EVENTS_LOG_DISABLED = "true";
    okInsert();

    logSearchEvent(row());
    await flush();

    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("inserts the sanitized row — an out-of-int4 cheapest price is nulled, the demand row survives", async () => {
    const { inserted } = okInsert();
    logSearchEvent(row({ cheapest_price_cents: 9_999_999_999 }));
    await flush();

    expect(inserted).toEqual([row({ cheapest_price_cents: null })]);
    // Nulling a nullable number is not a failure — nothing is reported.
    expect(sentry.captureAPIError).not.toHaveBeenCalled();
  });

  it("nulls an out-of-int4 sold_out_count rather than dropping the header row", async () => {
    const { inserted } = okInsert();
    logSearchEvent(row({ sold_out_count: Number.NaN }));
    await flush();

    expect(inserted).toEqual([row({ sold_out_count: null })]);
  });

  it("warns to the console at most once per process, but reports to Sentry on every distinct failure within the hourly window collapsed to one call", async () => {
    supabase.from.mockReturnValue({
      insert: () => ({ abortSignal: () => Promise.reject(new Error("still down")) }),
    });

    logSearchEvent(row());
    await flush();
    logSearchEvent(row());
    await flush();

    const consoleCalls = vi
      .mocked(console.warn)
      .mock.calls.filter((c) => c[0] === "[search-events] insert failed (further failures reported to Sentry hourly):");
    expect(consoleCalls).toHaveLength(1);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });
});

describe("insertability gate (migration 027's CHECKs, mirrored)", () => {
  it("accepts an ordinary row", () => {
    expect(uninsertableReasons(row())).toEqual([]);
    expect(rowIsInsertable(row())).toBe(true);
  });

  it("accepts the boundary values both CHECKs allow", () => {
    // stay_days = 0 is a valid same-day (0-night) stay; lead_days = -1 is the
    // documented floor (a search on the day after check-in, across a
    // timezone edge), not an error.
    expect(rowIsInsertable(row({ stay_days: 0, lead_days: -1 }))).toBe(true);
  });

  it.each([
    ["2026-02-30", "a calendar-invalid date the shape regex accepts"],
    ["2026-04-31", "a 31st of a 30-day month"],
    ["2027-02-29", "Feb 29 of a non-leap year"],
  ])("rejects check_in=%s (%s)", (checkIn) => {
    // This is the one /api/search itself cannot catch: it validates
    // /^\d{4}-\d{2}-\d{2}$/ only, and dayDiff happily returns a NUMBER for
    // these (Date.parse rolls them forward), so nothing upstream drops them.
    expect(uninsertableReasons(row({ check_in: checkIn }))).toEqual([
      { column: "check_in", value: checkIn },
    ]);
  });

  it("rejects a reversed range (027's stay_days >= 0)", () => {
    expect(uninsertableReasons(row({ stay_days: -4 }))).toEqual([
      { column: "stay_days", value: "-4" },
    ]);
  });

  it("rejects a long-past check-in (027's lead_days >= -1)", () => {
    expect(uninsertableReasons(row({ lead_days: -45 }))).toEqual([
      { column: "lead_days", value: "-45" },
    ]);
  });

  it("rejects values a Postgres int cannot hold", () => {
    expect(uninsertableReasons(row({ stay_days: 2_147_483_648 }))).toEqual([
      { column: "stay_days", value: "2147483648" },
    ]);
    expect(uninsertableReasons(row({ results_count: Number.NaN }))).toEqual([
      { column: "results_count", value: "NaN" },
    ]);
    expect(uninsertableReasons(row({ stay_days: 1.5 }))).toEqual([
      { column: "stay_days", value: "1.5" },
    ]);
  });

  it("rejects a lowercase airport code (027 CHECK airport_code = upper(airport_code))", () => {
    expect(uninsertableReasons(row({ airport_code: "jfk" }))).toEqual([
      { column: "airport_code", value: "jfk" },
    ]);
  });

  it("reports every failing column at once", () => {
    expect(
      uninsertableReasons(row({ check_out: "2026-13-01", stay_days: -1 })).map(
        (r) => r.column
      )
    ).toEqual(["check_out", "stay_days"]);
  });

  it("truncates the offending value — it is raw caller input", () => {
    const [reason] = uninsertableReasons(row({ check_in: "x".repeat(200) }));
    expect(reason.value).toHaveLength(32);
  });

  it("does not touch the nullable ints — those are sanitized, not dropped", () => {
    // One header row per search: a junk price must cost a number, never the
    // stay/lead-time observation the table exists for.
    expect(rowIsInsertable(row({ cheapest_price_cents: 9_999_999_999 }))).toBe(true);
    expect(sanitizeRow(row({ cheapest_price_cents: 9_999_999_999 }))).toEqual(
      row({ cheapest_price_cents: null })
    );
  });
});

describe("logSearchEvent drop reporting", () => {
  it("never sends an uninsertable row to the DB", async () => {
    okInsert();
    logSearchEvent(row({ check_in: "2026-02-30" }));
    await flush();

    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("reports the drop on its OWN signature, with the values in context and only the columns in the message", async () => {
    okInsert();
    logSearchEvent(row({ check_in: "2026-02-30", lead_days: -45 }));
    await flush();

    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    const [err, ctx] = sentry.captureAPIError.mock.calls[0];
    // Distinct endpoint: an operator watching `search_events.insert` for a
    // dead writer must not see these, and vice versa.
    expect(ctx.endpoint).toBe("search_events.dropped_row");
    // Column names only — Sentry groups a stackless Error by message, and the
    // values are attacker-supplied and unbounded.
    expect(err.message).toBe(
      "search_events: dropped an uninsertable header row (check_in, lead_days)"
    );
    expect(err.message).not.toContain("2026-02-30");
    expect(ctx.extra.reasons).toEqual([
      { column: "check_in", value: "2026-02-30" },
      { column: "lead_days", value: "-45" },
    ]);
    expect(ctx.extra.row.airport_code).toBe("JFK");
    // Attribution fields never ride along — nothing there can cause a drop.
    expect(ctx.extra.row).not.toHaveProperty("ga_client_id");
    expect(ctx.extra.row).not.toHaveProperty("utm_source");
  });

  it("throttles drops to one report per hour, on a clock of their own", async () => {
    okInsert();
    logSearchEvent(row({ check_in: "2026-02-30" }));
    logSearchEvent(row({ check_in: "2026-02-31" }));
    logSearchEvent(row({ stay_days: -2 }));
    await flush();

    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("a burst of drops does NOT consume the insert-failure alert slot", async () => {
    // The whole point of the separate clock: a bot replaying stale URLs must
    // not be able to hide a real PGRST205 / revoked grant for an hour.
    okInsert();
    logSearchEvent(row({ check_in: "2026-02-30" }));
    await flush();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);

    supabase.from.mockReturnValue({
      insert: () => ({
        abortSignal: () =>
          Promise.resolve({ error: { code: "PGRST205", message: "table missing" } }),
      }),
    });
    logSearchEvent(row());
    await flush();

    expect(sentry.captureAPIError).toHaveBeenCalledTimes(2);
    expect(sentry.captureAPIError.mock.calls[1][1].endpoint).toBe("search_events.insert");
  });

  it("does not report a drop during next build or with the kill switch on", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    logSearchEvent(row({ check_in: "2026-02-30" }));
    delete process.env.NEXT_PHASE;

    process.env.SEARCH_EVENTS_LOG_DISABLED = "true";
    logSearchEvent(row({ check_in: "2026-02-30" }));
    await flush();

    expect(sentry.captureAPIError).not.toHaveBeenCalled();
  });

  it("never throws on an uninsertable row", () => {
    okInsert();
    expect(() => logSearchEvent(row({ check_in: "nonsense", stay_days: -9 }))).not.toThrow();
  });
});

describe("the gate itself can never become the failure", () => {
  it("a Sentry outage during a drop does not fall through to the insert-failure alert", async () => {
    sentry.captureAPIError.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    okInsert();

    expect(() => logSearchEvent(row({ check_in: "2026-02-30" }))).not.toThrow();
    await flush();

    // Nothing inserted, and console.warn (warnOnce's one-per-process line)
    // never fired — the drop did not masquerade as an insert failure.
    expect(supabase.from).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("is total — a row with a null-ish airport code is rejected, not thrown on", () => {
    const junk = { ...row(), airport_code: null } as unknown as SearchEventRow;
    expect(() => uninsertableReasons(junk)).not.toThrow();
    expect(uninsertableReasons(junk).map((r) => r.column)).toEqual(["airport_code"]);
  });
});
