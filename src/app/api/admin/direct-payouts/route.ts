/**
 * GET /api/admin/direct-payouts?lot=1&month=2026-10[&format=csv]
 *
 * The payout statement for one direct lot and one check-out month (Phase 6a,
 * notes/2026-10-12-direct-lots-phase6-plan.md §3), in THIS deployment's Stripe
 * mode only (staging sees test rows, production live ones). `format=csv`
 * returns the internal CSV — never sent to the lot: the open rows (margin,
 * fees) for an unpaid month, the recorded ledger lines for a paid one.
 */
import { NextRequest, NextResponse } from "next/server";
import { captureAPIError } from "@/lib/sentry";
import { stripeKeyIsLive } from "@/lib/cancellation/source-guard";
import { buildStatementView } from "@/lib/direct/payout-statement";
import { internalStatementCsv, internalPaidCsv } from "@/lib/direct/payout-csv";
import { readStatementLines } from "@/lib/direct/payout-email";
import { createAdminClient } from "@/lib/supabase/server";
import { lotMonthSchema, requireAdmin, requireLot, badRequest } from "@/lib/direct/payout-admin";

export const maxDuration = 60; // one Stripe read per booking (concurrency 10)

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const parsed = lotMonthSchema.safeParse({ lot: params.get("lot"), month: params.get("month") });
  if (!parsed.success) return badRequest(parsed.error);
  const format = params.get("format");
  if (format !== null && format !== "csv") return NextResponse.json({ error: "format: must be csv" }, { status: 400 });
  const { lot, month } = parsed.data;

  try {
    const admin = await requireAdmin();
    if (!admin.ok) return admin.response;
    const lotInfo = await requireLot(lot);
    if (!lotInfo.ok) return lotInfo.response;

    const view = await buildStatementView({
      lotId: lot,
      month,
      livemode: stripeKeyIsLive(),
      lotTimezone: lotInfo.value.timezone,
      nowMs: Date.now(),
    });
    if (format === "csv") {
      const csv = view.paid
        ? internalPaidCsv(await readStatementLines(await createAdminClient(), view.paid.id), view.paid.totalCents)
        : internalStatementCsv(view.items);
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="triply-internal-${lot}-${month}${view.paid ? "-paid" : "-open"}${view.livemode ? "" : "-test"}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return NextResponse.json({ lotName: lotInfo.value.name, ...view }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), {
      endpoint: "/api/admin/direct-payouts",
      method: "GET",
      extra: { lot, month },
    });
    return NextResponse.json({ error: "Statement could not be built — see Sentry for details" }, { status: 500 });
  }
}
