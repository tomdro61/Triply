// Removes credentials that travel in URLs from Sentry events before they leave
// the server. The post-trip review link /review/{token} is a bearer credential
// for that booking's review: the landing route redirects it away at once, but
// server tracing records the original request URL (sendDefaultPii does not
// cover URLs). Also the `token=` query of the unsubscribe links — including
// Sentry's `request.query_string`, which has no leading "?". And the token of
// our Discord webhooks (booking alerts, daily digest, direct-lot alerts):
// Sentry's fetch instrumentation records the full URL of every outgoing
// request in breadcrumbs and spans, and that token lets anyone post as us.

const REVIEW_PATH = /\/review\/[0-9a-zA-Z._-]{20,}/g;
const TOKEN_QUERY = /((?:^|[?&])token=)[^&#\s"']+/g;
// Any id segment, not just digits: a mistyped webhook URL still carries a real token.
const DISCORD_WEBHOOK = /(\/api\/(?:v\d+\/)?webhooks\/(?!stripe\b)[^/\s?#"']+\/)[^/\s?#"']+/g;

export function scrubUrlCredentials(text: string): string {
  return text
    .replace(REVIEW_PATH, "/review/[token]")
    .replace(TOKEN_QUERY, "$1[redacted]")
    .replace(DISCORD_WEBHOOK, "$1[token]");
}

/** Holds live SDK scope objects (the whole client graph), never user data. */
const SKIP_KEYS = new Set(["sdkProcessingMetadata"]);

/**
 * Deep-scrubs every string in a Sentry event (request, transaction name,
 * spans, breadcrumbs, extras). Writes back only strings that changed, never
 * walks SDK internals, and never throws: a throw in beforeSend makes Sentry
 * drop the event. Each value is scrubbed on its own, so one that can't be
 * written (a frozen object, a throwing getter) is skipped and logged while the
 * walk carries on — one bad value never leaves the REST of the event unscrubbed.
 */
export function scrubEventCredentials<T>(event: T): T {
  const seen = new WeakSet<object>();
  let failures = 0;
  // Arrays too: Object.keys gives their indices.
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (SKIP_KEYS.has(key)) continue;
      try {
        const v = record[key];
        if (typeof v === "string") {
          const s = scrubUrlCredentials(v);
          if (s !== v) record[key] = s;
        } else {
          walk(v);
        }
      } catch {
        failures++;
      }
    }
  };
  try {
    walk(event);
  } catch {
    failures++;
  }
  if (failures > 0) console.error(`sentry-scrub: ${failures} value(s) could not be scrubbed`);
  return event;
}
