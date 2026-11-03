import * as React from "react";
import { formatDate } from "@/lib/utils";
import { bulletLines } from "@/lib/utils/bullet-lines";
import { formatUsd, type CostBreakdown, type CostBreakdownResult } from "@/lib/booking/cost-breakdown";
import type { AnchoredFallback } from "../anchored-fallback";

/**
 * A Triply DIRECT-lot booking (4b plan §3.4). Absent for every ResLab booking,
 * which renders exactly as before. The at-lot estimate is DISPLAY ONLY: it is
 * never part of `totalAmount` (what was charged) or `dueAtLocation` (R1).
 */
export interface DirectLotEmailDetails {
  shuttlePhone?: string;
  /** "No oversized vehicle", "Large SUV / truck", … */
  vehicleSizeLabel: string;
  /** Oversized-vehicle surcharge + tax the lot collects at drop-off, in dollars; null = none. */
  atLotEstimate: number | null;
  /** Promo discount taken off the card charge, in dollars (0 = none) — its own line, as at checkout. */
  discount: number;
}

interface BookingConfirmationEmailProps {
  customerName: string;
  customerEmail: string;
  confirmationNumber: string;
  lotName: string;
  lotAddress: string;
  checkInDate: string;
  checkOutDate: string;
  checkInTime: string;
  checkOutTime: string;
  totalAmount: number;
  dueAtLocation?: number;
  vehicleInfo?: string;
  shuttlePhone?: string;
  shuttleDetails?: string;
  specialConditions?: string;
  protectionPlan?: string;
  protectionPlanPrice?: number;
  // Final PG sync state at the moment the email is composed. Drives the
  // protection callout copy — see ProtectionPlanStatus on the confirmation
  // page for the matching customer-facing variant. Permanent skip
  // (skipped_missing_data) MUST NOT render "Active" / "Start a Claim";
  // PG has no record so the claim link would 404 on them.
  pgSyncStatus?: "pending" | "synced" | "skipped_missing_data" | null;
  direct?: DirectLotEmailDetails;
  /**
   * The cost breakdown (plan notes/2026-10-12-cost-breakdown-plan.md). When
   * `ok`, the Payment Summary renders it line by line; absent or `ok: false`,
   * the fallback layout below renders from totalAmount / dueAtLocation.
   */
  breakdown?: CostBreakdownResult;
  /**
   * Set (by fulfilment) when `breakdown` is `ok: false` and the card charge is
   * known: the Payment Summary then states the charge itself — never a total
   * re-added from the parts the breakdown just rejected. Absent: the legacy
   * layout, unchanged (scripts/resend-confirmation.ts, the dev path).
   */
  anchoredFallback?: AnchoredFallback;
}

const rowCell = { padding: "3px 0", color: "#1e293b", fontSize: "14px" } as const;
const ruleCell = { padding: "10px 0 3px", color: "#1e293b", fontSize: "15px", fontWeight: "700", borderTop: "1px solid #fed7ca" } as const;
const totalCell = { padding: "10px 0 0", color: "#1e293b", fontSize: "17px", fontWeight: "700", borderTop: "1px solid #fed7ca" } as const;
const subCell = { padding: "3px 0", color: "#64748b", fontSize: "13px" } as const;

function AmountRow({ label, value, style }: { label: React.ReactNode; value: string; style: React.CSSProperties }) {
  return (
    <tr>
      <td style={style}>{label}</td>
      <td style={{ ...style, textAlign: "right" }}>{value}</td>
    </tr>
  );
}

/**
 * The fallback when a breakdown was attempted and did not add up, but the
 * card charge is known: only what can be stated — the charge, the protection
 * in it, and what is due at the location / lot when the core `fallbackDue`
 * says it can be stated (otherwise: the lot confirms it on arrival). No total.
 */
function AnchoredFallbackRows({ f, directVehicleSizeLabel }: { f: AnchoredFallback; directVehicleSizeLabel: string | null }) {
  const dueStyle = { padding: "6px 0 0", color: "#b45309", fontSize: "14px", fontWeight: "600" } as const;
  return (
    <>
      <AmountRow label="Charged to card" value={formatUsd(f.chargedCents)} style={f.due.kind !== "none" ? ruleCell : totalCell} />
      {f.protection && (
        <AmountRow label={`Includes Parking Protection — ${f.protection.label}`} value={formatUsd(f.protection.premiumCents)} style={subCell} />
      )}
      {f.due.kind === "amount" && directVehicleSizeLabel === null && (
        <AmountRow label="Due at location (as recorded)" value={formatUsd(f.due.cents)} style={dueStyle} />
      )}
      {f.due.kind === "amount" && directVehicleSizeLabel !== null && (
        <>
          <AmountRow label="Due at the lot (est.)" value={formatUsd(f.due.cents)} style={dueStyle} />
          <tr>
            <td colSpan={2} style={{ padding: "0 0 4px", color: "#64748b", fontSize: "12px", lineHeight: "1.5" }}>
              {directVehicleSizeLabel} surcharge incl. tax, paid at drop-off. The lot confirms your vehicle&rsquo;s size at the gate.
            </td>
          </tr>
        </>
      )}
      {f.due.kind === "unconfirmed" && (
        <tr>
          <td colSpan={2} style={{ padding: "6px 0 0", color: "#64748b", fontSize: "12px", lineHeight: "1.5" }}>
            The lot will confirm any amount due when you arrive. Questions?{" "}
            <a href="mailto:support@triplypro.com" style={{ color: "#f87356", textDecoration: "none" }}>support@triplypro.com</a>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The Payment Summary rows from a cost breakdown — every amount computed by
 * buildCostBreakdown, none here. ResLab: lines → Total (→ Paid online + Due at
 * location when something is due there). Direct: lines → Charged today (this
 * email is sent at booking) → Due at the lot (est.) → Trip total (est.).
 */
function BreakdownRows({ b }: { b: CostBreakdown }) {
  const cardLabel = b.totalLabel === "Charged to card" ? "Charged today" : b.totalLabel;
  const hasSecondStep = b.dueAtLocationCents > 0 || b.atLot !== null;
  return (
    <>
      {b.lines.map((line) => (
        <AmountRow
          key={line.key}
          label={line.label}
          value={formatUsd(line.cents, line.credit)}
          style={line.credit ? { ...rowCell, color: "#15803d" } : rowCell}
        />
      ))}
      <AmountRow
        label={
          cardLabel === "Charged today" ? (
            <>
              Charged today <span style={{ color: "#64748b", fontSize: "12px", fontWeight: "400" }}>(card)</span>
            </>
          ) : (
            cardLabel
          )
        }
        value={formatUsd(b.totalCents)}
        style={hasSecondStep ? ruleCell : totalCell}
      />
      {b.dueAtLocationCents > 0 && (
        <>
          <AmountRow label="Paid online (card)" value={formatUsd(b.paidOnlineCents)} style={subCell} />
          <AmountRow
            label="Due at location"
            value={formatUsd(b.dueAtLocationCents)}
            style={{ ...rowCell, color: "#b45309", fontWeight: "600" }}
          />
        </>
      )}
      {b.atLot !== null && (
        <>
          <AmountRow
            label="Due at the lot (est.)"
            value={formatUsd(b.atLot.cents)}
            style={{ padding: "6px 0 0", color: "#b45309", fontSize: "14px", fontWeight: "600" }}
          />
          <tr>
            <td colSpan={2} style={{ padding: "0 0 4px", color: "#64748b", fontSize: "12px", lineHeight: "1.5" }}>
              {b.atLot.vehicleSizeLabel} surcharge incl. tax, paid at drop-off. The lot confirms your vehicle&rsquo;s size at the gate.
            </td>
          </tr>
          {b.tripTotalCents !== null && (
            <AmountRow label="Trip total (est.)" value={formatUsd(b.tripTotalCents)} style={totalCell} />
          )}
        </>
      )}
      {b.netPaidCents !== null && (
        <>
          <AmountRow label="Refunded" value={formatUsd(b.refundedCents, true)} style={{ ...rowCell, color: "#15803d" }} />
          <AmountRow label="Net paid" value={formatUsd(b.netPaidCents)} style={totalCell} />
        </>
      )}
    </>
  );
}

// Triply-controlled redirect (next.config.mjs /claims) → Park Guard claim
// portal. Keeps the visible URL on triplypro.com in email clients (hover
// preview, copied links) so the third-party domain containing "coverage"
// never appears on customer-facing surfaces.
const PARKGUARD_CLAIM_URL = `${process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com"}/claims`;
const PARKGUARD_TERMS_URL = "https://www.parkguard.com/terms-of-use-triplypro";

export function BookingConfirmationEmail({
  customerName,
  customerEmail,
  confirmationNumber,
  lotName,
  lotAddress,
  checkInDate,
  checkOutDate,
  checkInTime,
  checkOutTime,
  totalAmount,
  dueAtLocation,
  vehicleInfo,
  shuttlePhone,
  shuttleDetails,
  specialConditions,
  protectionPlan,
  protectionPlanPrice,
  pgSyncStatus,
  direct,
  breakdown,
  anchoredFallback,
}: BookingConfirmationEmailProps) {
  // A direct lot's shuttle phone comes from its snapshot; ResLab never passes one.
  shuttlePhone = direct?.shuttlePhone ?? shuttlePhone;
  // Lot notes written as "- " lines render as a list (same rule as the lot page).
  const conditionBullets = bulletLines(specialConditions);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com";
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(confirmationNumber)}`;
  const directionsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lotAddress)}`;
  const paidOnline = dueAtLocation && dueAtLocation > 0 ? totalAmount - dueAtLocation : totalAmount;
  // The callout block and the line item must gate together — partial info
  // (block but no charge, or charge with no block) is the failure mode.
  // Compute the formatted price once so neither render site needs a non-null
  // assertion that would silently render "NaN" if the guard ever drifts.
  const protectionPriceText =
    !!protectionPlan && protectionPlanPrice != null && protectionPlanPrice > 0
      ? protectionPlanPrice.toFixed(2)
      : null;
  const hasProtection = protectionPriceText !== null;
  // "Active" requires PG to have actually acknowledged the enrollment
  // (pgSyncStatus === "synced"). Any other state — null (transient
  // outage, booking-insert failure, PG capture threw), "pending"
  // (in-flight reconciliation), or "skipped_missing_data" (permanent
  // skip on lot missing address fields) — means the claim link would
  // 404 on PG's side. Render the "Confirming" variant in all those
  // cases. Mirrors ProtectionPlanStatus on the confirmation page.
  const isProtectionConfirmed = hasProtection && pgSyncStatus === "synced";
  const isProtectionUnconfirmed = hasProtection && !isProtectionConfirmed;

  const labelStyle = {
    color: "#64748b",
    fontSize: "11px",
    margin: "0 0 4px" as const,
    textTransform: "uppercase" as const,
    letterSpacing: "1px",
  };

  return (
    <div style={{ fontFamily: "Arial, Helvetica, sans-serif", maxWidth: "600px", margin: "0 auto", backgroundColor: "#ffffff" }}>
      {/* Header */}
      <table style={{ width: "100%", padding: "20px 30px" }}>
        <tbody>
          <tr>
            <td style={{ textAlign: "left" }}>
              <span style={{ color: "#f87356", fontSize: "24px", fontWeight: "700" }}>Triply</span>
            </td>
            {!direct && (
              <td style={{ textAlign: "right", verticalAlign: "middle" }}>
                <p style={{ color: "#94a3b8", fontSize: "9px", margin: "0 0 2px", textAlign: "right" }}>Powered by</p>
                <img
                  src={`${appUrl}/reslab-logo.png`}
                  alt="Reservations Lab"
                  width="90"
                  style={{ maxWidth: "90px", height: "auto" }}
                />
              </td>
            )}
          </tr>
        </tbody>
      </table>
      <hr style={{ border: "none", borderTop: "1px solid #e9ecef", margin: "0 30px" }} />

      {/* Main Content */}
      <div style={{ padding: "24px 30px 30px" }}>

        {/* Confirmation Banner */}
        <div style={{ backgroundColor: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "8px", padding: "14px 18px", marginBottom: "20px" }}>
          <p style={{ color: "#059669", fontSize: "16px", fontWeight: "700", margin: "0 0 4px" }}>&#10003; Booking Confirmed</p>
          <p style={{ color: "#065f46", fontSize: "13px", margin: "0", lineHeight: "1.4" }}>
            Hi {customerName}, your parking reservation is confirmed. Show the QR code below at the facility entrance.
          </p>
        </div>

        {/* QR Code + Confirmation */}
        <table style={{ width: "100%", marginBottom: "24px" }}>
          <tbody>
            <tr>
              <td style={{ width: "140px", verticalAlign: "top" }}>
                <img
                  src={qrCodeUrl}
                  alt={`QR Code: ${confirmationNumber}`}
                  width="130"
                  height="130"
                  style={{ display: "block", borderRadius: "6px" }}
                />
              </td>
              <td style={{ verticalAlign: "top", paddingLeft: "16px" }}>
                <p style={labelStyle}>Confirmation</p>
                <p style={{ color: "#1e293b", fontSize: "22px", fontWeight: "700", margin: "0 0 14px", fontFamily: "monospace" }}>{confirmationNumber}</p>
                <p style={labelStyle}>Guest</p>
                <p style={{ color: "#1e293b", fontSize: "15px", fontWeight: "600", margin: "0" }}>{customerName}</p>
              </td>
            </tr>
          </tbody>
        </table>

        <hr style={{ border: "none", borderTop: "1px solid #e9ecef", margin: "0 0 24px" }} />

        {/* Location */}
        <div style={{ backgroundColor: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "8px", padding: "18px", marginBottom: "16px" }}>
          <p style={{ ...labelStyle, color: "#0369a1" }}>Parking Location</p>
          <p style={{ color: "#1e293b", fontSize: "15px", fontWeight: "600", margin: "0 0 4px" }}>{lotName}</p>
          <p style={{ color: "#64748b", fontSize: "13px", margin: "0 0 8px" }}>{lotAddress}</p>
          {shuttlePhone && (
            <p style={{ color: "#1e293b", fontSize: "13px", margin: "0 0 8px" }}>
              Shuttle: <a href={`tel:${shuttlePhone}`} style={{ color: "#f87356", textDecoration: "none", fontWeight: "600" }}>{shuttlePhone}</a>
            </p>
          )}
          <p style={{ margin: "0" }}>
            <a href={directionsUrl} style={{ color: "#0369a1", fontSize: "13px", textDecoration: "none", fontWeight: "600" }}>Get Directions &rarr;</a>
          </p>
        </div>

        {/* Special Conditions */}
        {specialConditions && (
          <div style={{ backgroundColor: "#fefce8", border: "1px solid #fde68a", borderRadius: "8px", padding: "18px", marginBottom: "16px" }}>
            <p style={{ ...labelStyle, color: "#92400e", marginBottom: "8px" }}>&#9888; Important Information</p>
            {conditionBullets ? (
              <ul style={{ color: "#78350f", fontSize: "13px", margin: "0", paddingLeft: "18px", lineHeight: "1.6" }}>
                {conditionBullets.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : (
              <p style={{ color: "#78350f", fontSize: "13px", margin: "0", lineHeight: "1.6" }}>{specialConditions}</p>
            )}
          </div>
        )}

        {/* Shuttle Instructions */}
        {shuttleDetails && (
          <div style={{ backgroundColor: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "18px", marginBottom: "16px" }}>
            <p style={{ ...labelStyle, color: "#166534", marginBottom: "8px" }}>&#128652; Shuttle Instructions</p>
            <p style={{ color: "#14532d", fontSize: "13px", margin: "0", lineHeight: "1.6" }}>{shuttleDetails}</p>
          </div>
        )}

        {/* Dates & Vehicle */}
        <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "18px", marginBottom: "16px" }}>
          <table style={{ width: "100%" }}>
            <tbody>
              <tr>
                <td style={{ width: "50%", verticalAlign: "top" }}>
                  <p style={labelStyle}>Check-in</p>
                  <p style={{ color: "#1e293b", fontSize: "14px", fontWeight: "600", margin: "0 0 2px" }}>{formatDate(checkInDate)}</p>
                  <p style={{ color: "#64748b", fontSize: "13px", margin: "0" }}>{checkInTime}</p>
                </td>
                <td style={{ width: "50%", verticalAlign: "top" }}>
                  <p style={labelStyle}>Check-out</p>
                  <p style={{ color: "#1e293b", fontSize: "14px", fontWeight: "600", margin: "0 0 2px" }}>{formatDate(checkOutDate)}</p>
                  <p style={{ color: "#64748b", fontSize: "13px", margin: "0" }}>{checkOutTime}</p>
                </td>
              </tr>
            </tbody>
          </table>
          {vehicleInfo && (
            <>
              <hr style={{ border: "none", borderTop: "1px solid #e2e8f0", margin: "14px 0" }} />
              <p style={labelStyle}>Vehicle</p>
              <p style={{ color: "#1e293b", fontSize: "14px", fontWeight: "600", margin: "0" }}>{vehicleInfo}</p>
            </>
          )}
          {direct && (
            <>
              <p style={{ ...labelStyle, marginTop: "12px" }}>Vehicle size</p>
              <p style={{ color: "#1e293b", fontSize: "14px", fontWeight: "600", margin: "0" }}>{direct.vehicleSizeLabel}</p>
            </>
          )}
        </div>

        {/* Parking Protection callout. Render variant depends on PG sync
            state — see ProtectionPlanStatus for the matching page-side copy. */}
        {isProtectionConfirmed && (
          <div style={{ backgroundColor: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: "8px", padding: "18px", marginBottom: "16px" }}>
            <p style={{ ...labelStyle, color: "#065f46", marginBottom: "8px" }}>&#128737; Parking Protection Active</p>
            <p style={{ color: "#065f46", fontSize: "13px", margin: "0 0 12px", lineHeight: "1.6" }}>
              Your booking includes the {protectionPlan} plan. If your vehicle is damaged or something is stolen while parked at the lot, file a claim through the link below.
            </p>
            <p style={{ margin: "0" }}>
              <a href={PARKGUARD_CLAIM_URL} style={{ color: "#059669", fontSize: "13px", textDecoration: "none", fontWeight: "600", marginRight: "16px" }}>Start a Claim &rarr;</a>
              <a href={PARKGUARD_TERMS_URL} style={{ color: "#475569", fontSize: "13px", textDecoration: "none", fontWeight: "600" }}>View Terms &rarr;</a>
            </p>
          </div>
        )}
        {isProtectionUnconfirmed && (
          <div style={{ backgroundColor: "#fef3c7", border: "1px solid #fcd34d", borderRadius: "8px", padding: "18px", marginBottom: "16px" }}>
            <p style={{ ...labelStyle, color: "#92400e", marginBottom: "8px" }}>&#128737; Parking Protection &mdash; Confirming</p>
            <p style={{ color: "#92400e", fontSize: "13px", margin: "0 0 12px", lineHeight: "1.6" }}>
              You purchased the {protectionPlan} plan. We&rsquo;re still confirming it with our partner &mdash; if you need to file a claim, please contact our support team and we&rsquo;ll get it sorted.
            </p>
            <p style={{ margin: "0" }}>
              <a href="mailto:support@triplypro.com" style={{ color: "#b45309", fontSize: "13px", textDecoration: "none", fontWeight: "600" }}>Contact Support &rarr;</a>
            </p>
          </div>
        )}

        {/* Payment */}
        <div style={{ backgroundColor: "#fef7f5", border: "1px solid #fed7ca", borderRadius: "8px", padding: "18px", marginBottom: "24px" }}>
          <p style={{ ...labelStyle, color: "#c2410c", marginBottom: "10px" }}>Payment Summary</p>
          <table style={{ width: "100%" }}>
            <tbody>
              {breakdown?.ok ? (
                <BreakdownRows b={breakdown} />
              ) : breakdown && anchoredFallback ? (
                <AnchoredFallbackRows f={anchoredFallback} directVehicleSizeLabel={direct ? direct.vehicleSizeLabel : null} />
              ) : direct && direct.atLotEstimate !== null && direct.atLotEstimate > 0 ? (
                <>
                  {/* Direct lot with an oversized vehicle: money changes hands
                      twice, so the card charge is "Charged today", the lot's
                      share is its own line, and the trip total is their sum —
                      the same words as checkout (order-summary). The at-lot
                      amount is display only and never part of totalAmount. */}
                  <tr>
                    <td style={{ padding: "3px 0", color: "#1e293b", fontSize: "14px" }}>Parking, fees &amp; taxes</td>
                    <td style={{ padding: "3px 0", color: "#1e293b", fontSize: "14px", textAlign: "right" }}>${(totalAmount - (protectionPriceText ? parseFloat(protectionPriceText) : 0) + direct.discount).toFixed(2)}</td>
                  </tr>
                  {direct.discount > 0 && (
                    <tr>
                      <td style={{ padding: "3px 0", color: "#15803d", fontSize: "14px" }}>Promo discount</td>
                      <td style={{ padding: "3px 0", color: "#15803d", fontSize: "14px", textAlign: "right" }}>&minus;${direct.discount.toFixed(2)}</td>
                    </tr>
                  )}
                  {hasProtection && (
                    <tr>
                      <td style={{ padding: "3px 0", color: "#1e293b", fontSize: "14px" }}>Parking Protection</td>
                      <td style={{ padding: "3px 0", color: "#1e293b", fontSize: "14px", textAlign: "right" }}>${protectionPriceText}</td>
                    </tr>
                  )}
                  <tr>
                    <td style={{ padding: "10px 0 3px", color: "#1e293b", fontSize: "15px", fontWeight: "700", borderTop: "1px solid #fed7ca" }}>Charged today <span style={{ color: "#64748b", fontSize: "12px", fontWeight: "400" }}>(card)</span></td>
                    <td style={{ padding: "10px 0 3px", color: "#1e293b", fontSize: "15px", fontWeight: "700", textAlign: "right", borderTop: "1px solid #fed7ca" }}>${totalAmount.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "6px 0 0", color: "#b45309", fontSize: "14px", fontWeight: "600" }}>Due at the lot (est.)</td>
                    <td style={{ padding: "6px 0 0", color: "#b45309", fontSize: "14px", fontWeight: "600", textAlign: "right" }}>${direct.atLotEstimate.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td colSpan={2} style={{ padding: "0 0 4px", color: "#64748b", fontSize: "12px", lineHeight: "1.5" }}>
                      {direct.vehicleSizeLabel} surcharge incl. tax, paid at drop-off. The lot confirms your vehicle&rsquo;s size at the gate.
                    </td>
                  </tr>
                  <tr>
                    <td style={{ padding: "10px 0 0", color: "#1e293b", fontSize: "17px", fontWeight: "700", borderTop: "1px solid #fed7ca" }}>Trip total (est.)</td>
                    <td style={{ padding: "10px 0 0", color: "#1e293b", fontSize: "17px", textAlign: "right", fontWeight: "700", borderTop: "1px solid #fed7ca" }}>${(Math.round((totalAmount + direct.atLotEstimate) * 100) / 100).toFixed(2)}</td>
                  </tr>
                </>
              ) : dueAtLocation && dueAtLocation > 0 ? (
                <>
                  {/* Addition-style breakdown: every line is an addend that
                      sums to Total. Subtraction-style ("Paid online incl.
                      Protection" + "Due at location") read as three addends
                      and don't reconcile against Total. */}
                  <tr>
                    <td style={{ padding: "3px 0", color: "#1e293b", fontSize: "14px" }}>Parking</td>
                    <td style={{ padding: "3px 0", color: "#1e293b", fontSize: "14px", textAlign: "right" }}>${(paidOnline - (protectionPriceText ? parseFloat(protectionPriceText) : 0)).toFixed(2)}</td>
                  </tr>
                  {hasProtection && (
                    <tr>
                      <td style={{ padding: "3px 0", color: "#1e293b", fontSize: "14px" }}>Parking Protection</td>
                      <td style={{ padding: "3px 0", color: "#1e293b", fontSize: "14px", textAlign: "right" }}>${protectionPriceText}</td>
                    </tr>
                  )}
                  <tr>
                    <td style={{ padding: "3px 0", color: "#64748b", fontSize: "13px", fontStyle: "italic" }}>(Paid online)</td>
                    <td style={{ padding: "3px 0", color: "#64748b", fontSize: "13px", textAlign: "right", fontStyle: "italic" }}>${paidOnline.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "3px 0", color: "#1e293b", fontSize: "14px" }}>Due at location</td>
                    <td style={{ padding: "3px 0", color: "#1e293b", fontSize: "14px", textAlign: "right" }}>${dueAtLocation.toFixed(2)}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: "10px 0 0", color: "#1e293b", fontSize: "17px", fontWeight: "700", borderTop: "1px solid #fed7ca" }}>Total</td>
                    <td style={{ padding: "10px 0 0", color: "#1e293b", fontSize: "17px", textAlign: "right", fontWeight: "700", borderTop: "1px solid #fed7ca" }}>${totalAmount.toFixed(2)}</td>
                  </tr>
                </>
              ) : (
                <>
                  {hasProtection && (
                    <tr>
                      <td style={{ padding: "3px 0", color: "#64748b", fontSize: "13px" }}>Parking Protection</td>
                      <td style={{ padding: "3px 0", color: "#64748b", fontSize: "13px", textAlign: "right" }}>${protectionPriceText}</td>
                    </tr>
                  )}
                  <tr>
                    <td style={{ padding: "10px 0 0", color: "#1e293b", fontSize: "17px", fontWeight: "700", borderTop: hasProtection ? "1px solid #fed7ca" : "0" }}>Total Paid</td>
                    <td style={{ padding: "10px 0 0", color: "#1e293b", fontSize: "17px", textAlign: "right", fontWeight: "700", borderTop: hasProtection ? "1px solid #fed7ca" : "0" }}>${totalAmount.toFixed(2)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* CTA Button — email param lets guest customers (not logged in) view their booking */}
        <div style={{ textAlign: "center", marginBottom: "28px" }}>
          <a
            href={`${appUrl}/confirmation/${confirmationNumber}?email=${encodeURIComponent(customerEmail)}`}
            style={{
              display: "inline-block",
              backgroundColor: "#f87356",
              color: "#ffffff",
              padding: "12px 32px",
              borderRadius: "6px",
              textDecoration: "none",
              fontWeight: "600",
              fontSize: "15px",
            }}
          >
            View Booking Details
          </a>
        </div>

        {/* What to Expect */}
        <div style={{ backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "18px", marginBottom: "24px" }}>
          <p style={{ color: "#1e293b", fontSize: "14px", fontWeight: "700", margin: "0 0 10px" }}>What to Expect</p>
          <ol style={{ color: "#475569", fontSize: "13px", lineHeight: "1.9", paddingLeft: "18px", margin: "0" }}>
            <li>Drive to the parking facility on your check-in date</li>
            <li>Scan your QR code at the entrance gate</li>
            <li>Park and take the shuttle to the terminal{shuttlePhone ? ` (${shuttlePhone})` : ""}{shuttleDetails && !shuttlePhone ? " — see shuttle instructions above" : ""}</li>
            <li>On return, call for shuttle pickup and retrieve your vehicle</li>
          </ol>
        </div>

        {/* Cancellation & Help */}
        <p style={{ color: "#64748b", fontSize: "12px", margin: "0 0 4px", lineHeight: "1.5" }}>
          <strong style={{ color: "#1e293b" }}>Cancellation:</strong> Free up to 24 hours before check-in. Late cancellations may incur fees.
        </p>
        <p style={{ color: "#64748b", fontSize: "12px", margin: "0", lineHeight: "1.5" }}>
          <strong style={{ color: "#1e293b" }}>Need help?</strong>{" "}
          <a href={`${appUrl}/help`} style={{ color: "#f87356", textDecoration: "none" }}>Help Center</a>{" | "}
          <a href={`${appUrl}/contact`} style={{ color: "#f87356", textDecoration: "none" }}>Contact Us</a>
        </p>
      </div>

      {/* Footer */}
      <hr style={{ border: "none", borderTop: "1px solid #e9ecef", margin: "0 30px" }} />
      <table style={{ width: "100%", padding: "16px 30px" }}>
        <tbody>
          <tr>
            <td style={{ textAlign: "center" }}>
              <p style={{ color: "#94a3b8", fontSize: "11px", margin: "0", lineHeight: "1.6" }}>
                &copy; {new Date().getFullYear()} Triply &middot; Your Trip Simplified
                <br />
                You received this email because you booked on triplypro.com
              </p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
