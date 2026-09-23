import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { addDays, format, subDays } from "date-fns";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { getAirportByCode } from "@/config/airports";
import { captureAPIError } from "@/lib/sentry";
import {
  assertWaitlistSigningSecret,
  isWaitlistConfigError,
  waitlistUnsubscribeUrl,
} from "@/lib/waitlist/unsubscribe-token";

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
): Promise<boolean> {
  const attempts = (row.notify_attempts ?? 0) + 1;
  // Only a counter that actually REACHED the database can justify the
  // give-up alarm below (pass 4, item 6): firing it off the in-memory value
  // told Sentry "row X will no longer be retried" while the row still held
  // 4 and tomorrow's run picked it straight back up — an alarm that is wrong
  // in the direction of "stop looking into it".
  let persisted = false;
  try {
    const { data, error } = await supabase
      .from("booking_waitlist")
      .update({
        notify_attempts: attempts,
        // Bounded: this is diagnostic context, not a log — never let a
        // pathological error string grow the row unboundedly.
        last_notify_error: errorMessage.slice(0, 500),
      })
      .eq("id", row.id)
      // `.select("id")`: an UPDATE whose WHERE matches nothing returns no
      // error, just an empty result — without this, a vanished or re-keyed row
      // would look like a successful counter write.
      .select("id");
    if (error) {
      captureAPIError(new Error(error.message), {
        ...CTX,
        stage: "record_notify_failure",
        code: error.code,
      });
    } else if (!data || data.length === 0) {
      captureAPIError(
        new Error(`waitlist-notify: notify_attempts update matched no rows for id ${row.id}`),
        { ...CTX, stage: "record_notify_failure_no_match" }
      );
    } else {
      persisted = true;
    }
  } catch (e) {
    captureAPIError(e instanceof Error ? e : new Error(String(e)), {
      ...CTX,
      stage: "record_notify_failure",
    });
  }

  if (persisted && attempts >= MAX_NOTIFY_ATTEMPTS) {
    alarm(
      "waitlist_notify_giveup",
      `waitlist-notify: row ${row.id} (${row.email}) has failed ${attempts} times and will no longer be retried — last error: ${errorMessage}`,
      "error"
    );
  }
  // The caller needs to know: a row whose failure could not even be RECORDED
  // has made no progress at all and will be retried tomorrow unchanged.
  return persisted;
}

/**
 * Resend's per-call failure, with the status kept so the run can tell a
 * permanent per-recipient rejection (4xx: invalid/suppressed address,
 * validation error) from a transient one (429, 5xx, no status = network).
 */
class ResendSendError extends Error {
  readonly statusCode: number | undefined;
  constructor(message: string, statusCode: number | undefined) {
    super(message);
    this.name = "ResendSendError";
    this.statusCode = statusCode;
  }
}

/** Would retrying this failure tomorrow plausibly succeed? */
function isTransientSendFailure(error: unknown): boolean {
  if (error instanceof ResendSendError) {
    const c = error.statusCode;
    return c === undefined || c === 429 || c >= 500;
  }
  // Anything that is not a Resend rejection (socket reset, DNS, a thrown
  // client) is infrastructure, not the recipient.
  return true;
}

/**
 * Writes notified_at, with ONE inline retry.
 *
 * By the time this runs the email has already left, so failing to record it
 * costs the traveller a duplicate email tomorrow — and the compensating
 * write (recordNotifyFailure) is an UPDATE on the SAME row, so whatever made
 * this fail usually makes that fail too, leaving the counter untouched and
 * the duplicate re-sending daily (pass 4, item 5). One retry costs one round
 * trip and covers the transient case; a sustained write outage still falls
 * through to the loud path.
 *
 * Returns the error to report, or null on success.
 */
async function markNotified(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  rowId: string
): Promise<{ message: string; code?: string } | null> {
  // supabase-js normally RESOLVES `{ error }`, but the underlying fetch can
  // still reject (DNS, socket reset). Caught here rather than left to the
  // caller's try, which would file it under `stage: "send"` — i.e. report a
  // delivered email as undelivered, and leave the row to be re-sent tomorrow
  // as if the traveller had never been emailed at all.
  const attempt = async (): Promise<{ message: string; code?: string } | null> => {
    try {
      const { data, error } = await supabase
        .from("booking_waitlist")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", rowId)
        // A zero-row UPDATE is not an error to PostgREST; without this the
        // delivery-critical write could report success and re-send tomorrow.
        .select("id");
      if (error) return { message: error.message, code: error.code };
      if (!data || data.length === 0) {
        return { message: `notified_at update matched no rows for id ${rowId}` };
      }
      return null;
    } catch (e) {
      return { message: e instanceof Error ? e.message : String(e) };
    }
  };

  const first = await attempt();
  if (!first) return null;
  return await attempt();
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Assert the signing secret ONCE, before the loop and before any counter
  // can move (pass 4, item 2). Every email this route sends needs an
  // unsubscribe link, so a missing WAITLIST_SIGNING_SECRET fails 100% of
  // rows — and charging that to each row's notify_attempts retired the ENTIRE
  // backlog after five daily runs, after which the cron returns a clean
  // `200 {sent: 0, sendFailed: 0}` forever. 503 is the honest answer: nothing
  // attempted, nothing counted, and a status a monitor can page on.
  try {
    assertWaitlistSigningSecret();
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), {
      ...CTX,
      stage: "config",
    });
    return NextResponse.json(
      { ok: false, error: "waitlist signing secret is not configured" },
      { status: 503 }
    );
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
  // Rows whose failure could not be recorded either: notified_at unset AND
  // notify_attempts unchanged, so tomorrow re-sends them unchanged and the
  // give-up counter can never retire them. Zero forward progress — a run
  // with any of these must not report 200 (pass 5, item 1).
  let unpersisted = 0;
  let deadlineHit = false;
  const startedAt = Date.now();
  // One flush at the end, sized to what is left of maxDuration: four 2 s
  // flushes after a 55 s batch would be killed mid-alarm on the worst run.
  const flushRemaining = () =>
    Sentry.flush(Math.max(250, Math.min(2000, 58_000 - (Date.now() - startedAt))));

  // Send failures are recorded AFTER the loop, not inline: a run in which
  // EVERY send failed is an outage (Resend down, key rotated), not N bad
  // addresses, and charging notify_attempts for it would retire the whole
  // backlog after five such days — permanently, silently (pass 4, item 2).
  // That verdict only exists once the loop has finished, so the evidence is
  // parked here until then.
  const sendFailures: Array<{ row: WaitlistRow; message: string; transient: boolean }> = [];

  for (const row of pending) {
    if (Date.now() - startedAt > NOTIFY_BUDGET_MS) {
      deadlineHit = true;
      break;
    }
    try {
      await sendOpensOnEmail(row);
      const markError = await markNotified(supabase, row.id);
      if (markError) {
        // The email already went out; failing to record that here means
        // tomorrow's run still sees notified_at IS NULL and sends it AGAIN
        // — this is a duplicate-email risk, not a lost-notification one.
        // Loud so it can be caught and marked by hand. notify_attempts still
        // counts this (inline, unlike a send failure: the counter write is
        // the same kind of write that just failed twice, so deferring it
        // would buy nothing): after enough of these, re-sending duplicates
        // forever is worse than giving up and paging someone once.
        captureAPIError(new Error(markError.message), {
          ...CTX,
          stage: "mark_notified",
          code: markError.code,
        });
        markFailed++;
        if (!(await recordNotifyFailure(supabase, row, markError.message))) unpersisted++;
        continue;
      }
      sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      captureAPIError(error instanceof Error ? error : new Error(message), {
        ...CTX,
        stage: "send",
      });
      if (isWaitlistConfigError(error)) {
        // Not this row's fault and guaranteed to fail every remaining row
        // identically — never charge it to notify_attempts, and don't burn
        // the rest of the batch proving it. The assert at the top of this
        // handler normally makes this unreachable; getting here means the
        // env changed under a running instance.
        await flushRemaining();
        return NextResponse.json(
          {
            ok: false,
            error: "waitlist signing secret is not configured",
            scanned: pending.length,
            sent,
          },
          { status: 503 }
        );
      }
      sendFailed++;
      sendFailures.push({ row, message, transient: isTransientSendFailure(error) });
    }
  }

  // A whole-batch send failure is an outage only when every failure is one
  // a retry could fix (429 / 5xx / no HTTP status). Two suppressed or
  // invalid addresses that happen to be the whole day's batch are NOT an
  // outage — they are permanent rejections and must be charged, or they
  // squat the queue and 500 the cron daily while the alarm blames Resend
  // (pass 5, item 2). Batch size is irrelevant: a lone traveller during a
  // real Resend outage is not charged either.
  const allSendsFailed = pending.length > 0 && sendFailed === pending.length;
  const outage = allSendsFailed && sendFailures.every((f) => f.transient);
  if (outage) {
    alarm(
      "waitlist_notify_outage",
      `waitlist-notify: all ${pending.length} sends failed this run with transient errors — treating as an outage, notify_attempts NOT charged. Last error: ${
        sendFailures[sendFailures.length - 1]?.message ?? "unknown"
      }`,
      "error"
    );
  } else {
    for (const failure of sendFailures) {
      if (!(await recordNotifyFailure(supabase, failure.row, failure.message))) unpersisted++;
    }
  }
  if (unpersisted > 0) {
    alarm(
      "waitlist_notify_no_progress",
      `waitlist-notify: ${unpersisted} row(s) could neither record delivery nor charge notify_attempts — they WILL be re-sent tomorrow and cannot retire until the write path is fixed`,
      "error"
    );
  }

  // "N of M failed" alarm — a cron that silently drops failures forever is
  // no different from one that never ran (pattern from
  // reconcile-cancellations). >0 alone is loud-but-200 (per-row failures are
  // expected at some background rate and the rest of the batch still went
  // out); sendFailed===scanned (allSendsFailed, computed above) means NOTHING
  // was actually delivered this run, which is the caller's signal to page
  // someone — that one 500s.
  const totalFailed = sendFailed + markFailed;
  if (totalFailed > 0) {
    alarm(
      "waitlist_notify_failures",
      `waitlist-notify: ${sendFailed} send failures, ${markFailed} mark-notified failures of ${pending.length} attempted` +
        (deadlineHit ? " (run also hit its time budget before finishing)" : ""),
      "warning"
    );
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
  }

  // Separate, independent signal (pass 3, item 3): rows more than 2 days
  // overdue and still unnotified. The main select above only ever looks at
  // the oldest MAX_ROWS_PER_RUN pending rows, so a row that's been stuck for
  // a week is invisible to `capped` once the backlog is bigger than one
  // run's cap — this is the check that catches that case even when this
  // run's own batch looks clean.
  //
  // Filtered to rows this cron will ACTUALLY still try (pass 4, item 3):
  // - `unsubscribed_at IS NULL`, or the first traveller who unsubscribes
  //   after their opens_on passed makes this fire at error level on every
  //   run, forever, for a row nobody should ever email;
  // - `notify_attempts < MAX`, because a given-up row already got its own
  //   give-up alarm — counting it here would re-page daily for the same
  //   known-dead row.
  // The two IS NULL predicates are also exactly the partial index's WHERE
  // clause (026), so this becomes an index scan on opens_on with
  // notify_attempts as a cheap residual filter, instead of the sequential
  // scan the unfiltered version forced. `head: true` — this only ever needed
  // the number, never the rows.
  const twoDaysAgoISO = format(subDays(new Date(), 2), "yyyy-MM-dd");
  const { count: overdueCount, error: overdueError } = await supabase
    .from("booking_waitlist")
    .select("id", { count: "exact", head: true })
    .lt("opens_on", twoDaysAgoISO)
    .is("notified_at", null)
    .is("unsubscribed_at", null)
    .lt("notify_attempts", MAX_NOTIFY_ATTEMPTS);

  if (overdueError) {
    captureAPIError(new Error(overdueError.message), { ...CTX, stage: "overdue_check" });
  } else if ((overdueCount ?? 0) > 0) {
    alarm(
      "waitlist_notify_backlog",
      `waitlist-notify: ${overdueCount} row(s) are more than 2 days overdue and still unnotified`,
      "error"
    );
  }

  // Standing population of rows this cron has GIVEN UP on. They are excluded
  // from the send select and the overdue count by design, so without this
  // their only trace is the one-time give-up event on a stable fingerprint —
  // the first abandoned traveller opens the issue and every later one is an
  // invisible increment (pass 5, item 3). Reported every run, chartable, with
  // the revive SQL named (runbook § 14).
  const { count: abandonedCount, error: abandonedError } = await supabase
    .from("booking_waitlist")
    .select("id", { count: "exact", head: true })
    .is("notified_at", null)
    .is("unsubscribed_at", null)
    .gte("notify_attempts", MAX_NOTIFY_ATTEMPTS);
  if (abandonedError) {
    captureAPIError(new Error(abandonedError.message), { ...CTX, stage: "abandoned_check" });
  } else if ((abandonedCount ?? 0) > 0) {
    alarm(
      "waitlist_notify_abandoned",
      `waitlist-notify: ${abandonedCount} traveller(s) will never be notified (notify_attempts >= ${MAX_NOTIFY_ATTEMPTS}) — after fixing the cause, run the revive SQL in OPERATIONS_RUNBOOK § 14`,
      "error"
    );
  }

  await flushRemaining();

  const noProgress = unpersisted > 0;
  return NextResponse.json(
    {
      ok: !allSendsFailed && !noProgress,
      scanned: pending.length,
      sent,
      sendFailed,
      markFailed,
      unpersisted,
      abandoned: abandonedError ? null : (abandonedCount ?? 0),
      capped,
    },
    { status: allSendsFailed || noProgress ? 500 : 200 }
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
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : undefined;
    throw new ResendSendError(
      `Resend error for waitlist row ${row.id}: ${error.message}`,
      statusCode
    );
  }
}
