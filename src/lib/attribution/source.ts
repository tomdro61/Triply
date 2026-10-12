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
  no_referrer_blog: "No referrer → blog",
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

// Matched against the first touch's utm_source + referrer host, lowercased.
// Order matters: gemini.google.com must be read as Gemini before it can match Google.
const CHATGPT = /chatgpt|openai/;
const GEMINI = /gemini|bard\.google/;
const COPILOT = /copilot/;
const OTHER_AI = /perplexity|claude\.ai|anthropic|duck\.ai|meta\.ai|you\.com|phind/;
const GOOGLE = /google/;

export function bookingSource(row: AttributionRow): BookingSource {
  const a = row.attribution;
  if (a && a.v === null) return "invalid";
  const channel = isChannel(row.channel) ? row.channel : null;
  if (!channel) return "unknown";
  const first = a?.first;
  const hint = `${first?.src ?? ""} ${first?.ref ?? ""}`.toLowerCase();

  if (CHATGPT.test(hint)) return "chatgpt";
  if (GEMINI.test(hint)) return "gemini";
  if (COPILOT.test(hint)) return "copilot";
  if (OTHER_AI.test(hint)) return "other_ai";

  switch (channel) {
    case "paid_search":
    case "paid_social":
      return "paid";
    case "email":
      return "email";
    case "organic_social":
      return "social";
    case "partner":
      return "partner";
    case "organic_search":
      return GOOGLE.test(hint) ? "google" : "other_search";
    case "referral":
      // The Android Google app (com.google.android.googlequicksearchbox) and
      // Google's own widgets arrive as non-search referrers.
      return GOOGLE.test(hint) ? "google" : "referral";
    case "direct":
      // Nobody types a deep blog URL: a referrer-less first visit straight to an
      // article is a search or AI app that withheld the referrer. Kept apart from
      // Direct so it is not read as typed-in / returning traffic.
      return first?.land?.startsWith("/blog/") ? "no_referrer_blog" : "direct";
  }
}

export const bookingSourceLabel = (row: AttributionRow): string => BOOKING_SOURCE_LABELS[bookingSource(row)];
