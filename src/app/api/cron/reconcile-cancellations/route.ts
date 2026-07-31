import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { captureAPIError } from "@/lib/sentry";
import { reconcileStuckCancellations } from "@/lib/cancellation/reconcile";

// Recovery cron for self-service cancellations interrupted mid-teardown (a stuck
// refund, or an ambiguous ResLab cancel). Runs on its OWN schedule + 60s budget
// (see vercel.json) so a ResLab-driven slowdown of recovery can never starve the
// daily payment-orphan monitor (reconcile-payments). Mutating but idempotent —
// the shared finalize core + the selfcancel:<pi> Stripe key + a per-row atomic
// re-claim make re-running safe.
//
// Monitor discipline: a run that leaves work unfinished — anything stalled or
// leaked, OR a CAPPED backlog it couldn't fully drain — MUST be loud (Sentry
// capture + flush before returning). Silence == a clean, fully-drained run only.
//
// Auth: Vercel injects `Authorization: Bearer <CRON_SECRET>`; refuse without it.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Stop the row loop this far into the 60s budget, leaving headroom for the
// in-flight row to finish + the Sentry flush + the response.
const RECOVERY_BUDGET_MS = 45_000;

const CTX = {
  endpoint: "/api/cron/reconcile-cancellations",
  method: "GET" as const,
};

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let report;
  try {
    report = await reconcileStuckCancellations(
      Date.now(),
      Date.now() + RECOVERY_BUDGET_MS,
    );
  } catch (error) {
    // The recovery sweep itself failed (e.g. the scan errored). Fail LOUD — a
    // broken recovery must never look like a clean run.
    captureAPIError(error instanceof Error ? error : new Error(String(error)), CTX);
    await Sentry.flush(2000);
    return NextResponse.json(
      { ok: false, error: "cancel reconciliation crashed" },
      { status: 500 },
    );
  }

  const needsAttention =
    report.stalled.length > 0 || report.leakedClaims > 0 || report.capped;
  if (needsAttention) {
    captureAPIError(
      new Error(
        `Cancel reconciliation: recovered ${report.recovered}, ${report.stalled.length} stalled, ${report.leakedClaims} leaked claim(s)` +
          (report.capped ? " — CAPPED (backlog exceeds one run's capacity)" : "") +
          (report.stalled.length > 0
            ? `. Stalled: ${report.stalled
                .map((s) => `${s.reservationNumber}[${s.cancelState}]=${s.reason}`)
                .join(", ")}`
            : ""),
      ),
      CTX,
    );
  }
  // Flush whenever recovery ran OR needs attention: a RECOVERED row may have
  // queued its own Sentry events (Park Guard / email / terminal-write sub-
  // failures) that would otherwise be dropped when the serverless function
  // freezes right after the response.
  if (report.recovered > 0 || needsAttention) {
    await Sentry.flush(2000);
  }

  return NextResponse.json({ ok: true, ...report });
}
