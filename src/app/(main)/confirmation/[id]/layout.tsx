import type { Metadata } from "next";

export const metadata: Metadata = {
  // An emailed link lands here with ?email=, kept in the address bar when the
  // browser blocks sessionStorage. Never send that URL on as a referrer —
  // Clarity and GA record the next page's referrer (same rule as
  // /checkout/complete and its Stripe client secret). strict-origin sends the
  // origin only, never the path or query. Not no-referrer: a meta policy stays
  // in force for the whole tab after an in-app navigation, and Mapbox's
  // URL-restricted token needs the origin as Referer on /search and lot pages.
  referrer: "strict-origin",
};

export default function ConfirmationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
