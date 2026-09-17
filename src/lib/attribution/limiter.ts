/**
 * Bounded per-key rate limiter for the unauthenticated attribution endpoint.
 *
 * The existing limiter in src/lib/ai/rate-limit.ts keeps an unbounded Map;
 * fine for the chat's small audience, an unbounded-memory leak on an endpoint
 * every visitor hits. This one is an LRU: at most MAX_KEYS entries, oldest
 * evicted on insert. State is per warm lambda instance — a best-effort brake,
 * not a security boundary (the origin check is).
 */

const MAX_KEYS = 5000;
const WINDOW_MS = 60_000;
const LIMIT = 30;

interface Bucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, Bucket>();

export function checkAttributionRateLimit(key: string, now = Date.now()): boolean {
  let b = store.get(key);
  if (b) {
    // Refresh LRU position.
    store.delete(key);
    if (now >= b.resetAt) b = undefined;
  }
  if (!b) {
    b = { count: 0, resetAt: now + WINDOW_MS };
  }
  if (b.count >= LIMIT) {
    store.set(key, b);
    return false;
  }
  b.count++;
  store.set(key, b);
  while (store.size > MAX_KEYS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return true;
}

export function __resetAttributionRateLimitForTests(): void {
  store.clear();
}

export function __attributionRateLimitSizeForTests(): number {
  return store.size;
}
