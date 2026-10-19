import { beforeEach, describe, expect, it, vi } from "vitest";

const flags = { enabled: false, airports: new Set<string>() };
vi.mock("@/lib/hotels/flags", () => ({
  parkStayFlags: () => flags,
  isParkStayEnabledFor: (code: string) => flags.enabled && flags.airports.has(code.toUpperCase()),
}));

import ParkStayPage from "@/app/(main)/park-stay/page";
import ParkStayHotelPage from "@/app/(main)/park-stay/[airport]/[hotelKey]/page";
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
});

describe("Park & Stay pages (plan v3 §8.1)", () => {
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
    expect(ParkStayPage()).toBeTruthy();
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
});
