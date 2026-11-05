import { describe, it, expect } from "vitest";
import { clarityInitScript, gtagInitScript } from "../inline-analytics-scripts";

const window_ = (): Record<string, unknown> => ({});

/** Runs an inline script against a stubbed page; returns what it did. */
function run(script: string, page: { href: string; referrer?: string; cookie?: string }) {
  const dataLayer: unknown[] = [];
  const inserted: { src: string }[] = [];
  const firstScript = { parentNode: { insertBefore: (el: { src: string }) => inserted.push(el) } };
  const document = {
    cookie: page.cookie ?? "",
    referrer: page.referrer ?? "",
    createElement: () => ({ async: false, src: "" }),
    getElementsByTagName: () => [firstScript],
  };
  // In the browser `dataLayer` is window.dataLayer; here gtag pushes its
  // `arguments` objects onto the array passed in. The script is our own
  // module's output, not outside input.
  new Function("window", "document", "location", "dataLayer", script)(window_(), document, { href: page.href }, dataLayer);
  const calls = dataLayer.map((args) => Array.from(args as ArrayLike<unknown>));
  return { calls, clarityLoaded: inserted.some((el) => el.src.includes("clarity.ms")) };
}

const OPTED_OUT = `triply_cookie_consent=${encodeURIComponent(JSON.stringify({ analyticsOptOut: true }))}`;

describe("gtag-init", () => {
  it("a normal page: config sends its own page_view", () => {
    const { calls } = run(gtagInitScript("G-TEST"), { href: "https://www.triplypro.com/search?airport=JFK" });
    expect(calls).toContainEqual(["config", "G-TEST"]);
    expect(calls.some((c) => c[0] === "event")).toBe(false);
  });

  it("an emailed confirmation link: the page_view goes out without the email", () => {
    const { calls } = run(gtagInitScript("G-TEST"), {
      href: "https://www.triplypro.com/confirmation/RTL1?lot=reslab-2&email=dana%40example.com",
    });
    expect(calls).toContainEqual(["config", "G-TEST", { send_page_view: false }]);
    expect(calls).toContainEqual(["event", "page_view", { page_location: "https://www.triplypro.com/confirmation/RTL1?lot=reslab-2" }]);
    expect(JSON.stringify(calls)).not.toContain("dana");
  });

  it("the 3-D Secure return: the client secret never reaches the page_view", () => {
    const { calls } = run(gtagInitScript("G-TEST"), {
      href: "https://www.triplypro.com/checkout/complete?payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_x&redirect_status=succeeded",
    });
    expect(JSON.stringify(calls)).not.toContain("secret_x");
  });

  it("an opt-out sets analytics_storage denied; utm_medium=email is not a secret", () => {
    const { calls } = run(gtagInitScript("G-TEST"), { href: "https://www.triplypro.com/?utm_medium=email", cookie: OPTED_OUT });
    expect(calls).toContainEqual(["consent", "default", expect.objectContaining({ analytics_storage: "denied" })]);
    expect(calls).toContainEqual(["config", "G-TEST"]);
  });
});

describe("clarity-init", () => {
  it("loads on a normal page", () => {
    expect(run(clarityInitScript("abc123"), { href: "https://www.triplypro.com/search?utm_medium=email" }).clarityLoaded).toBe(true);
  });

  it("is not loaded for an analytics opt-out", () => {
    expect(run(clarityInitScript("abc123"), { href: "https://www.triplypro.com/", cookie: OPTED_OUT }).clarityLoaded).toBe(false);
  });

  it("is not loaded while the URL or the referrer carries the email or a client secret", () => {
    expect(run(clarityInitScript("abc123"), { href: "https://www.triplypro.com/confirmation/RTL1?email=a%40b.co" }).clarityLoaded).toBe(false);
    expect(
      run(clarityInitScript("abc123"), { href: "https://www.triplypro.com/checkout/complete?payment_intent_client_secret=pi_1_secret_x" })
        .clarityLoaded
    ).toBe(false);
    expect(
      run(clarityInitScript("abc123"), {
        href: "https://www.triplypro.com/help",
        referrer: "https://www.triplypro.com/confirmation/RTL1?email=a%40b.co",
      }).clarityLoaded
    ).toBe(false);
  });
});
