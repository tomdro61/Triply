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
  uninsertableReasons,
  sanitizeRow,
  isRealDate,
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

describe("isRealDate", () => {
  it("accepts real calendar dates only", () => {
    expect(isRealDate("2026-02-28")).toBe(true);
    expect(isRealDate("2028-02-29")).toBe(true); // leap year
    // Shape-valid but calendar-invalid: Date.parse rolls these forward,
    // Postgres rejects them (22008) and would sink the whole batch.
    expect(isRealDate("2026-02-30")).toBe(false);
    expect(isRealDate("2026-04-31")).toBe(false);
    expect(isRealDate("2027-02-29")).toBe(false);
    expect(isRealDate("2026-10-1")).toBe(false);
    expect(isRealDate("")).toBe(false);
  });
});

describe("rowIsInsertable — mirrors the 025 CHECK constraints and column types", () => {
  it("accepts a normal row, the -1 boundary, and null ints", () => {
    expect(rowIsInsertable(row())).toBe(true);
    expect(rowIsInsertable(row({ lead_days: -1, stay_days: 0 }))).toBe(true);
    expect(rowIsInsertable(row({ available_spots: null, grand_total_cents: null }))).toBe(true);
  });

  it("rejects rows Postgres would reject, so one bad row cannot sink the batch — and says why", () => {
    expect(rowIsInsertable(row({ lead_days: -2 }))).toBe(false);
    expect(rowIsInsertable(row({ stay_days: -1 }))).toBe(false);
    expect(rowIsInsertable(row({ lead_days: Number.NaN }))).toBe(false);
    expect(rowIsInsertable(row({ check_in: "2026-10-1" }))).toBe(false);
    expect(rowIsInsertable(row({ check_in: "2026-02-30" }))).toBe(false);
    expect(rowIsInsertable(row({ check_out: "" }))).toBe(false);
    expect(rowIsInsertable(row({ reslab_location_id: 1.5 }))).toBe(false);
    expect(uninsertableReasons(row({ lead_days: -2, check_in: "2026-02-30" }))).toEqual([
      "lead_days=-2",
      "check_in=2026-02-30",
    ]);
    // Reasons never echo an unbounded caller string.
    const long = "x".repeat(500);
    expect(uninsertableReasons(row({ check_out: long }))[0].length).toBeLessThan(50);
  });

  it("does NOT drop a row for a bad per-lot int — sanitizeRow nulls it so the sold_out observation survives", () => {
    expect(rowIsInsertable(row({ available_spots: 2.5 }))).toBe(true);
    expect(sanitizeRow(row({ available_spots: 2.5 }))).toMatchObject({ available_spots: null, sold_out: false });
    expect(sanitizeRow(row({ grand_total_cents: 2 ** 31 }))).toMatchObject({ grand_total_cents: null });
    expect(sanitizeRow(row({ grand_total_cents: -(2 ** 31) }))).toMatchObject({ grand_total_cents: -(2 ** 31) });
    const fine = row();
    expect(sanitizeRow(fine)).toBe(fine); // untouched when nothing to fix
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

  it("drops only the rows that would violate a CHECK, inserts the rest, and REPORTS the drop", async () => {
    const { inserted } = okInsert();

    logAvailability([row({ reslab_location_id: 1 }), row({ reslab_location_id: 2, lead_days: -30 })]);
    await flush();

    const rows = inserted[0] as AvailabilityRow[];
    expect(rows.map((r) => r.reslab_location_id)).toEqual([1]);
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    const [err, ctx] = sentry.captureAPIError.mock.calls[0] as [
      Error,
      { endpoint: string; extra?: { sample?: AvailabilityRow } },
    ];
    expect(ctx.endpoint).toBe("availability_log.guard");
    expect(err.message).toMatch(/dropped 1\/2 .*JFK search: lead_days=-30/);
    expect(ctx.extra?.sample?.reslab_location_id).toBe(2);
  });

  it("does not insert when every row is uninsertable — but never silently", async () => {
    okInsert();
    logAvailability([row({ lead_days: -30 })]);
    await flush();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("throttles drop reports to once per process-hour, independently of insert-failure reports", async () => {
    okInsert();
    logAvailability([row({ lead_days: -30 })]);
    await flush();
    logAvailability([row({ lead_days: -30 })]);
    await flush();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);

    // An insert failure in the same hour is still reported on its own clock.
    const abortSignal = vi.fn(() => Promise.resolve({ error: { code: "42501", message: "denied" } }));
    supabase.from.mockReturnValue({ insert: () => ({ abortSignal }) });
    logAvailability([row()]);
    await flush();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(2);
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

  it("keeps the PostgREST code in the Sentry message but NOT the per-row details", async () => {
    const abortSignal = vi.fn(() =>
      Promise.resolve({
        error: {
          code: "23514",
          message: 'new row for relation "availability_log" violates check constraint',
          details: "Failing row contains (12345, 2026-09-22, 9f2c-unique-uuid, …)",
        },
      })
    );
    supabase.from.mockReturnValue({ insert: () => ({ abortSignal }) });

    expect(() => logAvailability([row()])).not.toThrow();
    await flush();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    const [err, ctx] = sentry.captureAPIError.mock.calls[0] as [
      Error,
      { extra?: { postgrest?: string } },
    ];
    expect(err.message).toMatch(/^23514: new row for relation/);
    // Details are unique per event (they carry the row id): they ride as
    // context, never in the message.
    expect(err.message).not.toMatch(/Failing row/);
    expect(ctx.extra?.postgrest).toMatch(/Failing row contains/);
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

  it("does not throw when from() itself throws synchronously inside the insert", async () => {
    supabase.from.mockImplementation(() => {
      throw new Error("client exploded synchronously");
    });
    expect(() => logAvailability([row()])).not.toThrow();
    await flush();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the prelude itself throws (before the insert closure exists)", async () => {
    const spy = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("no entropy");
    });
    try {
      okInsert();
      expect(() => logAvailability([row()])).not.toThrow();
      await flush();
      expect(supabase.from).not.toHaveBeenCalled();
      expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does nothing for an empty batch", async () => {
    expect(() => logAvailability([])).not.toThrow();
    await flush();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
