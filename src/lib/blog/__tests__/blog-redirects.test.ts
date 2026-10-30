import { describe, expect, it } from "vitest";
import { buildBlogRedirects, resolveBlogHref } from "../blog-redirects.mjs";
import liveMap from "../../../config/blog-redirects.json";

const map = { "ewr-parking-prices": "newark-airport-parking-rates" };

describe("buildBlogRedirects", () => {
  it("maps each old slug to a permanent (308) redirect", () => {
    expect(buildBlogRedirects(map)).toEqual([
      { source: "/blog/ewr-parking-prices", destination: "/blog/newark-airport-parking-rates", permanent: true },
    ]);
  });
  it("is empty for the committed map (nothing merged yet)", () => {
    expect(buildBlogRedirects(liveMap as Record<string, string>)).toEqual([]);
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
  ])("leaves %s alone", (href) => {
    expect(resolveBlogHref(href, map)).toBe(href);
  });

  it("passes undefined through", () => {
    expect(resolveBlogHref(undefined, map)).toBeUndefined();
  });
});
