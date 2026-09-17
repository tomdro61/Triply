/**
 * POST /api/attribution
 *
 * Sets the first-party attribution cookie (`triply_attr`, HttpOnly) from a
 * touch the AttributionCapture client component observed, plus a readable
 * sentinel (`triply_attr_state`) the client uses to avoid re-posting.
 *
 * Why the SERVER sets it: Safari ITP caps JS-written cookies at 7 days, and at
 * 24 hours when the landing came from a known tracker with link decoration
 * (gclid, fbclid…) — exactly the paid traffic we want attributed. A server-set
 * HTTP cookie keeps its 30-day life, and HttpOnly keeps click ids out of XSS
 * reach.
 *
 * Unauthenticated and visitor-facing, so: same-origin only (a cross-site fetch
 * would otherwise plant a cookie the browser then sends on the victim's next
 * visit), a body cap measured on what actually arrived (a chunked request has
 * no Content-Length), and a bounded per-IP limiter.
 *
 * Rejections are NOT silent: each class fires one Sentry event per lambda
 * instance. A 400 in particular can only mean our own client produced a body
 * our own shared schema rejects — a bug, never noise.
 */

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { touchSchema, parseAttributionCookie, ATTR_COOKIE } from "@/lib/attribution/schema";
import {
  buildCookieHeaders,
  fitCookie,
  mergeCookie,
  stripClickIds,
  stripClickIdsFromCookie,
} from "@/lib/attribution/capture";
import { checkAttributionRateLimit } from "@/lib/attribution/limiter";
import { normalizeHost } from "@/lib/attribution/classify";
import { CONSENT_COOKIE, hasAnalyticsOptOutFromCookie } from "@/lib/cookies/consent-server";
import { getAirportByCode } from "@/config/airports";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const MAX_BODY_BYTES = 2048;

const bodySchema = z
  .object({
    touch: touchSchema,
    apt: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  })
  .strict();

function isSameOrigin(request: NextRequest): boolean {
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
 *  client-spoofable behind Vercel), but this limiter is a brake, not the
 *  security boundary — the origin check is. */
function clientKey(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

// Once-per-instance telemetry for each rejection class. Sampling, not
// suppression: instances recycle, and the durable signal is presentRate7d on
// the admin dashboard.
const reported = new Set<string>();
export function __resetAttributionRouteTelemetryForTests(): void {
  reported.clear();
}
function reportOnce(kind: string, context: Record<string, unknown>) {
  if (reported.has(kind)) return;
  reported.add(kind);
  try {
    Sentry.withScope((scope) => {
      scope.setFingerprint([`attribution_post_${kind}`]);
      scope.setContext("attribution", context);
      Sentry.captureMessage(`POST /api/attribution rejected: ${kind}`, "warning");
    });
  } catch {
    /* never let telemetry affect the response */
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    reportOnce("403_origin", {
      secFetchSite: request.headers.get("sec-fetch-site"),
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkAttributionRateLimit(clientKey(request))) {
    reportOnce("429_rate_limited", {});
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Measure the body that actually arrived: Content-Length is absent on a
  // chunked request, so a header check alone is bypassable.
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    reportOnce("413_body", { length: text.length });
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    reportOnce("400_json", {});
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    reportOnce("400_schema", { issue: parsed.error.issues[0]?.message ?? "unknown" });
    return NextResponse.json({ error: "Invalid touch" }, { status: 400 });
  }

  const optOut = hasAnalyticsOptOutFromCookie(request.cookies.get(CONSENT_COOKIE)?.value);
  // The route is the trust boundary, not the client: re-enforce the documented
  // field invariants here (ref = host only, land = a path, at = OUR clock — a
  // visitor's clock must not become a permanent "days to booking" input).
  const inbound = parsed.data.touch;
  const normalized = JSON.parse(
    JSON.stringify({
      ...inbound,
      ref: inbound.ref ? (normalizeHost(inbound.ref) ?? undefined) : undefined,
      // A path, never a URL: reject "//evil.com" as well as absolute forms.
      land: inbound.land && inbound.land.startsWith("/") && !inbound.land.startsWith("//") ? inbound.land : undefined,
      at: Math.floor(Date.now() / 1000),
    })
  ) as typeof inbound;
  const touch = optOut ? stripClickIds(normalized) : normalized;

  // Validate the airport against config so the cookie can only ever carry a
  // real production code.
  const aptInput = parsed.data.apt?.toUpperCase();
  const aptAirport = aptInput ? getAirportByCode(aptInput) : undefined;
  const apt = aptAirport && !aptAirport.isTest ? aptAirport.code : null;

  const existing = parseAttributionCookie(request.cookies.get(ATTR_COOKIE)?.value);
  if (existing.state === "invalid") {
    // Replaced, not merged (no salvageable first touch) — but recorded: a
    // capture POST usually heals a bad cookie before checkout, so this is the
    // only place the drift alarm can reliably fire.
    reportOnce("invalid_existing_cookie", { issue: existing.issue.slice(0, 200) });
  }
  let base = existing.state === "valid" ? existing.value : null;
  // An opt-out must scrub click ids captured BEFORE the visitor opted out too.
  if (base && optOut) base = stripClickIdsFromCookie(base);

  const merged = mergeCookie(base, touch, apt);
  const { value, dropped } = fitCookie(merged);
  if (dropped.length > 0) reportOnce("fields_dropped_for_size", { dropped });

  const res = new NextResponse(null, { status: 204 });
  const secure = process.env.NODE_ENV === "production";
  for (const c of buildCookieHeaders(value, secure)) {
    res.cookies.set(c.name, c.value, c.options);
  }
  return res;
}
