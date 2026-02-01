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
  checkInTime?: string;
  checkOutTime?: string;
  totalAmount: number;
  dueAtLocation?: number;
  vehicleInfo?: string;
}

export async function sendBookingConfirmation({
  to,
  customerName,
  confirmationNumber,
  lotName,
  lotAddress,
  checkInDate,
  checkOutDate,
  checkInTime = "10:00 AM",
  checkOutTime = "2:00 PM",
  totalAmount,
  dueAtLocation,
  vehicleInfo,
}: SendBookingConfirmationParams) {
  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject: `Booking Confirmed - ${confirmationNumber}`,
      react: BookingConfirmationEmail({
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
      }),
    });

    if (error) {
      console.error("Failed to send booking confirmation email:", error);
      return { success: false, error };
    }

    console.log("Booking confirmation email sent:", data?.id);
    return { success: true, emailId: data?.id };
  } catch (err) {
    console.error("Error sending booking confirmation email:", err);
    return { success: false, error: err };
  }
}
