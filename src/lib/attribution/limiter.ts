/**
 * Bounded per-key rate limiter for unauthenticated, visitor-facing endpoints
 * (attribution, newsletter, ...).
 *
 * The existing limiter in src/lib/ai/rate-limit.ts keeps an unbounded Map;
 * fine for the chat's small audience, an unbounded-memory leak on an endpoint
 * every visitor hits. This one is an LRU: at most maxKeys entries, oldest
 * evicted on insert. State is per warm lambda instance — a best-effort brake,
 * not a security boundary (the origin check is).
 */

interface Bucket {
  count: number;
  resetAt: number;
}

function createBoundedRateLimiter(opts: { limit: number; windowMs: number; maxKeys: number }) {
  const { limit, windowMs, maxKeys } = opts;
  const store = new Map<string, Bucket>();

  function check(key: string, now = Date.now()): boolean {
    let b = store.get(key);
    if (b) {
      // Refresh LRU position.
      store.delete(key);
      if (now >= b.resetAt) b = undefined;
    }
    if (!b) {
      b = { count: 0, resetAt: now + windowMs };
    }
    if (b.count >= limit) {
      store.set(key, b);
      return false;
    }
    b.count++;
    store.set(key, b);
    while (store.size > maxKeys) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
    return true;
  }

  return {
    check,
    reset: () => store.clear(),
    size: () => store.size,
  };
}

const attributionLimiter = createBoundedRateLimiter({ limit: 30, windowMs: 60_000, maxKeys: 5000 });

export function checkAttributionRateLimit(key: string, now = Date.now()): boolean {
  return attributionLimiter.check(key, now);
}

export function __resetAttributionRateLimitForTests(): void {
  attributionLimiter.reset();
}

export function __attributionRateLimitSizeForTests(): number {
  return attributionLimiter.size();
}

// Newsletter signup is a heavier action (mints a live promo code + sends an
// email) than an attribution touch, so it's tighter than the attribution
// limiter above — but 5/min/IP (the original budget) punished shared IPs
// (airport WiFi, CGNAT) after a handful of readers signed up back to back.
// Widened to ~15/min/IP; the route only charges this limiter on the mint
// path (after validation and the read-only lookups), not on every request.
//
// That mint-only charging left every OTHER request on the route (lookups,
// "already subscribed" responses) completely unmetered — see
// checkNewsletterRequestRateLimit below, which closes that gap.
const newsletterLimiter = createBoundedRateLimiter({ limit: 15, windowMs: 60_000, maxKeys: 5000 });

export const NEWSLETTER_RATE_LIMIT_WINDOW_SECONDS = 60;

export function checkNewsletterRateLimit(key: string, now = Date.now()): boolean {
  return newsletterLimiter.check(key, now);
}

export function __resetNewsletterRateLimitForTests(): void {
  newsletterLimiter.reset();
}

export function __newsletterRateLimitSizeForTests(): number {
  return newsletterLimiter.size();
}

// Request-level ceiling for the newsletter route, charged on EVERY request
// that clears the origin check — before any lookup, mint, or send. Pass-3
// review: charging only the mint path (above) left every non-mint request
// (1-2 SELECTs + an UPDATE per call) completely unbounded from a public
// endpoint, and made hitting the mint quota vs. not into an enumeration
// oracle ("already subscribed" lookups never 429'd, no matter how many were
// sent). This is deliberately looser than the mint quota — it exists to cap
// total DB load per IP, not to gate the expensive mint+send action.
const newsletterRequestLimiter = createBoundedRateLimiter({ limit: 60, windowMs: 60_000, maxKeys: 5000 });

export const NEWSLETTER_REQUEST_RATE_LIMIT_WINDOW_SECONDS = 60;

export function checkNewsletterRequestRateLimit(key: string, now = Date.now()): boolean {
  return newsletterRequestLimiter.check(key, now);
}

export function __resetNewsletterRequestRateLimitForTests(): void {
  newsletterRequestLimiter.reset();
}

export function __newsletterRequestRateLimitSizeForTests(): number {
  return newsletterRequestLimiter.size();
}

// Same budget as newsletter: also mints a send (a confirmation email) per
// request, so it gets the same tighter ~5/min/IP rather than attribution's 30.
const waitlistLimiter = createBoundedRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 5000 });

export function checkWaitlistRateLimit(key: string, now = Date.now()): boolean {
  return waitlistLimiter.check(key, now);
}

export function __resetWaitlistRateLimitForTests(): void {
  waitlistLimiter.reset();
}

export function __waitlistRateLimitSizeForTests(): number {
  return waitlistLimiter.size();
}
