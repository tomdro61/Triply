import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { detectPaymentAnomalies } from "@/lib/accounting/detect-payment-anomalies";
import {
  sendReconciliationAlert,
  sendMonitorFailureAlert,
} from "@/lib/resend/send-reconciliation-alert";
import { captureAPIError } from "@/lib/sentry";
import { isSnapshotEnabled, readSnapshotMeta, SNAPSHOT_MAX_AGE_MS } from "@/lib/reslab/location-snapshot";

// Daily payment→booking reconciliation (Vercel Cron — see vercel.json).
// Read-only: scans recent Stripe charges vs bookings and EMAILS the admins if
// any charge lacks a booking (orphan) or a customer holds more charges than
// bookings (double-charge). The standing safety net so a "charged but no
// booking" gap is caught within a day instead of via a chargeback.
//
// Design rule for a MONITOR: its FAILURE must never look like its HEALTHY
// state. Every failure path here is LOUD — it emails the admins (the watched
// channel) and flushes Sentry before returning, and reports a non-ok/500 so
// Vercel cron-failure alerting can fire. Silence == a clean run only.
//
// Vercel runs crons only against Production, where STRIPE_SECRET_KEY is LIVE.
// Auth: Vercel injects `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET
// is set; the route refuses to run without it.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const WINDOW_DAYS = 14;
// A no-metadata retained charge alerts only while fresh, so a real orphan that
// happens to lack `lotId` is caught promptly without a persistent manual
// Payment Link re-alerting every day for the whole window.
const RECENT_UNMATCHED_MS = 2 * 24 * 60 * 60 * 1000;

// Sentry.flush can itself reject (a throwing flush hook, an aborted transport);
// a telemetry fault must never convert a healthy run into an unhandled 500.
const safeFlush = () => Sentry.flush(2000).catch(() => {});

const CTX = { endpoint: "/api/cron/reconcile-payments", method: "GET" as const };

// Loud escalation for a monitor-health failure: Sentry (flushed) + admin email
// (best-effort) + 500. Serverless can freeze the function right after the
// response, so flush before returning or the "loud" fallback stays silent.
async function escalateFailure(reason: string) {
  captureAPIError(new Error(reason), CTX);
  try {
    await sendMonitorFailureAlert(reason);
  } catch (e) {
    captureAPIError(e instanceof Error ? e : new Error(String(e)), CTX);
  }
  await safeFlush();
  return NextResponse.json({ ok: false, error: reason }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let report;
  try {
    report = await detectPaymentAnomalies(WINDOW_DAYS);
  } catch (error) {
    return escalateFailure(
      `Payment monitor crashed before completing — charges were NOT verified: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // Zero-scan blind spot: a live prod account cannot have 0 charges over a
  // 2-week window. Zero means a misconfigured/rotated key, wrong mode, or a
  // degraded Stripe API — the monitor checked nothing. Escalate, don't green.
  if (report.stripeLivemode && report.scannedPaymentIntents === 0) {
    return escalateFailure(
      "Payment monitor scanned 0 live PaymentIntents over the window — likely a misconfigured Stripe key or degraded API. Charges were NOT verified."
    );
  }

  const now = Date.now();
  const freshUnmatched = report.possibleManualCharges.filter(
    (c) => now - Date.parse(c.createdISO) < RECENT_UNMATCHED_MS
  ).length;
  const alertCount =
    report.orphans.length +
    report.doubleCharges.length +
    report.duplicateBookings.length +
    freshUnmatched;

  if (alertCount > 0) {
    captureAPIError(
      new Error(
        `Payment reconciliation: ${report.orphans.length} orphan(s) + ${report.doubleCharges.length} double-charge(s) + ${report.duplicateBookings.length} duplicate-cart booking(s) + ${freshUnmatched} new unmatched charge(s) in ${WINDOW_DAYS}d`
      ),
      CTX
    );
    try {
      await sendReconciliationAlert(report);
    } catch (emailErr) {
      // The run that matters most just failed to notify. Fail LOUD: Sentry +
      // flush + 500 — never report ok when the obligated alert didn't send.
      captureAPIError(emailErr instanceof Error ? emailErr : new Error(String(emailErr)), CTX);
      await safeFlush();
      return NextResponse.json(
        { ok: false, error: "anomalies found but alert email failed", anomalies: alertCount },
        { status: 500 }
      );
    }
    await safeFlush();
  } else if (process.env.HEARTBEAT_URL) {
    // Optional external dead-man's-switch: ping a cron monitor on a clean run
    // so the cron NOT running at all (which never reaches this code) trips an
    // external alert. Best-effort — a failed ping must not fail the run.
    try {
      await fetch(process.env.HEARTBEAT_URL, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      /* heartbeat is best-effort */
    }
  }

  // Daily heartbeat (AFTER the payment alert so it can never delay or affect it) for the shared ResLab location snapshot (plan v3 §6): the
  // refresh cron reports its own failures, but only a run that HAPPENS can
  // report — a cron that stopped being invoked reports nothing. This runs
  // once a day regardless, so "the snapshot is > 24 h old" is a deterministic,
  // once-a-day, genuinely-new Sentry event. Never affects the payment report.
  if (isSnapshotEnabled()) {
    try {
      const meta = await readSnapshotMeta();
      const problem =
        meta.kind === "none"
          ? "no snapshot row — the refresh cron has never succeeded"
          : meta.kind === "error"
            ? `snapshot unreadable: ${meta.message}`
            : now - meta.builtAtMs > SNAPSHOT_MAX_AGE_MS
              ? `snapshot is ${Math.round((now - meta.builtAtMs) / 3_600_000)} h old — the refresh cron has not succeeded in over a day; search is on per-instance sweeps`
              : null;
      if (problem) {
        captureAPIError(new Error(`ResLab location snapshot: ${problem}`), { ...CTX, stage: "snapshot_heartbeat" });
        // A once-a-day dead-man's switch is the one event here that must not be
        // lost to a frozen function — flush like every other alert in this file.
        await safeFlush();
      }
    } catch (heartbeatErr) {
      captureAPIError(heartbeatErr instanceof Error ? heartbeatErr : new Error(String(heartbeatErr)), { ...CTX, stage: "snapshot_heartbeat" });
      await safeFlush();
    }
  }

  return NextResponse.json({
    ok: true,
    anomalies: alertCount,
    orphans: report.orphans.length,
    doubleCharges: report.doubleCharges.length,
    duplicateBookings: report.duplicateBookings.length,
    freshUnmatched,
    possibleManualCharges: report.possibleManualCharges.length,
    invoicePayments: report.invoicePayments,
    scanned: report.scannedPaymentIntents,
    windowDays: WINDOW_DAYS,
    stripeLivemode: report.stripeLivemode,
  });
}
