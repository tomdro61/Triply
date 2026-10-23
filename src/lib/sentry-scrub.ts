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
// The token classes stop at quotes and backslashes: the text being scrubbed is
// often JSON, and a swallowed escape would break it.
// `"` too: in JSON a query_string that STARTS with token= follows the opening quote.
const TOKEN_QUERY = /((?:^|[?&"])token=)[^&#\s"'\\]+/g;
// Any id segment, not just digits: a mistyped webhook URL still carries a real token.
const DISCORD_WEBHOOK = /(\/api\/(?:v\d+\/)?webhooks\/(?!stripe\b)[^/\s?#"'\\]+\/)[^/\s?#"'\\]+/g;

export function scrubUrlCredentials(text: string): string {
  return text
    .replace(REVIEW_PATH, "/review/[token]")
    .replace(TOKEN_QUERY, "$1[redacted]")
    .replace(DISCORD_WEBHOOK, "$1[token]");
}

/**
 * Holds live SDK scope objects (the whole client graph), so it is not
 * serialised with the event. The SDK reads it after beforeSend and sends ONE
 * part of it: `dynamicSamplingContext` becomes the envelope's trace header
 * (transaction name included), so that part is scrubbed; the rest is put back
 * as is.
 */
const SDK_METADATA_KEY = "sdkProcessingMetadata";
const DSC_KEY = "dynamicSamplingContext";

/** The metadata to put back: the same object, or a shallow copy with a scrubbed sampling context. */
function scrubbedMetadata(metadata: unknown): unknown {
  if (metadata === null || typeof metadata !== "object") return metadata;
  const dsc: unknown = Reflect.get(metadata, DSC_KEY);
  if (dsc === undefined) return metadata;
  // A plain record of strings; a throw here drops the event (the caller's catch).
  const clean: unknown = JSON.parse(scrubUrlCredentials(JSON.stringify(dsc)));
  return { ...metadata, [DSC_KEY]: clean };
}

/**
 * Returns the event with every credential removed from what Sentry will SEND.
 *
 * It scrubs the event's JSON text — the same serialisation Sentry's envelope
 * uses — rather than walking the objects, because a walk can't see what only
 * serialisation reveals (a URL object's toJSON, a getter, a frozen or shared
 * object) and every one of those leaked a token in review. The result is a
 * fresh plain copy rebuilt from the scrubbed text.
 *
 * A cycle is retried with repeated objects written as "[Circular]" (as
 * Sentry's own envelope fallback does). Anything that still can't be
 * serialised (a throwing getter, extreme depth) fails CLOSED: null tells
 * Sentry to drop the event — dropping beats sending a token. Never throws.
 */
export function scrubEventCredentials<T extends object>(event: T): T | null {
  try {
    const metadata: unknown = Reflect.get(event, SDK_METADATA_KEY);
    const skipMetadata = function (this: unknown, key: string, value: unknown): unknown {
      return this === event && key === SDK_METADATA_KEY ? undefined : value;
    };
    let json: string;
    try {
      json = JSON.stringify(event, skipMetadata);
    } catch {
      // Only a true cycle (an object inside itself) becomes "[Circular]"; a
      // shared object reached twice is written twice. JSON.stringify walks depth
      // first, so `ancestors` is the path from the root to the current holder.
      // A BigInt (e.g. a log attribute) is written as a string.
      const ancestors: unknown[] = [];
      json = JSON.stringify(event, function (this: unknown, key: string, value: unknown) {
        const v = skipMetadata.call(this, key, value);
        if (typeof v === "bigint") return v.toString();
        if (typeof v !== "object" || v === null) return v;
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
        if (ancestors.includes(v)) return "[Circular]";
        ancestors.push(v);
        return v;
      });
    }
    // The fields of an event are plain JSON data, so the parsed copy has the event's shape.
    const scrubbed = JSON.parse(scrubUrlCredentials(json)) as T;
    if (metadata !== undefined) Reflect.set(scrubbed, SDK_METADATA_KEY, scrubbedMetadata(metadata));
    return scrubbed;
  } catch (error) {
    console.error("sentry-scrub: event could not be serialised; dropped so no credential is sent", error);
    return null;
  }
}
