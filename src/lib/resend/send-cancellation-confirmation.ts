import { render } from "@react-email/render";
import { resend, FROM_EMAIL } from "./client";
import { CancellationConfirmationEmail } from "./templates/cancellation-confirmation";

interface SendCancellationConfirmationParams {
  to: string;
  customerName: string;
  confirmationNumber: string;
  lotName: string;
  lotAddress: string;
  checkInDate: string;
  checkOutDate: string;
  refundAmount: number;
  wasRefunded: boolean;
}

export async function sendCancellationConfirmation({
  to,
  customerName,
  confirmationNumber,
  lotName,
  lotAddress,
  checkInDate,
  checkOutDate,
  refundAmount,
  wasRefunded,
}: SendCancellationConfirmationParams) {
  try {
    const emailHtml = await render(
      CancellationConfirmationEmail({
        customerName,
        confirmationNumber,
        lotName,
        lotAddress,
        checkInDate,
        checkOutDate,
        refundAmount,
        wasRefunded,
      })
    );

    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: [to],
      subject: `Reservation Cancelled - ${confirmationNumber}`,
      html: emailHtml,
    });

    if (error) {
      console.error("Failed to send cancellation email:", error);
      return { success: false, error };
    }

    return { success: true, emailId: data?.id };
  } catch (err) {
    console.error("Error sending cancellation email:", err);
    return { success: false, error: err };
  }
}
