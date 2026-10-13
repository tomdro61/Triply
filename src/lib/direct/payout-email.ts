import { createAdminClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend/client";
import { escapeHtml } from "@/lib/validation/schemas";
import { captureDirectLotStatement } from "@/lib/sentry";
import { bounded, BoundedTimeoutError } from "@/lib/utils/bounded";
import { resolveLotRecipients } from "./lot-notice";
import { lotStatementCsv, type PaidLineRow } from "./payout-csv";

/**
 * The payout statement email to a direct lot (Phase 6a, plan §3). Sent AFTER
 * the month is marked paid, as its own retryable step: the ledger is the
 * record, the email only tells the lot about it.
 *
 * RECIPIENTS — the lot's billing inbox for a live statement on the production
 * deployment; the override inbox with "[TEST]" everywhere else (the same rule
 * as the lot notices, `resolveLotRecipients`). The billing-email CMS field
 * (plan Q12) does not exist yet, so a production statement is marked paid but
 * NOT emailed, and the admin page says so.
 *
 * ONE EMAIL PER ATTEMPT — each send claims the next `statement_attempts`
 * value with a compare-and-set, and that number is part of the Resend
 * idempotency key: two concurrent sends cannot share an attempt (the loser
 * gets "busy"), and every completed claim is a new email. The key only covers
 * the SDK's own retry; the page's busy guard and confirm prevent repeats.
 */

/** Lot billing inboxes — none until the CMS field exists (plan Q12). */
const BILLING_EMAILS_NOT_YET_IN_CMS: string[] = [];

const SEND_TIMEOUT_MS = 10_000;
const DB_TIMEOUT_MS = 3_000;
const LINE_PAGE = 1_000;

export type StatementEmailResult =
  | { outcome: "sent"; emailId: string | null; to: string[]; test: boolean }
  /** Nothing was sent and nothing was claimed. */
  | { outcome: "skipped"; reason: string }
  /** Another send claimed this attempt first. */
  | { outcome: "busy"; reason: string }
  | { outcome: "failed"; reason: string }
  /** No answer from Resend in time — it may have been delivered. */
  | { outcome: "unknown"; reason: string };

interface StatementRow {
  id: string;
  direct_lot_id: string;
  period_month: string;
  livemode: boolean;
  total_cents: number | string;
  statement_attempts: number;
}

interface LineRow {
  reservation_number: string;
  kind: "payout" | "adjustment";
  amount_cents: number | string;
  decision: "auto" | "manual";
  basis: Record<string, unknown>;
  note: string | null;
  decided_by: string | null;
}

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>;

/** Every line of one paid statement (paged: PostgREST returns at most 1,000 rows per request). */
export async function readStatementLines(supabase: AdminClient, statementId: string): Promise<PaidLineRow[]> {
  const rows: LineRow[] = [];
  for (let from = 0; ; from += LINE_PAGE) {
    const { data, error } = await supabase
      .from("direct_lot_payout_lines")
      .select("reservation_number, kind, amount_cents, decision, basis, note, decided_by")
      .eq("statement_id", statementId)
      .order("reservation_number", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + LINE_PAGE - 1)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS))
      .returns<LineRow[]>();
    if (error) throw new Error(`statement lines read failed: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < LINE_PAGE) break;
  }
  return rows.map((l) => {
    const amount = Number(l.amount_cents); // BIGINT may arrive as a string
    if (!Number.isSafeInteger(amount)) throw new Error(`line amount unreadable for ${l.reservation_number}`);
    return { ...l, amount_cents: amount };
  });
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** "October 2026" from a date-only "2026-10-01" — calendar formatting, no wall clock involved. */
const monthLabel = (periodMonth: string) =>
  new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${periodMonth}T00:00:00Z`));

function statementEmail(lotName: string, periodMonth: string, totalCents: number, lineCount: number, test: boolean) {
  const prefix = test ? "[TEST] " : "";
  const period = monthLabel(periodMonth);
  const subject = `${prefix}Triply payout statement — ${lotName} — ${period}`;
  // A negative month (claw-backs only) is a balance the lot owes: shown as a positive amount under that label.
  const totalLabel = totalCents < 0 ? "Net balance owed to Triply" : "Amount paid";
  const rows: Array<[string, string]> = [
    ["Lot", lotName],
    ["Period (check-out month)", period],
    ["Lines", String(lineCount)],
    [totalLabel, usd(Math.abs(totalCents))],
  ];
  const html = `<div style="font-family:Arial,sans-serif;color:#1e293b">
<p>${escapeHtml(prefix)}Here is Triply's payout statement for ${escapeHtml(lotName)}, ${escapeHtml(period)}.</p>
<table style="border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b">${escapeHtml(k)}</td><td style="padding:4px 0"><strong>${escapeHtml(v)}</strong></td></tr>`)
    .join("")}</table>
<p>The attached CSV lists every booking on this statement. Questions: reply to this email.</p>
</div>`;
  const text = `${prefix}Triply payout statement for ${lotName}, ${period}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nThe attached CSV lists every booking on this statement.`;
  return { subject, html, text };
}

export async function sendStatementEmail(statementId: string, lotName: string): Promise<StatementEmailResult> {
  const report = (outcome: "skipped" | "failed" | "unknown", reason: string) =>
    captureDirectLotStatement(new Error(`Direct lot statement ${statementId}: ${reason}`), { statementId, outcome });

  const supabase = await createAdminClient();
  const { data: st, error: stError } = await supabase
    .from("direct_lot_statements")
    .select("id, direct_lot_id, period_month, livemode, total_cents, statement_attempts")
    .eq("id", statementId)
    .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS))
    .maybeSingle<StatementRow>();
  if (stError) throw new Error(`statement read failed: ${stError.message}`);
  if (!st) throw new Error(`statement ${statementId} not found`);

  const recipients = resolveLotRecipients(st.livemode, BILLING_EMAILS_NOT_YET_IN_CMS);
  if (!recipients) {
    const reason = "DIRECT_LOT_NOTICE_OVERRIDE_TO is not set — a non-production statement was not sent";
    report("skipped", reason);
    return { outcome: "skipped", reason };
  }
  if (recipients.to.length === 0) {
    const reason = "the lot has no billing email on file yet (CMS field pending) — statement not emailed";
    report("skipped", reason);
    return { outcome: "skipped", reason };
  }

  const lines = await readStatementLines(supabase, statementId);
  const totalCents = Number(st.total_cents);
  if (!Number.isSafeInteger(totalCents)) throw new Error("statement total unreadable");
  if (lines.length === 0) throw new Error("statement has no lines");

  // Claim the next attempt (compare-and-set): two concurrent sends cannot share a number.
  const attempt = st.statement_attempts + 1;
  const { data: claimed, error: claimError } = await supabase
    .from("direct_lot_statements")
    .update({ statement_attempts: attempt })
    .eq("id", statementId)
    .eq("statement_attempts", st.statement_attempts)
    .select("statement_attempts")
    .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS))
    .maybeSingle();
  if (claimError) throw new Error(`attempt claim failed: ${claimError.message}`);
  if (!claimed) return { outcome: "busy", reason: "another send of this statement started first — reload" };

  const { subject, html, text } = statementEmail(lotName, st.period_month, totalCents, lines.length, recipients.test);
  const csv = lotStatementCsv(lines, totalCents);
  const mode = st.livemode ? "live" : "test";
  let sent: Awaited<ReturnType<typeof resend.emails.send>>;
  try {
    sent = await bounded(
      resend.emails.send(
        {
          from: FROM_EMAIL,
          to: recipients.to,
          subject,
          html,
          text,
          attachments: [{ filename: `triply-statement-${st.direct_lot_id}-${st.period_month.slice(0, 7)}.csv`, content: Buffer.from(csv, "utf8") }],
        },
        { idempotencyKey: `direct-lot-statement/${st.direct_lot_id}/${st.period_month.slice(0, 7)}/${mode}/${attempt}` }
      ),
      SEND_TIMEOUT_MS,
      "Resend"
    );
  } catch (err) {
    if (err instanceof BoundedTimeoutError) {
      const reason = `${err.message} — the statement may have been delivered; check the inbox before re-sending`;
      report("unknown", reason);
      return { outcome: "unknown", reason };
    }
    const reason = `send threw: ${err instanceof Error ? err.message : String(err)}`;
    report("failed", reason);
    return { outcome: "failed", reason };
  }
  const { data, error } = sent;
  if (error) {
    // A 5xx, an unreadable reply, or a 409 about the idempotency key (the same key in flight, or reused
    // with another body) says nothing about whether the lot got an email.
    const unknown =
      error.name === "application_error" ||
      error.name === "internal_server_error" ||
      error.name === "concurrent_idempotent_requests" ||
      error.name === "invalid_idempotent_request" ||
      error.statusCode == null ||
      error.statusCode >= 500;
    const reason = unknown
      ? `Resend outcome unknown (${error.name}) — check the inbox before re-sending`
      : `Resend refused the statement (${error.name}: ${error.message})`;
    report(unknown ? "unknown" : "failed", reason);
    return { outcome: unknown ? "unknown" : "failed", reason };
  }
  const emailId = data?.id ?? null;
  if (emailId) {
    const { error: stampError } = await supabase
      .from("direct_lot_statements")
      .update({ statement_email_id: emailId })
      .eq("id", statementId)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    if (stampError) report("failed", `sent (Resend ${emailId}) but statement_email_id was not stamped: ${stampError.message}`);
  }
  return { outcome: "sent", emailId, to: recipients.to, test: recipients.test };
}
