/**
 * The deployment environment, as data every environment-dependent rule keys on.
 *
 * NEXT_PUBLIC_APP_ENV is the project's own setting; when it is absent fall back
 * to VERCEL_ENV, which Vercel sets on every deployment (production | preview |
 * development). Anything else is "unknown" — and every consumer must treat
 * "unknown" as the most restrictive case (visibility fails closed, telemetry
 * rows are tagged unknown, never production).
 *
 * Lives in its own module so pure libraries (direct-lot visibility, the
 * availability log) can share it without pulling in `next/server`.
 */
export type AppEnv = "production" | "preview" | "staging" | "development" | "unknown" | (string & {});

export function resolveEnv(): string {
  const configured = process.env.NEXT_PUBLIC_APP_ENV;
  if (configured) return configured;
  const vercel = process.env.VERCEL_ENV;
  if (vercel === "production" || vercel === "preview" || vercel === "development") {
    return vercel;
  }
  return "unknown";
}
