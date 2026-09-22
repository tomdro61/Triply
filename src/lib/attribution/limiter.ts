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
// path now (after validation), not on every request, so the two changes
// together still bound the actual cost (a code + an email) per IP per
// minute while leaving read-only responses ("you're already subscribed")
// unlimited.
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
