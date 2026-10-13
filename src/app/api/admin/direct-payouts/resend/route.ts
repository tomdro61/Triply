/**
 * POST /api/admin/direct-payouts/resend { lot, month }
 *
 * Sends the statement email of an already-paid month again (Phase 6a). Each
 * call is a new attempt with its own Resend idempotency key — a deliberate
 * re-send, so the page warns when the statement was already emailed.
 */
import { NextRequest, NextResponse } from "next/server";
import { captureAPIError } from "@/lib/sentry";
import { createAdminClient } from "@/lib/supabase/server";
import { stripeKeyIsLive } from "@/lib/cancellation/source-guard";
import { sendStatementEmail } from "@/lib/direct/payout-email";
import { lotMonthSchema, requireAdmin, requireLot, badRequest } from "@/lib/direct/payout-admin";

export const maxDuration = 30; // the email step: reads, a 10 s send, a stamp

const DB_TIMEOUT_MS = 3_000;

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = lotMonthSchema.safeParse(raw);
  if (!parsed.success) return badRequest(parsed.error);
  const { lot, month } = parsed.data;
  const livemode = stripeKeyIsLive();

  try {
    const admin = await requireAdmin();
    if (!admin.ok) return admin.response;
    const lotInfo = await requireLot(lot);
    if (!lotInfo.ok) return lotInfo.response;

    const supabase = await createAdminClient();
    const { data, error } = await supabase
      .from("direct_lot_statements")
      .select("id")
      .eq("direct_lot_id", lot)
      .eq("period_month", `${month}-01`)
      .eq("livemode", livemode)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS))
      .maybeSingle<{ id: string }>();
    if (error) throw new Error(`statement read failed: ${error.message}`);
    if (!data) return NextResponse.json({ error: "This month has not been marked paid." }, { status: 404 });

    const email = await sendStatementEmail(data.id, lotInfo.value);
    return NextResponse.json({ statementId: data.id, email });
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), {
      endpoint: "/api/admin/direct-payouts/resend",
      method: "POST",
      extra: { lot, month, livemode },
    });
    return NextResponse.json({ error: "Re-send failed — see Sentry for details" }, { status: 500 });
  }
}
