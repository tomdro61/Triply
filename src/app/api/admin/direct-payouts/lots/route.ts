/**
 * GET /api/admin/direct-payouts/lots — every direct lot (sellable or not), for
 * the payout section's lot picker.
 */
import { NextResponse } from "next/server";
import { fetchDirectLots } from "@/lib/direct/store";
import { requireAdmin } from "@/lib/direct/payout-admin";
import { captureAPIError } from "@/lib/sentry";

export async function GET() {
  try {
    const admin = await requireAdmin();
    if (!admin.ok) return admin.response;
    const r = await fetchDirectLots({}, "/api/admin/direct-payouts/lots");
    // fetchDirectLots reports its own failures to Sentry.
    if (!r.ok) return NextResponse.json({ error: "Lots unavailable — try again" }, { status: 503 });
    return NextResponse.json(
      { lots: r.lots.map((l) => ({ id: String(l.payloadId), name: l.name })), dropped: r.dropped },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    captureAPIError(err instanceof Error ? err : new Error(String(err)), { endpoint: "/api/admin/direct-payouts/lots", method: "GET" });
    return NextResponse.json({ error: "Lots unavailable — see Sentry for details" }, { status: 500 });
  }
}
