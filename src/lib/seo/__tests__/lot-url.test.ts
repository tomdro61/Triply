/**
 * resolveLotUrl — real 404 / 308 for dead and old-slug lot URLs, decided
 * before the lot page streams (soft-404 fix, 10 Nov 2026).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const nav = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  permanentRedirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));
vi.mock("next/navigation", () => nav);

const status = vi.hoisted(() => ({ lotSlugStatus: vi.fn() }));
vi.mock("@/lib/reslab/get-lot", () => status);

import { resolveLotUrl } from "../lot-url";

const live = new Set(["EWR:snap-parking", "JFK:bolt-parking", "EWR:snap-parking-ewr-long-term"]);
beforeEach(() => {
  nav.notFound.mockClear();
  nav.permanentRedirect.mockClear();
  status.lotSlugStatus.mockReset();
  status.lotSlugStatus.mockImplementation(async (slug: string, code: string) =>
    live.has(`${code}:${slug}`) ? "exists" : "missing",
  );
});

describe("resolveLotUrl", () => {
  it("a live slug renders (no 404, no redirect)", async () => {
    await expect(resolveLotUrl("new-york-ewr", "snap-parking", {})).resolves.toBeUndefined();
  });

  it("an old code-suffixed slug 308s to the live slug, query kept", async () => {
    await expect(
      resolveLotUrl("new-york-ewr", "snap-parking-ewr", { checkin: "2026-11-20", checkout: "2026-11-24" }),
    ).rejects.toThrow("REDIRECT /new-york-ewr/airport-parking/snap-parking?checkin=2026-11-20&checkout=2026-11-24");
  });

  it("redirects to the airport the suffix names (old LGA URL for a JFK lot)", async () => {
    await expect(resolveLotUrl("new-york-lga", "bolt-parking-jfk", {})).rejects.toThrow(
      "REDIRECT /new-york-jfk/airport-parking/bolt-parking",
    );
  });

  it("a dead slug with no live code-less twin is a real 404", async () => {
    await expect(resolveLotUrl("boston-bos", "preflight-airport-parking", {})).rejects.toThrow("NOT_FOUND");
    await expect(resolveLotUrl("chicago-ord", "days-inn-ord", {})).rejects.toThrow("NOT_FOUND");
    expect(nav.permanentRedirect).not.toHaveBeenCalled();
  });

  it("a suffix that is not an airport code is not stripped", async () => {
    await expect(resolveLotUrl("new-york-ewr", "snap-parking-xyz", {})).rejects.toThrow("NOT_FOUND");
    expect(status.lotSlugStatus).toHaveBeenCalledTimes(1);
  });

  it("unknown (thin list, failed read) renders the page as before — never a 404 on a guess", async () => {
    status.lotSlugStatus.mockResolvedValue("unknown");
    await expect(resolveLotUrl("new-york-ewr", "snap-parking-ewr", {})).resolves.toBeUndefined();
  });

  it("an unknown airport is a 404 without a lot lookup", async () => {
    await expect(resolveLotUrl("nowhere-xxx", "snap-parking", {})).rejects.toThrow("NOT_FOUND");
    expect(status.lotSlugStatus).not.toHaveBeenCalled();
  });
});
