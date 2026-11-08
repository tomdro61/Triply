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
 *   (`/search?checkinTime=10%3A00%20AM`). A raw space is refused and lands on "/".
 *
 * Returns the normalised path, so the value checked is the value used, and
 * running it twice gives the same result. Pure: browser and server.
 */

// Only compared against, never visited. `.invalid` can never resolve, so it
// can't be mistaken for a real host.
const PARSE_BASE = "https://triply.invalid";
const MAX_LENGTH = 2048;
// Sending someone back into sign-in after they sign in loops. A loop guard,
// not a security rule: exact paths, case-sensitive.
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
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return "/";
  if (hasUnsafeChar(value)) return "/";
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
  if (SIGN_IN_PATHS.has(url.pathname)) return "/";
  return path;
}
