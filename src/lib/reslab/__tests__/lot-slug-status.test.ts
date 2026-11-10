/**
 * lotSlugStatus — the lot page's no-pricing existence check (soft-404 fix,
 * 10 Nov 2026). "missing" only when the lists are complete and readable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const searchMock = vi.hoisted(() => ({ getChannelLocationsCached: vi.fn() }));
vi.mock("../search", async () => {
  const actual = await vi.importActual<typeof import("../search")>("../search");
  return { ...actual, ...searchMock };
});
const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: vi.fn(async () => db) }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));

import { lotSlugStatus } from "../get-lot";
import { __resetCaptureThrottleForTests } from "@/lib/direct/store";
import { directLotRow } from "@/lib/direct/__tests__/fixtures";

function loc(id: number, name: string, currency?: string) {
  return { id, name, latitude: "40.64", longitude: "-73.77", ...(currency ? { currency: { code: currency } } : {}) };
}
function channel(data: unknown[], incomplete = false) {
  searchMock.getChannelLocationsCached.mockResolvedValue({ data, incomplete, stale: false });
}
function directRows(rows: unknown[] | null, error: { code: string; message: string } | null = null) {
  db.rpc.mockReturnValue({ abortSignal: async () => ({ data: rows, error }) });
}

beforeEach(() => {
  searchMock.getChannelLocationsCached.mockReset();
  db.rpc.mockReset();
  __resetCaptureThrottleForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.NEXT_PUBLIC_APP_ENV = "staging";
  channel([loc(7, "Snap Parking")]);
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_ENV;
  delete process.env.ENABLE_DIRECT_LOTS;
});

describe("lotSlugStatus — ResLab", () => {
  it("exists for a live lot's slug; missing for an old code-suffixed slug on a complete list", async () => {
    expect(await lotSlugStatus("snap-parking", "EWR")).toBe("exists");
    expect(await lotSlugStatus("snap-parking-ewr", "EWR")).toBe("missing");
  });

  it("a thin list never says missing", async () => {
    channel([loc(7, "Snap Parking")], true);
    expect(await lotSlugStatus("snap-parking-ewr", "EWR")).toBe("unknown");
  });

  it("a list read that throws is unknown, not missing", async () => {
    searchMock.getChannelLocationsCached.mockRejectedValue(new Error("breaker open"));
    expect(await lotSlugStatus("snap-parking", "EWR")).toBe("unknown");
  });

  it("a hidden or non-USD lot is missing even on a thin list (firm 404, as findLotBySlug)", async () => {
    channel([loc(416, "Parking 4 Airport"), loc(9, "Maple Leaf Lot", "CAD")], true);
    expect(await lotSlugStatus("parking-4-airport", "JFK")).toBe("missing");
    expect(await lotSlugStatus("maple-leaf-lot", "YYZ")).toBe("missing");
  });

  it("ids are not slugs: left to getLotById", async () => {
    expect(await lotSlugStatus("7", "EWR")).toBe("unknown");
    expect(await lotSlugStatus("reslab-7", "EWR")).toBe("unknown");
    expect(searchMock.getChannelLocationsCached).not.toHaveBeenCalled();
  });
});

describe("lotSlugStatus — direct lots on", () => {
  beforeEach(() => {
    process.env.ENABLE_DIRECT_LOTS = "true";
  });

  it("a direct slug in this airport exists; the same slug at another airport falls to ResLab", async () => {
    directRows([directLotRow({ slug: "acme-jfk", airport_code: "JFK" })]);
    expect(await lotSlugStatus("acme-jfk", "JFK")).toBe("exists");
    expect(await lotSlugStatus("acme-jfk", "BOS")).toBe("missing");
  });

  it("a failed direct read is unknown", async () => {
    directRows(null, { code: "57014", message: "statement timeout" });
    expect(await lotSlugStatus("acme-jfk", "JFK")).toBe("unknown");
  });

  it("direct ids are left to getLotById", async () => {
    expect(await lotSlugStatus("direct-12", "JFK")).toBe("unknown");
  });
});
