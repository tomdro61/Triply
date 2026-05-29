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
    // Generic browser / runtime / chunk-loading noise.
    "ResizeObserver loop limit exceeded",
    "ResizeObserver loop completed with undelivered notifications",
    "Non-Error promise rejection captured",
    /Loading chunk \d+ failed/,
    /ChunkLoadError/,
    "Network request failed",
    "Failed to fetch",
    // Fetch/lock aborted because the user navigated away mid-request,
    // including the Supabase auth-js lock timeout. Not actionable. (TRIPLY-7)
    "signal is aborted without reason",
    // Browser-extension / injected-script errors — not our code. (TRIPLY-J,
    // TRIPLY-C, TRIPLY-9) Backed up by denyUrls below for stacks that carry
    // an extension origin.
    "Can't find variable: _G",
    "runtime.sendMessage",
    "_globalBindingName",
    // Old / insecure-context browsers without Web Crypto. (TRIPLY-E)
    "crypto.randomUUID is not a function",
    // Cross-origin postMessage noise from bots/embeds on blog routes. (TRIPLY-F)
    "invalid origin",
    // iOS WebKit-based browsers (Brave, Firefox) inject extension content
    // scripts into the page context, so their stack frames carry the page
    // URL — denyUrls below can't see them. Match by message instead.
    // Triply never references window.ethereum or __firefox__ in app code,
    // so substring matches are safe.
    // (TRIPLY-M — Brave iOS wallet shim, TRIPLY-K — Firefox/Brave iOS bridge)
    "window.ethereum",
    "__firefox__",
    // iOS WKWebView native-bridge timeout — emitted by Apple's WebKit when
    // an injected script calls window.webkit.messageHandlers.*.postMessage()
    // and the native side doesn't reply in time. Fires from in-app browsers
    // (DuckDuckGo, Gmail, Instagram, etc.) that inject tracker-blocking or
    // analytics shims. The string is produced by WebKit itself; nothing we
    // ship can emit it. (TRIPLY-P)
    "WKWebView API client did not respond to this postMessage",
  ],

  // Drop errors whose top stack frame originates in a browser extension — a
  // large, ever-growing class of noise that is never our code. Complements the
  // extension-specific message matches in ignoreErrors above.
  denyUrls: [
    /^chrome-extension:\/\//i,
    /^moz-extension:\/\//i,
    /^safari-(web-)?extension:\/\//i,
    /extensions\//i,
  ],
});

// Captures router-level transitions for App Router navigation tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
