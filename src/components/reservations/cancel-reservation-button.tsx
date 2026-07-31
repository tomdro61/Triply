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

// Rendered OUTSIDE the card's <Link>, so nothing here needs to stopPropagation
// or preventDefault — clicks don't reach the card navigation.
type Phase = "idle" | "confirming" | "submitting" | "processing" | "error";

export function CancelReservationButton({
  reservationNumber,
  cancellable,
  onCancelled,
}: CancelReservationButtonProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);

  // Inside 24h (or otherwise ineligible): no online cancel — route to support.
  if (!cancellable) {
    return (
      <div className="mt-3 pt-3 border-t border-gray-100">
        <p className="text-xs text-gray-500">
          Cancellations are only available more than 24 hours before check-in.{" "}
          <a href="/help" className="text-brand-orange font-medium hover:underline">
            Contact support
          </a>{" "}
          for help.
        </p>
      </div>
    );
  }

  if (phase === "processing") {
    return (
      <div className="mt-3 pt-3 border-t border-gray-100 flex items-start gap-2">
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
      const data: Record<string, unknown> = await res.json().catch(() => ({}));

      if (res.status === 401) {
        // Session expired between page load and click — send them to log back in.
        router.push("/auth/login?redirect=/reservations");
        return;
      }
      // 202 MUST be checked before the 200 case: res.ok is true for the whole
      // 2xx range. A 202 is NON-terminal — an ambiguous ResLab hold OR a refund
      // still pending — so the reservation is NOT confirmed-cancelled yet. Show
      // "processing" and do NOT flip the card (the cron finishes it + emails).
      if (res.status === 202) {
        setPhase("processing");
        setMessage(
          typeof data.message === "string"
            ? data.message
            : "We're processing your cancellation and will confirm by email shortly.",
        );
        return;
      }
      if (res.status === 200) {
        // Terminal: cancelled / refunded / already-cancelled. The badge flip + the
        // cancellation email (with the refund breakdown) are the confirmation.
        onCancelled(reservationNumber);
        return;
      }
      // The cancel API emits ONLY 200 and 202 in the 2xx range. If a no-body 2xx
      // (204/205) is ever added, revisit this — an empty body would parse to {} and
      // fall through here, showing a spurious error on a real success.
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
    <div className="mt-3 pt-3 border-t border-gray-100">
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
            type="button"
            onClick={() => void submit()}
            disabled={phase === "submitting"}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-red-600 hover:text-red-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {phase === "submitting" && <Loader2 className="h-4 w-4 animate-spin" />}
            {phase === "submitting" ? "Cancelling…" : "Yes, cancel"}
          </button>
          <button
            type="button"
            onClick={() => {
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
          type="button"
          onClick={() => setPhase("confirming")}
          className="text-sm font-medium text-gray-500 hover:text-red-600 transition-colors"
        >
          Cancel reservation
        </button>
      )}
    </div>
  );
}

function errorMessageFor(status: number, data: Record<string, unknown>): string {
  // The server writes customer-safe, precise messages (e.g. a dirty-data 500's
  // "we did NOT cancel your reservation, contact support" — which must NOT become
  // a misleading "try again"). Prefer it; the status fallbacks below cover the
  // case where the body didn't parse (data is the {}-default).
  if (typeof data.message === "string" && data.message) return data.message;
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
