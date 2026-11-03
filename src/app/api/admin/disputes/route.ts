/**
 * GET /api/admin/disputes — the dispute ledger (migration 045/046) for
 * /admin/disputes, plus Radar early fraud warnings. Open disputes first,
 * nearest deadline first. `?mode=live|test|all` (default live): staging and
 * production share one database.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { captureAPIError } from "@/lib/sentry";
import { createAdminClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/direct/payout-admin";

const modeSchema = z.enum(["live", "test", "all"]);

export async function GET(request: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return gate.response;

  const mode = modeSchema.safeParse(request.nextUrl.searchParams.get("mode") ?? "live");
  if (!mode.success) return NextResponse.json({ error: "mode must be one of: live, test, all" }, { status: 400 });

  try {
    const supabase = await createAdminClient();
    let disputes = supabase
      .from("disputes")
      .select(
        "stripe_dispute_id, booking_id, amount_cents, currency, reason, status, evidence_due_by, livemode, evidence_drafted_at, evidence_draft_error, outcome, closed_at, submitted_at, submitted_by, created_at, bookings(reslab_reservation_number, location_name, check_in)"
      )
      .order("created_at", { ascending: false })
      .limit(200);
    let warnings = supabase
      .from("fraud_warnings")
      .select("stripe_warning_id, charge_id, booking_id, fraud_type, actionable, livemode, created_at, bookings(reslab_reservation_number, status)")
      .order("created_at", { ascending: false })
      .limit(50);
    if (mode.data !== "all") {
      disputes = disputes.eq("livemode", mode.data === "live");
      warnings = warnings.eq("livemode", mode.data === "live");
    }

    const [d, w] = await Promise.all([disputes, warnings]);
    if (d.error) throw new Error(`disputes: ${d.error.message}`);
    // Warnings are secondary: a missing table (046 not applied) must not hide disputes.
    const warningError = w.error ? w.error.message : null;
    if (w.error) captureAPIError(new Error(`fraud_warnings: ${w.error.message}`), { endpoint: "/api/admin/disputes", method: "GET" });

    return NextResponse.json({ disputes: d.data ?? [], warnings: w.data ?? [], warningError });
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), { endpoint: "/api/admin/disputes", method: "GET" });
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load disputes" }, { status: 500 });
  }
}
