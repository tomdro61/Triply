import { describe, expect, it } from "vitest";
import { welcomeBookLabel, welcomeBookUrl } from "../welcome-link";

describe("welcomeBookUrl", () => {
  it("sends a known, sellable airport to its search with email UTMs", () => {
    const url = new URL(welcomeBookUrl("DFW"));
    expect(url.origin).toBe("https://www.triplypro.com");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("airport")).toBe("DFW");
    expect(url.searchParams.get("utm_source")).toBe("triply");
    expect(url.searchParams.get("utm_medium")).toBe("email");
    expect(url.searchParams.get("utm_campaign")).toBe("welcome");
    expect(url.searchParams.get("utm_content")).toBe("book_now");
  });

  it("falls back to the homepage (still tagged) when no airport is known", () => {
    for (const code of [undefined, null, "", "ZZZ"]) {
      const url = new URL(welcomeBookUrl(code));
      expect(url.pathname).toBe("/");
      expect(url.searchParams.has("airport")).toBe(false);
      expect(url.searchParams.get("utm_campaign")).toBe("welcome");
    }
  });

  it("falls back to the homepage for an airport we don't sell", () => {
    expect(new URL(welcomeBookUrl("TEST-NY")).pathname).toBe("/");
  });
});

describe("welcomeBookLabel", () => {
  it("names the airport when known, generic otherwise", () => {
    expect(welcomeBookLabel("DFW")).toBe("Book DFW parking &amp; save 10%");
    expect(welcomeBookLabel(undefined)).toBe("Book Now &amp; Save 10%");
  });
});
