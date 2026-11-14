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

/** Read by summarize.mjs (same folder), which fails the job if it is not empty. */
const VIOLATIONS_FILE = path.join(__dirname, "..", "guard-violations.txt");

/** The only non-GET requests the page may send to the preview. None of them
 *  writes to Supabase, sends mail or books: pre-pay-no-writes.test.ts
 *  (src/app/api/checkout/__tests__/) fails if one starts to, and also covers
 *  GET /api/checkout/lot. */
const ALLOWED_MUTATING = new Set([
  "POST /api/checkout/lot", // creates a Stripe TEST PaymentIntent
  "POST /api/checkout/lot/update-pi", // changes that PaymentIntent's amount
  "POST /api/attribution", // cookies only
]);

/** First-party telemetry: dropped quietly. */
const QUIET_PREVIEW_PATHS = [/^\/monitoring/, /^\/_vercel\//];

/** Never, by any method. A search logs rows to the production database, and
 *  airport and lot pages run one while rendering; the rest is the booking itself. */
const FORBIDDEN_PREVIEW_PATHS = [
  /^\/api\/search/,
  /^\/[^/]+\/airport-parking/,
  /^\/api\/reservations/,
  /^\/checkout\/complete/,
];

/** Our own hosts other than the preview under test: a write to one is never expected. */
const isOurOtherHost = (host: string) => host.endsWith("triplypro.com") || host.endsWith(".vercel.app");

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
      // Only plain paths. Next.js answers `/api//search` with a redirect to
      // `/api/search`, which would slip past the path rules below.
      // (Encoded characters are fine in a chunk name, except an encoded slash.)
      const plainPath =
        /^(\/[A-Za-z0-9._~@:+,=()\[\]%-]+)*\/?$/.test(url.pathname) &&
        !url.pathname.includes("..") &&
        !/%2f|%5c/i.test(url.pathname);
      if (!plainPath) {
        violate(`a preview path this guard cannot judge: ${label}`);
        return route.abort("blockedbyclient");
      }
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
      // Fetched from Node with redirects OFF: a redirect followed by the
      // browser is not shown to this handler again and keeps the headers, so
      // it could reach a forbidden path, or carry the token to another host.
      const token = await previewToken();
      try {
        const response = await route.fetch({
          headers: { ...request.headers(), [TRUSTED_TOKEN_HEADER]: token },
          maxRedirects: 0,
        });
        if (response.status() >= 300 && response.status() < 400) {
          // Vercel refusing the token also looks like this (a redirect to its sign-in).
          violate(`the preview answered with a redirect (HTTP ${response.status()}): ${label}`);
          return await route.abort("blockedbyclient");
        }
        return await route.fulfill({ response });
      } catch {
        // NEVER rethrow or print this error: Playwright's text for a failed
        // fetch lists the request headers, token included, and this
        // repository's CI logs are public. The request simply fails; the
        // test then fails on whatever it was waiting for.
        return route.abort("failed").catch(() => {});
      }
    }

    if (isStripeHost(url.hostname)) {
      if (carriesLiveKey(request)) {
        violate(`a LIVE Stripe key was used: ${label}`);
        return route.abort("blockedbyclient");
      }
      if (url.hostname === "api.stripe.com" && /^\/v1\/(payment|setup)_intents\/[^/]+\/confirm$/.test(url.pathname)) {
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

    if (isOurOtherHost(url.hostname) && !READ_METHODS.has(method)) {
      violate(`a write to another of our hosts: ${label}`);
      return route.abort("blockedbyclient");
    }

    // Analytics, session recording, fonts, anything else: not needed.
    return route.abort("blockedbyclient");
  });

  // context.route does not see WebSockets. The checkout page opens none.
  await context.routeWebSocket(/.*/, (socket) => {
    violate(`a WebSocket was opened: ${new URL(socket.url()).host}`);
    void socket.close();
  });

  return { violations, publishableKey: () => publishableKey };
}
