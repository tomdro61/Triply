import * as React from "react";
import { formatDate } from "@/lib/utils";

interface CancellationConfirmationEmailProps {
  customerName: string;
  confirmationNumber: string;
  lotName: string;
  lotAddress: string;
  checkInDate: string;
  checkOutDate: string;
  refundAmount: number;
  wasRefunded: boolean;
}

export function CancellationConfirmationEmail({
  customerName,
  confirmationNumber,
  lotName,
  lotAddress,
  checkInDate,
  checkOutDate,
  refundAmount,
  wasRefunded,
}: CancellationConfirmationEmailProps) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com";

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
          </tr>
        </tbody>
      </table>
      <hr style={{ border: "none", borderTop: "1px solid #e9ecef", margin: "0 30px" }} />

      {/* Main Content */}
      <div style={{ padding: "24px 30px 30px" }}>

        {/* Cancellation Banner */}
        <div style={{ backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "8px", padding: "14px 18px", marginBottom: "20px" }}>
          <p style={{ color: "#dc2626", fontSize: "16px", fontWeight: "700", margin: "0 0 4px" }}>Reservation Cancelled</p>
          <p style={{ color: "#991b1b", fontSize: "13px", margin: "0", lineHeight: "1.4" }}>
            Hi {customerName}, your parking reservation has been cancelled.
            {wasRefunded && " A full refund has been issued to your original payment method."}
          </p>
        </div>

        {/* Confirmation Number */}
        <div style={{ marginBottom: "24px" }}>
          <p style={labelStyle}>Confirmation Number</p>
          <p style={{ color: "#1e293b", fontSize: "22px", fontWeight: "700", margin: "0", fontFamily: "monospace" }}>{confirmationNumber}</p>
        </div>

        <hr style={{ border: "none", borderTop: "1px solid #e9ecef", margin: "0 0 24px" }} />

        {/* Cancelled Reservation Details */}
        <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "18px", marginBottom: "16px" }}>
          <p style={{ ...labelStyle, marginBottom: "10px" }}>Cancelled Reservation</p>
          <p style={{ color: "#1e293b", fontSize: "15px", fontWeight: "600", margin: "0 0 4px" }}>{lotName}</p>
          <p style={{ color: "#64748b", fontSize: "13px", margin: "0 0 12px" }}>{lotAddress}</p>
          <table style={{ width: "100%" }}>
            <tbody>
              <tr>
                <td style={{ width: "50%", verticalAlign: "top" }}>
                  <p style={labelStyle}>Check-in</p>
                  <p style={{ color: "#64748b", fontSize: "14px", margin: "0", textDecoration: "line-through" }}>{formatDate(checkInDate)}</p>
                </td>
                <td style={{ width: "50%", verticalAlign: "top" }}>
                  <p style={labelStyle}>Check-out</p>
                  <p style={{ color: "#64748b", fontSize: "14px", margin: "0", textDecoration: "line-through" }}>{formatDate(checkOutDate)}</p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Refund Info */}
        {wasRefunded && (
          <div style={{ backgroundColor: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "8px", padding: "18px", marginBottom: "16px" }}>
            <p style={{ ...labelStyle, color: "#166534", marginBottom: "10px" }}>Refund Details</p>
            <table style={{ width: "100%" }}>
              <tbody>
                <tr>
                  <td style={{ color: "#1e293b", fontSize: "15px", fontWeight: "700" }}>Refund Amount</td>
                  <td style={{ color: "#1e293b", fontSize: "15px", fontWeight: "700", textAlign: "right" }}>${refundAmount.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
            <p style={{ color: "#166534", fontSize: "12px", margin: "10px 0 0", lineHeight: "1.5" }}>
              Please allow 5-10 business days for the refund to appear on your statement, depending on your bank.
            </p>
          </div>
        )}

        {/* Rebook CTA */}
        <div style={{ textAlign: "center", margin: "28px 0" }}>
          <p style={{ color: "#475569", fontSize: "14px", margin: "0 0 16px" }}>
            Need to rebook? We're here to help.
          </p>
          <a
            href={appUrl}
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
            Search Parking
          </a>
        </div>

        {/* Help */}
        <p style={{ color: "#64748b", fontSize: "12px", margin: "0", lineHeight: "1.5" }}>
          <strong style={{ color: "#1e293b" }}>Questions about your refund?</strong>{" "}
          <a href={`${appUrl}/contact`} style={{ color: "#f87356", textDecoration: "none" }}>Contact Us</a>{" | "}
          <a href={`${appUrl}/help`} style={{ color: "#f87356", textDecoration: "none" }}>Help Center</a>
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
                You received this email because you had a booking on triplypro.com
              </p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
