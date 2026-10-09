import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { captureAPIError } from "@/lib/sentry";
import { TEST_RESLAB_LOCATION_IDS } from "@/config/admin";
import { assertReviewSigningSecret, isReviewConfigError } from "@/lib/reviews/token";
import {
  REVIEWABLE_STATUSES,
  selectReviewSends,
  type ReviewBookingRow,
  type ReviewCandidate,
  type ReviewLedgerRow,
} from "@/lib/reviews/select";
import {
  isIdempotencyConflict,
  isSendConfigFailure,
  isTransientSendFailure,
  RESEND_SEND_TIMEOUT_MS,
  sendReviewEmail,
} from "@/lib/reviews/email";

/**
 * GET /api/cron/post-trip-review
 *
 * Daily at 23:00 UTC (vercel.json) — early evening in every US zone. Sends the
 * "How was parking at {lot}?" email to each booking whose check-out has passed
 * at the lot (airport-local; see src/lib/reviews/select.ts for the time rule)
 * within the last INITIAL_MAX_DAYS_AFTER days, and ONE reminder three days
 * after check-out when no review exists. Then never again.
 *
 * LEDGER (review_emails, UNIQUE (booking_id, kind), migration 037) — the
 * checkout-recovery pattern: claimed → sent | failed | retry → (re-claimed).
 * A row is INSERTed `claimed` BEFORE the send and `send_started_at` stamped
 * right before the Resend call; the send carries a Resend Idempotency-Key on
 * booking + kind with a byte-stable payload. A transient failure parks the row
 * as `retry` for the next run; a permanent one marks it `failed` (no reminder
 * ever follows). An old `claimed` row that never reached Resend is removed so
 * the booking is judged afresh; one that did is alarmed for a human. Every
 * failure mode errs toward NOT emailing.
 *
 * Gated by POST_TRIP_REVIEW_EMAILS_ENABLED=true so the code can merge dark.
 * Needs REVIEW_SIGNING_SECRET (the review links); refuses with 503 without it.
 * Auth: Vercel injects `Authorization: Bearer <CRON_SECRET>`; refuse without it.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_SENDS_PER_RUN = 40;
const RUN_DEADLINE_MS = 52_000;
const DB_TIMEOUT_MS = 3_000;
/** Worst case for one candidate: claim (+ re-claim) + send-start stamp +
 *  Resend + mark. Started only when it still fits before the deadline. */
const CANDIDATE_RESERVE_MS = DB_TIMEOUT_MS * 4 + RESEND_SEND_TIMEOUT_MS;
/** Check-outs this far back are read; the selector applies the real windows. */
const LOOKBACK_DAYS = 8;
/** A `claimed` row older than this will never be finished by its run. */
const STALE_CLAIM_MS = 15 * 60_000;
/** PostgREST's default row cap; hitting it means rows may be missing. */
const ROW_CAP = 1000;
/** Ids per `.in()` filter, so the request URL stays short. */
const IN_CHUNK = 150;

const dbSignal = () => AbortSignal.timeout(DB_TIMEOUT_MS);
const CTX = { endpoint: "/api/cron/post-trip-review", method: "GET" as const };

type Supabase = Awaited<ReturnType<typeof createAdminClient>>;

function redact(s: string): string {
  return s.replace(/[^\s@<>()"',;]+@[^\s@<>()"',;]+/g, "[email]");
}

function alarm(fingerprint: string, message: string, level: "info" | "warning" | "error") {
  Sentry.withScope((scope) => {
    scope.setFingerprint([fingerprint]);
    Sentry.captureMessage(message, level);
  });
}

async function respond(body: Record<string, unknown>, status = 200) {
  await Sentry.flush(2000).catch(() => {});
  return NextResponse.json(body, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(stage: string, message: string) {
  captureAPIError(new Error(`post-trip-review: ${redact(message)}`), { ...CTX, stage });
  return respond({ ok: false, error: redact(message) }, 500);
}

// --- Row parsing (Zod, never casts) ------------------------------------------

const customerSchema = z.object({
  email: z.string().nullable(),
  first_name: z.string().nullable(),
});

const bookingRowSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  cancel_state: z.string().nullable(),
  check_out: z.string(),
  location_name: z.string(),
  airport_code: z.string().nullable(),
  reslab_location_id: z.number().int().nullable(),
  direct_lot_id: z.string().nullable(),
  location_timezone: z.string().nullable(),
  livemode: z.boolean().nullable(),
  // PostgREST returns a many-to-one embed as an object; accept an array too.
  customers: z.union([customerSchema, z.array(customerSchema)]).nullable(),
});

const ledgerRowSchema = z.object({
  booking_id: z.string(),
  kind: z.enum(["initial", "reminder"]),
  status: z.enum(["claimed", "retry", "sent", "failed"]),
  sent_at: z.string().nullable(),
});

const BOOKING_COLS =
  "id, status, cancel_state, check_out, location_name, airport_code, reslab_location_id, direct_lot_id, location_timezone, livemode, customers!inner(email, first_name)";

function toBookingRow(r: z.infer<typeof bookingRowSchema>): ReviewBookingRow {
  const cust = Array.isArray(r.customers) ? (r.customers[0] ?? null) : r.customers;
  return {
    id: r.id,
    status: r.status,
    cancelState: r.cancel_state,
    checkOut: r.check_out,
    locationName: r.location_name,
    airportCode: r.airport_code,
    reslabLocationId: r.reslab_location_id,
    directLotId: r.direct_lot_id,
    locationTimezone: r.location_timezone,
    livemode: r.livemode,
    email: cust?.email ?? null,
    firstName: cust?.first_name ?? null,
  };
}

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Ledger rows + reviewed booking ids for these bookings. Throws on any read
 *  error: an unreadable ledger means we cannot know what was already sent. */
async function readState(
  supabase: Supabase,
  bookingIds: string[]
): Promise<{ ledger: ReviewLedgerRow[]; reviewed: Set<string> }> {
  const ledger: ReviewLedgerRow[] = [];
  const reviewed = new Set<string>();
  for (const ids of chunks(bookingIds, IN_CHUNK)) {
    const [l, r] = await Promise.all([
      supabase
        .from("review_emails")
        .select("booking_id, kind, status, sent_at")
        .in("booking_id", ids)
        .abortSignal(dbSignal()),
      supabase.from("booking_reviews").select("booking_id").in("booking_id", ids).abortSignal(dbSignal()),
    ]);
    if (l.error) throw new Error(`review_emails read failed: ${l.error.message}`);
    if (r.error) throw new Error(`booking_reviews read failed: ${r.error.message}`);
    for (const raw of l.data ?? []) {
      const p = ledgerRowSchema.safeParse(raw);
      if (!p.success) throw new Error(`review_emails row failed validation: ${p.error.message}`);
      ledger.push({ bookingId: p.data.booking_id, kind: p.data.kind, status: p.data.status, sentAt: p.data.sent_at });
    }
    for (const raw of r.data ?? []) {
      const p = z.object({ booking_id: z.string() }).safeParse(raw);
      if (!p.success) throw new Error(`booking_reviews row failed validation: ${p.error.message}`);
      reviewed.add(p.data.booking_id);
    }
  }
  return { ledger, reviewed };
}

/** Old `claimed` rows: never-reached-Resend ones are removed (the booking is
 *  judged afresh next run); reached-Resend ones are alarmed for a human. */
async function sweepStaleClaims(supabase: Supabase, nowMs: number): Promise<{ released: number; alarmed: number }> {
  const { data, error } = await supabase
    .from("review_emails")
    .select("id, send_started_at")
    .eq("status", "claimed")
    .lt("claimed_at", new Date(nowMs - STALE_CLAIM_MS).toISOString())
    .abortSignal(dbSignal());
  if (error) {
    captureAPIError(new Error(`post-trip-review: stale-claim scan failed: ${error.message}`), {
      ...CTX,
      stage: "stale_claims",
    });
    return { released: -1, alarmed: -1 };
  }
  const rows = z.array(z.object({ id: z.string(), send_started_at: z.string().nullable() })).safeParse(data ?? []);
  if (!rows.success) {
    captureAPIError(new Error(`post-trip-review: stale-claim rows failed validation: ${rows.error.message}`), {
      ...CTX,
      stage: "stale_claims",
    });
    return { released: -1, alarmed: -1 };
  }
  const unsent = rows.data.filter((r) => !r.send_started_at).map((r) => r.id);
  let released = 0;
  if (unsent.length > 0) {
    const del = await supabase
      .from("review_emails")
      .delete()
      .in("id", unsent)
      .eq("status", "claimed")
      .is("send_started_at", null)
      .select("id")
      .abortSignal(dbSignal());
    if (del.error) {
      captureAPIError(new Error(`post-trip-review: stale unsent claims not released: ${del.error.message}`), {
        ...CTX,
        stage: "stale_claims",
      });
    } else {
      released = Array.isArray(del.data) ? del.data.length : 0;
    }
  }
  const alarmed = rows.data.length - unsent.length;
  if (alarmed > 0) {
    alarm(
      "post_trip_review_stale_claims",
      `post-trip-review: ${alarmed} claimed row(s) reached Resend and were never marked — the email may be out. Check Resend by booking id, then set the row to sent or failed by hand.`,
      "warning"
    );
  }
  return { released, alarmed };
}

/** INSERT a `claimed` row, or on 23505 re-claim a `retry` row. */
async function claimRow(
  supabase: Supabase,
  c: ReviewCandidate,
  nowIso: string
): Promise<{ id: string } | "taken" | "error"> {
  const ins = await supabase
    .from("review_emails")
    .insert({
      booking_id: c.bookingId,
      kind: c.kind,
      status: "claimed",
      claimed_at: nowIso,
      send_started_at: null,
      sent_at: null,
      last_error: null,
    })
    .select("id")
    .abortSignal(dbSignal());
  if (!ins.error) {
    const p = z.array(z.object({ id: z.string() })).length(1).safeParse(ins.data);
    if (p.success) return { id: p.data[0].id };
    captureAPIError(new Error("post-trip-review: claim INSERT returned no id"), { ...CTX, stage: "claim" });
    return "error";
  }
  if (ins.error.code !== "23505") {
    captureAPIError(new Error(`post-trip-review claim failed: ${redact(ins.error.message)}`), {
      ...CTX,
      stage: "claim",
      code: ins.error.code,
    });
    return "error";
  }
  // send_started_at / last_error are KEPT: evidence an earlier attempt reached
  // Resend, so a crash after re-claim is alarmed, never swept.
  const re = await supabase
    .from("review_emails")
    .update({ status: "claimed", claimed_at: nowIso })
    .eq("booking_id", c.bookingId)
    .eq("kind", c.kind)
    .eq("status", "retry")
    .select("id")
    .abortSignal(dbSignal());
  if (re.error) {
    captureAPIError(new Error(`post-trip-review re-claim failed: ${redact(re.error.message)}`), {
      ...CTX,
      stage: "reclaim",
      code: re.error.code,
    });
    return "error";
  }
  const p = z.array(z.object({ id: z.string() })).safeParse(re.data ?? []);
  return p.success && p.data.length === 1 ? { id: p.data[0].id } : "taken";
}

async function markRow(
  supabase: Supabase,
  rowId: string,
  patch: { status: "sent" | "failed" | "retry"; sent_at?: string; last_error?: string | null },
  result: { markFailed: number }
) {
  const { data, error } = await supabase
    .from("review_emails")
    .update(patch)
    .eq("id", rowId)
    .select("id")
    .abortSignal(dbSignal());
  if (error || !Array.isArray(data) || data.length === 0) {
    result.markFailed++;
    captureAPIError(
      new Error(`post-trip-review: status '${patch.status}' not recorded for ${rowId}: ${error?.message ?? "matched no rows"}`),
      { ...CTX, stage: `mark_${patch.status}` }
    );
  }
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.POST_TRIP_REVIEW_EMAILS_ENABLED !== "true") {
    return NextResponse.json({ ok: true, disabled: true });
  }
  try {
    assertReviewSigningSecret();
  } catch (error) {
    captureAPIError(error instanceof Error ? error : new Error(String(error)), { ...CTX, stage: "config" });
    return respond({ ok: false, error: "review signing secret is not configured" }, 503);
  }
  try {
    return await run();
  } catch (error) {
    return fail("unhandled", errorMessage(error));
  }
}

async function run() {
  const nowMs = Date.now();
  const elapsed = () => Date.now() - nowMs;
  const supabase = await createAdminClient();
  const stale = await sweepStaleClaims(supabase, nowMs);

  // check_out is a literal TIMESTAMP; bounding it by two UTC calendar dates
  // (a day of slack each side) never converts the stored value — the
  // selector makes the real, airport-local decision.
  const from = new Date(nowMs - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(nowMs + 2 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_COLS)
    .in("status", [...REVIEWABLE_STATUSES])
    .gte("check_out", from)
    .lt("check_out", to)
    .order("check_out", { ascending: true })
    .limit(ROW_CAP)
    .abortSignal(dbSignal());
  if (error) return fail("bookings_read", `bookings read failed: ${error.message}`);
  const rawRows = data ?? [];
  if (rawRows.length >= ROW_CAP) {
    alarm("post_trip_review_row_cap", `post-trip-review: bookings read hit the ${ROW_CAP}-row cap; some trips may be skipped`, "warning");
  }

  const bookings: ReviewBookingRow[] = [];
  let invalidRows = 0;
  for (const raw of rawRows) {
    const p = bookingRowSchema.safeParse(raw);
    if (p.success) bookings.push(toBookingRow(p.data));
    else invalidRows++;
  }
  if (invalidRows > 0) {
    captureAPIError(new Error(`post-trip-review: ${invalidRows} bookings row(s) failed validation and were skipped`), {
      ...CTX,
      stage: "bookings_parse",
    });
  }
  if (bookings.length === 0) {
    return respond({ ok: true, scanned: rawRows.length, invalidRows, sent: 0, staleClaims: stale });
  }

  let state: { ledger: ReviewLedgerRow[]; reviewed: Set<string> };
  try {
    state = await readState(supabase, bookings.map((b) => b.id));
  } catch (e) {
    return fail("state_read", errorMessage(e));
  }

  const { initial, reminder, skipped } = selectReviewSends(bookings, state.ledger, state.reviewed, nowMs, {
    testLocationIds: TEST_RESLAB_LOCATION_IDS,
  });
  const toSend = [...initial, ...reminder];

  const result = {
    scanned: rawRows.length,
    invalidRows,
    initialCandidates: initial.length,
    reminderCandidates: reminder.length,
    staleClaims: stale,
    sent: 0,
    sentUnconfirmed: 0,
    alreadyClaimed: 0,
    claimFailed: 0,
    sendFailed: 0,
    markFailed: 0,
    deferredToNextRun: 0,
  };

  let attempted = 0;
  for (const [i, c] of toSend.entries()) {
    if (attempted >= MAX_SENDS_PER_RUN || elapsed() + CANDIDATE_RESERVE_MS > RUN_DEADLINE_MS) {
      result.deferredToNextRun = toSend.length - i;
      break;
    }

    const claim = await claimRow(supabase, c, new Date().toISOString());
    if (claim === "taken") {
      result.alreadyClaimed++;
      continue;
    }
    if (claim === "error") {
      result.claimFailed++;
      continue;
    }
    const rowId = claim.id;
    attempted++;

    const started = await supabase
      .from("review_emails")
      .update({ send_started_at: new Date().toISOString() })
      .eq("id", rowId)
      .select("id")
      .abortSignal(dbSignal());
    if (started.error || !Array.isArray(started.data) || started.data.length === 0) {
      result.sendFailed++;
      captureAPIError(
        new Error(`post-trip-review: send_started_at not recorded for ${rowId}: ${started.error?.message ?? "matched no rows"}`),
        { ...CTX, stage: "send_start" }
      );
      await markRow(supabase, rowId, { status: "retry", last_error: "send_started_at write failed" }, result);
      continue;
    }

    try {
      await sendReviewEmail(c);
    } catch (error) {
      const message = redact(errorMessage(error)).slice(0, 500);
      if (isIdempotencyConflict(error)) {
        result.sentUnconfirmed++;
        alarm(
          "post_trip_review_idempotency_conflict",
          `post-trip-review: Resend 409 for ${c.kind} ${c.bookingId} — recorded as sent (delivery unconfirmed)`,
          "warning"
        );
        await markRow(supabase, rowId, { status: "sent", sent_at: new Date().toISOString(), last_error: message }, result);
        result.sent++;
        continue;
      }
      captureAPIError(new Error(`post-trip-review send failed: ${message}`), { ...CTX, stage: "send" });
      result.sendFailed++;
      if (isReviewConfigError(error) || isSendConfigFailure(error)) {
        // Not this row's fault, and every later send would fail the same way.
        await markRow(supabase, rowId, { status: "retry", last_error: message }, result);
        result.deferredToNextRun += toSend.length - i - 1;
        break;
      }
      await markRow(
        supabase,
        rowId,
        { status: isTransientSendFailure(error) ? "retry" : "failed", last_error: message },
        result
      );
      continue;
    }

    await markRow(supabase, rowId, { status: "sent", sent_at: new Date().toISOString(), last_error: null }, result);
    result.sent++;
  }

  if (result.deferredToNextRun > 0) {
    alarm(
      "post_trip_review_capped",
      `post-trip-review: ${result.deferredToNextRun} email(s) deferred to the next run (cap ${MAX_SENDS_PER_RUN} / ${RUN_DEADLINE_MS} ms deadline)`,
      "warning"
    );
  }
  const allFailed = attempted + result.claimFailed > 0 && result.sent === 0;
  if (result.sendFailed + result.claimFailed + result.markFailed > 0) {
    alarm(
      "post_trip_review_failures",
      `post-trip-review: ${result.sendFailed} send / ${result.claimFailed} claim / ${result.markFailed} mark failure(s); ${result.sent} sent`,
      allFailed ? "error" : "warning"
    );
  }
  return respond({ ok: !allFailed, ...result, skipped }, allFailed ? 500 : 200);
}
