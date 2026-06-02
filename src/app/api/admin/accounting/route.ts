/**
 * GET /api/admin/accounting
 *
 * Returns the revenue reconciliation breakdown for a date range:
 *   ?from=2026-05-01&to=2026-05-31&by=checkout&invoice=1608.88
 *
 * Defaults:
 *   - from / to: previous calendar month
 *   - by:        created   (matches /admin dashboard; pass ?by=checkout to
 *                            reconcile against a ResLab invoice — invoices
 *                            group by trip-completion month)
 *   - invoice:   0         (no comparison)
 *
 * Admin-gated. Runs ResLab API calls in parallel (concurrency 5). For a
 * typical month (~30 bookings) the call returns in ~5-10s; budget up to
 * the maxDuration below.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail } from "@/config/admin";
import { captureAPIError } from "@/lib/sentry";
import { reconcileRevenue } from "@/lib/accounting/reconcile";

export const maxDuration = 60; // ResLab fetch latency budget

function previousMonth(): { from: string; to: string } {
  const now = new Date();
  // Date.UTC(y, m, 0) where m is the current month (0-indexed) gives the
  // last day of the previous month — JS Date's "day 0 = day -1 of next
  // month" overflow. Correctly handles year boundaries (Jan 1 → Dec 31).
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const y = last.getUTCFullYear();
  const m = String(last.getUTCMonth() + 1).padStart(2, "0");
  const d = String(last.getUTCDate()).padStart(2, "0");
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}

// Strict ISO date — rejects "2026-13-32" and similar nonsense. `from > to`
// comparison below is string-lexicographic which is correct for
// zero-padded YYYY-MM-DD.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && s === d.toISOString().slice(0, 10);
  }, "must be a real calendar date");

const querySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    by: z.enum(["created", "checkout", "checkin"]),
    // Decimal only — Number("0xff") would pass z.coerce.number(), so use a regex.
    invoice: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/, "must be a decimal number")
      .transform((s) => parseFloat(s))
      .optional(),
    reslab: z.enum(["0", "1"]).optional(),
    stripe: z.enum(["0", "1"]).optional(),
  })
  .refine((q) => q.from <= q.to, { message: "from must be ≤ to" });

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const defaults = previousMonth();

  // Build a structured input then parse — Zod gives one canonical 400 path.
  const parsed = querySchema.safeParse({
    from: params.get("from") ?? defaults.from,
    to: params.get("to") ?? defaults.to,
    // Default to `created` for general reporting (matches the /admin
    // dashboard). Pass `by=checkout` when reconciling against a ResLab
    // invoice — invoices group by trip-completion month.
    by: params.get("by") ?? "created",
    invoice: params.get("invoice") ?? undefined,
    reslab: params.get("reslab") ?? undefined,
    stripe: params.get("stripe") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
      { status: 400 }
    );
  }

  const { from, to, by, invoice, reslab, stripe } = parsed.data;
  const includeReslab = reslab !== "0";
  const includeStripe = stripe !== "0";
  const invoiceAmount = invoice ?? 0;

  try {
    const authClient = await createClient();
    const {
      data: { user },
    } = await authClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!isAdminEmail(user.email)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const result = await reconcileRevenue({
      from,
      to,
      by,
      invoiceAmount,
      includeReslab,
      includeStripe,
    });

    return NextResponse.json(result);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    // Tag the query so Sentry triage doesn't require log spelunking.
    Sentry.withScope((scope) => {
      scope.setContext("accounting_query", { from, to, by, invoiceAmount, includeReslab, includeStripe });
      captureAPIError(e, { endpoint: "/api/admin/accounting", method: "GET" });
    });
    // Don't leak internal infra error messages to the client. Sentry has the detail.
    return NextResponse.json(
      { error: "Accounting query failed — see Sentry for details" },
      { status: 500 }
    );
  }
}
