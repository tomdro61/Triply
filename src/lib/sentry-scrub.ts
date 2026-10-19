// Removes credentials that travel in URLs from Sentry events before they leave
// the server. The post-trip review link /review/{token} is a bearer credential
// for that booking's review: the landing route redirects it away at once, but
// server tracing records the original request URL (sendDefaultPii does not
// cover URLs). Also the `token=` query of the unsubscribe links.

const REVIEW_PATH = /\/review\/[0-9a-zA-Z._-]{20,}/g;
const TOKEN_QUERY = /([?&]token=)[^&#\s"']+/g;

export function scrubUrlCredentials(text: string): string {
  return text.replace(REVIEW_PATH, "/review/[token]").replace(TOKEN_QUERY, "$1[redacted]");
}

/** Deep-scrubs every string in a Sentry event (request, transaction name,
 *  spans, breadcrumbs, extras). Mutates in place and returns the event. */
export function scrubEventCredentials<T>(event: T): T {
  const seen = new WeakSet<object>();
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return scrubUrlCredentials(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = walk(value[i]);
      return value;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) record[key] = walk(record[key]);
    return value;
  };
  return walk(event) as T;
}
