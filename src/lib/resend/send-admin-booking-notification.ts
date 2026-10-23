import { resend, FROM_EMAIL } from "./client";
import { ALERT_EMAILS } from "@/config/admin";
import { captureBookingError } from "@/lib/sentry";
import { escapeHtml } from "@/lib/validation/schemas";
import { formatUsd, type CostBreakdown, type CostBreakdownResult } from "@/lib/booking/cost-breakdown";
import type { AnchoredFallback } from "./anchored-fallback";
import { postToDiscord } from "@/lib/digest/discord";
import type { Embed } from "@/lib/digest/render";

interface AdminBookingNotificationParams {
  confirmationNumber: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  lotName: string;
  lotAddress: string;
  checkInDate: string;
  checkOutDate: string;
  totalAmount: number;
  dueAtLocation?: number;
  vehicleInfo?: string;
  airportCode?: string;
  // Paired: both undefined for opted-out bookings, both set when opted in.
  // The call site always passes them together via spread.
  protectionPlan?: string;
  protectionPlanPrice?: number;
  /** Direct lots only: where the booking lives ("Direct lot (Triply number …)"). */
  sourceLine?: string;
  /** Direct lots only: the declared vehicle size + at-lot estimate. */
  vehicleDeclaration?: string;
  /**
   * The cost breakdown (plan notes/2026-10-12-cost-breakdown-plan.md). When
   * `ok`, the money rows are a compact copy of the customer email's table;
   * absent or `ok: false` → the fallback rows (Total / Protection / Paid
   * Online / Due at Location).
   */
  breakdown?: CostBreakdownResult;
  /** With an `ok: false` breakdown and a known charge: what the email states instead (anchored-fallback.ts). */
  anchoredFallback?: AnchoredFallback;
}

const LABEL_TD = "padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;";
const VALUE_TD = "padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px;";

function moneyRow(label: string, value: string, valueStyle = ""): string {
  return `
              <tr>
                <td style="${LABEL_TD}">${escapeHtml(label)}</td>
                <td style="${VALUE_TD}${valueStyle}">${escapeHtml(value)}</td>
              </tr>`;
}

/** One money line, shared by the email (as a table row) and the Discord post (as a text line). */
interface MoneyLine {
  label: string;
  value: string;
  /** Email-only CSS appended to the value cell. */
  style?: string;
}

const STRONG = " color: #f87356; font-size: 16px; font-weight: 700;";
const DUE = " color: #d97706; font-weight: 600;";

/**
 * A breakdown was attempted and did not add up, but the charge is known: the
 * charge, the protection in it, the due-at-location amount only when it can
 * be stated, plus WHY the breakdown was withheld — never a total re-added from
 * the rejected parts.
 */
function anchoredFallbackLines(f: AnchoredFallback, direct: boolean): MoneyLine[] {
  const lines: MoneyLine[] = [{ label: "Charged to card", value: formatUsd(f.chargedCents), style: STRONG }];
  if (f.protection) lines.push({ label: `Parking Protection — ${f.protection.label} (incl.)`, value: formatUsd(f.protection.premiumCents) });
  const dueLabel = direct ? "Due at the lot (est.)" : "Due at location";
  if (f.due.kind === "amount") {
    lines.push({ label: dueLabel, value: formatUsd(f.due.cents), style: DUE });
  } else if (f.due.kind === "unconfirmed") {
    lines.push({ label: dueLabel, value: "Unconfirmed — check the reservation", style: DUE });
  }
  lines.push({ label: "Breakdown withheld", value: f.reason, style: " color: #6b7280;" });
  return lines;
}

/** The money lines from a cost breakdown — every amount from buildCostBreakdown, none computed here. */
function breakdownLines(b: CostBreakdown): MoneyLine[] {
  const lines: MoneyLine[] = b.lines.map((line) => ({
    label: line.label,
    value: formatUsd(line.cents, line.credit),
    style: line.credit ? " color: #15803d;" : "",
  }));
  lines.push({ label: b.totalLabel, value: formatUsd(b.totalCents), style: STRONG });
  if (b.dueAtLocationCents > 0) {
    lines.push({ label: "Paid online (card)", value: formatUsd(b.paidOnlineCents) });
    lines.push({ label: "Due at location", value: formatUsd(b.dueAtLocationCents), style: DUE });
  }
  if (b.atLot !== null) {
    lines.push({ label: `Due at the lot (est., ${b.atLot.vehicleSizeLabel})`, value: formatUsd(b.atLot.cents), style: DUE });
    if (b.tripTotalCents !== null) lines.push({ label: "Trip total (est.)", value: formatUsd(b.tripTotalCents) });
  }
  if (b.netPaidCents !== null) {
    lines.push({ label: "Refunded", value: formatUsd(b.refundedCents, true) });
    lines.push({ label: "Net paid", value: formatUsd(b.netPaidCents) });
  }
  return lines;
}

/** No breakdown attempted: Total / Protection / Paid Online / Due at Location, as before the breakdown. */
function plainLines(p: AdminBookingNotificationParams): MoneyLine[] {
  const lines: MoneyLine[] = [{ label: "Total", value: `$${p.totalAmount.toFixed(2)}`, style: STRONG }];
  // Pair the protection plan name and formatted price together so the line can
  // never half-render (name-without-price or price-without-name). Mirrors
  // booking-confirmation.tsx.
  if (p.protectionPlan && p.protectionPlanPrice != null && p.protectionPlanPrice > 0) {
    lines.push({ label: "Parking Protection", value: `${p.protectionPlan} — $${p.protectionPlanPrice.toFixed(2)}`, style: " font-weight: 600;" });
  }
  if (p.dueAtLocation && p.dueAtLocation > 0) {
    lines.push({ label: "Paid Online", value: `$${(p.totalAmount - p.dueAtLocation).toFixed(2)}` });
    lines.push({ label: "Due at Location", value: `$${p.dueAtLocation.toFixed(2)}`, style: DUE });
  }
  return lines;
}

function moneyLines(p: AdminBookingNotificationParams): MoneyLine[] {
  if (p.breakdown?.ok) return breakdownLines(p.breakdown);
  if (p.breakdown && p.anchoredFallback) return anchoredFallbackLines(p.anchoredFallback, p.sourceLine !== undefined);
  return plainLines(p);
}

// ---------------------------------------------------------------------------
// Discord (private #booking-alerts channel)
// ---------------------------------------------------------------------------

const ADMIN_BOOKINGS_URL = "https://www.triplypro.com/admin/bookings";
const DISCORD_USERNAME = "Triply Bookings";
/** A booking waits on this post (fulfilment awaits the alert), so keep it short; no retry — email is the fallback. */
const DISCORD_TIMEOUT_MS = 4_000;
const BRAND_CORAL = 0xf87356;

/**
 * Free text (customer name, lot name, labels) as plain Discord text: markdown
 * escaped so a name can't become a masked link ("[View](https://…)") or a
 * heading, whitespace collapsed to one line, clipped to Discord's limits.
 * Mentions inside an embed never ping, so "@everyone" needs nothing.
 */
function plain(text: string, max = 300): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const clipped = oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  return clipped.replace(/([\\`*_~|>[\]()])/g, "\\$1").replace(/^([#-])/, "\\$1");
}

/**
 * The alert as one Discord embed. Deliberately leaves out the customer's email,
 * phone and vehicle: the channel is private, but those are one click away in
 * the admin, so they don't need to live in Discord too.
 */
export function bookingAlertEmbed(p: AdminBookingNotificationParams): Embed {
  const where = `${plain(p.lotName)}${p.airportCode ? ` (${plain(p.airportCode, 10)})` : ""}`;
  const money = moneyLines(p).map((l) => `${plain(l.label, 120)}: **${plain(l.value, 120)}**`).join("\n");
  const fields: Embed["fields"] = [
    { name: "Location", value: p.lotAddress.trim() ? `${where}\n${plain(p.lotAddress)}` : where },
    { name: "Check-in", value: plain(p.checkInDate, 40) || "—", inline: true },
    { name: "Check-out", value: plain(p.checkOutDate, 40) || "—", inline: true },
    { name: "Money", value: money.slice(0, 1024) || "—" },
    { name: "Customer", value: plain(p.customerName, 120) || "—" },
  ];
  if (p.vehicleDeclaration) fields.push({ name: "Vehicle size", value: plain(p.vehicleDeclaration) });
  if (p.sourceLine) fields.push({ name: "Source", value: plain(p.sourceLine) });
  return {
    title: `New booking — ${plain(p.confirmationNumber, 60)}`,
    description: `[View in Dashboard](${ADMIN_BOOKINGS_URL})`,
    color: BRAND_CORAL,
    fields,
    footer: { text: "Triply booking alert · email, phone and vehicle are in the admin" },
  };
}

/**
 * The team's New Booking alert. With DISCORD_BOOKING_ALERTS_WEBHOOK_URL set it
 * is posted to the private #booking-alerts channel instead of emailed (Resend's
 * free plan caps sends at 100 a day, and these copies were a third of them).
 * When that post fails, or the variable is unset, the alert is emailed to
 * ALERT_EMAILS exactly as before — an alert is never dropped. Never throws.
 */
export async function sendAdminBookingNotification(params: AdminBookingNotificationParams) {
  const webhookUrl = (process.env.DISCORD_BOOKING_ALERTS_WEBHOOK_URL ?? "").trim();
  if (webhookUrl) {
    try {
      const res = await postToDiscord(webhookUrl, bookingAlertEmbed(params), {
        remainingBudgetMs: 0, // no retry: a booking is waiting, and email is the fallback
        username: DISCORD_USERNAME,
        timeoutMs: DISCORD_TIMEOUT_MS,
      });
      if (res.kind === "posted") return { success: true, channel: "discord" as const };
      captureBookingError(
        new Error(
          `Booking alert Discord post failed for ${params.confirmationNumber} (${res.status ?? "no response"}: ${res.body}) — emailed instead`
        ),
        { step: "checkout", airportCode: params.airportCode }
      );
    } catch (err) {
      captureBookingError(
        new Error(
          `Booking alert Discord post threw for ${params.confirmationNumber}: ${err instanceof Error ? err.message : String(err)} — emailed instead`
        ),
        { step: "checkout", airportCode: params.airportCode }
      );
    }
  }
  return emailAdminBookingNotification(params);
}

/**
 * Every customer- or lot-supplied value is HTML-escaped (the email's mailto is
 * URL-encoded): customer names, plates and makes are free text, and this email
 * goes to the team's inbox with a "View in Dashboard" link worth faking.
 */
async function emailAdminBookingNotification(params: AdminBookingNotificationParams) {
  const {
    confirmationNumber,
    customerName,
    customerEmail,
    customerPhone,
    lotName,
    lotAddress,
    checkInDate,
    checkOutDate,
    vehicleInfo,
    airportCode,
    sourceLine,
    vehicleDeclaration,
  } = params;
  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: ALERT_EMAILS,
      subject: `New Booking - ${confirmationNumber} | ${lotName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <div style="background-color: #1A1A2E; padding: 32px 40px; text-align: center;">
            <h1 style="margin: 0; color: #f87356; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Triply</h1>
            <p style="margin: 4px 0 0; color: #94a3b8; font-size: 13px;">New Reservation Received</p>
          </div>
          <div style="padding: 40px;">
            <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 16px; margin-bottom: 24px; text-align: center;">
              <p style="margin: 0; color: #065f46; font-size: 16px; font-weight: 700;">Confirmation #${escapeHtml(confirmationNumber)}</p>
            </div>

            <h2 style="margin: 0 0 16px; color: #111827; font-size: 18px; font-weight: 700;">Booking Details</h2>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px; width: 140px;">Location</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px; font-weight: 600;">${escapeHtml(lotName)}${airportCode ? ` (${escapeHtml(airportCode)})` : ""}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Address</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px;">${escapeHtml(lotAddress)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Check-in</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px; font-weight: 600;">${escapeHtml(checkInDate)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Check-out</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px; font-weight: 600;">${escapeHtml(checkOutDate)}</td>
              </tr>
              ${moneyLines(params).map((l) => moneyRow(l.label, l.value, l.style)).join("")}
            </table>

            <h2 style="margin: 0 0 16px; color: #111827; font-size: 18px; font-weight: 700;">Customer</h2>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px; width: 140px;">Name</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px; font-weight: 600;">${escapeHtml(customerName)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Email</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px;"><a href="mailto:${encodeURIComponent(customerEmail)}" style="color: #f87356; text-decoration: none;">${escapeHtml(customerEmail)}</a></td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Phone</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px;">${escapeHtml(customerPhone)}</td>
              </tr>
              ${vehicleInfo ? `
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Vehicle</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px;">${escapeHtml(vehicleInfo)}</td>
              </tr>
              ` : ""}
              ${vehicleDeclaration ? `
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Vehicle size</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px;">${escapeHtml(vehicleDeclaration)}</td>
              </tr>
              ` : ""}
              ${sourceLine ? `
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Source</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px; font-weight: 600;">${escapeHtml(sourceLine)}</td>
              </tr>
              ` : ""}
            </table>

            <div style="text-align: center;">
              <a href="https://www.triplypro.com/admin/bookings" style="display: inline-block; background-color: #f87356; color: #ffffff; text-decoration: none; font-weight: 700; font-size: 14px; padding: 12px 32px; border-radius: 8px;">View in Dashboard</a>
            </div>
          </div>
          <div style="background-color: #f9fafb; padding: 24px 40px; border-top: 1px solid #e5e7eb; text-align: center;">
            <p style="margin: 0; color: #9ca3af; font-size: 12px;">
              Triply Admin Notification<br>
              <a href="https://www.triplypro.com" style="color: #f87356; text-decoration: none;">triplypro.com</a>
            </p>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error("Failed to send admin booking notification:", error);
      captureBookingError(
        new Error(
          `Admin notification email failed for ${confirmationNumber}: ${error.message}`
        ),
        { step: "checkout", airportCode }
      );
      return { success: false, error };
    }

    return { success: true, emailId: data?.id };
  } catch (err) {
    console.error("Error sending admin booking notification:", err);
    captureBookingError(
      err instanceof Error
        ? err
        : new Error(
            `Admin notification email render failed for ${confirmationNumber}: ${String(err)}`
          ),
      { step: "checkout", airportCode }
    );
    return { success: false, error: err };
  }
}
