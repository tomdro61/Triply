import { beforeEach, describe, expect, it, vi } from "vitest";

const getLotById = vi.fn();
vi.mock("@/lib/reslab/get-lot", () => ({ getLotById: (...args: unknown[]) => getLotById(...args) }));
// The root layout builds its font at module scope; only its title template is under test.
vi.mock("next/font/google", () => ({ Inter: () => ({ variable: "" }), Poppins: () => ({ variable: "" }) }));

const resolveLotUrl = vi.fn();
vi.mock("@/lib/seo/lot-url", () => ({ resolveLotUrl: (...args: unknown[]) => resolveLotUrl(...args) }));

import LotPage, { generateMetadata } from "@/app/(main)/[slug]/airport-parking/[lot]/page";
import { metadata as rootMetadata } from "@/app/layout";
import { DirectInventoryUnavailableError } from "@/lib/direct/errors";

const props = (slug: string, lot: string, search: Record<string, string> = {}) => ({
  params: Promise.resolve({ slug, lot }),
  searchParams: Promise.resolve(search),
});

const redRoof = { name: "Red Roof Inn Allentown Airport", slug: "red-roof-inn-allentown-airport", photos: [] };

beforeEach(() => {
  getLotById.mockReset();
  getLotById.mockResolvedValue(redRoof);
});

describe("lot page metadata", () => {
  it("canonical is the bare sitemap path (metadataBase makes it absolute), built from lot.slug", async () => {
    const meta = await generateMetadata(props("allentown-abe", "red-roof-inn-allentown-airport") as never);
    expect(meta.alternates?.canonical).toBe(
      "/allentown-abe/airport-parking/red-roof-inn-allentown-airport"
    );
  });

  it("date params and an id-style segment fold into the same canonical", async () => {
    const meta = await generateMetadata(
      props("allentown-abe", "12345", { checkin: "2026-11-01", checkout: "2026-11-08" }) as never
    );
    expect(meta.alternates?.canonical).toBe(
      "/allentown-abe/airport-parking/red-roof-inn-allentown-airport"
    );
  });

  it("titles leave the brand suffix to the root template (no '| Triply | Triply')", async () => {
    const template = (rootMetadata.title as { template: string }).template;
    expect(template).toBe("%s | Triply");
    const meta = await generateMetadata(props("allentown-abe", "red-roof-inn-allentown-airport") as never);
    expect(template.replace("%s", meta.title as string)).toBe(
      "Red Roof Inn Allentown Airport - ABE Airport Parking | Triply"
    );
  });

  it("metadata never prices: Googlebot waits on it (htmlLimitedBots) and no field uses a price", async () => {
    await generateMetadata(props("allentown-abe", "red-roof-inn-allentown-airport") as never);
    const pricingWindowFor = getLotById.mock.calls[0][4] as (loc: unknown) => unknown;
    expect(pricingWindowFor({ id: 1 })).toBeNull();
  });

  it("not-found and unavailable states carry no canonical and no suffix", async () => {
    getLotById.mockResolvedValue(null);
    const missing = await generateMetadata(props("allentown-abe", "nope") as never);
    expect(missing).toEqual({ title: "Parking Not Found" });

    getLotById.mockRejectedValue(new DirectInventoryUnavailableError("down", "unavailable"));
    const down = await generateMetadata(props("allentown-abe", "red-roof-inn-allentown-airport") as never);
    expect(down).toEqual({ title: "Parking Temporarily Unavailable" });
  });
});

describe("lot page status decision", () => {
  // The 404 / 308 is only a real HTTP status while resolveLotUrl runs BEFORE
  // the Suspense boundary. Moved into LotPageContent, every dead or old lot
  // URL is a streamed 200 soft 404 again with no other test failing.
  beforeEach(() => {
    resolveLotUrl.mockReset();
  });

  it("awaits resolveLotUrl before returning the page, with the URL's airport, lot and query", async () => {
    resolveLotUrl.mockResolvedValue(undefined);
    await LotPage(props("new-york-ewr", "snap-parking-ewr", { checkin: "2026-11-20" }) as never);
    expect(resolveLotUrl).toHaveBeenCalledWith("new-york-ewr", "snap-parking-ewr", { checkin: "2026-11-20" });
  });

  it("a 404 or 308 thrown by resolveLotUrl escapes the page (it is not caught or deferred)", async () => {
    resolveLotUrl.mockImplementation(async () => {
      throw new Error("NOT_FOUND");
    });
    await expect(LotPage(props("boston-bos", "gone-lot") as never)).rejects.toThrow("NOT_FOUND");
  });
});
