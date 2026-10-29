import { getAirportByCode } from "@/config/airports";
import { appBase } from "@/lib/reviews/links";

/**
 * Where the welcome email's button sends a new subscriber.
 *
 * Signups come almost entirely from airport-specific blog posts (the 10%-off
 * box on "<airport> parking promo code" articles), and the signup records the
 * airport. Sending the reader to that airport's search — which runs at once
 * with default dates — beats the bare homepage, where they had to pick the
 * airport again. Unknown or unsellable airport → the homepage.
 *
 * utm_medium=email files the visit under the email channel in both our
 * attribution classifier and GA4; utm_campaign tells the welcome email apart
 * from the review ("review") and checkout-recovery emails.
 */
const UTM = { utm_source: "triply", utm_medium: "email", utm_campaign: "welcome", utm_content: "book_now" } as const;

export function welcomeBookUrl(airportCode: string | null | undefined): string {
  const airport = airportCode ? getAirportByCode(airportCode) : undefined;
  const url = new URL(airport?.enabled ? "/search" : "/", appBase());
  if (airport?.enabled) url.searchParams.set("airport", airport.code);
  for (const [k, v] of Object.entries(UTM)) url.searchParams.set(k, v);
  return url.toString();
}

export function welcomeBookLabel(airportCode: string | null | undefined): string {
  const airport = airportCode ? getAirportByCode(airportCode) : undefined;
  return airport?.enabled ? `Book ${airport.code} parking &amp; save 10%` : "Book Now &amp; Save 10%";
}
