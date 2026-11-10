/**
 * lotSlugLookup / lotIdLookup — the lot page's no-pricing existence check (soft-404 fix,
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

import { lotSlugLookup, lotIdLookup } from "../get-lot";

const lotSlugStatus = async (slug: string, code: string) => (await lotSlugLookup(slug, code)).status;
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

  it("a live slug that itself ends in a code exists; a hidden twin does not shadow a visible one", async () => {
    channel([loc(5, "Park N Fly JFK"), loc(416, "Dup Name"), loc(6, "Dup Name")]);
    expect(await lotSlugStatus("park-n-fly-jfk", "JFK")).toBe("exists");
    expect(await lotSlugStatus("dup-name", "JFK")).toBe("exists");
  });

  it("flag off: never reads direct inventory, and a direct-looking slug is decided on the list", async () => {
    expect(await lotSlugStatus("direct-12", "JFK")).toBe("missing");
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("ids are not slugs: left to lotIdLookup", async () => {
    expect(await lotSlugStatus("7", "EWR")).toBe("unknown");
    expect(await lotSlugStatus("reslab-7", "EWR")).toBe("unknown");
    expect(searchMock.getChannelLocationsCached).not.toHaveBeenCalled();
  });

  it("exists carries the visible same-name locations (any airport), not the hidden ones", async () => {
    channel([loc(416, "Dup Name"), loc(6, "Dup Name")]);
    const r = await lotSlugLookup("dup-name", "JFK");
    expect(r.status === "exists" && r.reslab.map((l) => l.id)).toEqual([6]);
  });
});

describe("lotIdLookup", () => {
  it("a live id exists with its location; a gone id on a complete list is missing", async () => {
    const r = await lotIdLookup("7");
    expect(r.status === "exists" && r.reslab[0].name).toBe("Snap Parking");
    expect((await lotIdLookup("reslab-7")).status).toBe("exists");
    expect((await lotIdLookup("379")).status).toBe("missing");
  });

  it("a gone id on a thin list, or a list read that throws, is unknown", async () => {
    channel([loc(7, "Snap Parking")], true);
    expect((await lotIdLookup("379")).status).toBe("unknown");
    searchMock.getChannelLocationsCached.mockRejectedValue(new Error("breaker open"));
    expect((await lotIdLookup("7")).status).toBe("unknown");
  });

  it("exists carries the list's incomplete flag", async () => {
    channel([loc(7, "Snap Parking")], true);
    const r = await lotSlugLookup("snap-parking", "EWR");
    expect(r.status === "exists" && r.incomplete).toBe(true);
  });

  it("a hidden or non-USD id is missing; a non-id is unknown", async () => {
    channel([loc(416, "Parking 4 Airport"), loc(9, "Maple Leaf Lot", "CAD")]);
    expect((await lotIdLookup("416")).status).toBe("missing");
    expect((await lotIdLookup("9")).status).toBe("missing");
    expect((await lotIdLookup("snap-parking")).status).toBe("unknown");
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

  it("numeric ids: a direct twin, or a failed direct read, is unknown; no twin falls to the list", async () => {
    directRows([directLotRow({ slug: "acme-jfk", airport_code: "JFK", reslab_location_id: 7 })]);
    expect((await lotIdLookup("7")).status).toBe("unknown");
    expect((await lotIdLookup("379")).status).toBe("missing");
    directRows(null, { code: "57014", message: "statement timeout" });
    expect((await lotIdLookup("8")).status).toBe("unknown");
  });

  it("direct ids are left to getLotById", async () => {
    expect(await lotSlugStatus("direct-12", "JFK")).toBe("unknown");
  });
});
