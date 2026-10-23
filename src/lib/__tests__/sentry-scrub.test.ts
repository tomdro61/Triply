import { describe, it, expect } from "vitest";
import { scrubEventCredentials, scrubUrlCredentials } from "../sentry-scrub";

const TOKEN = "3f2b8c1e-9a4d-4e2b-8c7a-1d2e3f4a5b6c.1797465600.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

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

  it("scrubs every string in a transaction event, including spans", () => {
    const event = {
      transaction: `GET /review/${TOKEN}`,
      request: { url: `https://www.triplypro.com/review/${TOKEN}` },
      spans: [{ description: `GET /review/${TOKEN}`, data: { "http.target": `/review/${TOKEN}?r=5` } }],
      breadcrumbs: [{ message: "ok", data: { n: 1 } }],
    };
    const out = scrubEventCredentials(event);
    expect(JSON.stringify(out)).not.toContain(TOKEN.split(".")[2]);
    expect(out.request.url).toBe("https://www.triplypro.com/review/[token]");
    expect(out.breadcrumbs[0].data.n).toBe(1);
  });

  it("removes a Discord webhook token from URLs, breadcrumbs and spans", () => {
    const hook = "https://discord.com/api/webhooks/1563293029723545644/AbC-def_123XYZ";
    expect(scrubUrlCredentials(`${hook}?wait=true`)).toBe("https://discord.com/api/webhooks/1563293029723545644/[token]?wait=true");
    expect(scrubUrlCredentials("https://discord.com/api/v10/webhooks/1/AbC-def_123XYZ")).toBe("https://discord.com/api/v10/webhooks/1/[token]");
    const event = {
      breadcrumbs: [{ category: "fetch", data: { url: `${hook}?wait=true`, method: "POST", status_code: 500 } }],
      spans: [{ description: `POST ${hook}`, data: { url: hook } }],
    };
    expect(JSON.stringify(scrubEventCredentials(event))).not.toContain("AbC-def_123XYZ");
  });

  it("scrubs a query_string where the token comes first (Sentry drops the leading ?)", () => {
    expect(scrubUrlCredentials("token=abc123&id=x")).toBe("token=[redacted]&id=x");
  });

  it("never walks SDK internals and never throws", () => {
    const frozen = Object.freeze({ url: "/review/" + "a".repeat(30) });
    const event = { request: { url: "/x" }, sdkProcessingMetadata: { capturedSpanScope: frozen }, extra: { f: frozen } };
    expect(() => scrubEventCredentials(event)).not.toThrow();
    expect(event.sdkProcessingMetadata.capturedSpanScope.url).toContain("aaaa");
  });
});
