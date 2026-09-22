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

beforeEach(() => {
  __resetAvailabilityLogWarnStateForTests();
  supabase.from.mockReset();
  sentry.captureAPIError.mockClear();
  vi.mocked(createAdminClient).mockClear();
  delete process.env.NEXT_PHASE;
  delete process.env.AVAILABILITY_LOG_DISABLED;
});

describe("dayDiff", () => {
  it("counts whole days between two dates", () => {
    expect(dayDiff("2026-01-01", "2026-01-10")).toBe(9);
  });

  it("is negative for a reversed range", () => {
    expect(dayDiff("2026-01-10", "2026-01-01")).toBe(-9);
  });

  it("returns 0 rather than NaN on an unparseable input", () => {
    expect(dayDiff("not-a-date", "2026-01-01")).toBe(0);
    expect(dayDiff("2026-01-01", "also-not-a-date")).toBe(0);
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

describe("logAvailability — never-throw contract", () => {
  it("is a no-op during `next build`", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    expect(() => logAvailability([row()])).not.toThrow();
    await flush();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("is a no-op when the kill switch is set", async () => {
    process.env.AVAILABILITY_LOG_DISABLED = "1";
    expect(() => logAvailability([row()])).not.toThrow();
    await flush();
    expect(supabase.from).not.toHaveBeenCalled();
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

  it("resolves without throwing when supabase reports an error object (e.g. missing table)", async () => {
    const abortSignal = vi.fn(() =>
      Promise.resolve({ error: { message: 'relation "availability_log" does not exist' } })
    );
    supabase.from.mockReturnValue({ insert: () => ({ abortSignal }) });

    expect(() => logAvailability([row()])).not.toThrow();
    await flush();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
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

  it("does nothing for an empty batch", async () => {
    expect(() => logAvailability([])).not.toThrow();
    await flush();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
