/**
 * Shared same-origin + client-key helpers for unauthenticated, visitor-facing
 * POST routes (attribution, newsletter, ...). Extracted from
 * src/app/api/attribution/route.ts so a second public endpoint doesn't grow a
 * second, silently-drifting copy.
 */

import { NextRequest } from "next/server";

export function isSameOrigin(request: NextRequest): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin") return true;
  if (site && site !== "same-origin") return false;
  // Older browsers: no Sec-Fetch-Site. Fall back to Origin vs Host.
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Vercel overwrites x-forwarded-for with the real client IP (it is not
 *  client-spoofable behind Vercel), but this is a brake, not the security
 *  boundary — the origin check is. */
export function clientKey(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}
