/** Channel enum — no imports, safe for client bundles. schema.ts re-exports it. */
export const CHANNELS = [
  "paid_search",
  "paid_social",
  "email",
  "partner",
  "referral",
  "organic_search",
  "organic_social",
  "direct",
] as const;
export type Channel = (typeof CHANNELS)[number];
export function isChannel(x: unknown): x is Channel {
  return typeof x === "string" && (CHANNELS as readonly string[]).includes(x);
}
