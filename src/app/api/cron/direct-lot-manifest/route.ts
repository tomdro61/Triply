/**
 * GET /api/cron/direct-lot-manifest — the evening reminder to each direct lot
 * of tomorrow's arrivals and departures (6b plan §3). Vercel cron `*\/10`.
 *
 * Every tick: lot_config problems → alert rows; NEW manifests for lots in their
 * 18:00–23:00 lot-local window; then recovery — follow-up cancel reminders,
 * takeovers and the noon cutoff — at any hour. The state machine lives in
 * src/lib/direct/manifest/run.ts.
 *
 * DIRECT_LOT_MANIFEST_DISABLED=true stops every manifest that has not reached
 * Resend: no new claims, no attempt + 1, no force, and a stale claim that never
 * reached Resend is closed `failed`. A manifest that may already have been
 * delivered is still retried under its SAME idempotency key (Resend answers
 * without a second email), and follow-up cancel reminders keep going.
 *
 *   ?dry=1                    render what would be sent now; sends and writes nothing
 *   ?dry=1&lot=1&date=D       render lot 1's manifest(s) for D
 *   ?lot=1&date=D&force=1     re-send from `checked` / `failed`, before the cutoff (§3.5)
 *
 * Stripe mode = this deployment's key (staging and production share the
 * database; a run only ever touches its own mode's rows). Sentry cron
 * check-ins catch a tick that never fired; every exit flushes.
 */

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { isRealDate } from "@/lib/availability/log";
import { stripeKeyIsLive } from "@/lib/cancellation/source-guard";
import { runManifestCron } from "@/lib/direct/manifest/run";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CTX = { endpoint: "/api/cron/direct-lot-manifest", method: "GET" as const };
const MONITOR_SLUG = "direct-lot-manifest";
/** The run's own budget: no send starts after it, well inside maxDuration. */
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
  const params = request.nextUrl.searchParams;
  const dry = params.get("dry") === "1";
  const force = params.get("force") === "1";
  const lot = params.get("lot");
  const date = params.get("date");

  if (lot !== null || date !== null || force) {
    if (lot === null || date === null) return NextResponse.json({ error: "lot and date go together" }, { status: 400 });
    if (!/^[0-9]{1,9}$/.test(lot)) return NextResponse.json({ error: "lot must be the numeric CMS lot id" }, { status: 400 });
    if (!isRealDate(date)) return NextResponse.json({ error: "date must be a real YYYY-MM-DD" }, { status: 400 });
    if (!dry && !force) return NextResponse.json({ error: "lot and date need force=1 (or dry=1)" }, { status: 400 });
    if (dry && force) return NextResponse.json({ error: "dry and force are exclusive" }, { status: 400 });
  }

  const disabled = process.env.DIRECT_LOT_MANIFEST_DISABLED === "true";
  const livemode = stripeKeyIsLive();
  const checkInId = dry ? undefined : checkIn("in_progress");

  try {
    const supabase = await createAdminClient();
    const result = await runManifestCron({
      supabase,
      livemode,
      nowMs: started,
      deadlineMs: started + RUN_BUDGET_MS,
      dry,
      disabled,
      target: lot !== null && date !== null ? { lotId: lot, date } : null,
      force,
    });
    if (!dry) {
      // A refused force is the caller's problem, not the cron's: only real errors fail the monitor.
      checkIn(result.errors > 0 ? "error" : "ok", checkInId);
      if (result.errors > 0) {
        captureAPIError(new Error(`direct lot manifest: ${result.errors} error(s) this tick`), { ...CTX, stage: "run", statusCode: result.status, extra: { runs: result.runs, followUps: result.followUps } });
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
