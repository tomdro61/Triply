/**
 * safeRedirectPath — where a person goes after signing in. The value comes from
 * the URL (login `?redirect=`, callback `?next=`), so only a page of our own
 * site passes; anything else becomes "/".
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { safeRedirectPath } from "../safe-redirect";

const ORIGIN = "https://www.triplypro.com";
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);
const E_ACUTE = "é"; // "é": 1 character raw, 6 once percent-encoded

describe("safeRedirectPath keeps our own pages", () => {
  it.each([
    "/",
    "/account",
    "/reservations",
    "/admin",
    "/partner",
    "/confirmation/RTL123",
    "/search?airport=JFK&checkin=2026-12-01",
    "/blog/x#faq",
    "/blog/a%20b",
  ])("%s", (value) => {
    expect(safeRedirectPath(value)).toBe(value);
  });
});

describe("safeRedirectPath sends everything else to the homepage", () => {
  it.each([
    ["missing", null],
    ["undefined", undefined],
    ["empty", ""],
    ["protocol-relative", "//evil.example"],
    ["backslash after the slash", "/\\evil.example"],
    ["two backslashes", "\\\\evil.example"],
    ["dot segment before //", "/.//evil.example"],
    ["parent segment before //", "/a/..//evil.example"],
    ["encoded dot segment before //", "/%2e//evil.example"],
    ["full address", "https://evil.example"],
    ["script", "javascript:alert(1)"],
    ["script, upper case", "JAVASCRIPT:alert(1)"],
    ["bare host", "evil.example"],
    ["the login page", "/auth/login"],
    ["the login page, trailing slash", "/auth/login/"],
    ["the login page with a query", "/auth/login?redirect=/account"],
    ["the sign-in callback", "/auth/callback?next=/x"],
    ["too long", "/" + "a".repeat(3000)],
  ])("%s", (_label, value) => {
    expect(safeRedirectPath(value)).toBe("/");
  });

  // Each row is refused by one rule only, so removing that rule fails here.
  it.each([
    ["backslash in the path", "/a\\b"],
    ["backslash in the query", "/x?q=a\\b"],
    ["space in the path", "/a b"],
    ["space in the query", "/x?q=a b"],
    ["NUL", `/a${NUL}b`],
    ["DEL", `/a${DEL}b`],
    ["tab", "/a\tb"],
    ["newline", "/a\nb"],
    ["protocol-relative to the parse base", "//triply.invalid/admin"],
    ["full address on the parse base", "https://triply.invalid/admin"],
  ])("%s (one rule only)", (_label, value) => {
    expect(safeRedirectPath(value)).toBe("/");
  });

  it("keeps a path of exactly 2048 characters and refuses 2049", () => {
    const longest = "/" + "a".repeat(2047);
    expect(safeRedirectPath(longest)).toBe(longest);
    expect(safeRedirectPath(longest + "a")).toBe("/");
  });

  // The cap applies to the normalised path. Capping the raw input let a short
  // path that grows when encoded pass the login page and fail the callback.
  it("caps the encoded length, so the callback's second pass agrees", () => {
    expect(safeRedirectPath("/" + E_ACUTE.repeat(400))).toBe("/"); // 401 raw, 2,401 encoded

    const out = safeRedirectPath("/blog?q=" + E_ACUTE.repeat(300)); // 1,808 encoded
    expect(out).toBe("/blog?q=" + "%C3%A9".repeat(300));
    const callback = new URL(`${ORIGIN}/auth/callback?next=${encodeURIComponent(out)}`);
    expect(safeRedirectPath(callback.searchParams.get("next"))).toBe(out);
  });
});

/**
 * The value checked is the value used: the helper returns the path it parsed,
 * not the raw input, so a consumer never re-reads dot segments or raw
 * characters in a form the checks didn't see.
 */
describe("safeRedirectPath returns the normalised path", () => {
  it.each([
    ["/a/../account", "/account"],
    ["/./account", "/account"],
    ["/%2e%2e/account", "/account"],
    [`/caf${E_ACUTE}`, "/caf%C3%A9"],
  ])("%s becomes %s", (value, expected) => {
    expect(safeRedirectPath(value)).toBe(expected);
  });
});

/**
 * Whatever the helper accepts must stay on our site wherever it is used:
 * pushed by the login page (resolved against the page's own URL) and
 * redirected by the server. And a second pass, which the callback makes after
 * Google or the sign-up email, must not change it.
 */
describe("safeRedirectPath output always stays on our site", () => {
  const PIECES = [
    "/", "\\", ".", "%", "2e", "2F", "5C", ":", "@", "?", "#",
    "\t", "\n", " ", "／", "∕", E_ACUTE, "a", "evil.example",
  ];

  // Deterministic, so a failure reproduces.
  function* inputs(count: number): Generator<string> {
    let seed = 20261108;
    // 32-bit LCG (Math.imul keeps it exact); the high bits are the random ones.
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 8;
    };
    for (let i = 0; i < count; i++) {
      const length = 1 + (next() % 8);
      let value = next() % 4 === 0 ? "" : "/";
      for (let j = 0; j < length; j++) value += PIECES[next() % PIECES.length];
      yield value;
    }
  }

  it("never leaves the site, and survives the callback round trip unchanged", () => {
    let accepted = 0;
    for (const value of inputs(20000)) {
      const out = safeRedirectPath(value);
      if (out !== "/") accepted++;

      expect(new URL(out, `${ORIGIN}/auth/login?redirect=x`).origin, value).toBe(ORIGIN);
      expect(new URL(out, ORIGIN).origin, value).toBe(ORIGIN);

      const callback = new URL(`${ORIGIN}/auth/callback?next=${encodeURIComponent(out)}`);
      expect(safeRedirectPath(callback.searchParams.get("next")), value).toBe(out);
      expect(safeRedirectPath(out), value).toBe(out);
    }
    // Not vacuous: plenty of inputs are real paths that pass.
    expect(accepted).toBeGreaterThan(1000);
  });
});

/**
 * Every read of a sign-in destination goes through the helper. A raw
 * `.get("redirect")` / `.get("next")` handed to router.push or a redirect is
 * how a link sends someone off-site after they sign in.
 */
describe("no unchecked sign-in destination", () => {
  const SRC = path.resolve(__dirname, "../../..");

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it('every .get("redirect") and .get("next") is wrapped in safeRedirectPath', () => {
    const READ = /\.get\(\s*(["'`])(redirect|next)\1\s*\)/g;
    // The cleaned value is used as is: `x = safeRedirectPath(params.get("next"))`.
    // A call wrapped around it (decodeURIComponent, say) can undo the cleaning:
    // "/%2F%2Fhost" is on our site, its decoded form "///host" is not.
    const WRAPPED = /(?:=>?|return)\s*safeRedirectPath\(\s*[\w.]+$/;
    const offenders: string[] = [];
    const readers = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(READ)) {
        readers.add(path.relative(SRC, file).split(path.sep).join("/"));
        if (!WRAPPED.test(text.slice(0, match.index))) {
          offenders.push(`${path.relative(SRC, file)}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Pinned by file, not by count: a read moved behind a constant key must
    // fail here even when a new read elsewhere keeps the count up.
    expect([...readers]).toEqual(
      expect.arrayContaining(["app/(main)/auth/login/page.tsx", "app/(main)/auth/callback/route.ts"])
    );
  });
});
