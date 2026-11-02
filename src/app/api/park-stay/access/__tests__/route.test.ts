import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = { enabled: true, airports: new Set(["JFK", "LGA", "EWR"]) };
const viewerAllowed = vi.fn(async (_caller: string) => true);
const fingerprint = vi.fn((): string | null => "f5d7c11622bdb289");
const takeLiteApiCall = vi.fn();
const reslabCalls = vi.fn();
const fetchSpy = vi.fn();

vi.mock("@/lib/hotels/flags", () => ({
  parkStayFlags: () => flags,
  isParkStayEnabledFor: (code: string) => flags.enabled && flags.airports.has(code.toUpperCase()),
}));
vi.mock("@/lib/hotels/admin-preview", () => ({ parkStayViewerAllowed: (caller: string) => viewerAllowed(caller) }));
vi.mock("@/lib/reslab/location-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/location-snapshot")>();
  return { ...actual, keyFingerprint: () => fingerprint() };
});
vi.mock("@/lib/hotels/liteapi/budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hotels/liteapi/budget")>();
  return { ...actual, takeLiteApiCall: (...a: unknown[]) => takeLiteApiCall(...a) };
});
vi.mock("@/lib/reslab/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reslab/client")>();
  const spy = (name: string) => (...a: unknown[]) => reslabCalls(name, ...a);
  return {
    ...actual,
    warmReslabToken: spy("warmReslabToken"),
    reslab: { ...actual.reslab, getLocation: spy("getLocation"), getMinPrice: spy("getMinPrice"), searchLocations: spy("searchLocations"), getAllLocations: spy("getAllLocations") },
  };
});

import { GET, dynamic } from "@/app/api/park-stay/access/route";
import type { ParkStayAccessResponse } from "@/app/api/park-stay/access/route";

beforeEach(() => {
  flags.enabled = true;
  flags.airports = new Set(["JFK", "LGA", "EWR"]);
  viewerAllowed.mockReset();
  viewerAllowed.mockResolvedValue(true);
  fingerprint.mockReset();
  fingerprint.mockReturnValue("f5d7c11622bdb289");
  for (const m of [takeLiteApiCall, reslabCalls, fetchSpy]) m.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // No supplier call on ANY path (plan §7).
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(takeLiteApiCall).not.toHaveBeenCalled();
  expect(reslabCalls).not.toHaveBeenCalled();
});

async function json(res: Response): Promise<unknown> {
  return res.json();
}

describe("GET /api/park-stay/access (CX plan v2 §1, Lock 2)", () => {
  it("is force-dynamic", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("flag off → the same 404 as the other routes, no-store, and NO auth call", async () => {
    flags.enabled = false;
    const res = await GET();
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await json(res)).toEqual({ error: "Not found" });
    expect(viewerAllowed).not.toHaveBeenCalled();
  });

  it("not a signed-in admin (or an auth error, which parkStayViewerAllowed answers false) → 404, no-store", async () => {
    viewerAllowed.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await json(res)).toEqual({ error: "Not found" });
    expect(viewerAllowed).toHaveBeenCalledWith("/api/park-stay/access");
  });

  it("an allowlisted airport with no enabled hotel → 404", async () => {
    flags.airports = new Set(["BOS"]);
    const res = await GET();
    expect(res.status).toBe(404);
  });

  it("admin → 200 with the open airports and their enabled hotels (production ids), no-store", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await json(res)) as ParkStayAccessResponse;
    expect(body.airports.map((a) => a.code)).toEqual(["JFK", "LGA", "EWR"]);
    for (const a of body.airports) expect(a.name.length).toBeGreaterThan(0);
    expect(body.hotels).toHaveLength(9);
    expect(body.hotels.find((h) => h.key === "red-carpet-inn-ewr")).toBeUndefined();
    expect(body.hotels[0]).toEqual({
      key: "doubletree-jfk",
      airport: "JFK",
      reslabLotId: 132,
      name: "DoubleTree by Hilton New York JFK Airport",
      photoUrl: "https://static.cupid.travel/hotels/614117928.jpg",
      shuttle: "Shuttle every 30 min, 24/7",
    });
    for (const h of body.hotels) {
      expect(Object.keys(h).sort()).toEqual(["airport", "key", "name", "photoUrl", "reslabLotId", "shuttle"]);
      expect(Number.isInteger(h.reslabLotId)).toBe(true);
    }
  });

  it("only the allowlisted airports' hotels", async () => {
    flags.airports = new Set(["JFK"]);
    const body = (await json(await GET())) as ParkStayAccessResponse;
    expect(body.airports.map((a) => a.code)).toEqual(["JFK"]);
    expect(body.hotels.map((h) => h.key)).toEqual(["doubletree-jfk", "hampton-inn-jfk"]);
  });

  it("another ResLab account (staging) or no key → every reslabLotId is null, never the production id", async () => {
    for (const fp of ["0000000000000000", null]) {
      fingerprint.mockReturnValue(fp);
      const body = (await json(await GET())) as ParkStayAccessResponse;
      expect(body.hotels).toHaveLength(9);
      expect(body.hotels.every((h) => h.reslabLotId === null)).toBe(true);
    }
  });
});
