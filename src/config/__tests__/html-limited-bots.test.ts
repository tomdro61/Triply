import { describe, expect, it } from "vitest";
import { HTML_LIMITED_BOTS } from "../html-limited-bots.mjs";

// Googlebot must get blocking metadata (title/canonical in <head>); Next's own
// list must keep working; real browsers must keep streaming.
describe("HTML_LIMITED_BOTS", () => {
  it.each([
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "facebookexternalhit/1.1",
    "Mozilla/5.0 (compatible; Google-InspectionTool/1.0)",
  ])("matches %s", (ua) => expect(HTML_LIMITED_BOTS.test(ua)).toBe(true));

  it.each([
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ])("leaves real browsers streaming: %s", (ua) => expect(HTML_LIMITED_BOTS.test(ua)).toBe(false));
});
