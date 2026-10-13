/**
 * POST /api/admin/direct-payouts/mark-paid
 * { lot, month, viewHash, expectedTotalCents, decisions: { [piId]: {action:"pay", amountCents, note} | {action:"defer"} }, note? }
 *
 * Records that Triply paid a direct lot for one check-out month (Phase 6a,
 * plan §3; the money moves offline). The statement is REBUILT here from the
 * database and a fresh Stripe read; the request only carries what the admin
 * saw (its hash and total) and the decisions on rows that need a person. Any
 * difference — a refund landed, a booking moved — refuses with 409 and the
 * admin must reload. The ledger write is one Postgres function call (migration
 * 039): all lines or none, a month or a booking never paid twice.
 *
 * The statement email goes AFTER the write and never fails the response: the
 * payment is recorded either way, and the page offers a re-send. Time budget
 * (maxDuration 60 s, where no catch block runs): the write is refused if the
 * rebuild took over REBUILD_BUDGET_MS, and the email is skipped (send it from
 * the page) once EMAIL_CUTOFF_MS has passed.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { captureAPIError } from "@/lib/sentry";
import { createAdminClient } from "@/lib/supabase/server";
import { stripeKeyIsLive } from "@/lib/cancellation/source-guard";
import { buildStatementView } from "@/lib/direct/payout-statement";
import { buildLedgerLines, decisionSchema } from "@/lib/direct/payout-lines";
import { sendStatementEmail, type StatementEmailResult } from "@/lib/direct/payout-email";
import { lotMonthSchema, requireAdmin, requireLot, badRequest } from "@/lib/direct/payout-admin";

export const maxDuration = 60; // statement rebuild (Stripe reads) + ledger write + email

const RPC_TIMEOUT_MS = 10_000;
const REBUILD_BUDGET_MS = 25_000;
/**
 * The email step can take ~22 s (three 3 s reads, a 10 s send, a 3 s stamp):
 * started by 30 s it ends by ~52 s, inside maxDuration. Rebuild (≤ 25 s) + the
 * ledger write (≤ 10 s) can pass this, and then the email is left to the page.
 */
const EMAIL_CUTOFF_MS = 30_000;

const bodySchema = lotMonthSchema.extend({
  viewHash: z.string().regex(/^[0-9a-f]{64}$/),
  expectedTotalCents: z.number().int().safe(),
  decisions: z.record(z.string().regex(/^pi_[A-Za-z0-9_]+$/), decisionSchema),
  note: z.string().trim().max(1000).optional(),
});

const conflict = (error: string) => NextResponse.json({ error }, { status: 409 });

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return badRequest(parsed.error);
  const { lot, month, viewHash, expectedTotalCents, decisions, note } = parsed.data;
  const livemode = stripeKeyIsLive();
  const startedAt = Date.now();

  try {
    const admin = await requireAdmin();
    if (!admin.ok) return admin.response;
    const lotInfo = await requireLot(lot);
    if (!lotInfo.ok) return lotInfo.response;

    const view = await buildStatementView({ lotId: lot, month, livemode, lotTimezone: lotInfo.value.timezone, nowMs: Date.now() });
    if (Date.now() - startedAt > REBUILD_BUDGET_MS) {
      return NextResponse.json({ error: "Rebuilding the statement took too long — nothing was recorded. Try again." }, { status: 503 });
    }
    if (view.paid) return conflict("This month is already marked paid.");
    // Test mode may pay an open month so a staging walk can run on this month's test bookings.
    if (!view.monthClosed && livemode) return conflict("This month is not over yet (lot-local time).");
    if (view.blocked.length > 0) {
      return conflict(`Fix these bookings first: ${view.blocked.map((b) => `${b.reservationNumber} (${b.reason})`).join("; ")}`);
    }
    if (view.viewHash !== viewHash) return conflict("The statement changed since it was loaded (a refund or a booking change). Reload and review it again.");

    const built = buildLedgerLines(view.items, decisions);
    if (!built.ok) return NextResponse.json({ error: built.error }, { status: 422 });
    if (built.totalCents !== expectedTotalCents) {
      return conflict(`The total is ${built.totalCents} cents, not the ${expectedTotalCents} shown. Reload and review it again.`);
    }

    const supabase = await createAdminClient();
    const { data: statementId, error: rpcError } = await supabase
      .rpc("mark_direct_lot_statement_paid", {
        p_direct_lot_id: lot,
        p_period_month: `${month}-01`,
        p_livemode: livemode,
        p_total_cents: built.totalCents,
        p_lines: built.lines,
        p_paid_by: admin.value.email,
        p_note: note || null,
      })
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS));
    if (rpcError) {
      // 23505: the month, or a booking on it, was paid by a concurrent request.
      if (rpcError.code === "23505") return conflict("Already paid — this month or one of its bookings was just marked paid. Reload.");
      // TP001: a booking was cancelled, or its ledger was changed by another payment, after the rebuild.
      if (rpcError.code === "TP001") return conflict("A booking changed (a cancellation or another payment) since the statement was loaded. Reload and review it again.");
      if (rpcError.code) {
        // Any SQLSTATE / PostgREST code: the database answered and rolled the whole call back. Not a
        // race the admin can fix by reloading — a bug or a broken row, so Sentry hears of it.
        captureAPIError(new Error(`mark_direct_lot_statement_paid refused: ${rpcError.code} ${rpcError.message}`), {
          endpoint: "/api/admin/direct-payouts/mark-paid",
          method: "POST",
          stage: "ledger_write",
          code: rpcError.code,
          extra: { lot, month, livemode, details: rpcError.details ?? null, hint: rpcError.hint ?? null },
        });
        return NextResponse.json(
          { error: `The ledger refused it and nothing was recorded (${rpcError.code}: ${rpcError.message}).` },
          { status: 500 }
        );
      }
      // No code: the request itself failed (a timeout, a dropped connection) — the write MAY have committed.
      captureAPIError(new Error(`mark_direct_lot_statement_paid failed: ${rpcError.message}`), {
        endpoint: "/api/admin/direct-payouts/mark-paid",
        method: "POST",
        stage: "ledger_write",
        code: rpcError.code || undefined,
        extra: { lot, month, livemode, details: rpcError.details ?? null, hint: rpcError.hint ?? null },
      });
      return NextResponse.json(
        { error: "The payment could not be confirmed as recorded. Reload before trying again — it may already be marked paid." },
        { status: 500 }
      );
    }
    if (typeof statementId !== "string") {
      captureAPIError(new Error("mark_direct_lot_statement_paid returned no statement id"), {
        endpoint: "/api/admin/direct-payouts/mark-paid",
        method: "POST",
        stage: "ledger_write",
        extra: { lot, month, livemode },
      });
      return NextResponse.json({ error: "Recorded state unknown — reload before trying again." }, { status: 500 });
    }

    let email: StatementEmailResult;
    try {
      email =
        Date.now() - startedAt > EMAIL_CUTOFF_MS
          ? { outcome: "skipped", reason: "no time left in this request — use Send statement" }
          : await sendStatementEmail(statementId, lotInfo.value.name);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      captureAPIError(e, { endpoint: "/api/admin/direct-payouts/mark-paid", method: "POST", stage: "statement_email", extra: { statementId } });
      email = { outcome: "failed", reason: "the statement email step failed — use Re-send" };
    }
    return NextResponse.json({ statementId, totalCents: built.totalCents, lines: built.lines.length, email });
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), {
      endpoint: "/api/admin/direct-payouts/mark-paid",
      method: "POST",
      extra: { lot, month, livemode },
    });
    return NextResponse.json({ error: "Mark paid failed before anything was recorded — see Sentry for details" }, { status: 500 });
  }
}
