"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, AlertTriangle, ExternalLink } from "lucide-react";
import { formatDateTime, formatPrice } from "@/lib/utils";
import { CANCELLATION_REASON_LABELS, type CancellationReason } from "@/lib/cancellation/reason-codes";
import { captureAPIError } from "@/lib/sentry";
import {
  bookingFailureMessage,
  parseBookingAnswer,
  type SupportBookingDetails,
} from "@/lib/support/booking-details";

type LoadState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; booking: SupportBookingDetails | null };

const STATUS_STYLE: Record<string, string> = {
  confirmed: "bg-green-100 text-green-700",
  completed: "bg-blue-100 text-blue-700",
  cancelled: "bg-red-100 text-red-700",
  refunded: "bg-red-100 text-red-700",
  disputed: "bg-amber-100 text-amber-800",
  payment_failed: "bg-amber-100 text-amber-800",
};

const report = (message: string, statusCode?: number) =>
  captureAPIError(new Error(message), { endpoint: "/api/admin/support/[id]/booking", method: "GET", statusCode, stage: "support_panel" });

const reasonLabel = (r: string | null) =>
  r && r in CANCELLATION_REASON_LABELS ? CANCELLATION_REASON_LABELS[r as CancellationReason] : r;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-gray-500">{label}:</span> <span className="text-gray-900">{children}</span>
    </div>
  );
}

/**
 * The booking behind a support ticket, shown in the ticket panel so the team
 * can answer without looking it up on /admin/bookings. Render it with
 * `key={ticketId}` so switching tickets starts from "loading", never from the
 * previous ticket's booking.
 */
export function SupportBookingPanel({ ticketId, hasReservationNumber }: { ticketId: string; hasReservationNumber: boolean }) {
  const [load, setLoad] = useState<LoadState>({ state: "loading" });

  useEffect(() => {
    if (!hasReservationNumber) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/support/${ticketId}/booking`);
        const data: unknown = await res.json().catch(() => undefined);
        if (cancelled) return;
        if (!res.ok) {
          if (res.status >= 500) report(`Support booking panel got ${res.status}`, res.status);
          setLoad({ state: "error", message: bookingFailureMessage(res.status) });
          return;
        }
        const parsed = parseBookingAnswer(data);
        if (!parsed.ok) {
          report("Support booking panel got a 200 that isn't a booking answer", res.status);
          setLoad({ state: "error", message: "Unexpected answer from the server. Refresh to try again, or look it up in Bookings." });
          return;
        }
        setLoad({ state: "ready", booking: parsed.booking });
      } catch (e) {
        if (cancelled) return;
        report(`Support booking panel fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        setLoad({ state: "error", message: "Couldn't reach the server. Check your connection and refresh." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ticketId, hasReservationNumber]);

  if (!hasReservationNumber) return null;

  if (load.state === "loading") {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-gray-200 p-4 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the booking…
      </div>
    );
  }
  if (load.state === "error") {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <AlertTriangle className="h-4 w-4" /> {load.message}
      </div>
    );
  }
  const b = load.booking;
  if (!b) {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">
        No booking found under this reservation number.
      </div>
    );
  }

  const status = b.status ?? "unknown";
  return (
    <div className="mt-4 rounded-lg border border-gray-200 p-4 text-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-gray-900">Booking</h3>
          <span className="font-mono text-gray-700">{b.reservationNumber}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_STYLE[status] ?? "bg-gray-100 text-gray-700"}`}>
            {status}
          </span>
          {b.inventorySource === "direct" && (
            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-700">Direct lot</span>
          )}
        </div>
        <Link
          href="/admin/bookings"
          target="_blank"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-orange hover:underline"
        >
          Cancel or refund in Bookings <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      {!b.emailMatchesTicket && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This booking is under a different email ({b.customer.email ?? "none on file"}). Verify the customer is the booker before
            sharing details or changing anything.
          </span>
        </div>
      )}

      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        <Row label="Lot">
          {b.locationName}
          {b.airportCode && ` (${b.airportCode})`}
        </Row>
        {b.locationAddress && <Row label="Address">{b.locationAddress}</Row>}
        <Row label="Check-in">{formatDateTime(b.checkIn)}</Row>
        <Row label="Check-out">{formatDateTime(b.checkOut)}</Row>
        <Row label="Customer">{b.customer.name}</Row>
        <Row label="Phone">{b.customer.phone ?? "—"}</Row>
        <Row label="Vehicle">
          {b.vehicle.description ?? "—"}
          {b.vehicle.sizeLabel && ` (${b.vehicle.sizeLabel})`}
        </Row>
        <Row label="Plate">{b.vehicle.plate ?? "—"}</Row>
        <Row label="Paid online">
          {b.money.paidOnline === null ? (
            <span className="text-red-600">Not recorded. Check Bookings before quoting an amount.</span>
          ) : (
            formatPrice(b.money.paidOnline)
          )}
        </Row>
        {b.money.dueAtLocation > 0 && <Row label="Due at lot">{formatPrice(b.money.dueAtLocation)}</Row>}
        {b.money.atLotEstimate > 0 && <Row label="Vehicle surcharge at lot (est.)">{formatPrice(b.money.atLotEstimate)}</Row>}
        {b.money.promoCode && (
          <Row label="Promo">
            {b.money.promoCode}
            {b.money.discount > 0 && ` (−${formatPrice(b.money.discount)})`}
          </Row>
        )}
        <Row label="Protection">
          {!b.protection
            ? "None"
            : `${b.protection.plan} (${b.protection.price === null ? "price not recorded" : formatPrice(b.protection.price)})`}
        </Row>
        <Row label="Booked">{b.bookedAt ? formatDateTime(b.bookedAt) : "—"}</Row>
      </div>

      {b.cancellation && (
        <div className="mt-3 rounded-lg bg-red-50 p-3 text-red-800">
          <span className="font-medium">{status === "refunded" ? "Cancelled and refunded" : "Cancelled"}</span>
          {b.cancellation.by && ` by ${b.cancellation.by}`}
          {b.cancellation.reason && ` — ${reasonLabel(b.cancellation.reason)}`}
          {b.cancellation.note && <div className="mt-1 whitespace-pre-wrap text-red-700">{b.cancellation.note}</div>}
          {b.cancellation.noteUnavailable && (
            <div className="mt-1 text-red-700">The staff note couldn&apos;t be loaded. See the booking in Bookings.</div>
          )}
        </div>
      )}
    </div>
  );
}
