import * as React from "react";

interface BookingConfirmationEmailProps {
  customerName: string;
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
}

export function BookingConfirmationEmail({
  customerName,
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
}: BookingConfirmationEmailProps) {
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com";
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(confirmationNumber)}`;
  const directionsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lotAddress)}`;
  const paidOnline = dueAtLocation && dueAtLocation > 0 ? totalAmount - dueAtLocation : totalAmount;

  return (
    <div style={{ fontFamily: "Arial, Helvetica, sans-serif", maxWidth: "600px", margin: "0 auto", backgroundColor: "#f5f5f5" }}>
      {/* Header */}
      <table style={{ width: "100%", backgroundColor: "#1A1A2E", padding: "20px 30px" }}>
        <tbody>
          <tr>
            <td style={{ textAlign: "left" }}>
              <span style={{ color: "#f87356", fontSize: "24px", fontWeight: "700" }}>Triply</span>
            </td>
            <td style={{ textAlign: "right", verticalAlign: "middle" }}>
              <img
                src={`${appUrl}/reslab-logo.png`}
                alt="Powered by Reservations Lab"
                width="100"
                style={{ maxWidth: "100px", height: "auto" }}
              />
            </td>
          </tr>
        </tbody>
      </table>

      {/* Main Content */}
      <div style={{ backgroundColor: "#ffffff", padding: "30px" }}>

        {/* Confirmation Header */}
        <p style={{ color: "#10b981", fontSize: "14px", fontWeight: "600", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "0.5px" }}>Booking Confirmed</p>
        <p style={{ color: "#1e293b", fontSize: "14px", margin: "0 0 24px", lineHeight: "1.5" }}>
          Hi {customerName}, your parking reservation is confirmed. Show the QR code below at the facility entrance.
        </p>

        {/* QR Code + Confirmation Number */}
        <table style={{ width: "100%", marginBottom: "28px" }}>
          <tbody>
            <tr>
              <td style={{ width: "140px", verticalAlign: "top" }}>
                <img
                  src={qrCodeUrl}
                  alt={`QR Code: ${confirmationNumber}`}
                  width="130"
                  height="130"
                  style={{ display: "block" }}
                />
              </td>
              <td style={{ verticalAlign: "top", paddingLeft: "16px" }}>
                <p style={{ color: "#64748b", fontSize: "11px", margin: "0 0 2px", textTransform: "uppercase", letterSpacing: "1px" }}>Confirmation</p>
                <p style={{ color: "#1e293b", fontSize: "24px", fontWeight: "700", margin: "0 0 16px", fontFamily: "monospace" }}>{confirmationNumber}</p>
                <p style={{ color: "#64748b", fontSize: "11px", margin: "0 0 2px", textTransform: "uppercase", letterSpacing: "1px" }}>Guest</p>
                <p style={{ color: "#1e293b", fontSize: "16px", fontWeight: "600", margin: "0" }}>{customerName}</p>
              </td>
            </tr>
          </tbody>
        </table>

        {/* Divider */}
        <hr style={{ border: "none", borderTop: "1px solid #e2e8f0", margin: "0 0 24px" }} />

        {/* Location */}
        <p style={{ color: "#64748b", fontSize: "11px", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "1px" }}>Parking Location</p>
        <p style={{ color: "#1e293b", fontSize: "16px", fontWeight: "600", margin: "0 0 4px" }}>{lotName}</p>
        <p style={{ color: "#64748b", fontSize: "14px", margin: "0 0 6px" }}>{lotAddress}</p>
        {shuttlePhone && (
          <p style={{ color: "#1e293b", fontSize: "14px", margin: "0 0 6px" }}>
            Shuttle: <a href={`tel:${shuttlePhone}`} style={{ color: "#f87356", textDecoration: "none" }}>{shuttlePhone}</a>
          </p>
        )}
        <p style={{ margin: "0 0 24px" }}>
          <a href={directionsUrl} style={{ color: "#f87356", fontSize: "14px", textDecoration: "none", fontWeight: "600" }}>Get Directions &rarr;</a>
        </p>

        {/* Divider */}
        <hr style={{ border: "none", borderTop: "1px solid #e2e8f0", margin: "0 0 24px" }} />

        {/* Dates + Vehicle in a simple table */}
        <table style={{ width: "100%", marginBottom: "24px" }}>
          <tbody>
            <tr>
              <td style={{ width: "50%", verticalAlign: "top" }}>
                <p style={{ color: "#64748b", fontSize: "11px", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "1px" }}>Check-in</p>
                <p style={{ color: "#1e293b", fontSize: "14px", fontWeight: "600", margin: "0 0 2px" }}>{formatDate(checkInDate)}</p>
                <p style={{ color: "#64748b", fontSize: "13px", margin: "0" }}>{checkInTime}</p>
              </td>
              <td style={{ width: "50%", verticalAlign: "top" }}>
                <p style={{ color: "#64748b", fontSize: "11px", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "1px" }}>Check-out</p>
                <p style={{ color: "#1e293b", fontSize: "14px", fontWeight: "600", margin: "0 0 2px" }}>{formatDate(checkOutDate)}</p>
                <p style={{ color: "#64748b", fontSize: "13px", margin: "0" }}>{checkOutTime}</p>
              </td>
            </tr>
          </tbody>
        </table>

        {vehicleInfo && (
          <>
            <p style={{ color: "#64748b", fontSize: "11px", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "1px" }}>Vehicle</p>
            <p style={{ color: "#1e293b", fontSize: "14px", fontWeight: "600", margin: "0 0 24px" }}>{vehicleInfo}</p>
          </>
        )}

        {/* Divider */}
        <hr style={{ border: "none", borderTop: "1px solid #e2e8f0", margin: "0 0 24px" }} />

        {/* Payment */}
        <p style={{ color: "#64748b", fontSize: "11px", margin: "0 0 12px", textTransform: "uppercase", letterSpacing: "1px" }}>Payment</p>
        <table style={{ width: "100%", marginBottom: "24px" }}>
          <tbody>
            {dueAtLocation && dueAtLocation > 0 ? (
              <>
                <tr>
                  <td style={{ padding: "4px 0", color: "#1e293b", fontSize: "14px" }}>Paid online</td>
                  <td style={{ padding: "4px 0", color: "#1e293b", fontSize: "14px", textAlign: "right" }}>${paidOnline.toFixed(2)}</td>
                </tr>
                <tr>
                  <td style={{ padding: "4px 0", color: "#64748b", fontSize: "14px" }}>Due at location</td>
                  <td style={{ padding: "4px 0", color: "#64748b", fontSize: "14px", textAlign: "right" }}>${dueAtLocation.toFixed(2)}</td>
                </tr>
                <tr>
                  <td style={{ padding: "10px 0 0", color: "#1e293b", fontSize: "18px", fontWeight: "700", borderTop: "1px solid #e2e8f0" }}>Total</td>
                  <td style={{ padding: "10px 0 0", color: "#1e293b", fontSize: "18px", textAlign: "right", fontWeight: "700", borderTop: "1px solid #e2e8f0" }}>${totalAmount.toFixed(2)}</td>
                </tr>
              </>
            ) : (
              <tr>
                <td style={{ padding: "0", color: "#1e293b", fontSize: "18px", fontWeight: "700" }}>Total Paid</td>
                <td style={{ padding: "0", color: "#1e293b", fontSize: "18px", textAlign: "right", fontWeight: "700" }}>${totalAmount.toFixed(2)}</td>
              </tr>
            )}
          </tbody>
        </table>

        {/* CTA Button */}
        <div style={{ textAlign: "center", marginBottom: "28px" }}>
          <a
            href={`${appUrl}/confirmation/${confirmationNumber}`}
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
        <div style={{ backgroundColor: "#f8fafc", borderRadius: "6px", padding: "20px", marginBottom: "20px" }}>
          <p style={{ color: "#1e293b", fontSize: "14px", fontWeight: "700", margin: "0 0 10px" }}>What to Expect</p>
          <ol style={{ color: "#475569", fontSize: "13px", lineHeight: "1.9", paddingLeft: "18px", margin: "0" }}>
            <li>Drive to the parking facility on your check-in date</li>
            <li>Scan your QR code at the entrance gate</li>
            <li>Park and take the shuttle to the terminal{shuttlePhone ? ` (${shuttlePhone})` : ""}</li>
            <li>On return, call for shuttle pickup and retrieve your vehicle</li>
          </ol>
        </div>

        {/* Cancellation */}
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
      <table style={{ width: "100%", padding: "20px 30px" }}>
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
