/**
 * /checkout/complete — the redirect-return page.
 *
 * Stripe sends customers here after any payment method that requires leaving
 * the site to authenticate: 3-D Secure card verification and every BNPL
 * provider. Until this release the route did not exist, so those customers
 * landed on a 404 *after* being charged, and the booking code — which lived in
 * the checkout tab they had just navigated away from — never ran. That is the
 * confirmed mechanism behind the orphan charges.
 *
 * The page does not create the booking itself. It asks the server to, and keeps
 * asking until there is a definitive answer, because the Stripe webhook may well
 * be completing the same booking concurrently.
 */

import { Suspense } from "react";
import type { Metadata } from "next";
import CheckoutCompleteClient from "./complete-client";

export const metadata: Metadata = {
  title: "Confirming your booking | Triply",
  // Never let a URL carrying a payment client_secret be indexed or sent as a
  // referrer to a third party.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function CheckoutCompletePage() {
  return (
    <Suspense fallback={<CompleteFallback />}>
      <CheckoutCompleteClient />
    </Suspense>
  );
}

function CompleteFallback() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="text-center">
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-[#f87356]" />
        <p className="mt-4 text-slate-600">Loading…</p>
      </div>
    </div>
  );
}
