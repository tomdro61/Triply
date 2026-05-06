// Edge-runtime Sentry initialization. Loaded by src/instrumentation.ts when
// NEXT_RUNTIME === "edge" (middleware, edge route handlers).

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Environment label so Sentry can separate prod / staging / dev events.
  environment: process.env.NEXT_PUBLIC_APP_ENV || "development",

  // Don't send events from local dev — saves quota and avoids noise.
  enabled: process.env.NODE_ENV !== "development",

  // Performance monitoring — sample 10% of transactions in production.
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  // Don't send IP / cookies / UA by default.
  sendDefaultPii: false,

  // Send application logs ingested via Sentry.logger.* alongside events.
  enableLogs: true,
});
