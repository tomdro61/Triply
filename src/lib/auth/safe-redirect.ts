/**
 * Where a person goes after signing in.
 *
 * The login page (`?redirect=`) and the sign-in callback (`?next=`) read the
 * destination from the URL, so a link can carry any value. Only a page of our
 * own site passes; anything else becomes "/", the homepage.
 *
 * - "/" is a navigation fallback, not customer data, so the "no silent default
 *   for user-supplied data" rule doesn't apply here.
 * - A refused value is not sent to Sentry: it is whatever the link's author
 *   typed, so it would only be noise.
 * - A caller that puts a query in the path must encode the inner values first
 *   (`/search?checkinTime=10%3A00%20AM`). A raw space is refused and lands on
 *   "/", and so is a raw `+` (the URL's query decodes it to a space).
 * - Our own pages that forward elsewhere by design (`/claims` → Park Guard)
 *   pass: we chose where they go.
 *
 * Returns the normalised path, so the value checked is the value used, and
 * running it twice gives the same result. Pure: browser and server.
 */

// Only compared against, never visited. `.invalid` can never resolve, so it
// can't be mistaken for a real host.
const PARSE_BASE = "https://triply.invalid";
// Checked on the normalised path: normalising percent-encodes, so "é" grows to
// "%C3%A9", and a cap on the raw input would let the callback's second pass
// refuse what the login page accepted.
const MAX_LENGTH = 2048;
// Sending someone back into sign-in after they sign in loops. A loop guard,
// not a security rule: exact paths (one trailing slash ignored), case-sensitive.
const SIGN_IN_PATHS = new Set(["/auth/login", "/auth/callback"]);

// Control characters, whitespace and the backslash. Browsers strip or rewrite
// these, which is how "/\host" and "/<tab>/host" get past a "one leading
// slash" check and land on another site.
function hasUnsafeChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

export function safeRedirectPath(value: string | null | undefined): string {
  if (!value || hasUnsafeChar(value)) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  let url: URL;
  try {
    url = new URL(value, PARSE_BASE);
  } catch {
    // Not a parseable path: an untrusted link value, not an API response.
    return "/";
  }
  // Defence in depth: the checks above already keep the value on the base.
  if (url.origin !== PARSE_BASE) return "/";

  const path = url.pathname + url.search + url.hash;
  // The security boundary. Normalising can create a leading "//": "/.//host",
  // "/a/..//host" and "/%2e//host" all become the path "//host", which a
  // browser reads as another site. Check the result, not the input.
  if (path.startsWith("//")) return "/";
  if (path.length > MAX_LENGTH) return "/";
  if (SIGN_IN_PATHS.has(url.pathname.replace(/\/$/, ""))) return "/";
  return path;
}
