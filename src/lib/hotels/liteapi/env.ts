/**
 * Which LiteAPI environment this process talks to, derived from the SAME
 * predicate the money paths use for Stripe live-mode
 * (`STRIPE_SECRET_KEY` starts with `sk_live_` — see
 * src/app/api/cron/sweep-pending-bookings/route.ts:73 and reconcile.ts). One
 * process is either live everywhere or test everywhere; a mixed state (live
 * Stripe + sandbox hotels, or the reverse) is exactly the shared-DB confusion
 * the plan forbids (§2.1).
 *
 * THROWS at first use when the selected mode's key is absent — never
 * `LITEAPI_API_KEY || LITEAPI_SANDBOX_KEY`, which would let a production
 * deploy quietly book sandbox rooms.
 *
 * Resolved lazily (not at import) so a build without the key still compiles
 * (the WAITLIST_SIGNING_SECRET lesson, PR #25).
 */

export type LiteApiMode = "live" | "sandbox";

export interface LiteApiEnv {
  mode: LiteApiMode;
  apiKey: string;
  /** search / rates / prebook */
  dataBaseUrl: string;
  /** book / get / cancel */
  bookBaseUrl: string;
}

export class LiteApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiteApiConfigError";
  }
}

/** A plain string map so tests can pass literals without casting through ProcessEnv. */
export type EnvMap = Record<string, string | undefined>;

export function liteApiModeFromEnv(env: EnvMap = process.env): LiteApiMode {
  return (env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_") ? "live" : "sandbox";
}

let cached: LiteApiEnv | null = null;

export function resolveHotelEnv(env: EnvMap = process.env): LiteApiEnv {
  if (cached && env === process.env) return cached;
  const mode = liteApiModeFromEnv(env);
  const apiKey = mode === "live" ? env.LITEAPI_API_KEY : env.LITEAPI_SANDBOX_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new LiteApiConfigError(
      mode === "live"
        ? "LITEAPI_API_KEY is not set but Stripe is in live mode — refusing to fall back to the sandbox key"
        : "LITEAPI_SANDBOX_KEY is not set (Stripe is in test mode, so the sandbox key is required)"
    );
  }
  const resolved: LiteApiEnv = {
    mode,
    apiKey: apiKey.trim(),
    dataBaseUrl: "https://api.liteapi.travel/v3.0",
    bookBaseUrl: "https://book.liteapi.travel/v3.0",
  };
  if (env === process.env) cached = resolved;
  return resolved;
}

export function __resetHotelEnvForTests(): void {
  cached = null;
}
