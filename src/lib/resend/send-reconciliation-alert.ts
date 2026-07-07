import { resend, FROM_EMAIL } from "./client";
import { ADMIN_EMAILS } from "@/config/admin";
import type { AnomalyReport } from "@/lib/accounting/detect-payment-anomalies";

// Escape every data-derived value before interpolating into the HTML email.
// Customer email (and Stripe passthrough fields) reach the admins' inboxes —
// an unescaped value could inject markup/phishing content there.
const esc = (s: string) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Emails the admin list when the daily reconciliation finds a payment→booking
 * anomaly. Email (not just Sentry) is deliberate: the July 2026 incident showed
 * Sentry alone wasn't watched — this lands in the same inbox as booking
 * notifications.
 */
export async function sendReconciliationAlert(report: AnomalyReport) {
  const row = (cells: string[]) =>
    `<tr>${cells
      .map(
        (c) =>
          `<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;">${c}</td>`
      )
      .join("")}</tr>`;

  const orphanRows = report.orphans
    .map((o) =>
      row([
        esc(o.createdISO.replace("T", " ").slice(0, 16)),
        `<strong style="color:#dc2626;">${usd(o.amount)}</strong>`,
        esc(o.email) || "—",
        esc(o.method),
        o.disputed ? "⚠️ disputed" : "",
        `<code style="font-size:11px;">${esc(o.paymentIntentId)}</code>`,
      ])
    )
    .join("");

  const doubleRows = report.doubleCharges
    .map((d) =>
      row([
        esc(d.email) || "—",
        `${d.charges} charges / ${d.bookings} booking(s)`,
        d.amounts.map(usd).join(", "),
        `${d.spanMinutes} min`,
        `<code style="font-size:11px;">${d.paymentIntentIds.map(esc).join("<br>")}</code>`,
      ])
    )
    .join("");

  const manualRows = report.possibleManualCharges
    .map((o) =>
      row([
        esc(o.createdISO.replace("T", " ").slice(0, 16)),
        usd(o.amount),
        esc(o.email) || "—",
        esc(o.method),
        `<code style="font-size:11px;">${esc(o.paymentIntentId)}</code>`,
      ])
    )
    .join("");

  const modeBanner = report.stripeLivemode
    ? ""
    : `<div style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:8px 12px;margin-bottom:16px;font-size:12px;color:#854d0e;">TEST-mode Stripe data (this ran on a non-production environment).</div>`;

  // Subject reflects whatever categories are non-empty (avoids a misleading
  // "0 orphan(s)" when the trigger was a new unmatched charge).
  const parts: string[] = [];
  if (report.orphans.length) parts.push(`${report.orphans.length} orphan(s)`);
  if (report.doubleCharges.length) parts.push(`${report.doubleCharges.length} double-charge(s)`);
  if (report.possibleManualCharges.length)
    parts.push(`${report.possibleManualCharges.length} unmatched charge(s)`);
  const subject = `🚨 Payment reconciliation: ${parts.join(", ") || "review needed"}`;

  const table = (heading: string, headers: string[], body: string) =>
    body
      ? `<h2 style="font-size:16px;margin:20px 0 8px;">${heading}</h2>
         <table style="width:100%;border-collapse:collapse;">
           <tr>${headers
             .map(
               (h) =>
                 `<th style="text-align:left;padding:8px 10px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase;">${h}</th>`
             )
             .join("")}</tr>
           ${body}
         </table>`
      : "";

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: ADMIN_EMAILS,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;color:#111827;">
        <div style="background:#1A1A2E;padding:24px 32px;border-radius:12px 12px 0 0;">
          <h1 style="margin:0;color:#f87356;font-size:22px;">Triply — Payment Reconciliation Alert</h1>
          <p style="margin:6px 0 0;color:#94a3b8;font-size:13px;">Last ${report.windowDays} days · ${report.scannedPaymentIntents} PaymentIntents scanned · ${report.succeededRetained} succeeded &amp; retained</p>
        </div>
        <div style="padding:28px 32px;background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px;">
          ${modeBanner}
          <p style="font-size:14px;">The daily check found charges that don't reconcile to a booking. Each needs manual triage — refund the customer or create the missing reservation.</p>
          ${table("Orphan charges — paid, NO booking (" + report.orphans.length + ")", ["Created", "Amount", "Email", "Method", "", "PaymentIntent"], orphanRows)}
          ${table("Double-charges — more charges than bookings (" + report.doubleCharges.length + ")", ["Email", "Charges/Bookings", "Amounts", "Span", "PaymentIntents"], doubleRows)}
          ${table("Unmatched charges — no booking, no checkout metadata (" + report.possibleManualCharges.length + ")", ["Created", "Amount", "Email", "Method", "PaymentIntent"], manualRows)}
          <p style="font-size:12px;color:#6b7280;margin-top:12px;">"Unmatched" are usually manual Stripe Payment Links (e.g. reservation extensions), not bugs — but verify any you don't recognize, since a real orphan missing metadata would land here too.</p>
          <div style="margin-top:24px;">
            <a href="https://dashboard.stripe.com/payments" style="display:inline-block;background:#f87356;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 24px;border-radius:8px;">Open Stripe Payments</a>
          </div>
        </div>
      </div>
    `,
  });

  if (error) throw new Error(`Reconciliation alert email failed: ${error.message}`);
  return { emailId: data?.id };
}

/**
 * Emails the admin list when the monitor itself FAILED to run (crash, timeout,
 * zero-scan misconfig). A monitor whose failure is silent gives false
 * confidence — this makes "the safety net is down" a loud, human-visible event,
 * not just an unwatched 500 in the cron logs.
 */
export async function sendMonitorFailureAlert(reason: string) {
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: ADMIN_EMAILS,
    subject: "🚨 Triply payment monitor FAILED to run",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
        <h2 style="color:#dc2626;">Payment reconciliation monitor failed</h2>
        <p style="font-size:14px;">The daily payment→booking reconciliation did not complete, so <strong>charges were NOT checked against bookings today</strong>. This isn't itself an anomaly, but the safety net is down until it runs clean again — don't read the absence of an alert as "payments healthy."</p>
        <p style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px;font-size:13px;">${esc(reason)}</p>
        <p style="font-size:13px;color:#6b7280;">Check Vercel cron logs + Sentry for <code>/api/cron/reconcile-payments</code>.</p>
      </div>
    `,
  });
  if (error) throw new Error(`Monitor failure alert email failed: ${error.message}`);
}
