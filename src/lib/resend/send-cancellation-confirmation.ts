import { render } from "@react-email/render";
import { resend, FROM_EMAIL } from "./client";
import { CancellationConfirmationEmail } from "./templates/cancellation-confirmation";
import { captureBookingError } from "@/lib/sentry";

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
  serviceFee?: number;
  protectionPlanRefund?: number;
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
  serviceFee,
  protectionPlanRefund,
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
        serviceFee,
        protectionPlanRefund,
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
      // Money-handling event — refund was issued and the customer doesn't
      // know unless this email lands. Surface to Sentry.
      captureBookingError(
        new Error(
          `Cancellation email send failed for ${confirmationNumber}: ${error.message}`
        ),
        { step: "confirmation" }
      );
      return { success: false, error };
    }

    return { success: true, emailId: data?.id };
  } catch (err) {
    console.error("Error sending cancellation email:", err);
    captureBookingError(
      err instanceof Error
        ? err
        : new Error(
            `Cancellation email render failed for ${confirmationNumber}: ${String(err)}`
          ),
      { step: "confirmation" }
    );
    return { success: false, error: err };
  }
}
