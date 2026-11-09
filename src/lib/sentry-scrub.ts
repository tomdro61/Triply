// Removes credentials that travel in URLs from Sentry events before they leave
// the server or the browser. The post-trip review link /review/{token} is a bearer credential
// for that booking's review: the landing route redirects it away at once, but
// server tracing records the original request URL (sendDefaultPii does not
// cover URLs). Also the `token=` query of the unsubscribe links — including
// Sentry's `request.query_string`, which has no leading "?". And the token of
// our Discord webhooks (booking alerts, daily digest, direct-lot alerts):
// Sentry's fetch instrumentation records the full URL of every outgoing
// request in breadcrumbs and spans, and that token lets anyone post as us.

import { RECORDED_URL_SECRET_PARAMS } from "./privacy/recorded-url-params";

const REVIEW_PATH = /\/review\/[0-9a-zA-Z._-]{20,}/g;
// The token classes stop at quotes and backslashes: the text being scrubbed is
// often JSON, and a swallowed escape would break it.
// `"` too: in JSON a query_string that STARTS with token= follows the opening quote.
const TOKEN_QUERY = /((?:^|[?&"])token=)[^&#\s"'\\]+/g;
// Any id segment, not just digits: a mistyped webhook URL still carries a real token.
const DISCORD_WEBHOOK = /(\/api\/(?:v\d+\/)?webhooks\/(?!stripe\b)[^/\s?#"'\\]+\/)[^/\s?#"'\\]+/g;
// RECORDED_URL_SECRET_PARAMS (lib/privacy/recorded-url-params.ts): the guest's
// email on an emailed confirmation link (/confirmation/{n}?email=), Stripe's
// 3-D Secure return (?payment_intent_client_secret=), which
// /api/reservations/complete trades for that email, and the signed booking key
// (?booking_key=). Matched by param NAME: `utm_medium=email` is a value and is
// left alone. Built from the list so the two can't drift.
const SECRET_PARAM_NAMES = RECORDED_URL_SECRET_PARAMS.join("|");
const SECRET_NAME_SET: ReadonlySet<string> = new Set(RECORDED_URL_SECRET_PARAMS);
// The START of every query param (`?`, `&`, the string's start, or a JSON
// quote, then a name and `=`). Only the name is consumed — never the value —
// so a secret nested unencoded inside another param's value
// (?next=/confirmation/n?booking_key=…) is still found. The name stops at `?`
// and `/`, so it never spans a path.
const PARAM_START = /(?:^|[?&"])([^=&#?/\s"'\\]+)=/g;
// A value runs to the next `&`, `#`, whitespace, quote or backslash: the text
// is often JSON, and a swallowed escape would break it.
const PARAM_VALUE = /[^&#\s"'\\]+/y;
// The same inside a URL that is itself encoded into another URL (…%3Femail%3D…).
const SECRET_QUERY_ENCODED = new RegExp(`((?:%3F|%26)(?:${SECRET_PARAM_NAMES})%3D)(?:(?!%26)[^&#\\s"'\\\\])+`, "gi");
// A Stripe client secret anywhere (a message, an encoded URL — so no \b: after
// "%3D" there is no word boundary): keep the PaymentIntent id, drop the secret.
const CLIENT_SECRET = /(pi_[A-Za-z0-9]+)_secret_[A-Za-z0-9]+/g;
// Request headers that carry a guest's proof: the confirmation page sends the
// checkout email (x-booking-email) and the signed booking key (x-booking-key);
// x-payment-client-secret is listed ahead of its first sender (checkout will
// send the Stripe client secret in it to ask for the key). The
// server SDK attaches request headers to events AND copies them onto the root
// span as "http.request.header.x_booking_email" etc. The SDK filters only some
// header names itself (words like auth, token, session; "key" on spans), so
// this list is ours to keep. Names are matched in any case; the value may
// contain JSON escapes.
const SECRET_HEADER =
  /("(?:http\.request\.header\.)?x[-_](?:booking[-_](?:email|key)|payment[-_]client[-_]secret)"\s*:\s*")(?:[^"\\]|\\.)*(")/gi;

/** A query param's name as URLSearchParams reads it: percent-decoded, `+` as a space. */
function decodedParamName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

/**
 * Redacts the value of every RECORDED_URL_SECRET_PARAMS param, the name
 * compared as URLSearchParams reads it (`booking%5Fkey=` opens the page exactly
 * like `booking_key=`). One left-to-right scan: linear, whatever the input.
 */
function scrubSecretParams(text: string): string {
  let out = "";
  let copied = 0;
  PARAM_START.lastIndex = 0;
  for (let m = PARAM_START.exec(text); m !== null; m = PARAM_START.exec(text)) {
    if (!SECRET_NAME_SET.has(decodedParamName(m[1]))) continue;
    const valueStart = m.index + m[0].length;
    PARAM_VALUE.lastIndex = valueStart;
    const value = PARAM_VALUE.exec(text);
    if (!value) continue;
    out += text.slice(copied, valueStart) + "[redacted]";
    copied = valueStart + value[0].length;
    PARAM_START.lastIndex = copied;
  }
  return out + text.slice(copied);
}

export function scrubUrlCredentials(text: string): string {
  return scrubSecretParams(
    text
      .replace(REVIEW_PATH, "/review/[token]")
      .replace(TOKEN_QUERY, "$1[redacted]")
      .replace(DISCORD_WEBHOOK, "$1[token]")
  )
    .replace(SECRET_QUERY_ENCODED, "$1[redacted]")
    .replace(CLIENT_SECRET, "$1_secret_[redacted]")
    .replace(SECRET_HEADER, "$1[redacted]$2");
}

/**
 * A browser breadcrumb with URL credentials removed from its strings only
 * (message, data.url / from / to). Not the JSON round-trip of
 * scrubEventCredentials: breadcrumbs reach this hook before Sentry normalises
 * them, and a round-trip would empty any Error or class instance they carry.
 */
export function scrubBreadcrumbUrls<T extends { message?: string; data?: { [key: string]: unknown } }>(crumb: T): T {
  const out: T = { ...crumb };
  if (typeof out.message === "string") out.message = scrubUrlCredentials(out.message);
  if (out.data) {
    const data = { ...out.data };
    for (const key of ["url", "from", "to"]) {
      const value = data[key];
      if (typeof value === "string") data[key] = scrubUrlCredentials(value);
    }
    out.data = data;
  }
  return out;
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
 * A cycle is retried with any object found inside itself written as
 * "[Circular]" (as Sentry's own envelope fallback does). Anything that still can't be
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
