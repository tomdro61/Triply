/**
 * The reporting "source" of a booking: a finer split of the stored first-touch
 * `channel`, read from the same persisted attribution. Used by the daily digest,
 * the admin dashboard and the admin bookings list, so all three agree.
 *
 * Why not just `channel`: the classifier that writes `bookings.channel`
 * (classify.ts) has no AI channel. A chatgpt.com visit (utm_source only) is
 * stored as "referral" and a gemini.google.com referrer as "organic_search",
 * and Google is not separated from Bing / DuckDuckGo / Yahoo. Deriving the
 * source at read time needs no schema change and reclassifies history the same
 * way as new rows.
 *
 * Pure and import-free beyond the row type, so client components can use it.
 */
import { isChannel, type AttributionRow } from "./display";

export const BOOKING_SOURCES = [
  "google",
  "other_search",
  "chatgpt",
  "gemini",
  "copilot",
  "other_ai",
  "no_referrer_blog",
  "direct",
  "referral",
  "email",
  "paid",
  "social",
  "partner",
  "invalid",
  "unknown",
] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export const BOOKING_SOURCE_LABELS: Record<BookingSource, string> = {
  google: "Google",
  other_search: "Bing & other engines",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  copilot: "Copilot",
  other_ai: "Other AI",
  no_referrer_blog: "Blog (no referrer)",
  direct: "Direct",
  referral: "Other referral",
  email: "Email",
  paid: "Paid",
  social: "Social",
  partner: "Partner",
  invalid: "Invalid cookie",
  unknown: "No data",
};

export const AI_SOURCES: ReadonlySet<BookingSource> = new Set(["chatgpt", "gemini", "copilot", "other_ai"]);

// ── host matching ──
// Host rules are anchored (exact host or a subdomain of it) so "bayou.com" is
// never you.com and "google.com.evil.com" is never Google. Kept local rather
// than imported from classify.ts so this module stays import-free for client
// components.

function normalizeRef(input: string | undefined): string {
  if (!input) return "";
  let host = input.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  }
  return host.replace(/^www\./, "").split("/")[0].split(":")[0];
}

const hostIs = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** google.com, google.co.uk, ucs-widget.corp.google.com — the same public-suffix rule as classify.ts. */
function isGoogleHost(host: string): boolean {
  const labels = host.split(".");
  const i = labels.lastIndexOf("google");
  if (i === -1) return false;
  const suffix = labels.slice(i + 1);
  if (suffix.length === 1) return /^[a-z]{2,4}$/.test(suffix[0]);
  if (suffix.length === 2) return /^[a-z]{2,3}$/.test(suffix[0]) && /^[a-z]{2}$/.test(suffix[1]);
  return false;
}

// Android app referrers arrive as the app's package name.
const GOOGLE_SEARCH_APPS = new Set(["com.google.android.googlequicksearchbox", "com.google.android.apps.searchlite"]);
const GMAIL_APP = "com.google.android.gm";
const YOUTUBE_APP = "com.google.android.youtube";

type AiSource = "chatgpt" | "gemini" | "copilot" | "other_ai";
/** Referrer hosts (subdomains included) and the bare utm_source values seen for each assistant. */
const AI_HOSTS: Array<[string, AiSource]> = [
  ["chatgpt.com", "chatgpt"],
  ["openai.com", "chatgpt"],
  ["gemini.google.com", "gemini"],
  ["bard.google.com", "gemini"],
  ["com.google.android.apps.bard", "gemini"], // the Gemini Android app
  ["copilot.microsoft.com", "copilot"],
  ["copilot.com", "copilot"],
  ["perplexity.ai", "other_ai"],
  ["claude.ai", "other_ai"],
  ["duck.ai", "other_ai"],
  ["meta.ai", "other_ai"],
  ["you.com", "other_ai"],
  ["phind.com", "other_ai"],
];
const AI_SRC_ALIASES: Record<string, AiSource> = {
  chatgpt: "chatgpt",
  openai: "chatgpt",
  gemini: "gemini",
  bard: "gemini",
  copilot: "copilot",
  perplexity: "other_ai",
  claude: "other_ai",
};

function aiSource(src: string, host: string): AiSource | null {
  for (const [domain, source] of AI_HOSTS) {
    if ((host && hostIs(host, domain)) || src === domain) return source;
  }
  return AI_SRC_ALIASES[src] ?? null;
}

export function bookingSource(row: AttributionRow): BookingSource {
  const a = row.attribution;
  if (a && a.v === null) return "invalid";
  const channel = isChannel(row.channel) ? row.channel : null;
  if (!channel) return "unknown";
  const first = a?.first;
  const src = (first?.src ?? "").trim().toLowerCase();
  const host = normalizeRef(first?.ref);

  // A paid click stays Paid even when its utm_source names an assistant (an ad on an AI surface).
  if (channel === "paid_search" || channel === "paid_social") return "paid";
  const ai = aiSource(src, host);
  if (ai) return ai;

  switch (channel) {
    case "email":
      return "email";
    case "organic_social":
      return "social";
    case "partner":
      return "partner";
    case "organic_search":
      return isGoogleHost(host) || src === "google" ? "google" : "other_search";
    case "referral":
      // classify.ts stores an Android app referrer as a referral. Only the Google
      // search app is Google; Gmail is email and YouTube is social.
      if (GOOGLE_SEARCH_APPS.has(host)) return "google";
      if (host === GMAIL_APP) return "email";
      if (host === YOUTUBE_APP) return "social";
      return "referral";
    case "direct":
      // Nobody types a deep blog URL: a referrer-less first visit straight to an
      // article is a search or AI app that withheld the referrer. Kept apart from
      // Direct so it is not read as typed-in / returning traffic.
      return first?.land?.startsWith("/blog/") ? "no_referrer_blog" : "direct";
  }
}

export const bookingSourceLabel = (row: AttributionRow): string => BOOKING_SOURCE_LABELS[bookingSource(row)];

export function isBookingSource(x: unknown): x is BookingSource {
  return typeof x === "string" && (BOOKING_SOURCES as readonly string[]).includes(x);
}

/** Label for a key that arrived over JSON: an unknown key is shown raw rather than blank. */
export const bookingSourceLabelForKey = (key: string): string => (isBookingSource(key) ? BOOKING_SOURCE_LABELS[key] : key);
