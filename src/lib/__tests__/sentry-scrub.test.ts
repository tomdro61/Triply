import { describe, it, expect } from "vitest";
import { scrubEventCredentials, scrubUrlCredentials } from "../sentry-scrub";

/** The scrubbed event, failing the test if it was dropped. */
function scrub<T extends object>(event: T): T {
  const out = scrubEventCredentials(event);
  if (out === null) throw new Error("event was dropped");
  return out;
}

const TOKEN = "3f2b8c1e-9a4d-4e2b-8c7a-1d2e3f4a5b6c.1797465600.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const HOOK = "https://discord.com/api/webhooks/1/AbC-def_123XYZ";
const SCRUBBED = "https://discord.com/api/webhooks/1/[token]";

describe("sentry-scrub", () => {
  it("removes the review token from paths and token= from queries", () => {
    expect(scrubUrlCredentials(`https://www.triplypro.com/review/${TOKEN}?r=4`)).toBe(
      "https://www.triplypro.com/review/[token]?r=4"
    );
    expect(scrubUrlCredentials("/api/reviews/unsubscribe?id=abc&token=secret123")).toBe(
      "/api/reviews/unsubscribe?id=abc&token=[redacted]"
    );
    // The token-free page is left alone.
    expect(scrubUrlCredentials("https://www.triplypro.com/review?r=4")).toBe("https://www.triplypro.com/review?r=4");
  });

  it("scrubs a query_string where the token comes first (Sentry drops the leading ?)", () => {
    expect(scrubUrlCredentials("token=abc123&id=x")).toBe("token=[redacted]&id=x");
  });

  it("removes a Discord webhook token whatever the id looks like; leaves our Stripe route alone", () => {
    expect(scrubUrlCredentials(`https://discord.com/api/webhooks/1563293029723545644/AbC-def_123XYZ?wait=true`)).toBe(
      "https://discord.com/api/webhooks/1563293029723545644/[token]?wait=true"
    );
    expect(scrubUrlCredentials("https://discord.com/api/v10/webhooks/1/AbC-def_123XYZ")).toBe("https://discord.com/api/v10/webhooks/1/[token]");
    // A mistyped id still carries a real token.
    expect(scrubUrlCredentials("https://discord.com/api/webhooks/1234x/AbC-def_123XYZ")).toBe("https://discord.com/api/webhooks/1234x/[token]");
    expect(scrubUrlCredentials("https://www.triplypro.com/api/webhooks/stripe")).toBe("https://www.triplypro.com/api/webhooks/stripe");
  });

  it("scrubs every string in a transaction event, including spans and breadcrumbs", () => {
    const event = {
      transaction: `GET /review/${TOKEN}`,
      request: { url: `https://www.triplypro.com/review/${TOKEN}` },
      spans: [{ description: `POST ${HOOK}`, data: { "http.target": `/review/${TOKEN}?r=5`, url: HOOK } }],
      breadcrumbs: [{ category: "fetch", data: { url: `${HOOK}?wait=true`, status_code: 500, n: 1 } }],
    };
    const out = scrub(event);
    const text = JSON.stringify(out);
    expect(text).not.toContain(TOKEN.split(".")[2]);
    expect(text).not.toContain("AbC-def_123XYZ");
    expect(out.request.url).toBe("https://www.triplypro.com/review/[token]");
    expect(out.breadcrumbs[0].data).toEqual({ url: `${SCRUBBED}?wait=true`, status_code: 500, n: 1 });
  });

  it("frozen objects, a frozen event and arrays: the result is a scrubbed plain copy", () => {
    const event = Object.freeze({ request: { headers: Object.freeze({ referer: HOOK, accept: "*/*" }) }, c: Object.freeze([HOOK, "x"]) });
    expect(scrub(event)).toEqual({ request: { headers: { referer: SCRUBBED, accept: "*/*" } }, c: [SCRUBBED, "x"] });
  });

  it("[codex] one frozen object referenced twice: BOTH references are scrubbed", () => {
    const shared = Object.freeze({ url: HOOK });
    expect(JSON.stringify(scrub({ request: { headers: shared, data: shared } }))).not.toContain("AbC-def_123XYZ");
  });

  it("[codex] a value that only serialisation reveals (a URL object's toJSON) is scrubbed", () => {
    const out = scrub({ attributes: { url: new URL(HOOK) } });
    expect(out.attributes.url).toBe(SCRUBBED);
  });

  it("[codex] a getter is read once, and what it returned is what gets scrubbed", () => {
    let reads = 0;
    const event = Object.defineProperty({}, "data", { enumerable: true, get: () => ({ url: HOOK, n: ++reads }) });
    expect(JSON.stringify(scrub(event))).not.toContain("AbC-def_123XYZ");
    expect(reads).toBe(1);
  });

  it("a cycle is serialised with [Circular], scrubbed, and kept", () => {
    const a: Record<string, unknown> = { url: HOOK };
    a.self = a;
    expect(scrub({ extra: a }).extra).toEqual({ url: SCRUBBED, self: "[Circular]" });
  });

  it("on the cycle retry, a SHARED (non-cyclic) object keeps its data both times; a BigInt becomes a string", () => {
    const shared = { a: 1, url: HOOK };
    const me: Record<string, unknown> = {};
    me.me = me;
    const out = scrub({ extra: { s1: shared, s2: shared, me, n: BigInt(10) } });
    expect(out.extra).toEqual({ s1: { a: 1, url: SCRUBBED }, s2: { a: 1, url: SCRUBBED }, me: { me: "[Circular]" }, n: "10" });
  });

  it("[codex] anything that can't be serialised (a throwing getter, extreme depth) is DROPPED, never sent unscrubbed", () => {
    const tricky = Object.defineProperty({ url: HOOK }, "bad", { enumerable: true, get() { throw new Error("boom"); } });
    expect(scrubEventCredentials({ extra: tricky })).toBeNull();
    let deep: Record<string, unknown> = { url: HOOK };
    for (let i = 0; i < 20_000; i++) deep = { d: deep };
    expect(scrubEventCredentials({ request: { data: deep, url: HOOK } })).toBeNull();
  });

  it("a JSON escape next to a token is never swallowed (the scrubbed text still parses)", () => {
    const out = scrub({ message: `failed: "${HOOK}" and /x?token=abc"q` });
    expect(out.message).toBe(`failed: "${SCRUBBED}" and /x?token=[redacted]"q`);
  });

  it("sdkProcessingMetadata is not serialised, and without a sampling context is put back as the same object", () => {
    const meta = { capturedSpanScope: { url: "/review/" + "a".repeat(30) }, live: () => 1 };
    const out = scrub({ request: { url: "/x" }, sdkProcessingMetadata: meta });
    expect(out.sdkProcessingMetadata).toBe(meta);
    expect(meta.capturedSpanScope.url).toContain("aaaa");
  });

  it("[codex] the sampling context (sent as the envelope's trace header) is scrubbed; live references kept", () => {
    const scope = { live: () => 1 };
    const meta = { capturedSpanScope: scope, dynamicSamplingContext: { trace_id: "abc", transaction: `GET /review/${TOKEN}` } };
    const out = scrub({ type: "transaction", sdkProcessingMetadata: meta });
    expect(out.sdkProcessingMetadata.dynamicSamplingContext).toEqual({ trace_id: "abc", transaction: "GET /review/[token]" });
    expect(out.sdkProcessingMetadata.capturedSpanScope).toBe(scope);
    // The caller's metadata object is not mutated.
    expect(meta.dynamicSamplingContext.transaction).toContain(TOKEN);
  });

  it("[codex] a query_string that STARTS with token= is scrubbed inside an event", () => {
    const out = scrub({ request: { query_string: "token=abc123&id=x", url: "https://www.triplypro.com/api/reviews/unsubscribe" } });
    expect(out.request.query_string).toBe("token=[redacted]&id=x");
  });

  it("an event with nothing to scrub comes back equal", () => {
    const event = { message: "hello", tags: { a: "b" }, level: "error" };
    expect(scrub(event)).toEqual(event);
  });
});
