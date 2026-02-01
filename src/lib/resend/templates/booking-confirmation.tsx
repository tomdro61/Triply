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

  return (
    <div style={{ fontFamily: "Inter, Arial, sans-serif", maxWidth: "600px", margin: "0 auto", padding: "20px" }}>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: "30px" }}>
        <h1 style={{ color: "#f87356", fontSize: "28px", margin: "0" }}>Triply</h1>
        <p style={{ color: "#64748b", fontSize: "14px", margin: "5px 0 0" }}>Your Trip Simplified</p>
      </div>

      {/* Success Banner */}
      <div style={{ backgroundColor: "#ecfdf5", border: "1px solid #10b981", borderRadius: "8px", padding: "20px", textAlign: "center", marginBottom: "30px" }}>
        <div style={{ fontSize: "48px", marginBottom: "10px" }}>✓</div>
        <h2 style={{ color: "#065f46", margin: "0 0 5px", fontSize: "22px" }}>Booking Confirmed!</h2>
        <p style={{ color: "#047857", margin: "0", fontSize: "14px" }}>
          Confirmation #{confirmationNumber}
        </p>
      </div>

      {/* Greeting */}
      <p style={{ color: "#1e293b", fontSize: "16px", lineHeight: "1.6" }}>
        Hi {customerName},
      </p>
      <p style={{ color: "#1e293b", fontSize: "16px", lineHeight: "1.6" }}>
        Your parking reservation is confirmed! Here are your booking details:
      </p>

      {/* Booking Details Card */}
      <div style={{ backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "20px", marginBottom: "20px" }}>
        <h3 style={{ color: "#1e293b", margin: "0 0 15px", fontSize: "18px", borderBottom: "1px solid #e2e8f0", paddingBottom: "10px" }}>
          {lotName}
        </h3>
        <p style={{ color: "#64748b", margin: "0 0 15px", fontSize: "14px" }}>
          {lotAddress}
        </p>

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
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <td style={{ padding: "8px 0", color: "#1e293b", fontSize: "16px", fontWeight: "600" }}>Total Paid</td>
              <td style={{ padding: "8px 0", color: "#f87356", fontSize: "20px", textAlign: "right", fontWeight: "700" }}>
                ${totalAmount.toFixed(2)}
              </td>
            </tr>
            {dueAtLocation && dueAtLocation > 0 && (
              <tr>
                <td style={{ padding: "8px 0", color: "#64748b", fontSize: "14px" }}>Due at Location</td>
                <td style={{ padding: "8px 0", color: "#64748b", fontSize: "14px", textAlign: "right" }}>
                  ${dueAtLocation.toFixed(2)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* What's Next */}
      <div style={{ marginBottom: "30px" }}>
        <h3 style={{ color: "#1e293b", margin: "0 0 15px", fontSize: "18px" }}>What's Next?</h3>
        <ol style={{ color: "#1e293b", fontSize: "14px", lineHeight: "1.8", paddingLeft: "20px", margin: "0" }}>
          <li>Save this email or take a screenshot of your confirmation number</li>
          <li>On your check-in date, drive to the parking facility</li>
          <li>Show your confirmation number at the entrance</li>
          <li>Park your vehicle and catch your shuttle to the airport</li>
        </ol>
      </div>

      {/* View Booking Button */}
      <div style={{ textAlign: "center", marginBottom: "30px" }}>
        <a
          href={`https://triplypro.com/confirmation/${confirmationNumber}`}
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
      <div style={{ backgroundColor: "#f8fafc", borderRadius: "8px", padding: "20px", marginBottom: "20px" }}>
        <h4 style={{ color: "#1e293b", margin: "0 0 10px", fontSize: "14px" }}>Need Help?</h4>
        <p style={{ color: "#64748b", margin: "0", fontSize: "14px", lineHeight: "1.6" }}>
          If you have questions about your reservation, visit our{" "}
          <a href="https://triplypro.com/help" style={{ color: "#f87356" }}>Help Center</a>{" "}
          or reply to this email.
        </p>
      </div>

      {/* Footer */}
      <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "20px", textAlign: "center" }}>
        <p style={{ color: "#64748b", fontSize: "12px", margin: "0 0 10px" }}>
          Triply - Your Trip Simplified
        </p>
        <p style={{ color: "#94a3b8", fontSize: "11px", margin: "0" }}>
          This email was sent to you because you made a reservation on triplypro.com.
          <br />
          © {new Date().getFullYear()} Triply. All rights reserved.
        </p>
      </div>
    </div>
  );
}
