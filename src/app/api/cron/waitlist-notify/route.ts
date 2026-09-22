import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { addDays, format } from "date-fns";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { getAirportByCode } from "@/config/airports";
import { captureAPIError } from "@/lib/sentry";
import { waitlistUnsubscribeUrl } from "@/lib/waitlist/unsubscribe-token";

/**
 * GET /api/cron/waitlist-notify
 *
 * The sender /api/waitlist promised: "we'll email you that day". Runs daily
 * (see vercel.json), picks every booking_waitlist row whose opens_on has
 * arrived, unsent, not unsubscribed, and sends one "it's open, go book it"
 * email each. A per-row failure is captured to Sentry and skipped — one bad
 * address must never stop the rest of the batch from sending.
 *
 * Auth: same pattern as reconcile-cancellations — Vercel injects
 * `Authorization: Bearer <CRON_SECRET>`; refuse without it.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Keep one run bounded; whatever's left picks up on tomorrow's run since
// opens_on <= today only grows the backlog forward, never drops rows. 200
// serial Resend sends in a 60s budget was at/over budget on its own (each
// send is a real HTTP round trip) and left no margin before a slow run
// starts returning 429s — see the between-rows deadline below, which is the
// real backstop; this is just how many rows we're willing to even attempt.
const MAX_ROWS_PER_RUN = 50;

// Elapsed-time budget for the send loop (mirrors reconcile-cancellations'
// 45s/60s). Checked BETWEEN rows, not a hard per-row guarantee — a single
// slow send that starts near the budget can still push the run past
// maxDuration. Safe either way: nothing here is written until the send for
// that row has already succeeded, and any row not reached today is picked up
// by tomorrow's run (opens_on <= today keeps matching until notified_at is
// set).
const NOTIFY_BUDGET_MS = 45_000;

const CTX = { endpoint: "/api/cron/waitlist-notify", method: "GET" as const };

interface WaitlistRow {
  id: string;
  email: string;
  airport_code: string;
  wanted_checkin: string;
  wanted_checkout: string | null;
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const todayISO = format(new Date(), "yyyy-MM-dd");
  const supabase = await createAdminClient();

  const { data: rows, error: selectError } = await supabase
    .from("booking_waitlist")
    .select("id, email, airport_code, wanted_checkin, wanted_checkout")
    .lte("opens_on", todayISO)
    .is("notified_at", null)
    .is("unsubscribed_at", null)
    // Oldest opens_on first: without an explicit order, once the backlog
    // exceeds MAX_ROWS_PER_RUN the same overdue rows can be skipped run
    // after run (same shape as the July cron-starvation bug) — ordering
    // guarantees the longest-waiting rows are the ones this run attempts.
    .order("opens_on", { ascending: true })
    .limit(MAX_ROWS_PER_RUN);

  if (selectError) {
    captureAPIError(new Error(selectError.message), { ...CTX, stage: "select" });
    return NextResponse.json({ ok: false, error: "select failed" }, { status: 500 });
  }

  const pending = (rows ?? []) as WaitlistRow[];
  let sent = 0;
  let failed = 0;
  let deadlineHit = false;
  const startedAt = Date.now();

  for (const row of pending) {
    if (Date.now() - startedAt > NOTIFY_BUDGET_MS) {
      deadlineHit = true;
      break;
    }
    try {
      await sendOpensOnEmail(row);
      const { error: updateError } = await supabase
        .from("booking_waitlist")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", row.id);
      if (updateError) {
        // The email already went out; failing to record that here means
        // tomorrow's run still sees notified_at IS NULL and sends it AGAIN
        // — this is a duplicate-email risk, not a lost-notification one.
        // Loud so it can be caught and marked by hand, but there's no retry
        // path here that would fix it (the row's own state already says
        // "not yet sent" whether we like it or not).
        captureAPIError(new Error(updateError.message), {
          ...CTX,
          stage: "mark_notified",
          code: updateError.code,
        });
        failed++;
        continue;
      }
      sent++;
    } catch (error) {
      captureAPIError(error instanceof Error ? error : new Error(String(error)), {
        ...CTX,
        stage: "send",
      });
      failed++;
    }
  }

  // "N of M failed" alarm — a cron that silently drops failures forever is
  // no different from one that never ran (pattern from
  // reconcile-cancellations). failed>0 alone is loud-but-200 (per-row
  // failures are expected at some background rate and the rest of the batch
  // still went out); failed===scanned means NOTHING sent this run, which is
  // the caller's signal to actually page someone.
  if (failed > 0) {
    Sentry.captureMessage(
      `waitlist-notify: ${failed} of ${pending.length} failed to send` +
        (deadlineHit ? " (run also hit its time budget before finishing)" : ""),
      "warning"
    );
    await Sentry.flush(2000);
  } else if (deadlineHit) {
    // Nothing failed, but the run didn't finish the backlog — still worth a
    // (quieter) signal since it means the backlog is now outgrowing one run.
    Sentry.captureMessage(
      `waitlist-notify: hit its ${NOTIFY_BUDGET_MS}ms budget with rows still pending`,
      "info"
    );
    await Sentry.flush(2000);
  }

  const allFailed = pending.length > 0 && failed === pending.length;

  return NextResponse.json(
    {
      ok: !allFailed,
      scanned: pending.length,
      sent,
      failed,
      capped: pending.length >= MAX_ROWS_PER_RUN || deadlineHit,
    },
    { status: allFailed ? 500 : 200 }
  );
}

async function sendOpensOnEmail(row: WaitlistRow) {
  const airport = getAirportByCode(row.airport_code);
  const airportName = airport ? `${airport.city} (${row.airport_code})` : row.airport_code;
  const checkinDate = format(new Date(`${row.wanted_checkin}T00:00:00`), "MMMM d, yyyy");
  const unsubscribeUrl = waitlistUnsubscribeUrl(row.id);

  // /search needs BOTH a check-in and a check-out date to price a lot —
  // omitting checkout was landing every notification click on a page with no
  // priced results. Fall back to a 7-day stay when the traveller never gave
  // us a return date; this is a pricing-estimate carve-out, not the actual
  // trip length, but it's a working search result instead of a broken one.
  const checkoutISO =
    row.wanted_checkout ??
    format(addDays(new Date(`${row.wanted_checkin}T00:00:00`), 7), "yyyy-MM-dd");

  const searchParams = new URLSearchParams({
    airport: row.airport_code,
    checkin: row.wanted_checkin,
    checkout: checkoutISO,
  });
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com";
  const searchUrl = `${base.replace(/\/$/, "")}/search?${searchParams.toString()}`;

  // resend@6.9.1 never throws for an API-level failure — it resolves
  // { data: null, error }. Destructure and throw BEFORE the caller writes
  // notified_at, so a Resend error (e.g. a 429) leaves the row retryable
  // instead of permanently burning it as "sent".
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [row.email],
    subject: `${row.airport_code} parking for ${format(
      new Date(`${row.wanted_checkin}T00:00:00`),
      "MMM d"
    )} is now open to book`,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <div style="background-color: #1A1A2E; padding: 32px 40px; text-align: center;">
          <h1 style="margin: 0; color: #f87356; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Triply</h1>
          <p style="margin: 4px 0 0; color: #94a3b8; font-size: 13px;">Your Trip Simplified</p>
        </div>
        <div style="padding: 40px;">
          <h2 style="margin: 0 0 20px; color: #111827; font-size: 20px; font-weight: 700;">${airportName} is open for booking</h2>
          <p style="font-size: 15px; color: #374151; line-height: 1.6;">
            You asked us to let you know when parking opened for <strong>${checkinDate}</strong>. It's here &mdash; go grab your spot before it's gone.
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${searchUrl}" style="background-color: #f87356; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 16px; display: inline-block;">
              Book ${row.airport_code} Parking
            </a>
          </div>
        </div>
        <div style="background-color: #f9fafb; padding: 24px 40px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="margin: 0; color: #9ca3af; font-size: 12px;">
            Triply - Airport Parking Made Easy<br>
            <a href="https://www.triplypro.com" style="color: #f87356; text-decoration: none;">triplypro.com</a><br>
            <a href="${unsubscribeUrl}" style="color: #9ca3af; text-decoration: underline;">Unsubscribe</a>
          </p>
        </div>
      </div>
    `,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message}`);
  }
}
