/**
 * Which direct lots an environment may show (plan B11 / C3).
 *
 * The CMS and the database are shared by production, staging, preview and
 * local, so a lot's visibility is data, not config:
 *   production   → visible everywhere (lets Tom rehearse a real lot on staging)
 *   staging_only → visible only off-production (test lots)
 * Anything unrecognised — an unknown visibility value OR an unknown
 * environment — fails CLOSED. Never use `airports.ts`'s NODE_ENV-based
 * isProduction here; `resolveEnv()` (NEXT_PUBLIC_APP_ENV, then VERCEL_ENV) is
 * the one source.
 */
export const DIRECT_LOT_VISIBILITIES = ["production", "staging_only"] as const;
export type DirectLotVisibility = (typeof DIRECT_LOT_VISIBILITIES)[number];

export function parseVisibility(value: unknown): DirectLotVisibility | null {
  return typeof value === "string" && (DIRECT_LOT_VISIBILITIES as readonly string[]).includes(value)
    ? (value as DirectLotVisibility)
    : null;
}

const NON_PRODUCTION_ENVS = new Set(["staging", "preview", "development"]);

export function isDirectLotVisible(visibility: unknown, env: string): boolean {
  const v = parseVisibility(visibility);
  if (!v) return false;
  if (v === "production") return env === "production" || NON_PRODUCTION_ENVS.has(env);
  // staging_only
  return NON_PRODUCTION_ENVS.has(env);
}
