/**
 * GET /api/cron/daily-digest — yesterday's Triply numbers to Discord
 * (plan: notes/2026-09-28-daily-digest-plan-v2.md). Vercel cron `5 13 * * *`.
 *
 * Monitor rule (reconcile-payments): a failure must never look like a healthy
 * state. A partial run posts red; a run whose bookings section (or half of all
 * sections) failed posts a red "could not run" embed with NO numbers and
 * returns 500; a missing webhook is 503; a Discord failure is 502; a failed
 * run-log write is 500 (the next delivery would duplicate the post) — all with
 * a flushed Sentry event and an `error` cron check-in. A thrown exception is
 * caught, reported, and closes the check-in too. Sentry cron check-ins catch a
 * run that never fired; every return path flushes so the closing check-in is
 * not lost when the function freezes.
 *
 * Idempotent per ET date via `digest_runs` (Vercel cron is at-least-once).
 * `?date=YYYY-MM-DD` re-runs a day (validated, ≤ 90 days back); `?force=1`
 * re-posts one already recorded; `?dry=1` collects, reads and renders but
 * posts nothing, records nothing and touches no check-in — it returns the
 * embed so a change can be previewed without a message in the channel.
 */

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { isRealDate } from "@/lib/availability/log";
import { collectDigest } from "@/lib/digest/collect";
import { renderEmbed, RED, type Embed } from "@/lib/digest/render";
import { writeModelRead, READ_TIMEOUT_MS, type ReadResult } from "@/lib/digest/read";
import { postToDiscord } from "@/lib/digest/discord";
import { windowForEtDay, yesterdayEt, shiftIsoDate, calendarDayIn, DIGEST_TZ } from "@/lib/digest/window";
import type { Flag } from "@/lib/digest/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CTX = { endpoint: "/api/cron/daily-digest", method: "GET" as const };
const MONITOR_SLUG = "daily-digest";
const RUN_BUDGET_MS = 50_000;
/** The model read is skipped when less than this is left, so the post always gets its budget. */
const READ_MIN_REMAINING_MS = READ_TIMEOUT_MS + 12_000;
const DB_TIMEOUT_MS = 8_000;
const safeFlush = () => Sentry.flush(2_000).catch(() => {});

const MONITOR_CONFIG = { schedule: { type: "crontab" as const, value: "5 13 * * *" }, checkinMargin: 30, maxRuntime: 5, timezone: "UTC" };

// Sentry types an in-progress check-in (no id) apart from a finished one (id required).
function checkIn(status: "in_progress"): string | undefined;
function checkIn(status: "ok" | "error", checkInId: string | undefined): string | undefined;
function checkIn(status: "in_progress" | "ok" | "error", checkInId?: string): string | undefined {
  try {
    if (status === "in_progress") return Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status }, MONITOR_CONFIG);
    if (!checkInId) return undefined; // the opening check-in failed; nothing to close
    return Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status, checkInId }, MONITOR_CONFIG);
  } catch {
    return undefined;
  }
}

type Outcome = "posted" | "posted_partial" | "could_not_run" | "post_failed";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const now = new Date(started);
  const force = request.nextUrl.searchParams.get("force") === "1";
  const dry = request.nextUrl.searchParams.get("dry") === "1";

  // Which ET day?
  const dateParam = request.nextUrl.searchParams.get("date");
  let dateEt: string;
  if (dateParam !== null) {
    if (!isRealDate(dateParam)) return NextResponse.json({ error: "date must be a real YYYY-MM-DD" }, { status: 400 });
    const floor = shiftIsoDate(calendarDayIn(DIGEST_TZ, now), -90);
    if (dateParam < floor || dateParam >= calendarDayIn(DIGEST_TZ, now)) {
      return NextResponse.json({ error: "date must be within the last 90 days and before today (ET)" }, { status: 400 });
    }
    dateEt = dateParam;
  } else {
    dateEt = yesterdayEt(now);
  }

  const webhook = process.env.DISCORD_DAILY_DIGEST_WEBHOOK_URL || process.env.DISCORD_SESSION_WEBHOOK_URL;
  if (!webhook && !dry) {
    captureAPIError(new Error("daily digest: no Discord webhook configured"), { ...CTX, stage: "config", statusCode: 503 });
    await safeFlush();
    return NextResponse.json({ ok: false, outcome: "no_webhook" }, { status: 503 });
  }

  const checkInId = dry ? undefined : checkIn("in_progress");
  const w = windowForEtDay(dateEt);

  try {
    const sb = await createAdminClient();

    // Idempotence: one post per ET date unless forced. A read ERROR is not "no
    // row": it means we cannot know, so we post but say so in the embed and the
    // response, and do not report the run as clean.
    const extraFlags: Flag[] = [];
    let runLogRead: "ok" | "error" | "skipped" = force || dry ? "skipped" : "ok"; // force = a deliberate re-post, dry = no post: nothing is read
    if (!force && !dry) {
      const prior = await sb.from("digest_runs").select("outcome, posted_at").eq("digest_date", dateEt).abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS)).maybeSingle();
      if (prior.error) {
        runLogRead = "error";
        captureAPIError(new Error(`digest_runs read failed: ${prior.error.code ?? "?"} ${prior.error.message}`), { ...CTX, stage: "idempotence" });
        extraFlags.push({ text: "digest run log unreadable before posting — this may be a duplicate" });
      } else if (prior.data) {
        const recorded = prior.data as { outcome: Outcome; posted_at: string };
        if (recorded.outcome !== "post_failed") {
          // A redelivery must mirror the recorded outcome: a could_not_run day
          // must not flip the monitor green just because the cron fired twice.
          const failed = recorded.outcome === "could_not_run";
          checkIn(failed ? "error" : "ok", checkInId);
          await safeFlush();
          return NextResponse.json({ ok: !failed, outcome: "already_posted", dateEt, previous: recorded }, { status: failed ? 500 : 200 });
        }
      }
    }

    const data = await collectDigest(w, now);

    // The model read only runs on a run that will show numbers, and only with
    // enough budget left for the post afterwards.
    const pre = renderEmbed(data, null, extraFlags);
    let read: ReadResult | null = null;
    if (pre.verdict.kind !== "could_not_run") {
      const remaining = RUN_BUDGET_MS - (Date.now() - started);
      read = remaining >= READ_MIN_REMAINING_MS ? await writeModelRead(data) : { kind: "unavailable", reason: "skipped: out of time after collect" };
    }
    const { embed, verdict, flags, truncated } = renderEmbed(data, read, extraFlags);
    const modelRead = read === null ? "skipped" : read.kind;
    const modelReadReason = read !== null && read.kind !== "ok" ? read.reason : null;

    if (dry) {
      // 200 always (the preview must come back), but `ok` means what it means everywhere else.
      return NextResponse.json({
        ok: verdict.kind !== "could_not_run", dry: true, dateEt, verdict: verdict.kind, sectionsFailed: verdict.kind === "ok" ? 0 : verdict.failed.length,
        flags: flags.map((f) => f.text), modelRead, modelReadReason,
        // The rejected paragraph, for previewing a prompt change. Dry response ONLY — never the posted embed.
        withheldText: read !== null && read.kind === "withheld" ? read.text ?? null : null,
        truncated, embed, ms: Date.now() - started,
      });
    }
    if (!webhook) throw new Error("unreachable: reached the posting path with no webhook configured");

    // Collect failures are reported on their own, BEFORE the post, so a Discord
    // outage cannot hide "N sections failed" behind "post failed".
    if (verdict.kind === "could_not_run") {
      captureAPIError(new Error(`daily digest could not run: ${verdict.failed.join(", ")} failed`), { ...CTX, stage: "collect", statusCode: 500 });
    } else if (verdict.kind === "partial") {
      captureAPIError(new Error(`daily digest partial: ${verdict.failed.join(", ")} unavailable`), { ...CTX, stage: "collect" });
    }

    const post = await postToDiscord(webhook, embed, { remainingBudgetMs: RUN_BUDGET_MS - (Date.now() - started) });

    const outcome: Outcome =
      post.kind !== "posted" ? "post_failed" : verdict.kind === "could_not_run" ? "could_not_run" : verdict.kind === "partial" ? "posted_partial" : "posted";
    const sectionsFailed = verdict.kind === "ok" ? 0 : verdict.failed.length;
    const messageChars = embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);

    const rec = await sb
      .from("digest_runs")
      .upsert(
        { digest_date: dateEt, posted_at: new Date().toISOString(), outcome, sections_failed: sectionsFailed, message_chars: messageChars, model_read: modelRead },
        { onConflict: "digest_date" }
      )
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    const runLogWrite: "ok" | "error" = rec.error ? "error" : "ok";
    if (rec.error) captureAPIError(new Error(`digest_runs write failed: ${rec.error.code ?? "?"} ${rec.error.message}`), { ...CTX, stage: "record", statusCode: 500 });

    const summary = {
      dateEt, outcome, verdict: verdict.kind, sectionsFailed, flags: flags.map((f) => f.text), modelRead, modelReadReason, truncated, messageChars,
      runLog: { read: runLogRead, write: runLogWrite }, ms: Date.now() - started,
    };

    if (post.kind !== "posted") {
      captureAPIError(new Error(`daily digest: Discord post failed (${post.status ?? "network"}): ${post.body}`), { ...CTX, stage: "discord", statusCode: 502 });
      checkIn("error", checkInId);
      await safeFlush();
      return NextResponse.json({ ok: false, ...summary, discord: post }, { status: 502 });
    }
    // Posted, but the run is not clean: a red no-number embed, or a run log we
    // could not read or write (the next delivery may duplicate this post).
    if (verdict.kind === "could_not_run" || runLogWrite === "error" || runLogRead === "error") {
      checkIn("error", checkInId);
      await safeFlush();
      return NextResponse.json({ ok: false, ...summary }, { status: 500 });
    }
    checkIn("ok", checkInId);
    await safeFlush();
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    // Nothing above may throw by design, so this is the unexpected case: report
    // it, try to post a red no-number embed, close the check-in as an error.
    const message = err instanceof Error ? err.message : String(err);
    captureAPIError(err instanceof Error ? err : new Error(message), { ...CTX, stage: "unhandled", statusCode: 500 });
    const embed: Embed = {
      title: `🛑 Triply daily — ${dateEt} — DIGEST CRASHED`,
      description: `The digest threw before it could post: ${message.slice(0, 300)}. No numbers are shown so none can be misread.`,
      color: RED,
      fields: [],
      footer: { text: w.label },
    };
    let posted = false;
    if (!dry && webhook) {
      try {
        posted = (await postToDiscord(webhook, embed, { remainingBudgetMs: Math.max(0, RUN_BUDGET_MS - (Date.now() - started)) })).kind === "posted";
      } catch {
        posted = false;
      }
    }
    checkIn("error", checkInId);
    await safeFlush();
    return NextResponse.json({ ok: false, outcome: "crashed", dateEt, error: message.slice(0, 300), crashEmbedPosted: posted, ms: Date.now() - started }, { status: 500 });
  }
}
