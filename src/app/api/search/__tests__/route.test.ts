/**
 * The search_events insert (src/lib/search-events/log.ts) must never affect
 * the search response — not its body, not its status, not its latency. This
 * is the contract test for that: the insert is made to reject/throw and the
 * route's response is asserted identical to the happy path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// after() requires a live Next.js request scope, which vitest doesn't
// provide — forcing it to throw exercises the same fallback (plain
// fire-and-forget) a real unit test run hits anyway.
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: () => {
      throw new Error("no request scope");
    },
  };
});

const searchParkingMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reslab/search", () => ({
  searchParking: searchParkingMock,
  isLocationBackoffError: () => false,
}));

vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));

const supabase = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: vi.fn(async () => supabase),
}));

import { GET } from "../route";

const okResult = {
  airport: { code: "JFK" },
  checkin: "2026-10-10",
  checkout: "2026-10-14",
  checkinTime: "10:00 AM",
  checkoutTime: "2:00 PM",
  results: [
    { pricing: { grandTotal: 123.45 } },
    { pricing: { grandTotal: 99.99 } },
  ],
  total: 2,
};

function req(query: Record<string, string> = {}) {
  const params = new URLSearchParams({
    airport: "JFK",
    checkin: "2026-10-10",
    checkout: "2026-10-14",
    ...query,
  });
  return new NextRequest(`https://triplypro.com/api/search?${params.toString()}`);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  searchParkingMock.mockReset();
  supabase.from.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GET /api/search — search_events insert never affects the response", () => {
  it("returns the normal 200 body when the insert rejects", async () => {
    searchParkingMock.mockResolvedValue(okResult);
    supabase.from.mockReturnValue({
      insert: () => Promise.reject(new Error("network down")),
    });

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(okResult);

    await flush();
    expect(console.warn).toHaveBeenCalledWith(
      "[search-events]",
      "EXCEPTION",
      "network down"
    );
  });

  it("returns the normal 200 body when supabase reports a PGRST205 error (table not migrated yet)", async () => {
    searchParkingMock.mockResolvedValue(okResult);
    supabase.from.mockReturnValue({
      insert: () =>
        Promise.resolve({
          error: { code: "PGRST205", message: 'Could not find the table "search_events"' },
        }),
    });

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(okResult);

    await flush();
    expect(console.warn).toHaveBeenCalledWith(
      "[search-events]",
      "PGRST205",
      'Could not find the table "search_events"'
    );
  });

  it("still returns 200 when createAdminClient itself throws", async () => {
    searchParkingMock.mockResolvedValue(okResult);
    const { createAdminClient } = await import("@/lib/supabase/server");
    vi.mocked(createAdminClient).mockImplementationOnce(async () => {
      throw new Error("no service-role key");
    });

    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(okResult);

    await flush();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("skips the insert entirely for an invalid date range, but the search response is unaffected", async () => {
    searchParkingMock.mockResolvedValue(okResult);

    const res = await GET(req({ checkin: "2026-10-14", checkout: "2026-10-10" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(okResult);

    await flush();
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
