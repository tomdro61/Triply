import { render } from "@react-email/render";
import { resend, FROM_EMAIL } from "./client";
import { BookingConfirmationEmail, type DirectLotEmailDetails } from "./templates/booking-confirmation";
import { captureBookingError } from "@/lib/sentry";
import { bounded, BoundedTimeoutError } from "@/lib/utils/bounded";

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
  pgSyncStatus?: "pending" | "synced" | "skipped_missing_data" | null;
  /** Set ONLY for a Triply direct-lot booking (4b plan §3.4). */
  direct?: DirectLotEmailDetails;
  /**
   * Resend idempotency key. A retry after a lost response is then never a
   * second email; a retry with a different body (the Park Guard line changed)
   * is refused by Resend as `invalid_idempotent_request` — which means the
   * FIRST one was accepted, so it is reported as sent.
   */
  idempotencyKey?: string;
  /** Bound the Resend call. A timeout is reported `uncertain`, not failed. */
  timeoutMs?: number;
}

export type SendBookingConfirmationResult =
  | { success: true; emailId?: string; duplicate?: boolean }
  | { success: false; error: unknown; uncertain?: boolean };

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
  pgSyncStatus,
  direct,
  idempotencyKey,
  timeoutMs,
}: SendBookingConfirmationParams): Promise<SendBookingConfirmationResult> {
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
        pgSyncStatus,
        direct,
      })
    );

    const request = resend.emails.send(
      {
        from: FROM_EMAIL,
        to: [to],
        subject: subject ?? `Booking Confirmed - ${confirmationNumber}`,
        html: emailHtml,
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );
    const { data, error } = timeoutMs ? await bounded(request, timeoutMs, "Resend") : await request;

    if (error?.name === "invalid_idempotent_request") {
      // This key was already used for an accepted send (a retry after a lost
      // response, with a body that has since changed). The customer has it.
      return { success: true, duplicate: true };
    }

    if (error) {
      console.error("Failed to send booking confirmation email:", error);
      // Money-handling event — customer was charged and Park Guard may have
      // been enrolled, but they don't know unless this email lands. Surface
      // to Sentry so ops can manually resend.
      captureBookingError(
        new Error(`Booking confirmation email send failed: ${error.message}`),
        { step: "confirmation", confirmationNumber }
      );
      return { success: false, error };
    }

    return { success: true, emailId: data?.id };
  } catch (err) {
    if (err instanceof BoundedTimeoutError) {
      // Resend may still deliver it: the caller must not treat this as a definite failure.
      captureBookingError(err, { step: "confirmation", confirmationNumber });
      return { success: false, error: err, uncertain: true };
    }
    console.error("Error sending booking confirmation email:", err);
    captureBookingError(
      err instanceof Error
        ? err
        : new Error(`Booking confirmation email render failed: ${String(err)}`),
      { step: "confirmation", confirmationNumber }
    );
    return { success: false, error: err };
  }
}
