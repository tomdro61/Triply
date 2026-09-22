import { describe, it, expect, vi, beforeEach } from "vitest";

// after() requires a live Next.js request scope, which vitest doesn't provide.
// Forcing it to throw exercises the same fallback path a real unit test run
// hits anyway, and keeps the test deterministic instead of depending on
// whatever next/server does outside a request.
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
  logAvailability,
  dayDiff,
  localToday,
  resolveEnv,
  rowIsInsertable,
  __resetAvailabilityLogWarnStateForTests,
  type AvailabilityRow,
} from "../log";
import { createAdminClient } from "@/lib/supabase/server";

const flush = () => new Promise((r) => setTimeout(r, 0));

function row(overrides: Partial<AvailabilityRow> = {}): AvailabilityRow {
  return {
    airport_code: "JFK",
    check_in: "2026-10-01",
    check_out: "2026-10-05",
    lead_days: 9,
    stay_days: 4,
    reslab_location_id: 1,
    sold_out: false,
    available_spots: 10,
    grand_total_cents: 1000,
    source: "search",
    ...overrides,
  };
}

/** A happy-path insert chain that records what was inserted. */
function okInsert() {
  const inserted: unknown[][] = [];
  const abortSignal = vi.fn(() => Promise.resolve({ error: null }));
  supabase.from.mockReturnValue({
    insert: (rows: unknown[]) => {
      inserted.push(rows);
      return { abortSignal };
    },
  });
  return { inserted, abortSignal };
}

beforeEach(() => {
  __resetAvailabilityLogWarnStateForTests();
  supabase.from.mockReset();
  sentry.captureAPIError.mockClear();
  vi.mocked(createAdminClient).mockClear();
  delete process.env.NEXT_PHASE;
  delete process.env.AVAILABILITY_LOG_DISABLED;
  delete process.env.NEXT_PUBLIC_APP_ENV;
  delete process.env.VERCEL_ENV;
});

describe("dayDiff", () => {
  it("counts whole days between two dates", () => {
    expect(dayDiff("2026-01-01", "2026-01-10")).toBe(9);
  });

  it("is negative for a reversed range", () => {
    expect(dayDiff("2026-01-10", "2026-01-01")).toBe(-9);
  });

  it("returns null rather than a fabricated 0 on an unparseable input", () => {
    expect(dayDiff("not-a-date", "2026-01-01")).toBeNull();
    expect(dayDiff("2026-01-01", "also-not-a-date")).toBeNull();
    // Non-zero-padded dates are accepted by Postgres but not by Date.parse —
    // the caller must skip the row, never store lead_days = 0.
    expect(dayDiff("2026-10-1", "2026-10-05")).toBeNull();
  });
});

describe("localToday", () => {
  it("returns a YYYY-MM-DD string for a valid IANA zone", () => {
    expect(localToday("America/New_York")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("falls back to UTC instead of throwing on an invalid zone", () => {
    expect(() => localToday("Not/AZone")).not.toThrow();
    expect(localToday("Not/AZone")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("resolveEnv", () => {
  it("prefers NEXT_PUBLIC_APP_ENV", () => {
    process.env.NEXT_PUBLIC_APP_ENV = "staging";
    process.env.VERCEL_ENV = "production";
    expect(resolveEnv()).toBe("staging");
  });

  it("falls back to VERCEL_ENV so a missing project var cannot tag production rows 'unknown'", () => {
    process.env.VERCEL_ENV = "production";
    expect(resolveEnv()).toBe("production");
    process.env.VERCEL_ENV = "preview";
    expect(resolveEnv()).toBe("preview");
  });

  it("is 'unknown' when neither is set or VERCEL_ENV is unrecognised", () => {
    expect(resolveEnv()).toBe("unknown");
    process.env.VERCEL_ENV = "something-else";
    expect(resolveEnv()).toBe("unknown");
  });
});

describe("rowIsInsertable — mirrors the 025 CHECK constraints", () => {
  it("accepts a normal row and the -1 boundary", () => {
    expect(rowIsInsertable(row())).toBe(true);
    expect(rowIsInsertable(row({ lead_days: -1, stay_days: 0 }))).toBe(true);
  });

  it("rejects rows Postgres would reject, so one bad row cannot sink the batch", () => {
    expect(rowIsInsertable(row({ lead_days: -2 }))).toBe(false);
    expect(rowIsInsertable(row({ stay_days: -1 }))).toBe(false);
    expect(rowIsInsertable(row({ lead_days: Number.NaN }))).toBe(false);
    expect(rowIsInsertable(row({ check_in: "2026-10-1" }))).toBe(false);
    expect(rowIsInsertable(row({ check_out: "" }))).toBe(false);
    expect(rowIsInsertable(row({ reslab_location_id: 1.5 }))).toBe(false);
  });
});

describe("logAvailability — happy path", () => {
  it("inserts every row with the env tag and one shared search_id", async () => {
    process.env.NEXT_PUBLIC_APP_ENV = "production";
    const { inserted, abortSignal } = okInsert();

    logAvailability([row({ reslab_location_id: 1 }), row({ reslab_location_id: 2, sold_out: null })]);
    await flush();

    expect(supabase.from).toHaveBeenCalledWith("availability_log");
    expect(abortSignal).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
    const rows = inserted[0] as Array<AvailabilityRow & { env: string; search_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.env === "production")).toBe(true);
    expect(rows[0].search_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[1].search_id).toBe(rows[0].search_id);
    // A null sold_out (unpriced lot) is an observation, not dropped.
    expect(rows[1].sold_out).toBeNull();
    expect(sentry.captureAPIError).not.toHaveBeenCalled();
  });

  it("drops only the rows that would violate a CHECK and inserts the rest", async () => {
    const { inserted } = okInsert();

    logAvailability([row({ reslab_location_id: 1 }), row({ reslab_location_id: 2, lead_days: -30 })]);
    await flush();

    const rows = inserted[0] as AvailabilityRow[];
    expect(rows.map((r) => r.reslab_location_id)).toEqual([1]);
  });

  it("does not insert at all when every row is uninsertable", async () => {
    okInsert();
    logAvailability([row({ lead_days: -30 })]);
    await flush();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("logAvailability — never-throw contract", () => {
  it("is a no-op during `next build`", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    expect(() => logAvailability([row()])).not.toThrow();
    await flush();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it.each(["1", "true", "TRUE", "yes"])("is a no-op when the kill switch is %s", async (v) => {
    process.env.AVAILABILITY_LOG_DISABLED = v;
    expect(() => logAvailability([row()])).not.toThrow();
    await flush();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("still logs when the kill switch is set to something that is not a yes", async () => {
    process.env.AVAILABILITY_LOG_DISABLED = "0";
    okInsert();
    logAvailability([row()]);
    await flush();
    expect(supabase.from).toHaveBeenCalled();
  });

  it("resolves without throwing when the supabase client itself throws", async () => {
    vi.mocked(createAdminClient).mockImplementationOnce(async () => {
      throw new Error("no service-role key");
    });
    expect(() => logAvailability([row()])).not.toThrow();
    await flush();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("resolves without throwing when the insert rejects", async () => {
    const abortSignal = vi.fn(() => Promise.reject(new Error("network down")));
    supabase.from.mockReturnValue({ insert: () => ({ abortSignal }) });

    expect(() => logAvailability([row()])).not.toThrow();
    await flush();
    expect(abortSignal).toHaveBeenCalled();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("keeps the PostgREST code in the Sentry event when supabase reports an error object", async () => {
    const abortSignal = vi.fn(() =>
      Promise.resolve({
        error: {
          code: "PGRST205",
          message: "Could not find the table 'public.availability_log' in the schema cache",
        },
      })
    );
    supabase.from.mockReturnValue({ insert: () => ({ abortSignal }) });

    expect(() => logAvailability([row()])).not.toThrow();
    await flush();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    const [err] = sentry.captureAPIError.mock.calls[0] as [Error];
    expect(err.message).toMatch(/^PGRST205: Could not find the table/);
  });

  it("reports to Sentry at most once per process-hour even across repeated failures", async () => {
    const abortSignal = vi.fn(() => Promise.resolve({ error: { message: "boom" } }));
    supabase.from.mockReturnValue({ insert: () => ({ abortSignal }) });

    logAvailability([row()]);
    await flush();
    logAvailability([row()]);
    await flush();

    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("does not throw when its own prelude throws (from() itself throwing)", async () => {
    supabase.from.mockImplementation(() => {
      throw new Error("client exploded synchronously");
    });
    expect(() => logAvailability([row()])).not.toThrow();
    await flush();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty batch", async () => {
    expect(() => logAvailability([])).not.toThrow();
    await flush();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
