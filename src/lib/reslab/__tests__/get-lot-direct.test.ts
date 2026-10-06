/**
 * getLotById resolution order with direct lots (plan A-24): canonical direct
 * id → ResLab id (twin-aware) → direct slug → ResLab slug (twin-aware), with
 * "direct read failed + miss" a 503 rather than a 404.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const reslabMock = vi.hoisted(() => ({ getAllLocations: vi.fn(), getLocation: vi.fn(), getMinPrice: vi.fn() }));
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>("@/lib/reslab/client");
  return { ...actual, reslab: reslabMock };
});
const searchMock = vi.hoisted(() => ({ getChannelLocationsCached: vi.fn() }));
vi.mock("../search", async () => {
  const actual = await vi.importActual<typeof import("../search")>("../search");
  return { ...actual, ...searchMock };
});
const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: vi.fn(async () => db) }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));
const flagState = vi.hoisted(() => ({ bookingOpen: false }));
vi.mock("@/lib/direct/flag", async () => {
  const actual = await vi.importActual<typeof import("@/lib/direct/flag")>("@/lib/direct/flag");
  return { ...actual, get DIRECT_BOOKING_OPEN() { return flagState.bookingOpen; } };
});

import { getLotById } from "../get-lot";
import { DirectInventoryUnavailableError } from "@/lib/direct/errors";
import { __resetCaptureThrottleForTests } from "@/lib/direct/store";
import { directLotRow } from "@/lib/direct/__tests__/fixtures";

const FROM = "2026-10-10 10:00:00";
const TO = "2026-10-14 14:00:00";
const AT_JFK = { latitude: 40.6413, longitude: -73.7781, code: "JFK" };
const AT_BOS = { latitude: 42.3656, longitude: -71.0096, code: "BOS" };

function loc(id: number, name: string) {
  return { id, name, address: "1 Airport Way", city: "Queens", latitude: "40.64", longitude: "-73.77", photos: [], amenities: [], extra_fields: [], cancellation_policies: [] };
}
function directRows(rows: unknown[] | null, error: { code: string; message: string } | null = null) {
  db.rpc.mockReturnValue({ abortSignal: async () => ({ data: rows, error }) });
}

beforeEach(() => {
  reslabMock.getAllLocations.mockReset();
  reslabMock.getLocation.mockReset();
  reslabMock.getMinPrice.mockReset();
  reslabMock.getMinPrice.mockRejectedValue(new Error("no pricing under test"));
  searchMock.getChannelLocationsCached.mockReset();
  searchMock.getChannelLocationsCached.mockResolvedValue({ data: [loc(7, "Lot Seven"), loc(8, "Lot Eight")], incomplete: false, stale: false });
  reslabMock.getLocation.mockImplementation(async (id: number) => loc(id, `Lot ${id}`));
  db.rpc.mockReset();
  __resetCaptureThrottleForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.NEXT_PUBLIC_APP_ENV = "staging";
  process.env.ENABLE_DIRECT_LOTS = "true";
  flagState.bookingOpen = false;
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_ENV;
  delete process.env.ENABLE_DIRECT_LOTS;
});

describe("getLotById — flag off", () => {
  beforeEach(() => { delete process.env.ENABLE_DIRECT_LOTS; });

  it("never reads direct inventory; a direct id is just an unknown slug", async () => {
    expect(await getLotById("direct-1", FROM, TO)).toBeNull();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("matches numeric ids strictly — a digit-leading slug no longer renders another lot (Aug-16 find)", async () => {
    expect(await getLotById("7", FROM, TO)).toMatchObject({ id: "reslab-7" });
    expect(await getLotById("reslab-8", FROM, TO)).toMatchObject({ id: "reslab-8" });
    expect(await getLotById("7-eleven-parking", FROM, TO)).toBeNull();
    expect(reslabMock.getLocation).not.toHaveBeenCalledWith(7, expect.anything());
    expect(reslabMock.getLocation).toHaveBeenCalledTimes(2);
  });
});

describe("getLotById — flag on", () => {
  it("resolves a canonical direct id without touching ResLab", async () => {
    directRows([directLotRow()]);
    const lot = await getLotById("direct-1", FROM, TO);
    expect(lot).toMatchObject({ id: "direct-1", source: "direct", airportCode: "JFK" });
    expect(lot?.pricing?.numberOfDays).toBe(5);
    expect(reslabMock.getLocation).not.toHaveBeenCalled();
    expect(searchMock.getChannelLocationsCached).not.toHaveBeenCalled();
  });

  it("a direct lot that is not sellable here is a 404, not a 503", async () => {
    directRows([directLotRow({ is_active: false })]);
    expect(await getLotById("direct-1", FROM, TO)).toBeNull();
    process.env.NEXT_PUBLIC_APP_ENV = "production"; // staging_only lot
    directRows([directLotRow()]);
    expect(await getLotById("direct-1", FROM, TO)).toBeNull();
  });

  it("a direct id while the direct read FAILED is a 503, never a 404", async () => {
    directRows(null, { code: "42883", message: "function public.direct_lots does not exist" });
    await expect(getLotById("direct-1", FROM, TO)).rejects.toBeInstanceOf(DirectInventoryUnavailableError);
  });

  it("a CMS slug wins over a ResLab slug of the same spelling and over a ResLab failure (the direct page needs no ResLab)", async () => {
    directRows([directLotRow()]);
    expect(await getLotById("the-parking-point-jfk", FROM, TO)).toMatchObject({ id: "direct-1" });
    // ResLab list thin → findLotBySlug would 503 a miss; the direct hit still renders.
    searchMock.getChannelLocationsCached.mockResolvedValue({ data: [], incomplete: true, stale: false });
    expect(await getLotById("the-parking-point-jfk", FROM, TO, AT_JFK)).toMatchObject({ id: "direct-1" });
    expect(reslabMock.getLocation).not.toHaveBeenCalled();
  });

  it("scopes direct matches to the URL's airport — a JFK lot does not render under Boston", async () => {
    directRows([directLotRow()]);
    expect(await getLotById("the-parking-point-jfk", FROM, TO, AT_BOS)).toBeNull();
    expect(await getLotById("direct-1", FROM, TO, AT_BOS)).toBeNull();
    expect(await getLotById("direct-1", FROM, TO, AT_JFK)).toMatchObject({ id: "direct-1" });
    // No airport context (the checkout API): matched by id alone.
    expect(await getLotById("direct-1", FROM, TO)).toMatchObject({ id: "direct-1" });
  });

  it("until direct booking is open, a declared ResLab twin still renders the ResLab lot", async () => {
    directRows([directLotRow({ reslab_location_id: 7 })]);
    expect(await getLotById("reslab-7", FROM, TO, AT_JFK)).toMatchObject({ id: "reslab-7" });
    expect(await getLotById("lot-seven", FROM, TO, AT_JFK)).toMatchObject({ id: "reslab-7" });
  });

  it("once direct booking is open, the twin maps reslab-<id>, the bare id and the ResLab slug to the direct lot (same airport only)", async () => {
    flagState.bookingOpen = true;
    directRows([directLotRow({ reslab_location_id: 7 })]);
    expect(await getLotById("reslab-7", FROM, TO, AT_JFK)).toMatchObject({ id: "direct-1" });
    expect(await getLotById("7", FROM, TO, AT_JFK)).toMatchObject({ id: "direct-1" });
    expect(await getLotById("lot-seven", FROM, TO, AT_JFK)).toMatchObject({ id: "direct-1" });
    // the untwinned neighbour is untouched; under another airport the ResLab lot stands
    expect(await getLotById("lot-eight", FROM, TO, AT_JFK)).toMatchObject({ id: "reslab-8" });
    expect(await getLotById("reslab-7", FROM, TO, AT_BOS)).toMatchObject({ id: "reslab-7" });
  });

  it("a ResLab lookup still works, with pricing untouched, while the direct read is failing", async () => {
    directRows(null, { code: "42501", message: "permission denied" });
    expect(await getLotById("reslab-8", FROM, TO)).toMatchObject({ id: "reslab-8" });
    expect(await getLotById("lot-eight", FROM, TO)).toMatchObject({ id: "reslab-8" });
  });

  it("a slug that is neither ResLab nor (readably) direct is a 503 while the direct read fails, a 404 once it works", async () => {
    directRows(null, { code: "42501", message: "permission denied" });
    await expect(getLotById("no-such-lot", FROM, TO)).rejects.toBeInstanceOf(DirectInventoryUnavailableError);
    directRows([directLotRow()]);
    expect(await getLotById("no-such-lot", FROM, TO)).toBeNull();
  });
});
