import { beforeEach, describe, expect, it, vi } from "vitest";

const getLotById = vi.fn();
vi.mock("@/lib/reslab/get-lot", () => ({ getLotById: (...args: unknown[]) => getLotById(...args) }));
// The root layout builds its font at module scope; only its title template is under test.
vi.mock("next/font/google", () => ({ Inter: () => ({ variable: "" }), Poppins: () => ({ variable: "" }) }));

import { generateMetadata } from "@/app/(main)/[slug]/airport-parking/[lot]/page";
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

  it("not-found and unavailable states carry no canonical and no suffix", async () => {
    getLotById.mockResolvedValue(null);
    const missing = await generateMetadata(props("allentown-abe", "nope") as never);
    expect(missing).toEqual({ title: "Parking Not Found" });

    getLotById.mockRejectedValue(new DirectInventoryUnavailableError("down", "unavailable"));
    const down = await generateMetadata(props("allentown-abe", "red-roof-inn-allentown-airport") as never);
    expect(down).toEqual({ title: "Parking Temporarily Unavailable" });
  });
});
