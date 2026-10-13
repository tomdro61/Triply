import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { fetchDirectLot } from "./store";
import { MONTH_PATTERN } from "./payout-statement";

/**
 * Shared steps of the direct-payout admin routes (Phase 6a): the admin check
 * (`getUser()` + `isAdminEmail`, as /api/admin/accounting) and the lot lookup.
 * Each returns either its value or the response to send.
 */

export const lotMonthSchema = z.object({
  // CMS payload id, as stored in bookings.direct_lot_id.
  lot: z.string().regex(/^[1-9]\d{0,8}$/, "must be a lot id"),
  month: z.string().regex(MONTH_PATTERN, "must be YYYY-MM"),
});

export type Gate<T> = { ok: true; value: T } | { ok: false; response: NextResponse };

export async function requireAdmin(): Promise<Gate<{ email: string }>> {
  const authClient = await createClient();
  const {
    data: { user },
  } = await authClient.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!user.email || !isAdminEmail(user.email)) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true, value: { email: user.email } };
}

export async function requireLot(lotId: string): Promise<Gate<{ name: string; timezone: string }>> {
  const r = await fetchDirectLot(Number(lotId));
  if (r.status === "found") return { ok: true, value: { name: r.lot.name, timezone: r.lot.timezone } };
  if (r.status === "not_found") return { ok: false, response: NextResponse.json({ error: "No such lot" }, { status: 404 }) };
  // A broken CMS row or an unreachable store is never "no such lot".
  return { ok: false, response: NextResponse.json({ error: "Lot details unavailable — try again" }, { status: 503 }) };
}

export const badRequest = (error: z.ZodError) =>
  NextResponse.json({ error: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
