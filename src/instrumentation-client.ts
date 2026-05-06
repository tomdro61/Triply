// Client-side Sentry initialization. Auto-loaded by Next.js when this file
// is at src/instrumentation-client.ts (next 15.3+ convention).

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Environment label so Sentry can separate prod / staging / dev events.
  environment: process.env.NEXT_PUBLIC_APP_ENV || "development",

  // Don't send events from local dev — saves quota and avoids noise.
  enabled: process.env.NODE_ENV !== "development",

  // Performance monitoring — sample 10% of transactions in production.
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  // Session replay — 10% of all sessions, 100% of sessions with errors.
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  // Replay must mask customer PII visible on screen (names, emails, phone,
  // vehicle info, addresses on confirmation pages, admin booking modal, etc.).
  // Without this, replays leak customer data into Sentry recordings.
  integrations: [
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],

  // Don't send IP address, cookies, or User-Agent by default — too easy to
  // leak session tokens or other identifiers via cookies. Attach selectively
  // via Sentry.withScope where useful (see lib/sentry.ts helpers).
  sendDefaultPii: false,

  // Send application logs ingested via Sentry.logger.* alongside events.
  enableLogs: true,

  // Filter out noise that we don't act on.
  ignoreErrors: [
    "ResizeObserver loop limit exceeded",
    "ResizeObserver loop completed with undelivered notifications",
    "Non-Error promise rejection captured",
    /Loading chunk \d+ failed/,
    /ChunkLoadError/,
    "Network request failed",
    "Failed to fetch",
  ],
});

// Captures router-level transitions for App Router navigation tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
