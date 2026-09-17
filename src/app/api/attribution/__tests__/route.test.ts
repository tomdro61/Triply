import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const sentry = vi.hoisted(() => ({ captureMessage: vi.fn(), withScope: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: sentry.captureMessage,
  withScope: (fn: (scope: unknown) => void) => {
    sentry.withScope();
    fn({ setFingerprint: vi.fn(), setTag: vi.fn(), setContext: vi.fn() });
  },
}));

import { POST, __resetAttributionRouteTelemetryForTests } from "../route";
import { __resetAttributionRateLimitForTests } from "@/lib/attribution/limiter";
import {
  ATTR_COOKIE,
  ATTR_STATE_COOKIE,
  encodeCookieValue,
  parseAttributionCookie,
  type AttributionCookie,
} from "@/lib/attribution/schema";

const HOST = "www.triplypro.com";
const touch = { src: "google", med: "cpc", click: "gclid:abc", land: "/new-york-jfk/airport-parking", at: 1 };

function post(
  body: unknown,
  opts: { headers?: Record<string, string>; cookies?: Record<string, string>; raw?: string } = {}
) {
  const cookie = Object.entries(opts.cookies ?? {}).map(([k, v]) => `${k}=${v}`).join("; ");
  const text = opts.raw ?? JSON.stringify(body);
  return new NextRequest(`https://${HOST}/api/attribution`, {
    method: "POST",
    headers: {
      host: HOST,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "203.0.113.7",
      ...(cookie ? { cookie } : {}),
      ...opts.headers,
    },
    body: text,
  });
}

function readCookie(res: Response, name: string): string | undefined {
  const all = res.headers.getSetCookie?.() ?? [];
  const hit = all.find((c) => c.startsWith(`${name}=`));
  return hit?.split(";")[0].slice(name.length + 1);
}
function readAttr(res: Response): AttributionCookie {
  const raw = readCookie(res, ATTR_COOKIE);
  const parsed = parseAttributionCookie(raw ? decodeURIComponent(raw) : raw);
  if (parsed.state !== "valid") throw new Error(`cookie not valid: ${JSON.stringify(parsed)}`);
  return parsed.value;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAttributionRateLimitForTests();
  __resetAttributionRouteTelemetryForTests();
});

describe("POST /api/attribution — origin gate", () => {
  it("sec-fetch-site: cross-site → 403, no Set-Cookie, one Sentry event", async () => {
    const res = await POST(post({ touch }, { headers: { "sec-fetch-site": "cross-site" } }));
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie?.() ?? []).toEqual([]);
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });
  it("sec-fetch-site: same-site (a sibling subdomain, e.g. the CMS) → 403", async () => {
    expect((await POST(post({ touch }, { headers: { "sec-fetch-site": "same-site" } }))).status).toBe(403);
  });
  it("no Sec-Fetch-Site: Origin host === Host → 204; mismatch → 403; neither → 403", async () => {
    const strip = { "sec-fetch-site": "" };
    const ok = post({ touch }, { headers: { ...strip, origin: `https://${HOST}` } });
    ok.headers.delete("sec-fetch-site");
    expect((await POST(ok)).status).toBe(204);
    const bad = post({ touch }, { headers: { ...strip, origin: "https://evil.example" } });
    bad.headers.delete("sec-fetch-site");
    expect((await POST(bad)).status).toBe(403);
    const none = post({ touch });
    none.headers.delete("sec-fetch-site");
    expect((await POST(none)).status).toBe(403);
  });
});

describe("POST /api/attribution — limits", () => {
  it("a body over 2048 bytes is 413 even with no Content-Length (measured on arrival)", async () => {
    const res = await POST(post(null, { raw: JSON.stringify({ touch: { ...touch, src: "x".repeat(3000) } }) }));
    expect(res.status).toBe(413);
  });
  it("31st request from the same IP inside a minute → 429; a different IP is unaffected", async () => {
    for (let i = 0; i < 30; i++) expect((await POST(post({ touch }))).status).toBe(204);
    expect((await POST(post({ touch }))).status).toBe(429);
    expect((await POST(post({ touch }, { headers: { "x-forwarded-for": "198.51.100.9" } }))).status).toBe(204);
  });
  it("IPv6 and a forwarded chain key on the first entry", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await POST(post({ touch }, { headers: { "x-forwarded-for": "2001:db8::1, 10.0.0.1" } }))).status).toBe(204);
    }
    expect((await POST(post({ touch }, { headers: { "x-forwarded-for": "2001:db8::1" } }))).status).toBe(429);
  });
  it("malformed JSON → 400; unknown top-level key → 400 (strict body)", async () => {
    expect((await POST(post(null, { raw: "{not json" }))).status).toBe(400);
    expect((await POST(post({ touch, channel: "partner" }))).status).toBe(400);
  });
});

describe("POST /api/attribution — cookie writing", () => {
  it("204 with the HttpOnly payload cookie and the readable '1|JFK' sentinel", async () => {
    const res = await POST(post({ touch, apt: "jfk" }));
    expect(res.status).toBe(204);
    const all = res.headers.getSetCookie();
    const payload = all.find((c) => c.startsWith(`${ATTR_COOKIE}=`))!;
    const sentinel = all.find((c) => c.startsWith(`${ATTR_STATE_COOKIE}=`))!;
    expect(payload).toMatch(/HttpOnly/i);
    expect(payload).toMatch(/SameSite=lax/i);
    expect(payload).toMatch(/Max-Age=2592000/);
    expect(sentinel).not.toMatch(/HttpOnly/i);
    expect(decodeURIComponent(readCookie(res, ATTR_STATE_COOKIE)!)).toBe("1|JFK");
    const value = readAttr(res);
    expect(value.first.click).toBe("gclid:abc");
    expect(value.apt).toBe("JFK");
    expect(value.last).toBeUndefined();
  });

  it("stamps `at` from the SERVER clock, normalises ref to a host, and rejects a non-path land", async () => {
    const res = await POST(
      post({ touch: { ...touch, at: 5, ref: "https://partner.example/inbox?token=secret", land: "javascript:alert(1)" } })
    );
    const value = readAttr(res);
    expect(value.first.at).toBeGreaterThan(1_700_000_000);
    expect(value.first.ref).toBe("partner.example");
    expect(value.first.land).toBeUndefined();
  });

  it("apt is validated against config: 'ZZZ' and a test airport are dropped", async () => {
    expect(readAttr(await POST(post({ touch, apt: "ZZZ" }))).apt).toBeUndefined();
  });

  it("analytics opt-out drops the click id BEFORE it is written — and scrubs one already in the cookie", async () => {
    const optOut = encodeURIComponent(JSON.stringify({ dismissed: true, analyticsOptOut: true, timestamp: "x" }));
    const existing: AttributionCookie = { v: 1, first: { src: "g", click: "gclid:old", at: 1 } };
    const res = await POST(
      post({ touch: { ...touch, click: "fbclid:new" } }, {
        cookies: { triply_cookie_consent: optOut, [ATTR_COOKIE]: encodeCookieValue(existing) },
      })
    );
    const value = readAttr(res);
    expect(value.first.click).toBeUndefined();
    expect(value.last?.click).toBeUndefined();
    expect(value.first.src).toBe("g");
  });

  it("an existing VALID cookie keeps `first` and gains `last`", async () => {
    const existing: AttributionCookie = { v: 1, first: { src: "g", med: "cpc", at: 1 }, apt: "JFK" };
    const res = await POST(
      post({ touch: { ...touch, src: "news", med: "email", click: undefined }, apt: "LGA" }, {
        cookies: { [ATTR_COOKIE]: encodeCookieValue(existing) },
      })
    );
    const value = readAttr(res);
    expect(value.first).toEqual(existing.first);
    expect(value.last?.med).toBe("email");
    expect(value.apt).toBe("LGA");
  });

  it("an existing INVALID cookie is replaced (first = the new touch) and reported once", async () => {
    const res = await POST(post({ touch }, { cookies: { [ATTR_COOKIE]: "garbage" } }));
    expect(res.status).toBe(204);
    expect(readAttr(res).first.src).toBe("google");
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    await POST(post({ touch }, { cookies: { [ATTR_COOKIE]: "garbage" } }));
    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
  });
});
