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
});
