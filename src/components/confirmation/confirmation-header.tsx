"use client";

import { CheckCircle, Mail, XCircle } from "lucide-react";

interface ConfirmationHeaderProps {
  confirmationId: string;
  email?: string;
  /**
   * The booking was cancelled (GET /api/reservations/[id] reports
   * status "cancelled"). Required: the page must decide, never default to a
   * "Booking Confirmed!" header for a reservation the lot won't honour.
   */
  cancelled: boolean;
}

export function ConfirmationHeader({
  confirmationId,
  email,
  cancelled,
}: ConfirmationHeaderProps) {
  return (
    <div className="text-center mb-8">
      {cancelled ? (
        <div className="inline-flex items-center justify-center w-20 h-20 bg-gray-100 rounded-full mb-6">
          <XCircle size={48} className="text-gray-500" />
        </div>
      ) : (
        <div className="inline-flex items-center justify-center w-20 h-20 bg-green-100 rounded-full mb-6">
          <CheckCircle size={48} className="text-green-500" />
        </div>
      )}

      <h1 className="text-3xl font-bold text-gray-900 mb-2">
        {cancelled ? "Booking Cancelled" : "Booking Confirmed!"}
      </h1>
      {cancelled ? (
        <p className="text-gray-600 mb-4 max-w-xl mx-auto">
          This parking reservation has been cancelled and can no longer be used at the lot.
          If you were due a refund, it goes back to your original payment method and usually
          appears within 5–10 business days. Didn&apos;t cancel this yourself? Contact{" "}
          <a href="mailto:support@triplypro.com" className="text-brand-orange underline">
            support@triplypro.com
          </a>
          .
        </p>
      ) : (
        <p className="text-gray-600 mb-4">
          Your parking reservation has been successfully booked.
        </p>
      )}

      <div className="inline-block bg-gray-100 rounded-lg px-6 py-3 mb-4">
        <p className="text-sm text-gray-500 mb-1">Confirmation Number</p>
        <p className="text-2xl font-bold text-gray-900 tracking-wider">
          {confirmationId}
        </p>
      </div>

      {email && !cancelled && (
        <div className="flex items-center justify-center text-sm text-gray-600">
          <Mail size={16} className="mr-2 text-brand-orange" />
          <span>
            Confirmation sent to <strong>{email}</strong>
          </span>
        </div>
      )}
    </div>
  );
}
