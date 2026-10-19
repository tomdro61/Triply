import { resend, FROM_EMAIL } from "./client";
import { ADMIN_EMAILS } from "@/config/admin";
import { captureBookingError } from "@/lib/sentry";
import { escapeHtml } from "@/lib/validation/schemas";
import { formatUsd, type CostBreakdown, type CostBreakdownResult } from "@/lib/booking/cost-breakdown";
import type { AnchoredFallback } from "./anchored-fallback";

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

/**
 * A breakdown was attempted and did not add up, but the charge is known: the
 * charge, the protection in it, the due-at-location amount only when it can
 * be stated, plus WHY the breakdown was withheld — never a total re-added from
 * the rejected parts.
 */
function anchoredFallbackRows(f: AnchoredFallback, direct: boolean): string {
  const rows = [moneyRow("Charged to card", formatUsd(f.chargedCents), " color: #f87356; font-size: 16px; font-weight: 700;")];
  if (f.protection) rows.push(moneyRow(`Parking Protection — ${f.protection.label} (incl.)`, formatUsd(f.protection.premiumCents)));
  const dueLabel = direct ? "Due at the lot (est.)" : "Due at location";
  if (f.due.kind === "amount") {
    rows.push(moneyRow(dueLabel, formatUsd(f.due.cents), " color: #d97706; font-weight: 600;"));
  } else if (f.due.kind === "unconfirmed") {
    rows.push(moneyRow(dueLabel, "Unconfirmed — check the reservation", " color: #d97706; font-weight: 600;"));
  }
  rows.push(moneyRow("Breakdown withheld", f.reason, " color: #6b7280;"));
  return rows.join("");
}

/** The money rows from a cost breakdown — every amount from buildCostBreakdown, none computed here. */
function breakdownRows(b: CostBreakdown): string {
  const rows = b.lines.map((line) => moneyRow(line.label, formatUsd(line.cents, line.credit), line.credit ? " color: #15803d;" : ""));
  const strong = " color: #f87356; font-size: 16px; font-weight: 700;";
  rows.push(moneyRow(b.totalLabel, formatUsd(b.totalCents), strong));
  if (b.dueAtLocationCents > 0) {
    rows.push(moneyRow("Paid online (card)", formatUsd(b.paidOnlineCents)));
    rows.push(moneyRow("Due at location", formatUsd(b.dueAtLocationCents), " color: #d97706; font-weight: 600;"));
  }
  if (b.atLot !== null) {
    rows.push(moneyRow(`Due at the lot (est., ${b.atLot.vehicleSizeLabel})`, formatUsd(b.atLot.cents), " color: #d97706; font-weight: 600;"));
    if (b.tripTotalCents !== null) rows.push(moneyRow("Trip total (est.)", formatUsd(b.tripTotalCents)));
  }
  if (b.netPaidCents !== null) {
    rows.push(moneyRow("Refunded", formatUsd(b.refundedCents, true)));
    rows.push(moneyRow("Net paid", formatUsd(b.netPaidCents)));
  }
  return rows.join("");
}

/**
 * Every customer- or lot-supplied value is HTML-escaped (the email's mailto is
 * URL-encoded): customer names, plates and makes are free text, and this email
 * goes to the team's inbox with a "View in Dashboard" link worth faking.
 */
export async function sendAdminBookingNotification({
  confirmationNumber,
  customerName,
  customerEmail,
  customerPhone,
  lotName,
  lotAddress,
  checkInDate,
  checkOutDate,
  totalAmount,
  dueAtLocation,
  vehicleInfo,
  airportCode,
  protectionPlan,
  protectionPlanPrice,
  sourceLine,
  vehicleDeclaration,
  breakdown,
  anchoredFallback,
}: AdminBookingNotificationParams) {
  try {
    const paidOnline = dueAtLocation ? totalAmount - dueAtLocation : totalAmount;
    // Pair the protection plan name and formatted price together so the
    // gated render block can never half-render (block-without-price or
    // price-without-block). Mirrors booking-confirmation.tsx.
    const protectionPriceText =
      !!protectionPlan && protectionPlanPrice != null && protectionPlanPrice > 0
        ? protectionPlanPrice.toFixed(2)
        : null;
    const hasProtection = protectionPriceText !== null;

    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: ADMIN_EMAILS,
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
              ${breakdown?.ok ? breakdownRows(breakdown) : breakdown && anchoredFallback ? anchoredFallbackRows(anchoredFallback, sourceLine !== undefined) : `
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Total</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #f87356; font-size: 16px; font-weight: 700;">$${totalAmount.toFixed(2)}</td>
              </tr>
              ${hasProtection ? `
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Parking Protection</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px; font-weight: 600;">${escapeHtml(protectionPlan ?? "")} — $${protectionPriceText}</td>
              </tr>
              ` : ""}
              ${dueAtLocation && dueAtLocation > 0 ? `
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Paid Online</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px;">$${paidOnline.toFixed(2)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Due at Location</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #d97706; font-size: 14px; font-weight: 600;">$${dueAtLocation.toFixed(2)}</td>
              </tr>
              ` : ""}
              `}
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
