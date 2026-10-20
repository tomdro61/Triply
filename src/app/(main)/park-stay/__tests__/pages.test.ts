import { beforeEach, describe, expect, it, vi } from "vitest";

const flags = { enabled: false, airports: new Set<string>() };
const viewerAllowed = vi.fn(async (_caller: string) => true);
vi.mock("@/lib/hotels/admin-preview", () => ({ parkStayViewerAllowed: (caller: string) => viewerAllowed(caller) }));
vi.mock("@/lib/hotels/flags", () => ({
  parkStayFlags: () => flags,
  isParkStayEnabledFor: (code: string) => flags.enabled && flags.airports.has(code.toUpperCase()),
}));

import ParkStayPage, { dynamic as searchPageDynamic } from "@/app/(main)/park-stay/page";
import ParkStayHotelPage, { dynamic as hotelPageDynamic } from "@/app/(main)/park-stay/[airport]/[hotelKey]/page";
import { dynamic as searchRouteDynamic } from "@/app/api/park-stay/search/route";
import { dynamic as hotelRouteDynamic } from "@/app/api/park-stay/hotel/route";
import { metadata } from "@/app/(main)/park-stay/layout";

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "digest" in err && String(err.digest).includes("404");
}

async function rejectsNotFound(fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect(isNotFound(err)).toBe(true);
    return;
  }
  throw new Error("expected notFound()");
}

const params = (airport: string, hotelKey: string) => ({ params: Promise.resolve({ airport, hotelKey }) });

beforeEach(() => {
  flags.enabled = false;
  flags.airports = new Set();
  viewerAllowed.mockReset();
  viewerAllowed.mockResolvedValue(true);
});

describe("Park & Stay pages (plan v3 §8.1)", () => {
  it("pages and API routes are force-dynamic, so a CDN never serves an admin's answer to anyone else (§20.1)", () => {
    for (const d of [searchPageDynamic, hotelPageDynamic, searchRouteDynamic, hotelRouteDynamic]) expect(d).toBe("force-dynamic");
  });

  it("are noindex / nofollow", () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });

  it("flag off → both pages 404 (the post-deploy negative control)", async () => {
    await rejectsNotFound(() => ParkStayPage());
    await rejectsNotFound(() => ParkStayHotelPage(params("jfk", "doubletree-jfk")));
  });

  it("flag on: the search page renders; unknown, disabled or other-airport hotel keys 404", async () => {
    flags.enabled = true;
    flags.airports = new Set(["JFK", "LGA", "EWR"]);
    expect(await ParkStayPage()).toBeTruthy();
    expect(await ParkStayHotelPage(params("jfk", "doubletree-jfk"))).toBeTruthy();
    await rejectsNotFound(() => ParkStayHotelPage(params("jfk", "nope")));
    await rejectsNotFound(() => ParkStayHotelPage(params("ewr", "red-carpet-inn-ewr")));
    await rejectsNotFound(() => ParkStayHotelPage(params("lga", "doubletree-jfk")));
    await rejectsNotFound(() => ParkStayHotelPage(params("bos", "doubletree-jfk")));
  });

  it("an allowlisted airport with no enabled hotel 404s", async () => {
    flags.enabled = true;
    flags.airports = new Set(["BOS"]);
    await rejectsNotFound(() => ParkStayPage());
  });

  it("flag on but not a signed-in admin → both pages 404 (the production preview, §20)", async () => {
    flags.enabled = true;
    flags.airports = new Set(["JFK", "LGA", "EWR"]);
    viewerAllowed.mockResolvedValue(false);
    await rejectsNotFound(() => ParkStayPage());
    await rejectsNotFound(() => ParkStayHotelPage(params("jfk", "doubletree-jfk")));
    expect(viewerAllowed).toHaveBeenCalledTimes(2);
  });
});
