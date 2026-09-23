import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { addDays, format, subDays } from "date-fns";
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

// A row that fails this many times (send failure OR failure to record
// notified_at after a successful send) stops being retried and gets one
// Sentry alarm instead of a daily one — see 026's notify_attempts column.
// Without this, a hard-bounced or typo'd address (or a genuinely broken
// mark_notified path) fails forever, one Sentry event per row per day, and
// permanently occupies one of MAX_ROWS_PER_RUN slots.
const MAX_NOTIFY_ATTEMPTS = 5;

const CTX = { endpoint: "/api/cron/waitlist-notify", method: "GET" as const };

interface WaitlistRow {
  id: string;
  email: string;
  airport_code: string;
  wanted_checkin: string;
  wanted_checkout: string | null;
  notify_attempts: number;
}

/** withScope + a stable fingerprint so every alarm of a given kind groups
 *  into one Sentry issue instead of a fresh issue per distinct message. */
function alarm(fingerprint: string, message: string, level: "info" | "warning" | "error") {
  Sentry.withScope((scope) => {
    scope.setFingerprint([fingerprint]);
    Sentry.captureMessage(message, level);
  });
}

/** Records a failed attempt on a row (send failure or mark_notified
 *  failure) and alarms once if this attempt pushed it past the give-up
 *  threshold. Never throws — a failure recording a failure must not itself
 *  take down the loop. */
async function recordNotifyFailure(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  row: WaitlistRow,
  errorMessage: string
) {
  const attempts = (row.notify_attempts ?? 0) + 1;
  try {
    const { error } = await supabase
      .from("booking_waitlist")
      .update({
        notify_attempts: attempts,
        // Bounded: this is diagnostic context, not a log — never let a
        // pathological error string grow the row unboundedly.
        last_notify_error: errorMessage.slice(0, 500),
      })
      .eq("id", row.id);
    if (error) {
      captureAPIError(new Error(error.message), {
        ...CTX,
        stage: "record_notify_failure",
        code: error.code,
      });
    }
  } catch (e) {
    captureAPIError(e instanceof Error ? e : new Error(String(e)), {
      ...CTX,
      stage: "record_notify_failure",
    });
  }

  if (attempts >= MAX_NOTIFY_ATTEMPTS) {
    alarm(
      "waitlist_notify_giveup",
      `waitlist-notify: row ${row.id} (${row.email}) has failed ${attempts} times and will no longer be retried — last error: ${errorMessage}`,
      "error"
    );
    await Sentry.flush(2000);
  }
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
    .select("id, email, airport_code, wanted_checkin, wanted_checkout, notify_attempts")
    .lte("opens_on", todayISO)
    .is("notified_at", null)
    .is("unsubscribed_at", null)
    // Rows that have already given up (see recordNotifyFailure /
    // MAX_NOTIFY_ATTEMPTS) must not keep occupying a slot in every future
    // run — that's exactly the poison-row-squats-the-queue-forever shape
    // this counter exists to break.
    .lt("notify_attempts", MAX_NOTIFY_ATTEMPTS)
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
  // Kept separate (review pass 3, item 5): a Resend failure means the email
  // did NOT go out and the row is correctly still retryable. A mark_notified
  // failure means the email DID go out and the row will be re-sent tomorrow
  // — a bookkeeping problem, not a delivery one. Conflating them into one
  // `failed` counter made a Supabase write outage look identical to
  // "nobody got their email", including gating the 500 below on it.
  let sendFailed = 0;
  let markFailed = 0;
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
        // Loud so it can be caught and marked by hand. notify_attempts still
        // counts this: after enough of these, re-sending duplicates forever
        // is worse than giving up and paging someone once.
        captureAPIError(new Error(updateError.message), {
          ...CTX,
          stage: "mark_notified",
          code: updateError.code,
        });
        markFailed++;
        await recordNotifyFailure(supabase, row, updateError.message);
        continue;
      }
      sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      captureAPIError(error instanceof Error ? error : new Error(message), {
        ...CTX,
        stage: "send",
      });
      sendFailed++;
      await recordNotifyFailure(supabase, row, message);
    }
  }

  // "N of M failed" alarm — a cron that silently drops failures forever is
  // no different from one that never ran (pattern from
  // reconcile-cancellations). >0 alone is loud-but-200 (per-row failures are
  // expected at some background rate and the rest of the batch still went
  // out); sendFailed===scanned (see below) means NOTHING was actually
  // delivered this run, which is the caller's signal to page someone.
  const totalFailed = sendFailed + markFailed;
  if (totalFailed > 0) {
    alarm(
      "waitlist_notify_failures",
      `waitlist-notify: ${sendFailed} send failures, ${markFailed} mark-notified failures of ${pending.length} attempted` +
        (deadlineHit ? " (run also hit its time budget before finishing)" : ""),
      "warning"
    );
    await Sentry.flush(2000);
  }

  // Cap/deadline alarm — deliberately INDEPENDENT of totalFailed above (pass
  // 3, item 3): 60 clean rows with MAX_ROWS_PER_RUN=50 sends 50, 200s, and
  // `capped: true` in a JSON body nobody reads, with zero failures. That's
  // still 10 travellers a day late, compounding every day the backlog stays
  // above the cap.
  const capped = pending.length >= MAX_ROWS_PER_RUN || deadlineHit;
  if (capped) {
    alarm(
      "waitlist_notify_capped",
      `waitlist-notify: run was capped (scanned ${pending.length} of max ${MAX_ROWS_PER_RUN}` +
        (deadlineHit ? `, hit its ${NOTIFY_BUDGET_MS}ms budget` : "") +
        ") — the backlog is outgrowing one run",
      "warning"
    );
    await Sentry.flush(2000);
  }

  // Separate, independent signal (pass 3, item 3): rows more than 2 days
  // overdue and still unnotified. The main select above only ever looks at
  // the oldest MAX_ROWS_PER_RUN pending rows, so a row that's been stuck for
  // a week is invisible to `capped` once the backlog is bigger than one
  // run's cap — this is the check that catches that case even when this
  // run's own batch looks clean.
  const twoDaysAgoISO = format(subDays(new Date(), 2), "yyyy-MM-dd");
  const { data: overdueRows, error: overdueError } = await supabase
    .from("booking_waitlist")
    .select("id")
    .lt("opens_on", twoDaysAgoISO)
    .is("notified_at", null);

  if (overdueError) {
    captureAPIError(new Error(overdueError.message), { ...CTX, stage: "overdue_check" });
  } else if ((overdueRows?.length ?? 0) > 0) {
    alarm(
      "waitlist_notify_backlog",
      `waitlist-notify: ${overdueRows!.length} row(s) are more than 2 days overdue and still unnotified`,
      "error"
    );
    await Sentry.flush(2000);
  }

  const allSendsFailed = pending.length > 0 && sendFailed === pending.length;

  return NextResponse.json(
    {
      ok: !allSendsFailed,
      scanned: pending.length,
      sent,
      sendFailed,
      markFailed,
      capped,
    },
    { status: allSendsFailed ? 500 : 200 }
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
    throw new Error(`Resend error for waitlist row ${row.id}: ${error.message}`);
  }
}
