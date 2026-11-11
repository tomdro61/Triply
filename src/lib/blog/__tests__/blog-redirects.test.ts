import { describe, expect, it } from "vitest";
import { buildBlogRedirects, resolveBlogHref, validateBlogRedirectMap } from "../blog-redirects.mjs";
import liveMap from "../../../config/blog-redirects.json";

const map = { "ewr-parking-prices": "newark-airport-parking-rates" };

describe("buildBlogRedirects", () => {
  it("maps each old slug to a permanent (308) redirect", () => {
    expect(buildBlogRedirects(map)).toEqual([
      { source: "/blog/ewr-parking-prices", destination: "/blog/newark-airport-parking-rates", permanent: true },
    ]);
  });
  it("builds one 308 per entry of the committed map (Nov 2026: deleted-post 404 rescues, no W2 merges yet)", () => {
    const map = liveMap as Record<string, string>;
    const built = buildBlogRedirects(map);
    expect(built).toHaveLength(Object.keys(map).length);
    for (const r of built) {
      expect(r.source).toMatch(/^\/blog\/[a-z0-9-]+$/);
      expect(r.destination).toMatch(/^\/blog\/[a-z0-9-]+$/);
      expect(r.permanent).toBe(true);
    }
  });
  it("fails the build on a self-redirect, a chain, a bad slug or a non-object map", () => {
    expect(() => buildBlogRedirects({ a: "a" })).toThrow(/redirects to itself/);
    expect(() => buildBlogRedirects({ a: "b", b: "c" })).toThrow(/chain/);
    expect(() => buildBlogRedirects({ "Bad Slug": "b" })).toThrow(/not a slug/);
    expect(() => buildBlogRedirects({ a: "b/c" })).toThrow(/not a slug/);
    expect(validateBlogRedirectMap([])).toEqual(["must be a flat { oldSlug: newSlug } object"]);
    expect(validateBlogRedirectMap({ a: "b", c: "b" })).toEqual([]);
  });
});

describe("resolveBlogHref", () => {
  it.each([
    ["/blog/ewr-parking-prices", "/blog/newark-airport-parking-rates"],
    ["/blog/ewr-parking-prices/", "/blog/newark-airport-parking-rates/"],
    ["/blog/ewr-parking-prices#rates", "/blog/newark-airport-parking-rates#rates"],
    ["/blog/ewr-parking-prices/?utm=x#a", "/blog/newark-airport-parking-rates/?utm=x#a"],
    ["https://www.triplypro.com/blog/ewr-parking-prices", "https://www.triplypro.com/blog/newark-airport-parking-rates"],
    ["https://triplypro.com/blog/EWR-parking-prices", "https://triplypro.com/blog/newark-airport-parking-rates"],
  ])("swaps %s", (href, want) => {
    expect(resolveBlogHref(href, map)).toBe(want);
  });

  it.each([
    "/blog/newark-airport-parking-rates",
    "/blog/ewr-parking-prices-2",
    "https://example.com/blog/ewr-parking-prices",
    "/newark-ewr/airport-parking",
    "mailto:hi@triplypro.com",
    "/blog/constructor",
    "/blog/x/sub",
  ])("leaves %s alone", (href) => {
    expect(resolveBlogHref(href, map)).toBe(href);
  });

  it("passes undefined through", () => {
    expect(resolveBlogHref(undefined, map)).toBeUndefined();
  });
});
