import { describe, expect, it } from "vitest";
import redirects from "../blog-redirects.json";

// Flattened old-slug -> new-slug map read by the app's redirects() and the blog engine's duplicate
// guard (plan v3.2 W1.1, W2): no chains, no loops, slug -> slug only.
const map = redirects as Record<string, string>;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe("blog-redirects.json", () => {
  it("is a flat object of slug -> slug", () => {
    expect(Array.isArray(map)).toBe(false);
    for (const [from, to] of Object.entries(map)) {
      expect(from, `key ${from}`).toMatch(SLUG);
      expect(to, `value for ${from}`).toMatch(SLUG);
    }
  });
  it("has no chains: no key is also a destination", () => {
    const destinations = new Set(Object.values(map));
    for (const from of Object.keys(map)) expect(destinations.has(from), `${from} is both a source and a destination`).toBe(false);
  });
  it("has no loops", () => {
    for (const [from, to] of Object.entries(map)) expect(to, `${from} -> ${to}`).not.toBe(from);
  });
});
