import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HOTEL_PHOTO_HOSTS, safePhotoUrl } from "../photo-hosts";

describe("safePhotoUrl", () => {
  it("passes an allowlisted https URL through unchanged", () => {
    expect(safePhotoUrl("https://static.cupid.travel/hotels/516916303.jpg")).toEqual({
      url: "https://static.cupid.travel/hotels/516916303.jpg",
      rejectedHost: null,
    });
  });
  it("rejects other hosts, http, subdomains and garbage — placeholder, never a CSP violation", () => {
    expect(safePhotoUrl("https://evil.example/x.jpg")).toEqual({ url: null, rejectedHost: "evil.example" });
    expect(safePhotoUrl("http://static.cupid.travel/x.jpg").url).toBeNull();
    expect(safePhotoUrl("https://cdn.static.cupid.travel/x.jpg").url).toBeNull(); // exact hostnames, no wildcards
    expect(safePhotoUrl("not a url")).toEqual({ url: null, rejectedHost: "<unparseable>" });
    expect(safePhotoUrl(null)).toEqual({ url: null, rejectedHost: null });
  });
});

describe("the allowlist is mirrored in next.config.mjs (remotePatterns AND CSP img-src)", () => {
  // next.config.mjs cannot import TypeScript, so the three lists are kept in
  // sync by this test rather than by a shared import.
  const config = readFileSync(fileURLToPath(new URL("../../../../next.config.mjs", import.meta.url)), "utf8");
  for (const host of HOTEL_PHOTO_HOSTS) {
    it(`${host} is in images.remotePatterns`, () => {
      expect(config).toMatch(new RegExp(`hostname:\\s*"${host.replace(/\./g, "\\.")}"`));
    });
    it(`${host} is in the CSP img-src`, () => {
      const imgSrc = /img-src[^"]*"/.exec(config)?.[0] ?? "";
      expect(imgSrc).toContain(`https://${host}`);
    });
  }
});
