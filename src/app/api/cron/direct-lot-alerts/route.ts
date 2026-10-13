/**
 * GET /api/cron/direct-lot-alerts — tells Triply, loudly, when a direct lot
 * was not told about a booking or a cancellation, or did not get its evening
 * manifest (6b plan §5). Vercel cron `*\/10` — Vercel runs crons only on
 * Production; on staging this runs only when called by hand (with CRON_SECRET).
 *
 * Posts to DISCORD_DAILY_DIGEST_WEBHOOK_URL as "Triply Alerts" (no fallback to
 * the session webhook: unset is a Sentry error and a 500). URGENT items carry
 * `@here` in production and each raises its own Sentry issue (the real-time
 * email). A staging call (test-mode Stripe) posts "[TEST]" lines and never pings.
 * Lines carry TRP numbers and lot ids only (no customer details). An item a
 * person marked resolved (direct_lot_alerts.resolved_at) is not posted again.
 * The scans and the posting rules live in src/lib/direct/alerts/.
 *
 *   ?dry=1   compute and return what would be posted; writes, posts and
 *            reports nothing, and touches no check-in
 *
 * DIRECT_LOT_ALERTS_DISABLED=true → 200, nothing done. Deliberately no cron
 * check-in either: the monitor then shows the safety net is off.
 *
 * Stripe mode = this deployment's key (staging and production share the
 * database; a run only ever reads and writes its own mode's rows). A failed
 * scan or DB write is a 500 and a failed Discord post a 502, each with an
 * `error` check-in; every exit flushes Sentry.
 */

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { stripeKeyIsLive } from "@/lib/cancellation/source-guard";
import { runAlertsCron } from "@/lib/direct/alerts/run";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CTX = { endpoint: "/api/cron/direct-lot-alerts", method: "GET" as const };
const MONITOR_SLUG = "direct-lot-alerts";
/** The run's own budget, well inside maxDuration. */
const RUN_BUDGET_MS = 45_000;
const safeFlush = () => Sentry.flush(2_000).catch(() => {});

const MONITOR_CONFIG = { schedule: { type: "crontab" as const, value: "*/10 * * * *" }, checkinMargin: 5, maxRuntime: 2, timezone: "UTC" };

// Sentry types an in-progress check-in (no id) apart from a finished one (id required).
function checkIn(status: "in_progress"): string | undefined;
function checkIn(status: "ok" | "error", checkInId: string | undefined): string | undefined;
function checkIn(status: "in_progress" | "ok" | "error", checkInId?: string): string | undefined {
  try {
    if (status === "in_progress") return Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status }, MONITOR_CONFIG);
    if (!checkInId) return undefined;
    return Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status, checkInId }, MONITOR_CONFIG);
  } catch {
    return undefined;
  }
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const dry = request.nextUrl.searchParams.get("dry") === "1";

  if (process.env.DIRECT_LOT_ALERTS_DISABLED === "true") {
    return NextResponse.json({ ok: true, disabled: true, dry });
  }

  const webhookUrl = (process.env.DISCORD_DAILY_DIGEST_WEBHOOK_URL ?? "").trim() || null;
  if (!webhookUrl && !dry) {
    captureAPIError(new Error("direct lot alerts: DISCORD_DAILY_DIGEST_WEBHOOK_URL is not set — no alert can be posted"), { ...CTX, stage: "config", statusCode: 500 });
    await safeFlush();
    return NextResponse.json({ ok: false, outcome: "no_webhook" }, { status: 500 });
  }

  const livemode = stripeKeyIsLive();
  const checkInId = dry ? undefined : checkIn("in_progress");

  try {
    const supabase = await createAdminClient();
    const result = await runAlertsCron({
      supabase,
      livemode,
      nowMs: started,
      deadlineMs: started + RUN_BUDGET_MS,
      dry,
      webhookUrl,
      manifestsDisabled: process.env.DIRECT_LOT_MANIFEST_DISABLED === "true",
    });
    if (!dry) {
      checkIn(result.ok ? "ok" : "error", checkInId);
      if (!result.ok) {
        captureAPIError(new Error(`direct lot alerts: tick not clean (${result.errors} error(s), ${result.posts.filter((p) => p.outcome === "failed").length} failed post(s))`), {
          ...CTX,
          stage: "run",
          statusCode: result.status,
          extra: { scans: result.scans, posts: result.posts },
        });
      }
    }
    await safeFlush();
    const { status, ...body } = result;
    return NextResponse.json({ ...body, ms: Date.now() - started }, { status: dry ? 200 : status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    captureAPIError(err instanceof Error ? err : new Error(message), { ...CTX, stage: "unhandled", statusCode: 500 });
    checkIn("error", checkInId);
    await safeFlush();
    return NextResponse.json({ ok: false, error: message.slice(0, 300), ms: Date.now() - started }, { status: 500 });
  }
}
