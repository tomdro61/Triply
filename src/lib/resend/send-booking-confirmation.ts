import { render } from "@react-email/render";
import { resend, FROM_EMAIL } from "./client";
import { BookingConfirmationEmail } from "./templates/booking-confirmation";

interface SendBookingConfirmationParams {
  to: string;
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
  shuttleDetails?: string;
  specialConditions?: string;
  subject?: string;
  protectionPlan?: string;
  protectionPlanPrice?: number;
  pgIdentifier?: string | null;
}

export async function sendBookingConfirmation({
  to,
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
  shuttleDetails,
  specialConditions,
  subject,
  protectionPlan,
  protectionPlanPrice,
  pgIdentifier,
}: SendBookingConfirmationParams) {
  try {
    // Render React component to HTML
    const emailHtml = await render(
      BookingConfirmationEmail({
        customerName,
        customerEmail: to,
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
        shuttleDetails,
        specialConditions,
        protectionPlan,
        protectionPlanPrice,
        pgIdentifier,
      })
    );

    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject: subject ?? `Booking Confirmed - ${confirmationNumber}`,
      html: emailHtml,
    });

    if (error) {
      console.error("Failed to send booking confirmation email:", error);
      return { success: false, error };
    }

    return { success: true, emailId: data?.id };
  } catch (err) {
    console.error("Error sending booking confirmation email:", err);
    return { success: false, error: err };
  }
}
