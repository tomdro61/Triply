"use client";

import { CheckCircle, Mail } from "lucide-react";

interface ConfirmationHeaderProps {
  confirmationId: string;
  email?: string;
}

export function ConfirmationHeader({
  confirmationId,
  email,
}: ConfirmationHeaderProps) {
  return (
    <div className="text-center mb-8">
      <div className="inline-flex items-center justify-center w-20 h-20 bg-green-100 rounded-full mb-6">
        <CheckCircle size={48} className="text-green-500" />
      </div>

      <h1 className="text-3xl font-bold text-gray-900 mb-2">
        Booking Confirmed!
      </h1>
      <p className="text-gray-600 mb-4">
        Your parking reservation has been successfully booked.
      </p>

      <div className="inline-block bg-gray-100 rounded-lg px-6 py-3 mb-4">
        <p className="text-sm text-gray-500 mb-1">Confirmation Number</p>
        <p className="text-2xl font-bold text-gray-900 tracking-wider">
          {confirmationId}
        </p>
      </div>

      {email && (
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
