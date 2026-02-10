/**
 * Tiered in-memory rate limiter for AI chat.
 *
 * Three windows per IP: per-minute (burst), per-hour, per-day.
 * Returns which tier was exceeded so the client can show an appropriate message.
 *
 * Note: In-memory state resets on Vercel cold starts (serverless spin-down
 * after ~5-15 min of inactivity). Acceptable for MVP — upgrade to Upstash
 * Redis for persistent rate limiting once usage grows.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

interface IPBuckets {
  minute: Bucket;
  hour: Bucket;
  day: Bucket;
}

const LIMITS = {
  perMinute: 10,
  perHour: 100,
  perDay: 500,
} as const;

const WINDOWS = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
} as const;

// In-memory store — survives within a single serverless instance
const store = new Map<string, IPBuckets>();

export type RateLimitTier = "minute" | "hour" | "day";

export interface RateLimitResult {
  allowed: boolean;
  tier?: RateLimitTier;
}

function getOrCreateBuckets(ip: string): IPBuckets {
  const now = Date.now();
  let buckets = store.get(ip);

  if (!buckets) {
    buckets = {
      minute: { count: 0, resetAt: now + WINDOWS.minute },
      hour: { count: 0, resetAt: now + WINDOWS.hour },
      day: { count: 0, resetAt: now + WINDOWS.day },
    };
    store.set(ip, buckets);
    return buckets;
  }

  // Reset expired windows
  if (now >= buckets.minute.resetAt) {
    buckets.minute = { count: 0, resetAt: now + WINDOWS.minute };
  }
  if (now >= buckets.hour.resetAt) {
    buckets.hour = { count: 0, resetAt: now + WINDOWS.hour };
  }
  if (now >= buckets.day.resetAt) {
    buckets.day = { count: 0, resetAt: now + WINDOWS.day };
  }

  return buckets;
}

export function checkRateLimit(ip: string): RateLimitResult {
  const buckets = getOrCreateBuckets(ip);

  // Check from strictest to broadest
  if (buckets.minute.count >= LIMITS.perMinute) {
    return { allowed: false, tier: "minute" };
  }
  if (buckets.hour.count >= LIMITS.perHour) {
    return { allowed: false, tier: "hour" };
  }
  if (buckets.day.count >= LIMITS.perDay) {
    return { allowed: false, tier: "day" };
  }

  // All clear — increment all buckets
  buckets.minute.count++;
  buckets.hour.count++;
  buckets.day.count++;

  return { allowed: true };
}
