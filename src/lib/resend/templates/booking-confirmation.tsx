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
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.triplypro.com";
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(confirmationNumber)}`;
  const directionsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lotAddress)}`;

  return (
    <div style={{ fontFamily: "Inter, Arial, sans-serif", maxWidth: "600px", margin: "0 auto", padding: "20px", backgroundColor: "#ffffff" }}>
      {/* Header with Triply + Powered by Reservations Lab */}
      <div style={{ display: "flex", marginBottom: "30px", borderBottom: "2px solid #f87356", paddingBottom: "15px" }}>
        <table style={{ width: "100%" }}>
          <tbody>
            <tr>
              <td style={{ textAlign: "left" }}>
                <h1 style={{ color: "#f87356", fontSize: "28px", margin: "0" }}>Triply</h1>
                <p style={{ color: "#64748b", fontSize: "12px", margin: "2px 0 0" }}>Your Trip Simplified</p>
              </td>
              <td style={{ textAlign: "right", verticalAlign: "middle" }}>
                <img
                  src={`${appUrl}/reslab-logo.png`}
                  alt="Powered by Reservations Lab"
                  width="120"
                  height="auto"
                  style={{ maxWidth: "120px" }}
                />
                <p style={{ color: "#94a3b8", fontSize: "10px", margin: "2px 0 0" }}>Powered by Reservations Lab</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Confirmation Banner */}
      <div style={{ backgroundColor: "#ecfdf5", border: "1px solid #10b981", borderRadius: "8px", padding: "20px", textAlign: "center", marginBottom: "24px" }}>
        <h2 style={{ color: "#065f46", margin: "0 0 5px", fontSize: "22px" }}>Your reservation is confirmed.</h2>
      </div>

      {/* QR Code + Reservation Info */}
      <div style={{ textAlign: "center", marginBottom: "24px" }}>
        <table style={{ margin: "0 auto" }}>
          <tbody>
            <tr>
              <td style={{ verticalAlign: "top", paddingRight: "20px" }}>
                <img
                  src={qrCodeUrl}
                  alt={`QR Code for reservation ${confirmationNumber}`}
                  width="150"
                  height="150"
                  style={{ border: "1px solid #e2e8f0", borderRadius: "4px" }}
                />
              </td>
              <td style={{ verticalAlign: "middle", textAlign: "left" }}>
                <p style={{ color: "#64748b", fontSize: "12px", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "1px" }}>Reservation #:</p>
                <p style={{ color: "#f87356", fontSize: "22px", fontWeight: "700", margin: "0 0 12px" }}>{confirmationNumber}</p>
                <p style={{ color: "#64748b", fontSize: "12px", margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "1px" }}>Your Reservation Receipt</p>
                <p style={{ color: "#1e293b", fontSize: "16px", fontWeight: "600", margin: "0" }}>{customerName}</p>
              </td>
            </tr>
          </tbody>
        </table>
        <p style={{ color: "#64748b", fontSize: "12px", margin: "10px 0 0" }}>
          Scan this QR code at the entrance gate for quick check-in
        </p>
      </div>

      {/* Parking Location Information */}
      <div style={{ backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "20px", marginBottom: "20px" }}>
        <h3 style={{ color: "#1e293b", margin: "0 0 12px", fontSize: "16px", fontWeight: "700" }}>Parking Location Information</h3>
        <p style={{ color: "#1e293b", fontSize: "15px", fontWeight: "600", margin: "0 0 4px" }}>{lotName}</p>
        <p style={{ color: "#64748b", fontSize: "14px", margin: "0 0 8px" }}>
          <a href={directionsUrl} style={{ color: "#f87356", textDecoration: "underline" }}>{lotAddress}</a>
        </p>
        {shuttlePhone && (
          <p style={{ color: "#1e293b", fontSize: "14px", margin: "0 0 4px" }}>
            <strong>Shuttle Pickup Phone:</strong>{" "}
            <a href={`tel:${shuttlePhone}`} style={{ color: "#f87356" }}>{shuttlePhone}</a>
          </p>
        )}
        <p style={{ margin: "8px 0 0" }}>
          <a href={directionsUrl} style={{ color: "#f87356", fontSize: "14px", textDecoration: "none", fontWeight: "600" }}>
            Get Driving Directions →
          </a>
        </p>
      </div>

      {/* Booking Details */}
      <div style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "20px", marginBottom: "20px" }}>
        <h3 style={{ color: "#1e293b", margin: "0 0 12px", fontSize: "16px", fontWeight: "700" }}>Reservation Details</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <td style={{ padding: "8px 0", color: "#64748b", fontSize: "14px" }}>Check-in</td>
              <td style={{ padding: "8px 0", color: "#1e293b", fontSize: "14px", textAlign: "right", fontWeight: "600" }}>
                {formatDate(checkInDate)} at {checkInTime}
              </td>
            </tr>
            <tr>
              <td style={{ padding: "8px 0", color: "#64748b", fontSize: "14px" }}>Check-out</td>
              <td style={{ padding: "8px 0", color: "#1e293b", fontSize: "14px", textAlign: "right", fontWeight: "600" }}>
                {formatDate(checkOutDate)} at {checkOutTime}
              </td>
            </tr>
            {vehicleInfo && (
              <tr>
                <td style={{ padding: "8px 0", color: "#64748b", fontSize: "14px" }}>Vehicle</td>
                <td style={{ padding: "8px 0", color: "#1e293b", fontSize: "14px", textAlign: "right", fontWeight: "600" }}>
                  {vehicleInfo}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Payment Summary */}
      <div style={{ backgroundColor: "#fff7ed", border: "1px solid #f87356", borderRadius: "8px", padding: "20px", marginBottom: "20px" }}>
        <h3 style={{ color: "#1e293b", margin: "0 0 12px", fontSize: "16px", fontWeight: "700" }}>Payment Summary</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {dueAtLocation && dueAtLocation > 0 ? (
              <>
                <tr>
                  <td style={{ padding: "8px 0", color: "#1e293b", fontSize: "14px" }}>Paid Online</td>
                  <td style={{ padding: "8px 0", color: "#1e293b", fontSize: "14px", textAlign: "right", fontWeight: "600" }}>
                    ${(totalAmount - dueAtLocation).toFixed(2)}
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "8px 0", color: "#64748b", fontSize: "14px" }}>Due at Location</td>
                  <td style={{ padding: "8px 0", color: "#64748b", fontSize: "14px", textAlign: "right" }}>
                    ${dueAtLocation.toFixed(2)}
                  </td>
                </tr>
                <tr>
                  <td style={{ padding: "8px 0", color: "#1e293b", fontSize: "16px", fontWeight: "700", borderTop: "1px solid #e2e8f0" }}>Total</td>
                  <td style={{ padding: "8px 0", color: "#f87356", fontSize: "20px", textAlign: "right", fontWeight: "700", borderTop: "1px solid #e2e8f0" }}>
                    ${totalAmount.toFixed(2)}
                  </td>
                </tr>
              </>
            ) : (
              <tr>
                <td style={{ padding: "8px 0", color: "#1e293b", fontSize: "16px", fontWeight: "700" }}>Total Paid</td>
                <td style={{ padding: "8px 0", color: "#f87356", fontSize: "20px", textAlign: "right", fontWeight: "700" }}>
                  ${totalAmount.toFixed(2)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* What's Next */}
      <div style={{ marginBottom: "24px" }}>
        <h3 style={{ color: "#1e293b", margin: "0 0 12px", fontSize: "16px", fontWeight: "700" }}>What to Expect</h3>
        <ol style={{ color: "#1e293b", fontSize: "14px", lineHeight: "2", paddingLeft: "20px", margin: "0" }}>
          <li>On your check-in date, drive to the parking facility</li>
          <li>At the entrance, scan your QR code or provide your confirmation number</li>
          <li>Park your vehicle in the designated area</li>
          <li>Take the shuttle to the airport terminal{shuttlePhone ? ` (call ${shuttlePhone} for pickup)` : ""}</li>
          <li>When you return, call for shuttle pickup and retrieve your vehicle</li>
        </ol>
      </div>

      {/* Cancellation Policy */}
      <div style={{ backgroundColor: "#fef3c7", border: "1px solid #f59e0b", borderRadius: "8px", padding: "16px", marginBottom: "24px" }}>
        <h4 style={{ color: "#92400e", margin: "0 0 6px", fontSize: "14px", fontWeight: "700" }}>Cancellation Policy</h4>
        <p style={{ color: "#92400e", margin: "0", fontSize: "13px", lineHeight: "1.5" }}>
          Free cancellation up to 24 hours before your check-in date. Cancellations made within 24 hours of check-in may be subject to fees.
          To cancel or modify your reservation, visit your{" "}
          <a href={`${appUrl}/confirmation/${confirmationNumber}`} style={{ color: "#92400e", fontWeight: "600" }}>booking details</a>.
        </p>
      </div>

      {/* View Booking Button */}
      <div style={{ textAlign: "center", marginBottom: "30px" }}>
        <a
          href={`${appUrl}/confirmation/${confirmationNumber}`}
          style={{
            display: "inline-block",
            backgroundColor: "#f87356",
            color: "#ffffff",
            padding: "14px 28px",
            borderRadius: "8px",
            textDecoration: "none",
            fontWeight: "600",
            fontSize: "16px",
          }}
        >
          View Booking Details
        </a>
      </div>

      {/* Help Section */}
      <div style={{ backgroundColor: "#f8fafc", borderRadius: "8px", padding: "16px", marginBottom: "20px" }}>
        <h4 style={{ color: "#1e293b", margin: "0 0 8px", fontSize: "14px" }}>Need Help?</h4>
        <p style={{ color: "#64748b", margin: "0", fontSize: "13px", lineHeight: "1.6" }}>
          If you have questions about your reservation, visit our{" "}
          <a href={`${appUrl}/help`} style={{ color: "#f87356" }}>Help Center</a>{" "}
          or contact us at{" "}
          <a href={`${appUrl}/contact`} style={{ color: "#f87356" }}>triplypro.com/contact</a>.
        </p>
      </div>

      {/* Footer */}
      <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "20px", textAlign: "center" }}>
        <p style={{ color: "#64748b", fontSize: "12px", margin: "0 0 5px" }}>
          Triply - Your Trip Simplified
        </p>
        <p style={{ color: "#94a3b8", fontSize: "11px", margin: "0" }}>
          This email was sent because you made a reservation on triplypro.com.
          <br />
          &copy; {new Date().getFullYear()} Triply. All rights reserved.
        </p>
      </div>
    </div>
  );
}
