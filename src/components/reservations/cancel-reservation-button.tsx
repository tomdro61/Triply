"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Loader2, AlertCircle, CalendarX, X } from "lucide-react";

interface CancelReservationButtonProps {
  reservationNumber: string;
  /**
   * Server-computed airport-local 24h eligibility (from /api/user/bookings).
   * When false, the reservation is inside the 24h window (or otherwise
   * ineligible) and we route to support instead of offering online cancel. The
   * cancel API STILL re-validates on the action — this is the display gate.
   */
  cancellable: boolean;
  /**
   * Lifts the terminal (200) outcome to the page so the card flips to Cancelled.
   * The refund amount goes with it because flipping status UNMOUNTS this
   * component — a success panel owned here could never paint.
   */
  onCancelled: (reservationNumber: string, refundAmount: number | null) => void;
}

// Validated at the boundary rather than cast. A 2xx whose body doesn't parse
// (captive portal / corporate proxy returning an HTML page with 200 — and our
// customers are on airport and hotel WiFi by definition) yields {}, which is
// TRUTHY. Casting through `unknown` would sail past the null check and render
// money(undefined) — undefined.toFixed(2) — throwing during render and taking
// out the whole reservations page via the error boundary, at the exact moment
// someone is trying to cancel. Also honours the no-casts-through-unknown rule.
const PreviewSchema = z.object({
  paidTotal: z.number(),
  refundAmount: z.number(),
  parkGuardWithheld: z.number(),
  priorRefunded: z.number(),
  hasParkGuard: z.boolean(),
  isAuthorizationRelease: z.boolean(),
});
type RefundPreview = z.infer<typeof PreviewSchema>;

// Rendered OUTSIDE the card's <Link>, so nothing here needs to stopPropagation
// or preventDefault — clicks don't reach the card navigation.
type Phase = "idle" | "confirming" | "submitting" | "processing" | "error";

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Preview failures that are NOT outages — they're the cancel path's own
 * refusals arriving early. For these the preview has already proven the action
 * will be refused, so a prominent red "Yes, cancel" buys a guaranteed error and
 * a support ticket. Everything else (5xx, network, shape failure) stays
 * actionable: the cancel window is time-bounded, and blocking someone during
 * our outage can cost them the entire refund.
 *
 * `cannot_cancel` is deliberately NOT here — that's the cancelled-in-another-tab
 * case, where the cancel route returns 200 alreadyCancelled and flips the card.
 */
const DEAD_END_CODES = new Set(["not_eligible", "amount_unavailable"]);

export function CancelReservationButton({
  reservationNumber,
  cancellable,
  onCancelled,
}: CancelReservationButtonProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewDeadEnd, setPreviewDeadEnd] = useState(false);
  // Discards superseded preview responses: reopen-during-flight, close, and
  // (critically) once a cancel is submitted — the dialog stays mounted through
  // `submitting`, so a slow preview landing mid-cancel would otherwise repaint
  // money, or an eligibility warning, under a spinning "Cancelling…" button.
  const previewSeq = useRef(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const openDialog = useCallback(() => {
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setPhase("confirming");
    setMessage(null);
    setPreview(null);
    setPreviewError(null);
    setPreviewDeadEnd(false);

    const seq = ++previewSeq.current;
    void (async () => {
      try {
        const res = await fetch(
          `/api/user/bookings/${encodeURIComponent(reservationNumber)}/cancel-preview`,
        );
        const data: Record<string, unknown> = await res.json().catch(() => ({}));
        if (seq !== previewSeq.current) return; // superseded

        // Session expired between page load and opening the dialog. Handle it
        // HERE rather than letting them confirm and get bounced afterwards,
        // losing the dialog — same treatment the cancel action gives a 401.
        if (res.status === 401) {
          router.push("/auth/login?redirect=/reservations");
          return;
        }
        if (!res.ok) {
          const code = typeof data.error === "string" ? data.error : "";
          setPreviewError(
            typeof data.message === "string"
              ? data.message
              : "We couldn't calculate your refund.",
          );
          setPreviewDeadEnd(DEAD_END_CODES.has(code));
          return;
        }
        const parsed = PreviewSchema.safeParse(data);
        if (!parsed.success) {
          // A shape failure is a preview failure, not a preview.
          setPreviewError("We couldn't calculate your refund.");
          return;
        }
        setPreview(parsed.data);
      } catch {
        if (seq !== previewSeq.current) return;
        setPreviewError("We couldn't calculate your refund.");
      }
    })();
  }, [reservationNumber, router]);

  const closeDialog = useCallback(() => {
    if (phase === "submitting") return; // never abandon an in-flight cancel
    previewSeq.current++;
    setPhase("idle");
    setMessage(null);
    setPreview(null);
    setPreviewError(null);
    setPreviewDeadEnd(false);
    returnFocusRef.current?.focus();
  }, [phase]);

  // Move focus into the dialog on open so a screen-reader user is told it
  // appeared and doesn't land nowhere.
  useEffect(() => {
    if (phase === "confirming") dialogRef.current?.focus();
  }, [phase]);

  // Escape closes — standard modal behaviour, and impossible mid-cancel.
  useEffect(() => {
    if (phase !== "confirming") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, closeDialog]);

  const submit = async () => {
    // Invalidate any in-flight preview before the money moves.
    previewSeq.current++;
    setPhase("submitting");
    setMessage(null);
    try {
      const res = await fetch(
        `/api/user/bookings/${encodeURIComponent(reservationNumber)}/cancel`,
        { method: "POST" },
      );
      const data: Record<string, unknown> = await res.json().catch(() => ({}));

      if (res.status === 401) {
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
        // Terminal: cancelled / refunded / already-cancelled. Hand the SERVER's
        // refund figure up — not the previewed one — so a divergence surfaces
        // rather than being papered over. `refunded !== true` (including the
        // alreadyCancelled shapes, which return before finalize runs) yields
        // null, and the parent renders copy that claims nothing about email.
        const amount =
          data.refunded === true && typeof data.refundAmount === "number"
            ? data.refundAmount
            : null;
        onCancelled(reservationNumber, amount);
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

  // ── Inside 24h (or otherwise ineligible): no online cancel — route to support.
  if (!cancellable) {
    return (
      <div className="mt-4 rounded-lg bg-gray-50 border border-gray-200 p-4">
        <p className="text-sm text-gray-600">
          <span className="font-medium text-gray-900">Need to cancel?</span>{" "}
          Online cancellation is available up to 24 hours before check-in.
        </p>
        <a
          href="/help"
          className="mt-2 inline-block text-sm font-semibold text-brand-orange hover:underline"
        >
          Contact support for help →
        </a>
      </div>
    );
  }

  // ── Non-terminal (202): cancellation accepted but still settling.
  if (phase === "processing") {
    return (
      <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 p-4">
        <div className="flex items-start gap-2.5">
          <Loader2 className="h-5 w-5 text-amber-600 mt-0.5 shrink-0 animate-spin" />
          <p className="text-sm text-amber-900">{message}</p>
        </div>
      </div>
    );
  }

  const dialogOpen = phase === "confirming" || phase === "submitting";

  return (
    <>
      <div className="mt-4 rounded-lg bg-gray-50 border border-gray-200 p-4">
        <p className="text-sm font-medium text-gray-900">
          Need to change your plans?
        </p>
        <p className="mt-0.5 text-sm text-gray-600">
          You can cancel this reservation online until 24 hours before check-in.
        </p>

        {phase === "error" && message && (
          <p className="mt-3 flex items-start gap-2 text-sm text-red-600">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{message}</span>
          </p>
        )}

        <button
          type="button"
          onClick={openDialog}
          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
        >
          <CalendarX className="h-4 w-4" />
          Cancel reservation
        </button>
      </div>

      {dialogOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
          // onMouseDown, not onClick: selecting the refund amount and releasing
          // outside the panel would otherwise dismiss the dialog mid-read.
          onMouseDown={closeDialog}
        >
          <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`cancel-title-${reservationNumber}`}
            className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl bg-white p-6 shadow-xl focus:outline-none"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <h3
                id={`cancel-title-${reservationNumber}`}
                className="text-lg font-bold text-gray-900"
              >
                Cancel this reservation?
              </h3>
              <button
                type="button"
                onClick={closeDialog}
                disabled={phase === "submitting"}
                aria-label="Close"
                className="-mr-1 -mt-1 rounded p-1 text-gray-400 hover:text-gray-600 disabled:opacity-40"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="mt-1 text-sm text-gray-600">
              Reservation {reservationNumber}. This can&apos;t be undone.
            </p>

            {/* Money. Server-computed from the actual charge via the same
                planTeardown the cancel uses — never derived in the browser, so
                the figure shown is the figure refunded. */}
            <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
              {preview === null && previewError === null && (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Calculating your refund…
                </div>
              )}

              {previewError && (
                <>
                  <p className="flex items-start gap-2 text-sm text-amber-700">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{previewError}</span>
                  </p>
                  {!previewDeadEnd && (
                    // We can't state the figure, so state the POLICY. Turns
                    // "confirming blind" into "informed by policy, exact figure
                    // to follow" — true under the locked refund rules.
                    <p className="mt-2 text-sm text-gray-600">
                      You&apos;ll be refunded everything you paid online, minus
                      the $6 Park Guard fee if you added protection. We&apos;ll
                      email your exact refund amount.
                    </p>
                  )}
                </>
              )}

              {preview &&
                (preview.isAuthorizationRelease ? (
                  <p className="text-sm text-gray-700">
                    Your card was authorized but never charged. Cancelling
                    releases the hold —{" "}
                    <span className="font-semibold">nothing will be billed.</span>
                  </p>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm font-semibold text-gray-900">
                        Refund to your card
                      </span>
                      <span className="text-xl font-bold text-gray-900">
                        {money(preview.refundAmount)}
                      </span>
                    </div>
                    <dl className="mt-3 space-y-1.5 border-t border-gray-200 pt-3 text-sm">
                      <div className="flex justify-between text-gray-600">
                        <dt>You paid</dt>
                        <dd>{money(preview.paidTotal)}</dd>
                      </div>
                      {preview.priorRefunded > 0 && (
                        // Without this the itemisation asserts
                        // paid − PG fee = refund, and a prior partial refund
                        // leaves an unexplained hole that reads as an error.
                        <div className="flex justify-between text-gray-600">
                          <dt>Already refunded</dt>
                          <dd>−{money(preview.priorRefunded)}</dd>
                        </div>
                      )}
                      {preview.hasParkGuard && preview.parkGuardWithheld > 0 && (
                        <div className="flex justify-between text-gray-600">
                          <dt>Park Guard fee (non-refundable)</dt>
                          <dd>−{money(preview.parkGuardWithheld)}</dd>
                        </div>
                      )}
                    </dl>
                    <p className="mt-3 text-xs text-gray-500">
                      Refunds usually appear within 5–10 business days, depending
                      on your bank.
                    </p>
                  </>
                ))}
            </div>

            <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <button
                type="button"
                onClick={closeDialog}
                disabled={phase === "submitting"}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Keep reservation
              </button>
              {previewDeadEnd ? (
                // The preview already proved the cancel will be refused; send
                // them to a human instead of a button guaranteed to fail.
                <a
                  href="/help"
                  className="inline-flex items-center justify-center rounded-lg bg-brand-orange px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-90"
                >
                  Contact support
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={phase === "submitting"}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {phase === "submitting" && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  {phase === "submitting" ? "Cancelling…" : "Yes, cancel"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
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
