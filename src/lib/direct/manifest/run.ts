import * as Sentry from "@sentry/nextjs";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { bounded, BoundedTimeoutError } from "@/lib/utils/bounded";
import { resolveLotRecipients } from "@/lib/direct/lot-notice";
import { isValidTimeZone } from "@/lib/utils/time";
import { calendarDayIn, shiftIsoDate } from "@/lib/digest/window";
import {
  readManifestSchedule,
  lotWallClock,
  inSendWindow,
  pastCutoff,
  type AdminClient,
  type LotProblem,
  type ManifestSchedule,
} from "./schedule";
import {
  selectManifestGroups,
  recheckManifestRows,
  lotHasConfirmedBookingOn,
  readFollowUpRows,
  normaliseRecipients,
  recipientsHash,
  type FollowUpRow,
  type ManifestGroup,
  type ManifestRow,
} from "./select";
import { renderManifest, renderFollowUpCancel, type RenderedEmail } from "./render";

/**
 * The evening manifest's send-once state machine (6b plan §3.4–§3.5).
 *
 * One `direct_lot_manifest_runs` row per (lot, date, Stripe mode, recipient
 * set). Every status write is a compare-and-set on (attempt, status,
 * claimed_at) — `claimed_at` is the lease: a fresh claim or a takeover writes
 * a new one, and a writer whose lease moved on matches no row and stops.
 *
 *   1 claim     INSERT `sending`. 23505 → `sent` (follow up) / `checked` skip;
 *               fresh `sending` skip; stale `sending` (5 min) take over, SAME
 *               attempt; `failed` (no unknown, before the cutoff) attempt + 1.
 *   2 re-check  before EVERY send, takeovers too: re-read the run's ids, drop
 *               any no longer listed, CAS the trimmed list into booking_ids and
 *               union it into ids_ever (everything the run may have sent).
 *   3 send      key direct-lot-manifest/{lot}/{date}/{live|test}/{hash}/{attempt}.
 *               Unknown → had_unknown, stay `sending` (the next takeover
 *               repeats the same key). `invalid_idempotent_request` = an earlier
 *               request with this key was ACCEPTED. Definite failure → `failed`,
 *               or stay `sending` once anything was unknown (never a new key).
 *   4 accepted  → `sent`.
 *   5 follow-up only once no more sends can happen (`sent`, or a stale
 *               `sending` past the cutoff): every id in ids_ever now cancelled
 *               gets a cancel reminder (once per booking per run, claimed in
 *               direct_lot_resends, ≤ 3 attempts then a `followup` alert); all
 *               done → `checked`.
 *   6 cutoff    no manifest send at/after 12:00 lot-local on the manifest date;
 *               a stale `sending` there counts as possibly delivered:
 *               had_unknown = true → step 5 → `checked`.
 *
 * Recovery (takeovers, follow-ups, cutoff) runs every tick regardless of the
 * send window and of DIRECT_LOT_MANIFEST_DISABLED; the kill switch stops NEW
 * manifests (claims, attempt + 1, force) only.
 *
 * Terminal markers for the alerts cron: a run checked at the cutoff without a
 * confirmed send has `sent_at IS NULL` (had_unknown = true); a `failed` run
 * whose last_error starts "nothing_to_list:" or "superseded:" sent nothing
 * because nothing was left to list (all cancelled / the lot got a booking).
 *
 * No PII leaves this module except in the emails themselves: Sentry messages,
 * alert details and last_error carry lot ids, dates and TRP numbers only.
 */

export const MANIFEST_RUNS_TABLE = "direct_lot_manifest_runs";
const ALERTS_TABLE = "direct_lot_alerts";
const RESENDS_TABLE = "direct_lot_resends";
const FOLLOWUP_KIND = "manifest_followup_cancel";

/** A `sending` claim older than this belongs to a dead sender (> any maxDuration). */
export const STALE_RUN_MS = 5 * 60_000;
export const MANIFEST_SEND_TIMEOUT_MS = 10_000;
/** A send is started only with this much budget left: the send itself plus its DB writes. */
const SEND_RESERVE_MS = MANIFEST_SEND_TIMEOUT_MS + 4_000;
export const MAX_FOLLOWUP_ATTEMPTS = 3;
const DB_TIMEOUT_MS = 3_000;
const RECOVERY_LIMIT = 500;
const dbSignal = () => AbortSignal.timeout(DB_TIMEOUT_MS);
const iso = () => new Date().toISOString();

export const CUTOFF_REASON = "cutoff: no confirmed send by 12:00 lot time on the manifest date — treated as possibly delivered";

const RUN_COLS =
  "direct_lot_id, manifest_date, livemode, recipients_hash, status, attempt, claimed_at, had_unknown, booking_ids, ids_ever, recipients, test, first_sent_at, sent_at, email_id, last_error";

export type RunStatus = "sending" | "sent" | "checked" | "failed";

export interface RunRow {
  direct_lot_id: string;
  manifest_date: string;
  livemode: boolean;
  recipients_hash: string;
  status: RunStatus;
  attempt: number;
  claimed_at: string;
  had_unknown: boolean;
  booking_ids: string[];
  ids_ever: string[];
  recipients: string[];
  test: boolean;
  first_sent_at: string | null;
  sent_at: string | null;
  email_id: string | null;
  last_error: string | null;
}

interface Lease {
  attempt: number;
  status: RunStatus;
  claimedAt: string;
}
const leaseOf = (run: RunRow): Lease => ({ attempt: run.attempt, status: run.status, claimedAt: run.claimed_at });

type RunPatch = Partial<Omit<RunRow, "direct_lot_id" | "manifest_date" | "livemode" | "recipients_hash">> & {
  attempt_claimed_at?: string;
};

export type RunOutcome =
  | "sent"
  | "unknown"
  | "failed"
  | "checked"
  | "cutoff_checked"
  | "followup_pending"
  | "already_done"
  | "in_flight"
  | "lost_lease"
  | "no_recipients"
  | "nothing_to_list"
  | "superseded"
  | "out_of_budget"
  | "no_zone"
  | "not_forceable"
  | "error";

export type FollowUpOutcome = "sent" | "already_sent" | "unknown" | "failed" | "gave_up" | "in_flight" | "out_of_budget" | "error";

export interface DryManifest {
  lotId: string;
  manifestDate: string;
  recipientsHash: string;
  /** Where it would go: the lot's set in production, the override inbox elsewhere; null = nowhere configured. */
  to: string[] | null;
  test: boolean | null;
  bookings: string[];
  subject: string;
  text: string;
  html: string;
}

export interface ManifestCronResult {
  ok: boolean;
  /** Suggested HTTP status. */
  status: number;
  livemode: boolean;
  dry: boolean;
  disabled: boolean;
  lots: Array<{
    lotId: string;
    timezone: string;
    localDate: string;
    localMinutes: number;
    manifestDate: string;
    hasBookingsTomorrow: boolean;
    expectsManifest: boolean;
    inWindow: boolean;
  }>;
  problems: LotProblem[];
  /** Event counts (a run can add more than one: "sent" then "checked"). */
  runs: Partial<Record<RunOutcome, number>>;
  followUps: Partial<Record<FollowUpOutcome, number>>;
  errors: number;
  budgetExhausted: boolean;
  manifests?: DryManifest[];
  force?: { refused?: string; runs: Array<{ recipientsHash: string; outcome: RunOutcome }> };
}

/** Addresses never reach Sentry, last_error or an alert. */
function redact(s: string): string {
  return s.replace(/[^\s@<>()"',;]+@[^\s@<>()"',;]+/g, "[email]").slice(0, 500);
}

function report(fingerprint: string[], message: string, level: "warning" | "error") {
  Sentry.withScope((scope) => {
    scope.setFingerprint(["direct-lot-manifest", ...fingerprint]);
    scope.setTag("cron", "direct-lot-manifest");
    Sentry.captureMessage(redact(message), level);
  });
}

const runKey = (lotId: string, date: string, livemode: boolean, hash: string) => `${lotId}/${date}/${livemode ? "live" : "test"}/${hash}`;

class Tick {
  readonly runs: Partial<Record<RunOutcome, number>> = {};
  readonly followUps: Partial<Record<FollowUpOutcome, number>> = {};
  errors = 0;
  budgetExhausted = false;
  /** Runs already driven this tick — the recovery pass skips them. */
  readonly handled = new Set<string>();

  constructor(
    readonly sb: AdminClient,
    readonly livemode: boolean,
    readonly nowMs: number,
    readonly deadlineMs: number,
    readonly schedule: ManifestSchedule
  ) {}

  count(o: RunOutcome) {
    this.runs[o] = (this.runs[o] ?? 0) + 1;
    if (o === "error") this.errors++;
  }
  countFollowUp(o: FollowUpOutcome) {
    this.followUps[o] = (this.followUps[o] ?? 0) + 1;
    if (o === "error") this.errors++;
  }
  hasSendBudget(): boolean {
    const ok = Date.now() + SEND_RESERVE_MS <= this.deadlineMs;
    if (!ok) this.budgetExhausted = true;
    return ok;
  }
  /** Reports only; the caller counts the error (an "error" outcome, or errors++). */
  dbError(stage: string, message: string) {
    report(["db", stage], `Direct lot manifest: ${stage} failed: ${message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Resend

type SendResult = { kind: "accepted"; emailId: string | null } | { kind: "unknown"; detail: string } | { kind: "failed"; detail: string };

/** Classified exactly as lot-notice.ts `claimAndSend` does. Never throws. */
async function sendEmail(to: string[], email: RenderedEmail, idempotencyKey: string): Promise<SendResult> {
  let sent: Awaited<ReturnType<typeof resend.emails.send>>;
  try {
    sent = await bounded(
      resend.emails.send({ from: FROM_EMAIL, to, subject: email.subject, html: email.html, text: email.text }, { idempotencyKey }),
      MANIFEST_SEND_TIMEOUT_MS,
      "Resend"
    );
  } catch (err) {
    // A timeout's outcome is UNKNOWN (Resend may have delivered). Any other
    // throw is a definite failure, as in lot-notice.
    if (err instanceof BoundedTimeoutError) return { kind: "unknown", detail: err.message };
    return { kind: "failed", detail: `Resend call threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { data, error } = sent;
  if (!error) return { kind: "accepted", emailId: data?.id ?? null };
  // This key already carried an ACCEPTED send (a changed body under the same key is refused, not re-sent).
  if (error.name === "invalid_idempotent_request") return { kind: "accepted", emailId: null };
  const unknownOutcome =
    error.name === "application_error" ||
    error.name === "internal_server_error" ||
    error.name === "concurrent_idempotent_requests" ||
    error.statusCode == null ||
    error.statusCode >= 500;
  const detail = `Resend ${error.name}${error.statusCode != null ? ` ${error.statusCode}` : ""}: ${error.message}`;
  return unknownOutcome ? { kind: "unknown", detail } : { kind: "failed", detail };
}

// ---------------------------------------------------------------------------
// Run rows

type CasResult = { kind: "ok"; run: RunRow } | { kind: "lost" } | { kind: "error" };

/** Compare-and-set on the lease. Single-condition filters only (PostgREST refuses `.or()` on UPDATE). */
async function casRun(t: Tick, run: RunRow, lease: Lease, patch: RunPatch): Promise<CasResult> {
  const { data, error } = await t.sb
    .from(MANIFEST_RUNS_TABLE)
    .update(patch)
    .eq("direct_lot_id", run.direct_lot_id)
    .eq("manifest_date", run.manifest_date)
    .eq("livemode", run.livemode)
    .eq("recipients_hash", run.recipients_hash)
    .eq("attempt", lease.attempt)
    .eq("status", lease.status)
    .eq("claimed_at", lease.claimedAt)
    .select(RUN_COLS)
    .abortSignal(dbSignal())
    .maybeSingle();
  if (error) {
    t.dbError("run update", `${run.direct_lot_id} ${run.manifest_date} ${run.recipients_hash}: ${error.code ?? "?"} ${error.message}`);
    return { kind: "error" };
  }
  return data ? { kind: "ok", run: data as RunRow } : { kind: "lost" };
}

const casOutcome = (r: CasResult, ok: RunOutcome): RunOutcome => (r.kind === "ok" ? ok : r.kind === "lost" ? "lost_lease" : "error");

async function readRun(t: Tick, lotId: string, date: string, hash: string): Promise<RunRow | null | "error"> {
  const { data, error } = await t.sb
    .from(MANIFEST_RUNS_TABLE)
    .select(RUN_COLS)
    .eq("direct_lot_id", lotId)
    .eq("manifest_date", date)
    .eq("livemode", t.livemode)
    .eq("recipients_hash", hash)
    .abortSignal(dbSignal())
    .maybeSingle();
  if (error) {
    t.dbError("run read", `${lotId} ${date} ${hash}: ${error.code ?? "?"} ${error.message}`);
    return "error";
  }
  return (data as RunRow | null) ?? null;
}

const isStale = (run: RunRow, nowMs: number) => {
  const at = Date.parse(run.claimed_at);
  return Number.isNaN(at) || at < nowMs - STALE_RUN_MS;
};

// ---------------------------------------------------------------------------
// Groups

/**
 * The manifests (lot, date) should get: one per recipient set of LISTED
 * bookings, or — only when the lot has no confirmed booking at all that day
 * (listed or not) and passes the E1 gate — one empty-day manifest to the CMS inbox.
 */
async function groupsFor(t: Tick, lotId: string, date: string): Promise<ManifestGroup[]> {
  const { groups, unroutable } = await selectManifestGroups(t.sb, t.livemode, lotId, date);
  for (const number of unroutable) {
    t.count("error");
    report(["unroutable", number], `Direct lot manifest: booking ${number} (lot ${lotId}, ${date}) has no direct_booking_terms recipients — left off the manifest`, "error");
  }
  if (groups.length > 0 || unroutable.length > 0) return groups;
  if (!t.schedule.emptyDayEligible.has(lotId)) return [];
  if (await lotHasConfirmedBookingOn(t.sb, t.livemode, lotId, date)) return [];
  const set = normaliseRecipients(t.schedule.cmsLots.get(lotId)?.notificationEmails ?? []);
  return set.length > 0 ? [{ recipients: set, hash: recipientsHash(set), rows: [] }] : [];
}

function lotNameFor(t: Tick, lotId: string, rows: ManifestRow[]): string {
  return rows.find((r) => r.lotName)?.lotName || t.schedule.cmsLots.get(lotId)?.name || `Lot ${lotId}`;
}

// ---------------------------------------------------------------------------
// Steps 2–4: re-check, send, record

async function attemptSend(t: Tick, run: RunRow, zone: string): Promise<RunOutcome> {
  if (!t.hasSendBudget()) return "out_of_budget"; // the claim goes stale and the next tick takes it over
  const lotId = run.direct_lot_id;
  const date = run.manifest_date;
  // Only an empty-day claim (or attempt) is ever written with an empty list: a
  // booked run whose re-check leaves nothing returns below without a CAS.
  const emptyDay = run.booking_ids.length === 0;
  let rows: ManifestRow[] = [];
  try {
    if (emptyDay) {
      // An empty-day reminder never goes to a lot that has a booking that day, listed or not.
      if (await lotHasConfirmedBookingOn(t.sb, t.livemode, lotId, date)) {
        const reason = "superseded: the lot has a booking for this date now; the empty-day reminder was not sent";
        if (run.had_unknown) return finishWithoutSend(t, run, reason);
        return casOutcome(await casRun(t, run, leaseOf(run), { status: "failed", last_error: reason }), "superseded");
      }
    } else {
      rows = await recheckManifestRows(t.sb, t.livemode, lotId, date, run.booking_ids);
      if (rows.length === 0) {
        // The list only ever shrinks, so no send can happen for this run any more.
        const reason = "nothing_to_list: every booking on the list was cancelled before the send";
        if (run.had_unknown) return finishWithoutSend(t, run, reason);
        return casOutcome(await casRun(t, run, leaseOf(run), { status: "failed", last_error: reason }), "nothing_to_list");
      }
    }
  } catch (err) {
    t.dbError("re-check", `${lotId} ${date}: ${err instanceof Error ? err.message : String(err)}`);
    return "error"; // the claim stays; a takeover repeats this attempt
  }

  const trimmed = rows.map((r) => r.bookingId);
  const recheck = await casRun(t, run, leaseOf(run), {
    booking_ids: trimmed,
    ids_ever: [...new Set([...run.ids_ever, ...trimmed])],
  });
  if (recheck.kind !== "ok") return casOutcome(recheck, "error");
  const current = recheck.run;

  const email = renderManifest({
    lotName: lotNameFor(t, lotId, rows),
    manifestDate: date,
    rows,
    asOfMinutes: lotWallClock(zone, t.nowMs).localMinutes,
    test: current.test,
  });
  const key = `direct-lot-manifest/${lotId}/${date}/${current.livemode ? "live" : "test"}/${current.recipients_hash}/${current.attempt}`;
  const result = await sendEmail(current.recipients, email, key);
  const label = `lot ${lotId} ${date} set ${current.recipients_hash} attempt ${current.attempt}`;

  if (result.kind === "accepted") {
    const now = iso();
    const marked = await casRun(t, current, leaseOf(current), {
      status: "sent",
      sent_at: now,
      first_sent_at: current.first_sent_at ?? now,
      email_id: result.emailId,
      last_error: null,
    });
    if (marked.kind !== "ok") {
      // Delivered, not recorded: the claim stays `sending`, and the takeover
      // repeats the SAME key — Resend answers it without a second email.
      report(["unrecorded", lotId], `Direct lot manifest ${label}: accepted by Resend but not marked sent (${marked.kind}); a takeover repeats the same key`, "error");
      return marked.kind === "lost" ? "lost_lease" : "error";
    }
    t.count(await followUpAndCheck(t, marked.run, "sent"));
    return "sent";
  }
  if (result.kind === "unknown") {
    report(["unknown", lotId], `Direct lot manifest ${label}: outcome unknown (${result.detail}); stays sending, the takeover repeats the same key`, "warning");
    return casOutcome(await casRun(t, current, leaseOf(current), { had_unknown: true, last_error: redact(result.detail) }), "unknown");
  }
  report(["failed", lotId], `Direct lot manifest ${label}: send failed (${result.detail})`, "error");
  // Once an attempt was unknown the run never moves to a new key: it stays `sending` and is retried as is.
  const patch: RunPatch = current.had_unknown ? { last_error: redact(result.detail) } : { status: "failed", last_error: redact(result.detail) };
  return casOutcome(await casRun(t, current, leaseOf(current), patch), "failed");
}

/** No more sends can happen and an earlier attempt may have delivered: follow up, then `checked`. */
function finishWithoutSend(t: Tick, run: RunRow, reason: string): Promise<RunOutcome> {
  return followUpAndCheck(t, run, "no_more_sends", reason);
}

// ---------------------------------------------------------------------------
// Step 5: follow-up

async function followUpAndCheck(t: Tick, run: RunRow, mode: "sent" | "no_more_sends", reason?: string): Promise<RunOutcome> {
  let rows: FollowUpRow[];
  try {
    rows = await readFollowUpRows(t.sb, run.ids_ever);
  } catch (err) {
    t.dbError("follow-up read", `${run.direct_lot_id} ${run.manifest_date}: ${err instanceof Error ? err.message : String(err)}`);
    return "error";
  }
  let done = true;
  for (const row of rows) {
    if (row.status !== "cancelled" && row.status !== "refunded") continue;
    const o = await followUpOne(t, run, row);
    t.countFollowUp(o);
    if (o !== "sent" && o !== "already_sent" && o !== "gave_up") done = false;
  }
  if (!done) return "followup_pending";
  const patch: RunPatch =
    mode === "sent" ? { status: "checked" } : { status: "checked", had_unknown: true, last_error: redact(reason ?? CUTOFF_REASON) };
  return casOutcome(await casRun(t, run, leaseOf(run), patch), mode === "sent" ? "checked" : "cutoff_checked");
}

interface ResendRow {
  id: string;
  attempts: number;
  outcome: "sending" | "sent" | "failed" | "unknown";
  updated_at: string;
}

async function followUpOne(t: Tick, run: RunRow, row: FollowUpRow): Promise<FollowUpOutcome> {
  const source = `manifest:${run.direct_lot_id}:${run.manifest_date}:${run.recipients_hash}`;
  if (!row.piId) {
    t.dbError("follow-up", `booking ${row.number} has no PaymentIntent id`);
    return "error";
  }
  if (!t.hasSendBudget()) return "out_of_budget";

  // Claim: the UNIQUE (booking_id, kind, source) row is the once-only lock.
  let attempt: number;
  let resendId: string;
  const ins = await t.sb
    .from(RESENDS_TABLE)
    .insert({
      booking_id: row.bookingId,
      stripe_payment_intent_id: row.piId,
      livemode: t.livemode,
      kind: FOLLOWUP_KIND,
      source,
      attempts: 1,
      sent_by: "manifest",
      recipients: run.recipients,
      outcome: "sending",
    })
    .select("id, attempts, outcome, updated_at")
    .abortSignal(dbSignal())
    .maybeSingle();
  if (!ins.error && ins.data) {
    attempt = 1;
    resendId = (ins.data as ResendRow).id;
  } else if (ins.error && ins.error.code !== "23505") {
    t.dbError("follow-up claim", `${row.number}: ${ins.error.code ?? "?"} ${ins.error.message}`);
    return "error";
  } else {
    const ex = await t.sb
      .from(RESENDS_TABLE)
      .select("id, attempts, outcome, updated_at")
      .eq("booking_id", row.bookingId)
      .eq("kind", FOLLOWUP_KIND)
      .eq("source", source)
      .abortSignal(dbSignal())
      .maybeSingle();
    if (ex.error || !ex.data) {
      t.dbError("follow-up read", `${row.number}: ${ex.error ? `${ex.error.code ?? "?"} ${ex.error.message}` : "claim row missing after 23505"}`);
      return "error";
    }
    const e = ex.data as ResendRow;
    if (e.outcome === "sent") return "already_sent";
    const updatedAt = Date.parse(e.updated_at);
    if (e.outcome === "sending" && !Number.isNaN(updatedAt) && updatedAt >= t.nowMs - STALE_RUN_MS) return "in_flight";
    if (e.attempts >= MAX_FOLLOWUP_ATTEMPTS) {
      await raiseFollowUpAlert(t, run, row, source, e.attempts, `no confirmed send after ${e.attempts} attempts (last: ${e.outcome})`);
      return "gave_up";
    }
    const next = await t.sb
      .from(RESENDS_TABLE)
      .update({ attempts: e.attempts + 1, outcome: "sending", last_error: null })
      .eq("id", e.id)
      .eq("attempts", e.attempts)
      .eq("outcome", e.outcome)
      .select("id")
      .abortSignal(dbSignal())
      .maybeSingle();
    if (next.error) {
      t.dbError("follow-up re-claim", `${row.number}: ${next.error.code ?? "?"} ${next.error.message}`);
      return "error";
    }
    if (!next.data) return "in_flight"; // another sender took this attempt
    attempt = e.attempts + 1;
    resendId = e.id;
  }

  const email = renderFollowUpCancel(
    {
      number: row.number,
      lotName: row.lotName || t.schedule.cmsLots.get(run.direct_lot_id)?.name || `Lot ${run.direct_lot_id}`,
      customerName: row.customerName,
      fromDate: row.fromDate,
      toDate: row.toDate,
      vehicleLine: row.vehicleLine,
    },
    run.test
  );
  const key = `direct-lot-followup/${row.bookingId}/${run.direct_lot_id}/${run.manifest_date}/${run.recipients_hash}/${attempt}`;
  const result = await sendEmail(run.recipients, email, key);
  const patch =
    result.kind === "accepted"
      ? { outcome: "sent", email_id: result.emailId, last_error: null }
      : { outcome: result.kind, last_error: redact(result.detail) };
  const rec = await t.sb
    .from(RESENDS_TABLE)
    .update(patch)
    .eq("id", resendId)
    .eq("attempts", attempt)
    .eq("outcome", "sending")
    .abortSignal(dbSignal());
  if (rec.error) {
    t.errors++;
    t.dbError("follow-up record", `${row.number} attempt ${attempt} (${result.kind}): ${rec.error.code ?? "?"} ${rec.error.message}`);
  }
  if (result.kind === "accepted") return "sent";
  report(["followup", row.bookingId], `Direct lot manifest follow-up for ${row.number} attempt ${attempt}: ${result.kind} (${result.detail})`, "warning");
  if (attempt >= MAX_FOLLOWUP_ATTEMPTS) {
    await raiseFollowUpAlert(t, run, row, source, attempt, `no confirmed send after ${attempt} attempts (last: ${result.kind})`);
    return "gave_up";
  }
  return result.kind;
}

async function raiseFollowUpAlert(t: Tick, run: RunRow, row: FollowUpRow, source: string, attempts: number, reason: string) {
  report(
    ["followup-gave-up", row.bookingId],
    `Direct lot manifest follow-up gave up: ${row.number} (lot ${run.direct_lot_id}, ${run.manifest_date}) — ${reason}`,
    "error"
  );
  await upsertAlert(t, `${row.bookingId}:${source}`, "followup", {
    number: row.number,
    lotId: run.direct_lot_id,
    manifestDate: run.manifest_date,
    attempts,
    reason: redact(reason),
  });
}

/** Writers touch ONLY last_seen_at + detail (first_seen_at defaults on insert; alerted_at is the alerts cron's). */
async function upsertAlert(t: Tick, subject: string, kind: "lot_config" | "followup", detail: Record<string, string | number>) {
  const { error } = await t.sb
    .from(ALERTS_TABLE)
    .upsert({ subject, kind, livemode: t.livemode, last_seen_at: iso(), detail }, { onConflict: "subject,kind,livemode" })
    .abortSignal(dbSignal());
  if (error) {
    t.errors++;
    t.dbError("alert write", `${kind} ${subject}: ${error.code ?? "?"} ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Step 1: claim

async function claimGroup(t: Tick, lotId: string, date: string, zone: string, group: ManifestGroup): Promise<RunOutcome> {
  t.handled.add(runKey(lotId, date, t.livemode, group.hash));
  const to = resolveLotRecipients(t.livemode, group.recipients);
  if (!to || to.to.length === 0) {
    report(["no-recipients", lotId], `Direct lot manifest for lot ${lotId} ${date}: DIRECT_LOT_NOTICE_OVERRIDE_TO is not set — a non-production manifest was not sent`, "warning");
    return "no_recipients";
  }
  if (!t.hasSendBudget()) return "out_of_budget";
  const ids = group.rows.map((r) => r.bookingId);
  const now = iso();
  const ins = await t.sb
    .from(MANIFEST_RUNS_TABLE)
    .insert({
      direct_lot_id: lotId,
      manifest_date: date,
      livemode: t.livemode,
      recipients_hash: group.hash,
      status: "sending",
      attempt: 1,
      claimed_at: now,
      attempt_claimed_at: now,
      had_unknown: false,
      booking_ids: ids,
      ids_ever: [],
      recipients: to.to,
      test: to.test,
    })
    .select(RUN_COLS)
    .abortSignal(dbSignal())
    .maybeSingle();
  if (!ins.error && ins.data) return attemptSend(t, ins.data as RunRow, zone);
  if (ins.error && ins.error.code !== "23505") {
    t.dbError("run claim", `${lotId} ${date} ${group.hash}: ${ins.error.code ?? "?"} ${ins.error.message}`);
    return "error";
  }

  const existing = await readRun(t, lotId, date, group.hash);
  if (existing === "error") return "error";
  if (!existing) {
    t.dbError("run claim", `${lotId} ${date} ${group.hash}: 23505 but no row`);
    return "error";
  }
  switch (existing.status) {
    case "checked":
      return "already_done";
    case "sent":
      return followUpAndCheck(t, existing, "sent");
    case "sending": {
      if (!isStale(existing, t.nowMs)) return "in_flight";
      const taken = await casRun(t, existing, leaseOf(existing), { claimed_at: iso() });
      return taken.kind === "ok" ? attemptSend(t, taken.run, zone) : casOutcome(taken, "error");
    }
    case "failed": {
      // A definite failure on every attempt so far: nothing was delivered, so a new key is safe.
      if (existing.had_unknown) return "already_done";
      const now2 = iso();
      const next = await casRun(t, existing, leaseOf(existing), {
        attempt: existing.attempt + 1,
        status: "sending",
        claimed_at: now2,
        attempt_claimed_at: now2,
        booking_ids: ids,
        last_error: null,
        email_id: null,
        recipients: to.to,
        test: to.test,
      });
      return next.kind === "ok" ? attemptSend(t, next.run, zone) : casOutcome(next, "error");
    }
  }
}

// ---------------------------------------------------------------------------
// Recovery: takeovers, follow-ups and the cutoff — every tick, any hour, kill switch or not

async function zoneForRun(t: Tick, run: RunRow): Promise<string | null> {
  const known = t.schedule.zones.get(run.direct_lot_id);
  if (known) return known;
  if (t.schedule.problems.some((p) => p.kind === "tz" && p.lotId === run.direct_lot_id)) return null;
  const ids = run.ids_ever.length > 0 ? run.ids_ever : run.booking_ids;
  if (ids.length === 0) return null;
  const { data, error } = await t.sb.from("bookings").select("location_timezone, lot_snapshot").in("id", ids).abortSignal(dbSignal());
  if (error) {
    t.errors++;
    t.dbError("run zone read", `${run.direct_lot_id}: ${error.code ?? "?"} ${error.message}`);
    return null;
  }
  const zones = new Set<string>();
  for (const b of (data ?? []) as Array<{ location_timezone: string | null; lot_snapshot: { timezone?: unknown } | null }>) {
    const snap = b.lot_snapshot && typeof b.lot_snapshot.timezone === "string" ? b.lot_snapshot.timezone : null;
    if (b.location_timezone && snap && b.location_timezone !== snap) return null;
    const z = b.location_timezone ?? snap;
    if (!isValidTimeZone(z)) return null;
    zones.add(z);
  }
  return zones.size === 1 ? [...zones][0] : null;
}

async function recover(t: Tick): Promise<void> {
  // Wide enough for "manifest date ≥ lot-local today − 1" in every US zone; filtered per lot below.
  const floor = shiftIsoDate(calendarDayIn("UTC", new Date(t.nowMs)), -2);
  const { data, error } = await t.sb
    .from(MANIFEST_RUNS_TABLE)
    .select(RUN_COLS)
    .eq("livemode", t.livemode)
    .in("status", ["sending", "sent"])
    .gte("manifest_date", floor)
    .order("manifest_date")
    .limit(RECOVERY_LIMIT)
    .abortSignal(dbSignal());
  if (error) {
    t.count("error");
    t.dbError("recovery read", `${error.code ?? "?"} ${error.message}`);
    return;
  }
  for (const run of (data ?? []) as RunRow[]) {
    const key = runKey(run.direct_lot_id, run.manifest_date, run.livemode, run.recipients_hash);
    if (t.handled.has(key)) continue;
    t.handled.add(key);
    const zone = await zoneForRun(t, run);
    if (!zone) {
      report(["no-zone", run.direct_lot_id], `Direct lot manifest: no agreed zone for lot ${run.direct_lot_id}; run ${run.manifest_date} ${run.recipients_hash} not recovered this tick`, "warning");
      t.count("no_zone");
      continue;
    }
    const { localDate, localMinutes } = lotWallClock(zone, t.nowMs);
    if (run.manifest_date < shiftIsoDate(localDate, -1)) continue;
    if (run.status === "sent") {
      t.count(await followUpAndCheck(t, run, "sent"));
      continue;
    }
    if (!isStale(run, t.nowMs)) {
      t.count("in_flight");
      continue;
    }
    if (pastCutoff(run.manifest_date, localDate, localMinutes)) {
      // Possibly delivered: mark it so BEFORE the follow-up, then check it off.
      const taken = await casRun(t, run, leaseOf(run), { claimed_at: iso(), had_unknown: true, last_error: CUTOFF_REASON });
      t.count(taken.kind === "ok" ? await followUpAndCheck(t, taken.run, "no_more_sends", CUTOFF_REASON) : casOutcome(taken, "error"));
      continue;
    }
    if (!t.hasSendBudget()) {
      t.count("out_of_budget");
      continue;
    }
    const taken = await casRun(t, run, leaseOf(run), { claimed_at: iso() });
    t.count(taken.kind === "ok" ? await attemptSend(t, taken.run, zone) : casOutcome(taken, "error"));
  }
}

// ---------------------------------------------------------------------------
// Force (§3.5)

async function forceRuns(t: Tick, lotId: string, date: string): Promise<{ refused?: string; status: number; runs: Array<{ recipientsHash: string; outcome: RunOutcome }> }> {
  const zone = t.schedule.zones.get(lotId);
  if (!zone) return { refused: "unknown lot, or its zone is in dispute", status: 404, runs: [] };
  const { localDate, localMinutes } = lotWallClock(zone, t.nowMs);
  if (pastCutoff(date, localDate, localMinutes)) return { refused: "past the cutoff (12:00 lot time on the manifest date)", status: 409, runs: [] };
  const { data, error } = await t.sb
    .from(MANIFEST_RUNS_TABLE)
    .select(RUN_COLS)
    .eq("direct_lot_id", lotId)
    .eq("manifest_date", date)
    .eq("livemode", t.livemode)
    .abortSignal(dbSignal());
  if (error) {
    t.count("error");
    t.dbError("force read", `${lotId} ${date}: ${error.code ?? "?"} ${error.message}`);
    return { refused: "run read failed", status: 500, runs: [] };
  }
  const runs = (data ?? []) as RunRow[];
  if (runs.length === 0) return { refused: "no manifest run for this lot and date", status: 404, runs: [] };
  let groups: ManifestGroup[];
  try {
    groups = await groupsFor(t, lotId, date);
  } catch (err) {
    t.count("error");
    t.dbError("force select", `${lotId} ${date}: ${err instanceof Error ? err.message : String(err)}`);
    return { refused: "booking read failed", status: 500, runs: [] };
  }
  const out: Array<{ recipientsHash: string; outcome: RunOutcome }> = [];
  for (const run of runs) {
    t.handled.add(runKey(lotId, date, t.livemode, run.recipients_hash));
    const record = (outcome: RunOutcome) => {
      t.count(outcome);
      out.push({ recipientsHash: run.recipients_hash, outcome });
    };
    if (run.status !== "checked" && run.status !== "failed") {
      record("not_forceable");
      continue;
    }
    const group = groups.find((g) => g.hash === run.recipients_hash);
    if (!group) {
      record("nothing_to_list");
      continue;
    }
    const to = resolveLotRecipients(t.livemode, group.recipients);
    if (!to || to.to.length === 0) {
      record("no_recipients");
      continue;
    }
    if (!t.hasSendBudget()) {
      record("out_of_budget");
      continue;
    }
    const now = iso();
    // A deliberate new attempt under a NEW key with a fresh list; ids_ever keeps growing.
    const next = await casRun(t, run, leaseOf(run), {
      attempt: run.attempt + 1,
      status: "sending",
      claimed_at: now,
      attempt_claimed_at: now,
      booking_ids: group.rows.map((r) => r.bookingId),
      had_unknown: false,
      sent_at: null,
      email_id: null,
      last_error: null,
      recipients: to.to,
      test: to.test,
    });
    record(next.kind === "ok" ? await attemptSend(t, next.run, zone) : casOutcome(next, "error"));
  }
  return { status: 200, runs: out };
}

// ---------------------------------------------------------------------------
// Entry

export interface ManifestCronOptions {
  supabase: AdminClient;
  livemode: boolean;
  nowMs: number;
  /** Wall-clock (Date.now()) deadline; no send starts without SEND_RESERVE_MS left. */
  deadlineMs: number;
  dry: boolean;
  /** DIRECT_LOT_MANIFEST_DISABLED: no NEW manifests (recovery and follow-ups still run). */
  disabled: boolean;
  /** `?lot&date` — with `force` a forced re-send (§3.5); with `dry` the preview target. */
  target: { lotId: string; date: string } | null;
  force: boolean;
}

/** Merged per (lot, kind): one alert subject each. */
function mergeProblems(problems: LotProblem[]): LotProblem[] {
  const byKey = new Map<string, LotProblem>();
  for (const p of problems) {
    const key = `${p.lotId}:${p.kind}`;
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...prev, detail: `${prev.detail}; ${p.detail}`.slice(0, 500) } : p);
  }
  return [...byKey.values()];
}

/** One tick. Throws only when the schedule cannot be read (the route reports it). */
export async function runManifestCron(opts: ManifestCronOptions): Promise<ManifestCronResult> {
  const { supabase, livemode, nowMs, deadlineMs, dry, disabled, target, force } = opts;
  const schedule = await readManifestSchedule(supabase, livemode, nowMs);
  const t = new Tick(supabase, livemode, nowMs, deadlineMs, schedule);
  const problems = mergeProblems(schedule.problems);
  const lots = schedule.lots.map((d) => ({
    lotId: d.lotId,
    timezone: d.timezone,
    localDate: d.localDate,
    localMinutes: d.localMinutes,
    manifestDate: d.manifestDate,
    hasBookingsTomorrow: d.hasBookingsTomorrow,
    expectsManifest: d.expectsManifest,
    inWindow: inSendWindow(d.localMinutes),
  }));
  const result = (extra: Partial<ManifestCronResult> = {}): ManifestCronResult => {
    const status = extra.status ?? (t.errors > 0 ? 500 : 200);
    return {
      ok: t.errors === 0 && status < 400,
      status,
      livemode,
      dry,
      disabled,
      lots,
      problems,
      runs: t.runs,
      followUps: t.followUps,
      errors: t.errors,
      budgetExhausted: t.budgetExhausted,
      ...extra,
    };
  };

  if (dry) {
    const manifests: DryManifest[] = [];
    const targetZone = target ? schedule.zones.get(target.lotId) : undefined;
    const targets = target
      ? targetZone
        ? [{ lotId: target.lotId, date: target.date, zone: targetZone }]
        : []
      : schedule.lots
          .filter((d) => inSendWindow(d.localMinutes) && d.expectsManifest)
          .map((d) => ({ lotId: d.lotId, date: d.manifestDate, zone: d.timezone }));
    for (const { lotId, date, zone } of targets) {
      let groups: ManifestGroup[];
      try {
        groups = await groupsFor(t, lotId, date);
      } catch (err) {
        t.count("error");
        t.dbError("dry select", `${lotId} ${date}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const g of groups) {
        const to = resolveLotRecipients(livemode, g.recipients);
        const email = renderManifest({
          lotName: lotNameFor(t, lotId, g.rows),
          manifestDate: date,
          rows: g.rows,
          asOfMinutes: lotWallClock(zone, nowMs).localMinutes,
          test: to?.test ?? !livemode,
        });
        manifests.push({
          lotId,
          manifestDate: date,
          recipientsHash: g.hash,
          to: to?.to ?? null,
          test: to?.test ?? null,
          bookings: g.rows.map((r) => r.number),
          ...email,
        });
      }
    }
    return result({ manifests });
  }

  for (const p of problems) {
    await upsertAlert(t, `${p.lotId}:${p.kind}`, "lot_config", { lotId: p.lotId, problem: p.kind, reason: redact(p.detail) });
  }

  let forceResult: ManifestCronResult["force"];
  let forceStatus: number | undefined;
  if (force && target) {
    if (disabled) {
      forceResult = { refused: "DIRECT_LOT_MANIFEST_DISABLED is set — no new manifests", runs: [] };
      forceStatus = 409;
    } else {
      const f = await forceRuns(t, target.lotId, target.date);
      forceResult = { refused: f.refused, runs: f.runs };
      if (f.status !== 200) forceStatus = f.status;
    }
  } else if (!disabled) {
    for (const day of schedule.lots) {
      if (!inSendWindow(day.localMinutes) || !day.expectsManifest) continue;
      let groups: ManifestGroup[];
      try {
        groups = await groupsFor(t, day.lotId, day.manifestDate);
      } catch (err) {
        t.count("error");
        t.dbError("select", `${day.lotId} ${day.manifestDate}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const g of groups) t.count(await claimGroup(t, day.lotId, day.manifestDate, day.timezone, g));
    }
  }

  await recover(t);
  return result({ ...(forceResult ? { force: forceResult } : {}), ...(forceStatus ? { status: forceStatus } : {}) });
}
