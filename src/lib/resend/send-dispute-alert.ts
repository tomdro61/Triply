import { resend, FROM_EMAIL } from "./client";
import { PAYMENT_ALERT_EMAILS } from "@/config/admin";
import type { Playbook } from "@/lib/disputes/evidence";

// Every data-derived value is escaped: dispute and booking fields come from
// Stripe and customer input.
const esc = (s: string) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

export type DisputeAlert = {
  disputeId: string;
  amountCents: number;
  reason: string;
  /** ISO timestamp of Stripe's evidence deadline, or null if Stripe gave none. */
  dueByISO: string | null;
  livemode: boolean;
  confirmationNumber: string | null;
  customerEmail: string | null;
  lot: string | null;
  checkIn: string | null;
  playbook: Playbook;
  draftSaved: boolean;
  draftError: string | null;
};

const dashboardUrl = (id: string, livemode: boolean) =>
  `https://dashboard.stripe.com/${livemode ? "" : "test/"}disputes/${encodeURIComponent(id)}`;

/**
 * Emails the payment-alert list the moment a dispute opens. Sentry alone was
 * the only signal before, and nobody watches it day to day — a missed
 * deadline is an automatic loss.
 */
export async function sendDisputeOpenedAlert(a: DisputeAlert) {
  const due = a.dueByISO ? a.dueByISO.slice(0, 10) : "unknown — check Stripe";
  const rows: [string, string][] = [
    ["Amount", `$${(a.amountCents / 100).toFixed(2)}`],
    ["Reason", `${esc(a.playbook.label)} <span style="color:#6b7280;">(${esc(a.reason)})</span>`],
    ["Respond by", `<strong style="color:#dc2626;">${esc(due)}</strong>`],
    ["Booking", a.confirmationNumber ? esc(a.confirmationNumber) : "<strong>No booking found for this charge</strong>"],
    ["Customer", a.customerEmail ? esc(a.customerEmail) : "—"],
    ["Lot", a.lot ? esc(a.lot) : "—"],
    ["Check-in", a.checkIn ? esc(a.checkIn.slice(0, 16).replace("T", " ")) : "—"],
  ];

  const draftLine = a.draftSaved
    ? "An evidence draft from the booking record is already saved on the dispute. It is <strong>not submitted</strong>."
    : a.draftError
      ? `The evidence draft could NOT be saved: ${esc(a.draftError)}. Fill the evidence in by hand.`
      : a.confirmationNumber
        ? "No evidence draft was saved on this dispute. Fill the evidence in by hand."
        : "No evidence draft was saved (no booking matched this charge). Fill the evidence in by hand.";

  const modeBanner = a.livemode
    ? ""
    : `<div style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:8px 12px;margin-bottom:16px;font-size:12px;color:#854d0e;">TEST-mode dispute.</div>`;

  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: PAYMENT_ALERT_EMAILS,
    subject: `⚠️ Dispute opened: $${(a.amountCents / 100).toFixed(2)} — respond by ${due}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111827;">
        <h2 style="color:#dc2626;margin-bottom:12px;">A customer disputed a charge</h2>
        ${modeBanner}
        <table style="width:100%;border-collapse:collapse;">
          ${rows
            .map(
              ([k, v]) =>
                `<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#6b7280;width:110px;">${k}</td><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:14px;">${v}</td></tr>`
            )
            .join("")}
        </table>
        <p style="font-size:14px;margin-top:18px;">${draftLine}</p>
        <p style="font-size:14px;margin:14px 0 6px;"><strong>Before you submit, add:</strong></p>
        <ol style="font-size:14px;margin-top:0;">${a.playbook.addByHand.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
        <p style="font-size:13px;color:#6b7280;">Stripe takes one submission per dispute. Review everything before you press Submit.</p>
        <a href="${dashboardUrl(a.disputeId, a.livemode)}" style="display:inline-block;background:#f87356;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 24px;border-radius:8px;">Open the dispute in Stripe</a>
      </div>
    `,
  });
  if (error) throw new Error(`Dispute alert email failed: ${error.message}`);
}

/** Emails the outcome when Stripe closes a dispute (won, lost, warning closed). */
export async function sendDisputeClosedAlert(a: {
  disputeId: string;
  amountCents: number;
  outcome: string;
  livemode: boolean;
  confirmationNumber: string | null;
}) {
  const won = a.outcome === "won" || a.outcome === "warning_closed";
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: PAYMENT_ALERT_EMAILS,
    subject: `${won ? "✅" : "❌"} Dispute ${a.outcome}: $${(a.amountCents / 100).toFixed(2)}${a.confirmationNumber ? ` (${a.confirmationNumber})` : ""}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827;">
        <p style="font-size:14px;">Stripe closed the dispute as <strong>${esc(a.outcome)}</strong>.</p>
        <a href="${dashboardUrl(a.disputeId, a.livemode)}" style="font-size:13px;color:#f87356;">Open in Stripe</a>
      </div>
    `,
  });
  if (error) throw new Error(`Dispute closed email failed: ${error.message}`);
}
