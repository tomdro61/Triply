/**
 * Referrer-host classification and the channel classifier.
 *
 * Pure functions, table-tested. The channel enum lives in schema.ts (CHANNELS)
 * and is enforced in TypeScript only — deliberately NO SQL CHECK on
 * bookings.channel, because a check violation from a marketing column would
 * abort a money-committed insert (see fulfill.ts).
 */

import type { AttributionCookie, Channel, Touch } from "./schema";

export type HostKind =
  | "internal"
  | "webmail"
  | "search"
  | "social"
  | "external"
  | "none";

/** Hosts whose referral is never an acquisition touch: our own site, and the
 *  payment / auth providers a customer bounces through mid-checkout. Without
 *  this list the 3-D Secure return (hooks.stripe.com) and Google sign-in
 *  (accounts.google.com) would overwrite last-touch as "referral"/"organic". */
const INTERNAL_HOSTS = [
  "triplypro.com",
  "localhost",
  "vercel.app",
  "stripe.com",
  "accounts.google.com",
  "supabase.co",
  "apple.com",
  "paypal.com",
  "klarna.com",
  "affirm.com",
  "afterpay.com",
];

const WEBMAIL_HOSTS = [
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
  "mail.yahoo.com",
  "mail.aol.com",
  "mail.proton.me",
  "mail.icloud.com",
];

const SEARCH_HOSTS = [
  "google.",
  "bing.com",
  "duckduckgo.com",
  "search.yahoo.com",
  "yahoo.com",
  "ecosia.org",
  "baidu.com",
  "yandex.",
  "search.brave.com",
  "startpage.com",
];

const SOCIAL_HOSTS = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "t.co",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "lnkd.in",
  "pinterest.",
  "tiktok.com",
  "reddit.com",
  "youtube.com",
  "youtu.be",
  "threads.net",
  "nextdoor.com",
];

/**
 * Host matching, anchored on the RIGHT so an attacker-controlled referrer like
 * `google.com.evil.com` can never pass as Google.
 *
 * - "stripe.com" matches stripe.com and any subdomain (hooks.stripe.com).
 * - A trailing-dot pattern ("google.") means the label `google` followed by a
 *   public suffix only: google.com, google.co.uk, www.google.de — but NOT
 *   google.com.evil.com (three labels after `google`) and NOT google.evil.io
 *   (a 4-letter "suffix" label). The suffix rule is deliberately narrow:
 *   one label of 2–4 chars, or two labels where the first is ≤3 chars and the
 *   second is a 2-letter country code.
 */
function hostMatches(host: string, pattern: string): boolean {
  if (!pattern.endsWith(".")) return host === pattern || host.endsWith(`.${pattern}`);
  const label = pattern.slice(0, -1);
  const labels = host.split(".");
  const i = labels.indexOf(label);
  if (i === -1) return false;
  const suffix = labels.slice(i + 1);
  if (suffix.length === 1) return /^[a-z]{2,4}$/.test(suffix[0]);
  if (suffix.length === 2) return /^[a-z]{2,3}$/.test(suffix[0]) && /^[a-z]{2}$/.test(suffix[1]);
  return false;
}

export function normalizeHost(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^www\./, "").split("/")[0].split(":")[0];
  return host || null;
}

export function classifyReferrerHost(hostInput: string | null | undefined): HostKind {
  const host = normalizeHost(hostInput);
  if (!host) return "none";
  // Order matters: mail.google.com is webmail, accounts.google.com is internal,
  // and only then does "google." mean search.
  if (INTERNAL_HOSTS.some((p) => hostMatches(host, p))) return "internal";
  if (WEBMAIL_HOSTS.some((p) => hostMatches(host, p))) return "webmail";
  if (SEARCH_HOSTS.some((p) => hostMatches(host, p))) return "search";
  if (SOCIAL_HOSTS.some((p) => hostMatches(host, p))) return "social";
  return "external";
}

const PAID_SEARCH_MEDIUMS = new Set(["cpc", "ppc", "paid", "paidsearch", "paid_search", "sem"]);
const PAID_SOCIAL_MEDIUMS = new Set(["paid_social", "paidsocial", "social-paid", "social_paid"]);
const SOCIAL_MEDIUMS = new Set(["social", "organic_social", "social-organic"]);
const GOOGLE_CLICK_PREFIXES = ["gclid:", "gbraid:", "wbraid:"];

export const PARTNER_SOURCE_RE = /^partner-(\d+)$/;

export interface ClassifyOptions {
  /** ResLab location ids of ACTIVE partners. A `utm_source=partner-<id>` that
   *  is not in this set classifies as referral — the tag is visitor input, so
   *  partner credit must be corroborated server-side. */
  activePartnerLocationIds?: ReadonlySet<number>;
  /** Which touch to classify. First-touch answers "which channel produced the
   *  customer"; last-touch is a query away in the JSON. */
  touch?: "first" | "last";
}

export function classifyTouch(t: Touch, opts: ClassifyOptions = {}): Channel {
  const med = (t.med ?? "").toLowerCase();
  const src = (t.src ?? "").toLowerCase();
  const refKind = classifyReferrerHost(t.ref);
  const click = t.click ?? "";

  if (PAID_SEARCH_MEDIUMS.has(med) || GOOGLE_CLICK_PREFIXES.some((p) => click.startsWith(p))) {
    return "paid_search";
  }
  if (PAID_SOCIAL_MEDIUMS.has(med) || click.startsWith("fbclid:")) return "paid_social";
  if (med === "email" || med === "newsletter" || refKind === "webmail") return "email";

  const partner = src.match(PARTNER_SOURCE_RE);
  if (partner) {
    const id = Number(partner[1]);
    if (opts.activePartnerLocationIds?.has(id)) return "partner";
    return "referral";
  }

  if (med === "referral") return "referral";
  if (SOCIAL_MEDIUMS.has(med) || refKind === "social") return "organic_social";
  if (refKind === "search") return "organic_search";
  if (refKind === "external") return "referral";
  // UTM present but medium unrecognised (e.g. utm_source only): the visitor was
  // tagged by someone, treat as referral rather than pretending it was direct.
  if (src || med || t.cmp) return "referral";
  return "direct";
}

export function classifyChannel(
  attr: AttributionCookie,
  opts: ClassifyOptions = {}
): Channel {
  const touch = opts.touch === "last" ? (attr.last ?? attr.first) : attr.first;
  return classifyTouch(touch, opts);
}
