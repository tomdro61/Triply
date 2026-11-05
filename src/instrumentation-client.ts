// Client-side Sentry initialization. Auto-loaded by Next.js when this file
// is at src/instrumentation-client.ts (next 15.3+ convention).

import * as Sentry from "@sentry/nextjs";
import { scrubBreadcrumbUrls, scrubEventCredentials } from "@/lib/sentry-scrub";
import { hasRecordedUrlSecret } from "@/lib/privacy/recorded-url-params";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Environment label so Sentry can separate prod / staging / dev events.
  environment: process.env.NEXT_PUBLIC_APP_ENV || "development",

  // Don't send events from local dev — saves quota and avoids noise.
  enabled: process.env.NODE_ENV !== "development",

  // Performance monitoring — sample 10% of transactions in production.
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

  // Session replay — 10% of all sessions, 100% of sessions with errors.
  // The replay integration itself is added lazily, below.
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,

  // Don't send IP address, cookies, or User-Agent by default — too easy to
  // leak session tokens or other identifiers via cookies. Attach selectively
  // via Sentry.withScope where useful (see lib/sentry.ts helpers).
  sendDefaultPii: false,

  // Send application logs ingested via Sentry.logger.* alongside events.
  enableLogs: true,

  // Page and request URLs can carry a guest's email (?email= on an emailed
  // confirmation link) or a Stripe client secret (the 3-D Secure return), and
  // the browser SDK records URLs in events, transactions, breadcrumbs and
  // logs. Same scrub as the server (src/lib/sentry-scrub.ts); these hooks run
  // after Sentry normalises the event. Breadcrumbs arrive raw, so only their
  // URL strings are scrubbed. Replay events are covered by the event processor
  // below; recordings by beforeAddRecordingEvent and by not starting replay on
  // such a URL.
  beforeSend: (event) => scrubEventCredentials(event),
  beforeSendTransaction: (event) => scrubEventCredentials(event),
  beforeSendLog: (log) => scrubEventCredentials(log),
  beforeBreadcrumb: (breadcrumb) => scrubBreadcrumbUrls(breadcrumb),

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

// Replay events (their `urls` list) skip beforeSend but pass event processors.
// Only those: processors run BEFORE normalisation, where the JSON round-trip
// would empty an Error carried in an error event's extra/contexts.
Sentry.addEventProcessor((event) => (event.type === "replay_event" ? scrubEventCredentials(event) : event));

// Session replay, loaded after the page is idle.
//
// Replay (the rrweb recorder) is the largest part of Sentry's browser code.
// Bundled into init above, it was downloaded and parsed on every page before
// the page could respond to a tap. Error capture and tracing still start
// immediately with Sentry.init; only the recorder waits. Trade-off: an error
// thrown in the first second or two of a visit, before the recorder is up,
// is still reported but has no replay attached.
//
// Replay must mask customer PII visible on screen (names, emails, phone,
// vehicle info, addresses on confirmation pages, admin booking modal, etc.).
// Without maskAllText / blockAllMedia, replays leak customer data into Sentry
// recordings.
function loadReplay() {
  import("@sentry/nextjs")
    .then(({ replayIntegration }) => {
      Sentry.addIntegration(
        replayIntegration({
          maskAllText: true,
          blockAllMedia: true,
          // Navigations and breadcrumbs inside a recording (custom events)
          // carry URLs too. The recording's first page URL is not passed
          // here — hence replay never starts on a URL with a secret (below).
          beforeAddRecordingEvent: (event) => scrubEventCredentials(event),
        })
      );
    })
    .catch(() => {
      // Chunk failed to load (offline, blocked by an extension). Error capture
      // is unaffected. Deliberately silent: a replay chunk that never loads on
      // some client is not an application error, and reporting it from here
      // would be one event per such page view.
    });
}

/**
 * Pages whose failures we most want a replay for happen in the first seconds
 * of a HARD load: /checkout/complete and /confirmation/* are where a customer
 * lands after a 3-D Secure redirect, and a ResLab 5xx on the confirmation
 * fetch (TRIPLY-27) fires before "load + idle". On those routes the recorder
 * starts immediately; everywhere else it waits for idle (PR #50 review).
 */
const REPLAY_EAGER_PATHS = /^\/(checkout|confirmation)(\/|$)/;

/**
 * The recorder's first event holds the page URL as it is when replay starts,
 * and no hook can scrub it. An emailed confirmation link (?email=) or the 3-D
 * Secure return (?payment_intent_client_secret=) is stripped by the page
 * after hydration, so on such a URL replay waits for load + idle and starts
 * only if the address bar is clean by then (storage blocked → the page keeps
 * ?email= → no replay for this page load).
 */
if (typeof window !== "undefined" && process.env.NODE_ENV !== "development") {
  const whenLoadedAndIdle = (cb: () => void) => {
    const whenIdle = () =>
      "requestIdleCallback" in window
        ? window.requestIdleCallback(cb, { timeout: 5000 })
        : setTimeout(cb, 3000);
    if (document.readyState === "complete") whenIdle();
    else window.addEventListener("load", whenIdle, { once: true });
  };
  const loadReplayIfClean = () => {
    if (!hasRecordedUrlSecret(window.location.href)) loadReplay();
  };

  if (REPLAY_EAGER_PATHS.test(window.location.pathname) && !hasRecordedUrlSecret(window.location.href)) {
    loadReplay();
  } else {
    whenLoadedAndIdle(loadReplayIfClean);
  }
}

// Captures router-level transitions for App Router navigation tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
