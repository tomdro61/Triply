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
