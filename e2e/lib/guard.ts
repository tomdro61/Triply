/**
 * The network guard: an ALLOWLIST on the whole browser context, installed
 * before the first navigation.
 *
 * Why it exists: a preview writes to the PRODUCTION database, and the Pay
 * click stages a row, books a reservation and sends an email, none of which
 * can be undone. This test stops before Pay; the guard is what makes "stops
 * before Pay" true even if the test or the page changes.
 *
 * - A request that could write (or that starts a booking) and is not on the
 *   list is ABORTED and recorded as a violation. A violation fails the run no
 *   matter what the retries say: it is also written to guard-violations.txt,
 *   which the workflow checks in its own step.
 * - Every other host (analytics, session recording, the Vercel toolbar) is
 *   aborted quietly: the test neither needs nor wants them.
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Request } from "@playwright/test";
import { TRUSTED_TOKEN_HEADER, previewToken } from "./preview-access";

export const VIOLATIONS_FILE = path.join(__dirname, "..", "guard-violations.txt");

/** The only requests to the preview that may change anything. Verified at
 *  `a155e39`: none of them writes to Supabase, sends mail or books (the
 *  server-side half of this is src/app/api/checkout/__tests__/pre-pay-no-writes.test.ts). */
const ALLOWED_MUTATING = new Set([
  "POST /api/checkout/lot", // creates a Stripe TEST PaymentIntent
  "POST /api/checkout/lot/update-pi", // changes that PaymentIntent's amount
  "POST /api/attribution", // cookies only
]);

/** First-party telemetry: dropped quietly. */
const QUIET_PREVIEW_PATHS = [/^\/monitoring/, /^\/_vercel\//];

/** Never, by any method. `/api/search` logs rows to the production database;
 *  the rest is the booking itself. */
const FORBIDDEN_PREVIEW_PATHS = [/^\/api\/search/, /^\/api\/reservations/, /^\/checkout\/complete/];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isStripeHost(host: string): boolean {
  return (
    host === "stripe.com" ||
    host.endsWith(".stripe.com") ||
    host.endsWith(".stripe.network") ||
    host.endsWith(".stripecdn.com")
  );
}

function carriesLiveKey(request: Request): boolean {
  const authorization = request.headers()["authorization"] ?? "";
  return [request.url(), request.postData() ?? "", authorization].some((text) => text.includes("pk_live_"));
}

export interface Guard {
  /** Violations seen so far in this context. */
  violations: string[];
  /** The Stripe publishable key the page used (test mode, or the guard has already failed the run). */
  publishableKey: () => string | null;
}

export async function installGuard(context: BrowserContext, preview: URL): Promise<Guard> {
  const violations: string[] = [];
  let publishableKey: string | null = null;

  const violate = (what: string) => {
    violations.push(what);
    appendFileSync(VIOLATIONS_FILE, `${what}\n`);
  };

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    // Path only: a query string can carry a customer's details.
    const label = `${method} ${url.hostname}${url.pathname}`;

    if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();

    if (url.hostname === preview.hostname) {
      if (FORBIDDEN_PREVIEW_PATHS.some((pattern) => pattern.test(url.pathname))) {
        violate(`forbidden request: ${label}`);
        return route.abort("blockedbyclient");
      }
      if (QUIET_PREVIEW_PATHS.some((pattern) => pattern.test(url.pathname))) {
        return route.abort("blockedbyclient");
      }
      if (!READ_METHODS.has(method) && !ALLOWED_MUTATING.has(`${method} ${url.pathname}`)) {
        violate(`unlisted write to the preview: ${label}`);
        return route.abort("blockedbyclient");
      }
      // The access token goes on preview requests only, and only from here.
      return route.continue({ headers: { ...request.headers(), [TRUSTED_TOKEN_HEADER]: await previewToken() } });
    }

    if (isStripeHost(url.hostname)) {
      if (carriesLiveKey(request)) {
        violate(`a LIVE Stripe key was used: ${label}`);
        return route.abort("blockedbyclient");
      }
      if (/\/confirm(\b|$)/.test(url.pathname)) {
        violate(`a Stripe confirmation was attempted: ${label}`);
        return route.abort("blockedbyclient");
      }
      const key = url.searchParams.get("key") ?? /(?:^|&)key=(pk_test_[A-Za-z0-9]+)/.exec(request.postData() ?? "")?.[1];
      if (key?.startsWith("pk_test_")) publishableKey = key;
      return route.continue();
    }

    if (url.hostname.endsWith(".supabase.co")) {
      if (!READ_METHODS.has(method)) {
        violate(`a browser write to Supabase: ${label}`);
        return route.abort("blockedbyclient");
      }
      return route.continue();
    }

    // Analytics, session recording, fonts, anything else: not needed.
    return route.abort("blockedbyclient");
  });

  return { violations, publishableKey: () => publishableKey };
}
