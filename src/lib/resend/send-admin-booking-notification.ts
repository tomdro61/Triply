import { resend, FROM_EMAIL } from "./client";
import { ADMIN_EMAILS } from "@/config/admin";

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
}

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
}: AdminBookingNotificationParams) {
  try {
    const paidOnline = dueAtLocation ? totalAmount - dueAtLocation : totalAmount;

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
              <p style="margin: 0; color: #065f46; font-size: 16px; font-weight: 700;">Confirmation #${confirmationNumber}</p>
            </div>

            <h2 style="margin: 0 0 16px; color: #111827; font-size: 18px; font-weight: 700;">Booking Details</h2>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px; width: 140px;">Location</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px; font-weight: 600;">${lotName}${airportCode ? ` (${airportCode})` : ""}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Address</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px;">${lotAddress}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Check-in</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px; font-weight: 600;">${checkInDate}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Check-out</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px; font-weight: 600;">${checkOutDate}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Total</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #f87356; font-size: 16px; font-weight: 700;">$${totalAmount.toFixed(2)}</td>
              </tr>
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
            </table>

            <h2 style="margin: 0 0 16px; color: #111827; font-size: 18px; font-weight: 700;">Customer</h2>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px; width: 140px;">Name</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px; font-weight: 600;">${customerName}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Email</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px;"><a href="mailto:${customerEmail}" style="color: #f87356; text-decoration: none;">${customerEmail}</a></td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Phone</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px;">${customerPhone}</td>
              </tr>
              ${vehicleInfo ? `
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;">Vehicle</td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; color: #111827; font-size: 14px;">${vehicleInfo}</td>
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
      return { success: false, error };
    }

    return { success: true, emailId: data?.id };
  } catch (err) {
    console.error("Error sending admin booking notification:", err);
    return { success: false, error: err };
  }
}
