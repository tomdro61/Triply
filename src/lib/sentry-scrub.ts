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
 * Returns `value` with every string scrubbed. Objects are fixed in place where
 * possible; when a field can't be written (a frozen object) or read (a
 * throwing getter), the object is replaced by a scrubbed copy — without the
 * unreadable field — and the copy goes to its parent the same way, up to the
 * event itself. So a scrub never leaves a credential behind by failing open.
 * Arrays too: Object.keys gives their indices.
 */
function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubUrlCredentials(value);
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  const record = value as Record<string, unknown>;
  // Scrubbed values that couldn't be written in place, and fields that couldn't be read.
  const pending = new Map<string, unknown>();
  const unreadable = new Set<string>();
  for (const key of Object.keys(record)) {
    if (SKIP_KEYS.has(key)) continue;
    let v: unknown;
    try {
      v = record[key];
    } catch {
      unreadable.add(key);
      continue;
    }
    const s = scrubValue(v, seen);
    if (s === v) continue;
    try {
      record[key] = s;
      if (record[key] === s) continue;
    } catch {
      // can't write here: the copy below carries it
    }
    pending.set(key, s);
  }
  if (pending.size === 0 && unreadable.size === 0) return value;

  // A copy of every readable field, with the scrubbed values in place.
  const field = (key: string): { ok: true; v: unknown } | { ok: false } => {
    if (unreadable.has(key)) return { ok: false };
    if (pending.has(key)) return { ok: true, v: pending.get(key) };
    try {
      return { ok: true, v: record[key] };
    } catch {
      return { ok: false };
    }
  };
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const key of Object.keys(record)) {
      const f = field(key);
      if (f.ok) out[Number(key)] = f.v;
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const f = field(key);
    if (f.ok) out[key] = f.v;
  }
  return out;
}

/**
 * Deep-scrubs every string in a Sentry event (request, transaction name,
 * spans, breadcrumbs, extras) — also used for transactions and logs. Never
 * walks SDK internals and never throws: a throw in beforeSend makes Sentry
 * drop the event. May return a scrubbed COPY when the event can't be fixed in
 * place (Sentry sends whatever beforeSend returns).
 */
export function scrubEventCredentials<T>(event: T): T {
  try {
    // scrubValue keeps the shape of what it is given; only strings change.
    return scrubValue(event, new WeakSet<object>()) as T;
  } catch (error) {
    // Only reachable through exotic objects (e.g. a Proxy whose ownKeys throws),
    // which Sentry's event normalisation does not produce.
    console.error("sentry-scrub: could not scrub event", error);
    return event;
  }
}
