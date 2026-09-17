import { describe, it, expect } from "vitest";
import { classifyChannel, classifyReferrerHost, classifyTouch } from "../classify";
import type { Touch } from "../schema";

const t = (over: Partial<Touch> = {}): Touch => ({ at: 1, land: "/", ...over });

describe("classifyReferrerHost", () => {
  it.each([
    ["https://www.google.com/", "search"],
    ["google.co.uk", "search"],
    ["Google.CO.UK", "search"],
    ["HTTPS://WWW.GOOGLE.COM/", "search"],
    ["https://www.bing.com/search?q=x", "search"],
    ["duckduckgo.com", "search"],
    ["mail.google.com", "webmail"],
    ["outlook.live.com", "webmail"],
    ["accounts.google.com", "internal"],
    ["hooks.stripe.com", "internal"],
    ["https://www.triplypro.com/search", "internal"],
    ["triplypro.com", "internal"],
    ["triply-git-feat-x.vercel.app", "internal"],
    ["abc.supabase.co", "internal"],
    ["l.facebook.com", "social"],
    ["t.co", "social"],
    ["www.pinterest.com", "social"],
    ["pinterest.co.uk", "social"],
    ["reddit.com", "social"],
    ["www.nytimes.com", "external"],
    ["https://example.com:8443/a", "external"],
    ["example.com:8443", "external"],
    // Right-anchored: an attacker-controlled referrer can never pass as a known host.
    ["google.com.evil.com", "external"],
    ["mail.google.com.evil.com", "external"],
    ["google.evil.io", "external"],
    ["notgoogle.com", "external"],
    ["evilstripe.com", "external"],
    ["stripe.com.evil.com", "external"],
    ["", "none"],
    [null, "none"],
  ])("%s → %s", (host, kind) => {
    expect(classifyReferrerHost(host)).toBe(kind);
  });
});

describe("classifyTouch", () => {
  it.each<[string, Partial<Touch>, string]>([
    ["utm_medium=cpc", { src: "google", med: "cpc" }, "paid_search"],
    ["gclid beats an organic-looking referrer", { ref: "google.com", click: "gclid:x" }, "paid_search"],
    ["gbraid", { click: "gbraid:x" }, "paid_search"],
    ["fbclid", { ref: "l.facebook.com", click: "fbclid:x" }, "paid_social"],
    ["paid_social medium", { src: "facebook", med: "paid_social" }, "paid_social"],
    ["utm_medium=email", { src: "newsletter", med: "email" }, "email"],
    ["webmail referrer without UTM", { ref: "mail.google.com" }, "email"],
    ["utm_medium=referral", { src: "partnerblog", med: "referral" }, "referral"],
    ["external referrer", { ref: "www.nytimes.com" }, "referral"],
    ["search referrer, no UTM", { ref: "google.com" }, "organic_search"],
    ["social referrer", { ref: "t.co" }, "organic_social"],
    ["utm_medium=social", { src: "instagram", med: "social" }, "organic_social"],
    ["UTM with unknown medium", { src: "flyer", med: "print" }, "referral"],
    ["utm_source only", { src: "qr" }, "referral"],
    ["nothing at all", {}, "direct"],
    ["a spoofed search referrer is just a referral", { ref: "google.com.evil.com" }, "referral"],
  ])("%s", (_name, over, expected) => {
    expect(classifyTouch(t(over))).toBe(expected);
  });

  it("partner requires an ACTIVE partner id — otherwise referral", () => {
    const touch = t({ src: "partner-416", med: "referral" });
    expect(classifyTouch(touch, { activePartnerLocationIds: new Set([416]) })).toBe("partner");
    expect(classifyTouch(touch, { activePartnerLocationIds: new Set([999]) })).toBe("referral");
    expect(classifyTouch(touch)).toBe("referral");
    expect(classifyTouch(t({ src: "partner-evil" }))).toBe("referral");
  });

  it("classifyChannel is first-touch by default, last-touch on request", () => {
    const attr = { v: 1 as const, first: t({ ref: "google.com" }), last: t({ src: "x", med: "email" }) };
    expect(classifyChannel(attr)).toBe("organic_search");
    expect(classifyChannel(attr, { touch: "last" })).toBe("email");
    expect(classifyChannel({ v: 1, first: t({ ref: "google.com" }) }, { touch: "last" })).toBe("organic_search");
  });
});
