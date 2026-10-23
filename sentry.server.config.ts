// Server-side Sentry initialization. Loaded by src/instrumentation.ts when
// NEXT_RUNTIME === "nodejs".

import * as Sentry from "@sentry/nextjs";
import { scrubEventCredentials } from "@/lib/sentry-scrub";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Environment label so Sentry can separate prod / staging / dev events.
  environment: process.env.NEXT_PUBLIC_APP_ENV || "development",

  // Don't send events from local dev — saves quota and avoids noise.
  enabled: process.env.NODE_ENV !== "development",

  // Performance monitoring — sample 10% of transactions in production.
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  // Don't send IP / cookies / UA by default. Attach selectively via
  // Sentry.withScope where useful (see lib/sentry.ts helpers).
  sendDefaultPii: false,

  // Send application logs ingested via Sentry.logger.* alongside events.
  enableLogs: true,

  // Credentials that travel in URLs (the review link /review/{token}, unsubscribe
  // ?token=, Discord webhook tokens) never leave the server, in errors or traces
  // (src/lib/sentry-scrub.ts).
  beforeSend: (event) => scrubEventCredentials(event),
  beforeSendTransaction: (event) => scrubEventCredentials(event),
});
