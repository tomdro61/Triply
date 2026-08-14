import { describe, it, expect, beforeEach, vi } from "vitest";

// The thing under guard: findLotBySlug must NEVER page-walk /locations itself.
// It used to, uncached, on the request path — ~54 ResLab calls per lookup of a
// slug that matched nothing, against a 500/day limit, reachable by
// unauthenticated input. Ten requests exhausted the day's budget and reproduced
// the 2026-08-10 site-wide search outage.
const reslabMock = vi.hoisted(() => ({
  getAllLocations: vi.fn(),
  getLocation: vi.fn(),
  getLocationTypes: vi.fn(),
  getMinPrice: vi.fn(),
}));
vi.mock("@/lib/reslab/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reslab/client")>(
    "@/lib/reslab/client",
  );
  return { ...actual, reslab: reslabMock };
});

const searchMock = vi.hoisted(() => ({ getChannelLocationsCached: vi.fn() }));
vi.mock("../search", async () => {
  const actual = await vi.importActual<typeof import("../search")>("../search");
  return { ...actual, ...searchMock };
});

import { findLotBySlug } from "../get-lot";

const FROM = "2026-09-01 10:00:00";
const TO = "2026-09-05 14:00:00";

function loc(id: number, name: string) {
  return {
    id,
    name,
    latitude: "42.0",
    longitude: "-71.0",
    photos: [],
    amenities: [],
    extra_fields: [],
    cancellation_policies: [],
  };
}

beforeEach(() => {
  reslabMock.getAllLocations.mockReset();
  reslabMock.getLocation.mockReset();
  reslabMock.getLocationTypes.mockReset();
  reslabMock.getMinPrice.mockReset();
  searchMock.getChannelLocationsCached.mockReset();
});

describe("findLotBySlug — must not sweep /locations on the request path", () => {
  it("resolves a slug WITHOUT calling getAllLocations", async () => {
    searchMock.getChannelLocationsCached.mockResolvedValue({
      data: [loc(1, "Broadway Motor Service"), loc(2, "Park For U")],
      incomplete: false,
      stale: false,
    });
    // Let the per-lot detail fetch fail; we only care about the list access.
    reslabMock.getLocation.mockRejectedValue(new Error("not under test"));

    await findLotBySlug("park-for-u", FROM, TO).catch(() => null);

    expect(searchMock.getChannelLocationsCached).toHaveBeenCalledTimes(1);
    // THE regression guard. Any page walk here is a rate-limit DoS vector.
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("a slug that matches nothing costs ZERO ResLab list calls", async () => {
    // Previously the worst case: a miss walked all 54 pages before giving up.
    searchMock.getChannelLocationsCached.mockResolvedValue({
      data: [loc(1, "Broadway Motor Service")],
      incomplete: false,
      stale: false,
    });

    const result = await findLotBySlug("no-such-lot-xyz", FROM, TO);

    expect(result).toBeNull();
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
    expect(reslabMock.getLocation).not.toHaveBeenCalled();
  });

  it("resolves a real lot from a COMPLETE list (positive path)", async () => {
    // Without this, a bug where a valid slug resolves to null — slug-generation
    // drift, a broken .find predicate — passes the whole suite.
    searchMock.getChannelLocationsCached.mockResolvedValue({
      data: [loc(1, "Broadway Motor Service"), loc(2, "Park For U")],
      incomplete: false,
      stale: false,
    });
    reslabMock.getLocation.mockResolvedValue(loc(2, "Park For U"));
    reslabMock.getMinPrice.mockRejectedValue(new Error("pricing not under test"));

    const result = await findLotBySlug("park-for-u", FROM, TO);

    expect(result).not.toBeNull();
    expect(result?.reslabLocationId).toBe(2);
    expect(reslabMock.getAllLocations).not.toHaveBeenCalled();
  });

  it("THROWS rather than 404s when the list is known INCOMPLETE", async () => {
    // The cache deliberately retains a thin list on a partial sweep so search
    // degrades instead of 503ing. A slug missing from a THIN list is not
    // evidence the lot doesn't exist — and returning null 404s a live lot whose
    // URL our own sitemap publishes. Google treats 404 as permanent.
    searchMock.getChannelLocationsCached.mockResolvedValue({
      data: [loc(1, "Broadway Motor Service")], // Park For U's page failed
      incomplete: true,
      stale: false,
    });

    await expect(findLotBySlug("park-for-u", FROM, TO)).rejects.toThrow(
      /incomplete/i,
    );
  });

  it("a miss on a STALE-but-complete list is still a real 404", async () => {
    // Guards the over-correction: stale means old, not thin, so a negative
    // answer off it is trustworthy. Throwing on stale would 500 the site for
    // the entire 24-72h stale window.
    searchMock.getChannelLocationsCached.mockResolvedValue({
      data: [loc(1, "Broadway Motor Service")],
      incomplete: false,
      stale: true,
    });

    await expect(findLotBySlug("no-such-lot-xyz", FROM, TO)).resolves.toBeNull();
  });

  it("propagates an upstream failure instead of returning a false 404", async () => {
    // `null` means "this lot does not exist" — the page turns it into a 404 and
    // Google deindexes the URL. An upstream outage must NOT be flattened into
    // that. This is the project's distinguish-your-errors rule, and the exact
    // anti-pattern behind the 2026-06-29 cached-empty incident.
    searchMock.getChannelLocationsCached.mockRejectedValue(
      new Error("ResLab location list unavailable (backing off)"),
    );

    await expect(findLotBySlug("park-for-u", FROM, TO)).rejects.toThrow(
      /backing off/i,
    );
  });
});
