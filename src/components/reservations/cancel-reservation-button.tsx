"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertCircle } from "lucide-react";

interface CancelReservationButtonProps {
  reservationNumber: string;
  /**
   * Server-computed airport-local 24h eligibility (from /api/user/bookings).
   * When false, the reservation is inside the 24h window (or otherwise
   * ineligible) and we route to support instead of offering online cancel. The
   * cancel API STILL re-validates on the action — this is the display gate.
   */
  cancellable: boolean;
  /** Lifts the terminal (200) outcome to the page so the card flips to Cancelled. */
  onCancelled: (reservationNumber: string) => void;
}

type Phase = "idle" | "confirming" | "submitting" | "processing" | "error";

export function CancelReservationButton({
  reservationNumber,
  cancellable,
  onCancelled,
}: CancelReservationButtonProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  // The parent card is a <Link> — every interaction here must NOT navigate.
  const stop = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // Inside 24h (or otherwise ineligible): no online cancel — route to support.
  if (!cancellable) {
    return (
      <div className="mt-3 pt-3 border-t border-gray-100" onClick={stop}>
        <p className="text-xs text-gray-500">
          Cancellations are only available more than 24 hours before check-in.{" "}
          <a
            href="/help"
            onClick={stop}
            className="text-brand-orange font-medium hover:underline"
          >
            Contact support
          </a>{" "}
          for help.
        </p>
      </div>
    );
  }

  if (phase === "processing") {
    return (
      <div className="mt-3 pt-3 border-t border-gray-100 flex items-start gap-2" onClick={stop}>
        <Loader2 className="h-4 w-4 text-brand-orange mt-0.5 shrink-0" />
        <p className="text-sm text-gray-700">{message}</p>
      </div>
    );
  }

  const submit = async () => {
    setPhase("submitting");
    setMessage(null);
    try {
      const res = await fetch(
        `/api/user/bookings/${encodeURIComponent(reservationNumber)}/cancel`,
        { method: "POST" },
      );
      const data: Record<string, unknown> = await res
        .json()
        .catch(() => ({}));

      if (res.status === 401) {
        // Session expired between page load and click — send them to log back in.
        router.push("/auth/login?redirect=/reservations");
        return;
      }
      if (res.ok) {
        // 200: cancelled / refunded / already-cancelled. The badge flip + the
        // cancellation email (with the refund breakdown) are the confirmation.
        onCancelled(reservationNumber);
        return;
      }
      if (res.status === 202) {
        setPhase("processing");
        setMessage(
          typeof data.message === "string"
            ? data.message
            : "We're processing your cancellation and will confirm by email shortly.",
        );
        return;
      }
      setPhase("error");
      setMessage(errorMessageFor(res.status, data));
    } catch {
      setPhase("error");
      setMessage(
        "We couldn't reach the server. Please check your connection and try again.",
      );
    }
  };

  const confirming = phase === "confirming" || phase === "submitting";

  return (
    <div className="mt-3 pt-3 border-t border-gray-100" onClick={stop}>
      {phase === "error" && message && (
        <p className="mb-2 flex items-start gap-2 text-sm text-red-600">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{message}</span>
        </p>
      )}
      {confirming ? (
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-700">Cancel this reservation?</span>
          <button
            onClick={(e) => {
              stop(e);
              void submit();
            }}
            disabled={phase === "submitting"}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-600 hover:text-red-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {phase === "submitting" && <Loader2 className="h-4 w-4 animate-spin" />}
            {phase === "submitting" ? "Cancelling…" : "Yes, cancel"}
          </button>
          <button
            onClick={(e) => {
              stop(e);
              if (phase !== "submitting") {
                setPhase("idle");
                setMessage(null);
              }
            }}
            disabled={phase === "submitting"}
            className="text-sm text-gray-500 hover:text-gray-700 disabled:opacity-60"
          >
            Keep it
          </button>
        </div>
      ) : (
        <button
          onClick={(e) => {
            stop(e);
            setPhase("confirming");
          }}
          className="text-sm font-medium text-gray-500 hover:text-red-600 transition-colors"
        >
          Cancel reservation
        </button>
      )}
    </div>
  );
}

function errorMessageFor(status: number, data: Record<string, unknown>): string {
  const error = typeof data.error === "string" ? data.error : "";
  if (status === 409 && error === "in_progress") {
    return "This cancellation is already being processed. Please refresh in a moment.";
  }
  if (status === 409 && error === "cannot_cancel") {
    return "This reservation can no longer be cancelled online (it may have already started). Please contact support.";
  }
  if (status === 422) {
    return "Cancellations are only available more than 24 hours before check-in. Please contact support for help.";
  }
  return "We couldn't cancel your reservation. Please try again, or contact support if the problem continues.";
}
