import { getAirportByCode } from "@/config/airports";

/** Shared by the review email and the review page (no Resend import here). */

export function appBase(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com").replace(/\/$/, "");
}

/**
 * utm_medium=email so both our attribution classifier (src/lib/attribution/
 * classify.ts: only medium "email"/"newsletter" maps to the email channel) and
 * GA4's default channel grouping file the visit under Email; source "triply"
 * matches the checkout-recovery email.
 */
const UTM = { utm_source: "triply", utm_medium: "email", utm_campaign: "review" } as const;

/**
 * "Book your next trip" target: the airport's landing page (its search widget
 * has the airport preselected) when we know an airport we sell, else the home
 * page. `placement` lands in utm_content (email vs. thank-you page).
 */
export function bookAgainUrl(airportCode: string | null, placement: "email" | "review_page" = "email"): string {
  const airport = airportCode ? getAirportByCode(airportCode) : undefined;
  const path = airport ? `/${airport.slug}/airport-parking` : "/";
  const url = new URL(path, appBase());
  for (const [k, v] of Object.entries(UTM)) url.searchParams.set(k, v);
  url.searchParams.set("utm_content", placement === "email" ? "book_again" : "book_again_page");
  return url.toString();
}

export function bookAgainLabel(airportCode: string | null): string {
  return airportCode ? `Book your next trip at ${airportCode}` : "Book your next trip";
}
