/**
 * resolveLotUrl — real 404 / 308 for dead, old-slug, numeric-id and
 * wrong-airport lot URLs, decided before the lot page streams (soft-404 fix
 * and audit follow-ups, 10 Nov 2026). Ownership uses the real airport config.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const nav = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  permanentRedirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));
vi.mock("next/navigation", () => nav);

const lookups = vi.hoisted(() => ({ lotSlugLookup: vi.fn(), lotIdLookup: vi.fn(), mayRenderDirectTwin: vi.fn() }));
vi.mock("@/lib/reslab/get-lot", () => lookups);
const sentry = vi.hoisted(() => ({ captureAPIError: vi.fn() }));
vi.mock("@/lib/sentry", () => sentry);

import { resolveLotUrl, __resetPrecheckCaptureThrottleForTests } from "../lot-url";

type Loc = { id: number; name: string; latitude: string; longitude: string };
const at = (id: number, name: string, lat: number, lng: number): Loc => ({ id, name, latitude: String(lat), longitude: String(lng) });
const NEAR_EWR = [40.69, -74.17] as const;
const NEAR_JFK = [40.66, -73.79] as const;
const NEAR_BOS = [42.37, -71.02] as const;
const NEAR_MIA = [25.8, -80.29] as const;
const NEAR_SFO = [37.62, -122.38] as const;
const BETWEEN_JFK_LGA = [40.7, -73.82] as const; // owned by JFK, within 15 km of LGA

/** slug -> the visible same-name locations (any airport); absent = no lot by that name. */
let live: Record<string, Loc[]>;
const NEAR_BUF = [42.94, -78.73] as const;
const ids: Record<string, Loc> = {
  "466": at(466, "Ramada by Wyndham Boston", ...NEAR_BOS),
  "6": at(6, "SFO Lot", ...NEAR_SFO),
};

beforeEach(() => {
  nav.notFound.mockClear();
  nav.permanentRedirect.mockClear();
  live = {
    "snap-parking": [at(1, "Snap Parking", ...NEAR_EWR)],
    "bolt-parking": [at(2, "Bolt Parking", ...NEAR_JFK)],
    "park-for-u": [at(3, "Park For U", ...NEAR_JFK)],
    "safe-park-jfk": [at(4, "Safe Park JFK", ...NEAR_JFK)],
    "safe-cruise-parking": [at(5, "Safe Cruise Parking", ...NEAR_MIA)],
    "sfo-lot": [at(6, "SFO Lot", ...NEAR_SFO)],
    "queens-lot": [at(7, "Queens Lot", ...BETWEEN_JFK_LGA)],
    "days-inn": [at(8, "Days Inn", ...NEAR_JFK), at(9, "Days Inn", ...NEAR_EWR)],
    "ramada-by-wyndham-boston": [ids["466"]],
  };
  lookups.lotSlugLookup.mockReset();
  lookups.lotSlugLookup.mockImplementation(async (slug: string) =>
    live[slug] ? { status: "exists", reslab: live[slug], incomplete: false } : { status: "missing" },
  );
  lookups.mayRenderDirectTwin.mockReset();
  lookups.mayRenderDirectTwin.mockResolvedValue(false);
  __resetPrecheckCaptureThrottleForTests();
  lookups.lotIdLookup.mockReset();
  lookups.lotIdLookup.mockImplementation(async (id: string) => {
    const loc = ids[id.replace(/^reslab-/, "")];
    return loc ? { status: "exists", reslab: [loc], incomplete: false } : { status: "missing" };
  });
});
afterEach(() => {
  delete process.env.SEARCH_OWN_AIRPORT_FILTER;
});

const resolve = (airport: string, lot: string, query: Record<string, string | string[] | undefined> = {}) =>
  resolveLotUrl(airport, lot, query);

describe("resolveLotUrl — live slugs", () => {
  it("a live lot owned by the URL's airport renders", async () => {
    await expect(resolve("new-york-ewr", "snap-parking")).resolves.toBeUndefined();
  });

  it("a live lot owned by another airport renders (search's sold-out fallback links it here; the canonical names the owner)", async () => {
    await expect(resolve("new-york-lga", "safe-park-jfk")).resolves.toBeUndefined();
    await expect(resolve("san-jose-sjc", "sfo-lot")).resolves.toBeUndefined();
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it("renders when ANY same-name lot belongs here (the one the sitemap lists), even if another is nearer", async () => {
    await expect(resolve("new-york-ewr", "days-inn")).resolves.toBeUndefined();
    await expect(resolve("new-york-jfk", "days-inn")).resolves.toBeUndefined();
  });

  it("a thin list never moves a live URL: renders", async () => {
    lookups.lotSlugLookup.mockResolvedValue({ status: "exists", reslab: live["safe-park-jfk"], incomplete: true });
    await expect(resolve("new-york-lga", "safe-park-jfk")).resolves.toBeUndefined();
  });

  it("with the own-airport filter off, no ownership redirect", async () => {
    process.env.SEARCH_OWN_AIRPORT_FILTER = "off";
    await expect(resolve("new-york-lga", "safe-park-jfk")).resolves.toBeUndefined();
  });

  it("a direct lot (no ResLab locations) renders", async () => {
    lookups.lotSlugLookup.mockResolvedValue({ status: "exists", reslab: [], incomplete: false });
    await expect(resolve("boston-bos", "acme-direct")).resolves.toBeUndefined();
  });
});

describe("resolveLotUrl — old code-suffixed slugs", () => {
  it("308s to the live lot at that airport, query kept", async () => {
    await expect(resolve("new-york-ewr", "snap-parking-ewr", { checkin: "2026-11-20", checkout: "2026-11-24" })).rejects.toThrow(
      "REDIRECT /new-york-ewr/airport-parking/snap-parking?checkin=2026-11-20&checkout=2026-11-24",
    );
  });

  it("goes to the airport the suffix names", async () => {
    await expect(resolve("new-york-lga", "bolt-parking-jfk")).rejects.toThrow("REDIRECT /new-york-jfk/airport-parking/bolt-parking");
  });

  it("404s when the only same-name lot belongs to another airport (park-for-u-yyz must not land on the JFK lot)", async () => {
    await expect(resolve("toronto-yyz", "park-for-u-yyz")).rejects.toThrow("NOT_FOUND");
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it("with the own-airport filter off, a far-away twin is still a 404, never a 308 (park-for-u-yyz vs the JFK lot)", async () => {
    process.env.SEARCH_OWN_AIRPORT_FILTER = "off";
    await expect(resolve("toronto-yyz", "park-for-u-yyz")).rejects.toThrow("NOT_FOUND");
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it("with the own-airport filter off, a nearby twin still 308s", async () => {
    process.env.SEARCH_OWN_AIRPORT_FILTER = "off";
    await expect(resolve("new-york-lga", "bolt-parking-jfk")).rejects.toThrow("REDIRECT /new-york-jfk/airport-parking/bolt-parking");
  });

  it("follows a lot that now belongs to a nearby airport (old -lga slug for a JFK-owned lot)", async () => {
    await expect(resolve("new-york-lga", "queens-lot-lga")).rejects.toThrow("REDIRECT /new-york-jfk/airport-parking/queens-lot");
  });

  it("a far-away twin on a thin list renders instead of 404ing", async () => {
    lookups.lotSlugLookup.mockImplementation(async (slug: string) =>
      slug === "park-for-u" ? { status: "exists", reslab: live["park-for-u"], incomplete: true } : { status: "missing" },
    );
    await expect(resolve("toronto-yyz", "park-for-u-yyz")).resolves.toBeUndefined();
  });

  it("a dead slug with no live twin is a real 404; a non-code suffix is not stripped", async () => {
    await expect(resolve("boston-bos", "preflight-airport-parking")).rejects.toThrow("NOT_FOUND");
    await expect(resolve("new-york-ewr", "snap-parking-xyz")).rejects.toThrow("NOT_FOUND");
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it("twin lookup can't tell → renders as before, no 404 on a guess", async () => {
    lookups.lotSlugLookup.mockImplementation(async (slug: string) => (slug === "bolt-parking" ? { status: "unknown" } : { status: "missing" }));
    await expect(resolve("new-york-lga", "bolt-parking-jfk")).resolves.toBeUndefined();
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it("keeps repeated params in order and drops undefined ones", async () => {
    await expect(resolve("new-york-ewr", "snap-parking-ewr", { checkin: ["2026-11-20", "2026-11-21"], ref: undefined })).rejects.toThrow(
      "REDIRECT /new-york-ewr/airport-parking/snap-parking?checkin=2026-11-20&checkin=2026-11-21",
    );
  });
});

describe("resolveLotUrl — cruise-port suffixes", () => {
  it("308s to the live code-less lot at the same airport", async () => {
    await expect(resolve("miami-mia", "safe-cruise-parking-portmiami")).rejects.toThrow("REDIRECT /miami-mia/airport-parking/safe-cruise-parking");
  });

  it("at an exempt airport (POE claims every lot), a far-away namesake is still a 404, never a 308", async () => {
    live["hampton-inn-suites"] = [at(10, "Hampton Inn & Suites", ...NEAR_BUF)];
    await expect(resolve("fort-lauderdale-poe", "hampton-inn-suites-port-everglades")).rejects.toThrow("NOT_FOUND");
    await expect(resolve("fort-lauderdale-poe", "hampton-inn-suites-poe")).rejects.toThrow("NOT_FOUND");
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it("404s when there is no live twin", async () => {
    await expect(resolve("san-diego-san", "fox-auto-parks-port-of-san-diego")).rejects.toThrow("NOT_FOUND");
  });
});

describe("resolveLotUrl — numeric ids", () => {
  it("a live id 308s to its slug URL under its owning airport", async () => {
    await expect(resolve("boston-bos", "466")).rejects.toThrow("REDIRECT /boston-bos/airport-parking/ramada-by-wyndham-boston");
    await expect(resolve("new-york-jfk", "reslab-466")).rejects.toThrow("REDIRECT /boston-bos/airport-parking/ramada-by-wyndham-boston");
  });

  it("an owner that sorts after the POE cruise port is still found (exempt airports never win)", async () => {
    await expect(resolve("san-jose-sjc", "6")).rejects.toThrow("REDIRECT /san-francisco-sfo/airport-parking/sfo-lot");
  });

  it("with the own-airport filter off, a live id still 308s to the URL its canonical names (no hop to a non-canonical URL)", async () => {
    process.env.SEARCH_OWN_AIRPORT_FILTER = "off";
    await expect(resolve("new-york-jfk", "466")).rejects.toThrow("REDIRECT /boston-bos/airport-parking/ramada-by-wyndham-boston");
  });

  it("an id the list holds as hidden (missing) is a real 404; unknown renders as before", async () => {
    await expect(resolve("toronto-yyz", "379")).rejects.toThrow("NOT_FOUND");
    lookups.lotIdLookup.mockResolvedValue({ status: "unknown" });
    await expect(resolve("toronto-yyz", "379")).resolves.toBeUndefined();
    expect(lookups.lotSlugLookup).not.toHaveBeenCalled();
  });
});

describe("resolveLotUrl — errors and bad airports", () => {
  it("a lookup that throws renders as before, never a 404, and reaches Sentry once per 10 minutes (lookups turn every expected failure into unknown, so a throw is a bug)", async () => {
    sentry.captureAPIError.mockClear();
    lookups.lotSlugLookup.mockRejectedValue(new Error("boom"));
    await expect(resolve("new-york-ewr", "snap-parking")).resolves.toBeUndefined();
    await expect(resolve("boston-bos", "gone-lot")).resolves.toBeUndefined();
    expect(nav.notFound).not.toHaveBeenCalled();
    expect(sentry.captureAPIError).toHaveBeenCalledTimes(1);
    expect(sentry.captureAPIError.mock.calls[0][1]).toMatchObject({ stage: "lot_url_precheck" });
  });

  it("a Sentry call that throws still renders as before (reporting never becomes a 500)", async () => {
    sentry.captureAPIError.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    lookups.lotSlugLookup.mockRejectedValue(new Error("boom"));
    await expect(resolve("new-york-ewr", "snap-parking")).resolves.toBeUndefined();
  });

  it("an unknown airport is a 404 without a lookup", async () => {
    await expect(resolve("nowhere-xxx", "snap-parking")).rejects.toThrow("NOT_FOUND");
    expect(lookups.lotSlugLookup).not.toHaveBeenCalled();
  });
});

describe("resolveLotUrl — pre-check deadline", () => {
  it("a lookup that hangs past the deadline renders as before (no 404, no 308, no blank tab)", async () => {
    vi.useFakeTimers();
    try {
      lookups.lotSlugLookup.mockImplementation(() => new Promise(() => {}));
      const pending = resolve("boston-bos", "gone-lot");
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toBeUndefined();
      expect(nav.notFound).not.toHaveBeenCalled();
      expect(nav.permanentRedirect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveLotUrl — a 308 lands only on the lot it means", () => {
  // Two "Foo Parking" lots near LGA: X is LGA's own (12 km out), Y is nearer
  // LGA (11 km) but JFK owns it. LGA's page for foo-parking renders X.
  const X = at(101, "Foo Parking", 40.88, -73.92);
  const Y = at(102, "Foo Parking", 40.7, -73.8);
  beforeEach(() => {
    live["foo-parking"] = [X, Y];
    ids["101"] = X;
  });
  afterEach(() => {
    delete ids["101"];
  });

  it("an old -lga slug goes to the LGA lot of that name, not a nearer namesake JFK owns", async () => {
    await expect(resolve("new-york-lga", "foo-parking-lga")).rejects.toThrow("REDIRECT /new-york-lga/airport-parking/foo-parking");
  });

  it("an id whose slug page would render a different namesake renders as before instead of a wrong 308", async () => {
    // With the own-airport filter off, LGA's foo-parking page renders Y
    // (nearest), so /lga/101 must not 308 there: it would show the wrong lot.
    process.env.SEARCH_OWN_AIRPORT_FILTER = "off";
    await expect(resolve("new-york-lga", "101")).resolves.toBeUndefined();
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
    expect(nav.notFound).not.toHaveBeenCalled();
  });

  it("a destination where a direct lot holds the slug renders as before", async () => {
    lookups.lotSlugLookup.mockImplementation(async (slug: string, code: string) =>
      slug === "foo-parking" && code === "LGA"
        ? { status: "exists", reslab: [], incomplete: false }
        : live[slug]
          ? { status: "exists", reslab: live[slug], incomplete: false }
          : { status: "missing" },
    );
    await expect(resolve("new-york-jfk", "101")).resolves.toBeUndefined();
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it("a destination where getLotById would swap in a direct twin renders as before", async () => {
    lookups.mayRenderDirectTwin.mockResolvedValue(true);
    await expect(resolve("new-york-lga", "foo-parking-lga")).resolves.toBeUndefined();
    await expect(resolve("new-york-jfk", "101")).resolves.toBeUndefined();
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it("a thin list at the destination renders as before", async () => {
    lookups.lotSlugLookup.mockImplementation(async (slug: string) =>
      live[slug] ? { status: "exists", reslab: live[slug], incomplete: true } : { status: "missing" },
    );
    await expect(resolve("new-york-jfk", "101")).resolves.toBeUndefined();
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it("an id whose airport owns a nearer namesake renders as before (the slug page would show that one)", async () => {
    // X and Z are both LGA's; LGA's bar-parking page renders Z, the nearer.
    const X2 = at(101, "Bar Parking", 40.88, -73.92);
    const Z = at(103, "Bar Parking", 40.8, -73.9);
    live["bar-parking"] = [X2, Z];
    ids["101"] = X2;
    await expect(resolve("new-york-lga", "101")).resolves.toBeUndefined();
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it("an owned namesake out of range does not hide an in-range one another airport owns", async () => {
    // A is LGA's but ~16 km out (beyond search range); B is ~10.5 km from LGA and JFK's.
    const A = at(104, "Hotel Lot", 40.92, -73.87);
    const B = at(105, "Hotel Lot", 40.7, -73.8);
    live["hotel-lot"] = [A, B];
    await expect(resolve("new-york-lga", "hotel-lot-lga")).rejects.toThrow("REDIRECT /new-york-jfk/airport-parking/hotel-lot");
  });
});
